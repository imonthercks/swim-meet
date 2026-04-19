/**
 * ExtractWithBedrock Lambda — Step Functions task
 *
 * Reads a PDF from S3 and invokes the Bedrock Agent (configured with the
 * AMAZON.CodeInterpreter action group) to perform data analysis on the
 * heat sheet.  The agent writes Python code at runtime to parse the PDF
 * bytes and return a structured JSON array of heat objects.
 *
 * The Code Interpreter action group gives the agent a sandboxed Python
 * environment so it can:
 *   - Decode and read the raw PDF bytes using pdfplumber / pdfminer
 *   - Handle multi-column layouts that confuse text-extraction heuristics
 *   - Produce and self-validate JSON before returning it
 *
 * Input (from Step Functions):
 *   { meetId, s3Bucket, s3Key, processingStatus }
 *
 * Output:
 *   { meetId, s3Bucket, s3Key, heats: Heat[] }
 *
 * Environment variables:
 *   AGENT_ID          – Bedrock Agent resource ID.
 *   AGENT_ALIAS_ID    – Bedrock Agent alias ID (points to prepared version).
 *   S3_BUCKET_NAME    – (unused at runtime; for reference only)
 */

import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  ResponseStream,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const bedrock = new BedrockAgentRuntimeClient({});

const AGENT_ID = process.env.AGENT_ID!;
const AGENT_ALIAS_ID = process.env.AGENT_ALIAS_ID!;

interface StepInput {
  meetId: string;
  s3Bucket: string;
  s3Key: string;
  processingStatus: string;
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

interface StepOutput {
  meetId: string;
  s3Bucket: string;
  s3Key: string;
  heats: Heat[];
}

/**
 * Accumulates text chunks from the Bedrock Agent response event stream
 * and returns the combined completion text.
 */
async function collectAgentResponse(stream: AsyncIterable<ResponseStream>): Promise<string> {
  const chunks: string[] = [];
  for await (const event of stream) {
    if ('chunk' in event && event.chunk?.bytes) {
      chunks.push(new TextDecoder().decode(event.chunk.bytes));
    }
  }
  return chunks.join('');
}

/**
 * Reads the PDF bytes from S3.
 */
async function readPdfBytes(bucket: string, key: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`Empty S3 response body for s3://${bucket}/${key}`);
  }
  // Body is a ReadableStream in Lambda Node.js 20+ environment
  const bytes = await response.Body.transformToByteArray();
  return bytes;
}

/**
 * Extracts a JSON array from the agent's free-text response.
 * Looks for the first '[' … ']' block in the output.
 */
function extractJsonArray(text: string): Heat[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Agent response does not contain a JSON array. Response: ${text.slice(0, 500)}`);
  }
  const jsonStr = text.slice(start, end + 1);
  return JSON.parse(jsonStr) as Heat[];
}

export async function handler(event: StepInput): Promise<StepOutput> {
  const { meetId, s3Bucket, s3Key } = event;

  console.log(`Reading PDF from s3://${s3Bucket}/${s3Key}`);
  const pdfBytes = await readPdfBytes(s3Bucket, s3Key);

  const inputText = `
You are analyzing a swim meet heat sheet PDF.

Use the Code Interpreter to read the attached PDF bytes (provided as a base64-encoded
byte array in the session file "heatsheet.pdf") and extract all events, heats, and
swimmer entries.

Return ONLY a valid JSON array of heat objects with this exact schema:
[
  {
    "id": "E001-H001",
    "event": 1,
    "event_name": "Girls 200 Yard Medley Relay",
    "heat": 1,
    "is_relay": true,
    "entries": [
      {
        "lane": 1,
        "school": "Andover",
        "relay": "A",
        "seed_time": "2:05.43",
        "swimmers": ["Last, First", "Last, First", "Last, First", "Last, First"]
      },
      { "lane": 2, "blank": true }
    ]
  }
]

For individual (non-relay) events each entry also has:
  "name": "Last, First",
  "age": "16"  (string or null)

Seed times prefixed with "X" are exhibition times — keep the full string including X.
"NT" means no time. Return blank entries as { "lane": N, "blank": true }.
meetId for this extraction: ${meetId}
`.trim();

  console.log(`Invoking Bedrock Agent ${AGENT_ID} alias ${AGENT_ALIAS_ID}`);
  const command = new InvokeAgentCommand({
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
            byteContent: {
              data: pdfBytes,
              mediaType: 'application/pdf',
            },
          },
          useCase: 'CODE_INTERPRETER',
        },
      ],
    },
  });

  const response = await bedrock.send(command);
  if (!response.completion) {
    throw new Error('Bedrock Agent returned no completion stream');
  }

  const rawText = await collectAgentResponse(response.completion);
  console.log(`Agent response length: ${rawText.length} chars`);

  const heats = extractJsonArray(rawText);
  console.log(`Extracted ${heats.length} heats for meet ${meetId}`);

  return { meetId, s3Bucket, s3Key, heats };
}
