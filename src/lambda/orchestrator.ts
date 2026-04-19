/**
 * Orchestrator Lambda — AWS Lambda Durable Function
 *
 * This is the single durable orchestrator for the entire PDF heat sheet
 * processing pipeline.  It uses the AWS Lambda Durable Execution SDK
 * (`@aws/durable-execution-sdk-js`) so that:
 *
 *   • Each pipeline step is automatically checkpointed after it completes.
 *   • If the Lambda is re-invoked (e.g. after an invocation timeout or
 *     service interruption), it replays instantly from the last checkpoint
 *     without re-running completed steps.
 *   • Retries with exponential back-off are configured per-step.
 *   • No separate orchestration service (e.g. Step Functions) is required —
 *     the durability is built directly into this Lambda function.
 *
 * Pipeline steps (in order):
 *   1. initialize-meet  — write MEET#META with processingStatus=PROCESSING
 *   2. extract-heats    — read PDF from S3, invoke Bedrock Agent (Code
 *                         Interpreter) to extract structured heat JSON
 *   3. validate-heats   — validate the extracted JSON against the canonical
 *                         heat schema
 *   4. store-heats      — batch-write heats to DynamoDB; set status=READY
 *
 * On any unhandled error a catch block writes status=FAILED to DynamoDB.
 *
 * Environment variables:
 *   TABLE_NAME      – DynamoDB table name.
 *   RAW_PDF_BUCKET  – S3 bucket name that holds the uploaded PDF.
 *   AGENT_ID        – Bedrock Agent resource ID.
 *   AGENT_ALIAS_ID  – Bedrock Agent alias ID.
 */

import {
  DurableContext,
  DurableExecutionHandler,
  withDurableExecution,
} from '@aws/durable-execution-sdk-js';
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  ResponseStream,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';

// ── AWS SDK clients ───────────────────────────────────────────────────────────
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const bedrock = new BedrockAgentRuntimeClient({});

// ── Environment variables ─────────────────────────────────────────────────────
const TABLE_NAME = process.env.TABLE_NAME!;
const AGENT_ID = process.env.AGENT_ID!;
const AGENT_ALIAS_ID = process.env.AGENT_ALIAS_ID!;

const BATCH_SIZE = 25;

// ── Types ─────────────────────────────────────────────────────────────────────
interface OrchestratorInput {
  meetId: string;
  s3Bucket: string;
  s3Key: string;
}

interface HeatEntry {
  lane: number;
  school?: string;
  name?: string;
  age?: string | null;
  seed_time?: string;
  relay?: string;
  swimmers?: string[];
  blank?: boolean;
}

interface Heat {
  id: string;
  event: number;
  event_name: string;
  heat: number;
  is_relay: boolean;
  entries: HeatEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectAgentResponse(stream: AsyncIterable<ResponseStream>): Promise<string> {
  const chunks: string[] = [];
  for await (const event of stream) {
    if ('chunk' in event && event.chunk?.bytes) {
      chunks.push(new TextDecoder().decode(event.chunk.bytes));
    }
  }
  return chunks.join('');
}

function extractJsonArray(text: string): Heat[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Agent response does not contain a JSON array. Preview: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as Heat[];
}

function heatSortKey(heat: Heat): string {
  const e = String(heat.event).padStart(3, '0');
  const h = String(heat.heat).padStart(3, '0');
  return `HEAT#E${e}#H${h}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function validateHeat(heat: Heat): string[] {
  const errors: string[] = [];
  if (!heat.id) errors.push('Heat missing \'id\'');
  if (typeof heat.event !== 'number' || heat.event < 1) errors.push(`${heat.id}: invalid 'event'`);
  if (!heat.event_name) errors.push(`${heat.id}: missing 'event_name'`);
  if (typeof heat.heat !== 'number' || heat.heat < 1) errors.push(`${heat.id}: invalid 'heat'`);
  if (typeof heat.is_relay !== 'boolean') errors.push(`${heat.id}: 'is_relay' must be boolean`);
  if (!Array.isArray(heat.entries) || heat.entries.length === 0) {
    errors.push(`${heat.id}: 'entries' must be a non-empty array`);
  } else {
    heat.entries.forEach((e, i) => {
      if (typeof e.lane !== 'number') errors.push(`${heat.id} entry[${i}]: 'lane' must be a number`);
    });
  }
  return errors;
}

// ── Durable Pipeline ──────────────────────────────────────────────────────────
//
// Each context.step() call is automatically checkpointed by the Lambda
// Durable Execution service.  If the orchestrator is re-invoked, completed
// steps are skipped and their cached result is returned instantly.

const durableHandler: DurableExecutionHandler<OrchestratorInput, void> = async (
  event: OrchestratorInput,
  context: DurableContext,
) => {
  const { meetId, s3Bucket, s3Key } = event;
  const now = new Date().toISOString();

  context.logger.info('Pipeline started', { meetId, s3Key });

  try {
    // ── Step 1: Initialize meet record ────────────────────────────────────────
    await context.step('initialize-meet', async () => {
      await ddb.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: marshall({
            PK: `MEET#${meetId}`,
            SK: 'META',
            meetId,
            s3Bucket,
            s3Key,
            processingStatus: 'PROCESSING',
            createdAt: now,
            updatedAt: now,
          }),
        }),
      );
      context.logger.info('Meet record initialized', { meetId });
    });

    // ── Step 2: Extract heats with Bedrock Agent (Code Interpreter) ───────────
    // The Bedrock Agent is equipped with the AMAZON.CodeInterpreter action group
    // which gives it a sandboxed Python runtime to parse the PDF and produce JSON.
    const heats = await context.step(
      'extract-heats',
      async () => {
        const s3Resp = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }));
        if (!s3Resp.Body) throw new Error(`Empty body for s3://${s3Bucket}/${s3Key}`);
        const pdfBytes = await s3Resp.Body.transformToByteArray();

        const inputText = `
You are analyzing a swim meet heat sheet PDF.
Use the Code Interpreter to read the attached PDF bytes (file: "heatsheet.pdf") and
extract all events, heats, and swimmer entries.

Return ONLY a valid JSON array of heat objects with this exact schema:
[
  {
    "id": "E001-H001",
    "event": 1,
    "event_name": "Girls 200 Yard Medley Relay",
    "heat": 1,
    "is_relay": true,
    "entries": [
      { "lane": 1, "school": "Andover", "relay": "A", "seed_time": "2:05.43",
        "swimmers": ["Last, First", "Last, First", "Last, First", "Last, First"] },
      { "lane": 2, "blank": true }
    ]
  }
]

For individual (non-relay) events each entry also includes "name" and "age" (string or null).
Seed times prefixed with "X" are exhibition — keep the X.  "NT" means no seed time.
meetId: ${meetId}`.trim();

        const resp = await bedrock.send(
          new InvokeAgentCommand({
            agentId: AGENT_ID,
            agentAliasId: AGENT_ALIAS_ID,
            sessionId: meetId,
            inputText,
            sessionState: {
              files: [
                {
                  name: 'heatsheet.pdf',
                  source: {
                    sourceType: 'BYTE_CONTENT',
                    byteContent: { data: pdfBytes, mediaType: 'application/pdf' },
                  },
                  useCase: 'CODE_INTERPRETER',
                },
              ],
            },
          }),
        );
        if (!resp.completion) throw new Error('Bedrock Agent returned no completion stream');
        const rawText = await collectAgentResponse(resp.completion);
        const extracted = extractJsonArray(rawText);
        context.logger.info('Extraction complete', { meetId, heatCount: extracted.length });
        return extracted;
      },
      {
        // Retry on Bedrock throttling with exponential back-off
        retryStrategy: (error, attempt) => ({
          shouldRetry: attempt < 3 && /throttl|serviceUnavail/i.test(String(error)),
          delay: { seconds: 30 * Math.pow(2, attempt - 1) },
        }),
      },
    );

    // ── Step 3: Validate extracted heats ─────────────────────────────────────
    const validatedHeats = await context.step('validate-heats', async () => {
      if (!Array.isArray(heats) || heats.length === 0) {
        throw new Error(`Meet ${meetId}: extraction produced no heats`);
      }
      const allErrors = heats.flatMap(validateHeat);
      const validHeats = heats.filter(h => validateHeat(h).length === 0);
      if (validHeats.length === 0) {
        throw new Error(`Meet ${meetId}: all heats failed validation. Errors: ${allErrors.slice(0, 5).join('; ')}`);
      }
      if (allErrors.length > 0) {
        context.logger.warn('Validation warnings', { meetId, sample: allErrors.slice(0, 3) });
      }
      context.logger.info('Validation complete', { meetId, validCount: validHeats.length });
      return validHeats;
    });

    // ── Step 4: Store heats in DynamoDB and mark READY ────────────────────────
    await context.step('store-heats', async () => {
      const ts = new Date().toISOString();
      const writeRequests = validatedHeats.map(heat => ({
        PutRequest: {
          Item: marshall({
            PK: `MEET#${meetId}`,
            SK: heatSortKey(heat),
            ...heat,
            schools: [...new Set(heat.entries.filter(e => e.school).map(e => e.school!))],
            updatedAt: ts,
          }),
        },
      }));
      for (const batch of chunk(writeRequests, BATCH_SIZE)) {
        await ddb.send(
          new BatchWriteItemCommand({ RequestItems: { [TABLE_NAME]: batch } }),
        );
      }
      // Update META to READY
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ PK: `MEET#${meetId}`, SK: 'META' }),
          UpdateExpression: 'SET processingStatus = :s, heatCount = :c, updatedAt = :t',
          ExpressionAttributeValues: marshall({ ':s': 'READY', ':c': validatedHeats.length, ':t': ts }),
        }),
      );
      context.logger.info('Heats stored', { meetId, count: validatedHeats.length });
    });

  } catch (err) {
    // ── Error handler: mark meet as FAILED ────────────────────────────────────
    // This step is NOT wrapped in context.step() so it always executes on the
    // error path without being replayed (the error itself is not checkpointed).
    const msg = err instanceof Error ? err.message : String(err);
    context.logger.error('Pipeline failed', err instanceof Error ? err : new Error(msg));
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ PK: `MEET#${meetId}`, SK: 'META' }),
          UpdateExpression: 'SET processingStatus = :s, errorMessage = :e, updatedAt = :t',
          ExpressionAttributeValues: marshall({
            ':s': 'FAILED',
            ':e': msg,
            ':t': new Date().toISOString(),
          }),
        }),
      );
    } catch (updateErr) {
      context.logger.error('Failed to update meet status to FAILED', updateErr instanceof Error ? updateErr : new Error(String(updateErr)));
    }
    throw err; // Re-throw so the durable framework records this as a failed execution
  }
};

export const handler = withDurableExecution(durableHandler);
