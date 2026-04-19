/**
 * ProcessingInitiator Lambda
 *
 * Triggered by SQS messages that originate from EventBridge S3 Object Created
 * events.  For each PDF uploaded to the raw-PDF bucket this function:
 *   1. Extracts the bucket name, object key, and a derived meetId from the
 *      S3 event detail embedded in the EventBridge / SQS message.
 *   2. Asynchronously invokes the Orchestrator Lambda (a Lambda Durable Function)
 *      which handles the end-to-end PDF processing pipeline with automatic
 *      checkpointing and retry.
 *
 * Using async invocation (InvocationType: 'Event') means this function returns
 * immediately while the durable orchestrator runs independently.
 *
 * Environment variables expected at runtime:
 *   ORCHESTRATOR_ARN – ARN of the durable Orchestrator Lambda function.
 */

import {
  InvokeCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
const ORCHESTRATOR_ARN = process.env.ORCHESTRATOR_ARN!;

interface S3EventDetail {
  bucket: { name: string };
  object: { key: string; size: number };
}

interface EventBridgeEvent {
  'source': string;
  'detail-type': string;
  'detail': S3EventDetail;
}

interface SQSRecord {
  body: string;
}

interface SQSEvent {
  Records: SQSRecord[];
}

/**
 * Derives a URL-safe meetId from the S3 object key.
 * Expected key pattern: pdfs/<userId>/<meetId>.pdf
 * Falls back to the full key (with slashes replaced) if the pattern doesn't match.
 */
function meetIdFromKey(key: string): string {
  const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
  const parts = decoded.split('/');
  const filename = parts[parts.length - 1] ?? decoded;
  return filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-');
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    let ebEvent: EventBridgeEvent;
    try {
      ebEvent = JSON.parse(record.body) as EventBridgeEvent;
    } catch {
      console.error('Failed to parse SQS message body:', record.body);
      continue;
    }

    const { bucket, object } = ebEvent.detail;
    const meetId = meetIdFromKey(object.key);

    const payload = JSON.stringify({
      meetId,
      s3Bucket: bucket.name,
      s3Key: object.key,
    });

    // Async invocation — returns immediately; the Orchestrator Lambda runs
    // as a durable function and handles its own checkpointing and retries.
    await lambda.send(
      new InvokeCommand({
        FunctionName: ORCHESTRATOR_ARN,
        InvocationType: 'Event', // async — fire and forget
        Payload: Buffer.from(payload),
      }),
    );

    console.log(`Triggered durable orchestrator for meet ${meetId} (s3://${bucket.name}/${object.key})`);
  }
}

