/**
 * UpdateMeetStatus Lambda — Step Functions task (error Catch handler)
 *
 * Updates the MEET#META DynamoDB record to FAILED when the state machine's
 * error Catch triggers.  Also invoked on success (status=READY) via the
 * pass-through from StoreHeats.
 *
 * Input (from Step Functions Catch / direct invocation):
 *   {
 *     meetId: string,
 *     targetStatus: 'READY' | 'FAILED',
 *     errorMessage?: string   // populated by Step Functions on Catch
 *   }
 *
 * Output:
 *   { meetId, processingStatus: string }
 *
 * Environment variables:
 *   TABLE_NAME – DynamoDB table name.
 */

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

interface StepInput {
  meetId: string;
  targetStatus: string;
  errorMessage?: string;
  // Step Functions Catch wraps the original input inside Cause/Error fields.
  // The state machine passes these as part of the input object.
  Cause?: string;
  Error?: string;
}

interface StepOutput {
  meetId: string;
  processingStatus: string;
}

export async function handler(event: StepInput): Promise<StepOutput> {
  const { meetId, targetStatus, errorMessage } = event;
  const now = new Date().toISOString();

  let updateExpr = 'SET processingStatus = :s, updatedAt = :t';
  const exprValues: Record<string, unknown> = { ':s': targetStatus, ':t': now };

  if (errorMessage || event.Cause) {
    updateExpr += ', errorMessage = :e';
    exprValues[':e'] = errorMessage ?? event.Cause ?? 'Unknown error';
  }

  await ddb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ PK: `MEET#${meetId}`, SK: 'META' }),
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: marshall(exprValues),
    }),
  );

  console.log(`Updated meet ${meetId} status to ${targetStatus}`);
  return { meetId, processingStatus: targetStatus };
}
