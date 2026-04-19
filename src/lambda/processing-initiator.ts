/**
 * ProcessingInitiator Lambda
 *
 * Triggered by SQS messages that originate from EventBridge S3 Object Created
 * events.  For each PDF uploaded to the raw-PDF bucket this function:
 *   1. Extracts the bucket name, object key, and a derived meetId from the
 *      S3 event detail embedded in the EventBridge / SQS message.
 *   2. Starts one Step Functions Standard Workflow execution per PDF so that
 *      the durable processing pipeline takes over.
 *
 * Environment variables expected at runtime:
 *   STATE_MACHINE_ARN – ARN of the HeatSheetProcessing state machine.
 */

import {
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

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

    const input = JSON.stringify({
      meetId,
      s3Bucket: bucket.name,
      s3Key: object.key,
    });

    const executionName = `${meetId}-${Date.now()}`;

    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: executionName,
        input,
      }),
    );

    console.log(`Started execution ${executionName} for meet ${meetId} (s3://${bucket.name}/${object.key})`);
  }
}
