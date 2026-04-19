/**
 * InitializeMeet Lambda — Step Functions task
 *
 * Creates (or upserts) the MEET#META record in DynamoDB with
 * processingStatus = PROCESSING so the SPA can poll progress.
 *
 * Input (from Step Functions):
 *   { meetId: string, s3Bucket: string, s3Key: string }
 *
 * Output:
 *   { meetId, s3Bucket, s3Key, processingStatus: 'PROCESSING' }
 *
 * Environment variables:
 *   TABLE_NAME – DynamoDB table name.
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

interface StepInput {
  meetId: string;
  s3Bucket: string;
  s3Key: string;
}

interface StepOutput extends StepInput {
  processingStatus: string;
}

export async function handler(event: StepInput): Promise<StepOutput> {
  const { meetId, s3Bucket, s3Key } = event;

  const now = new Date().toISOString();
  const item = {
    PK: `MEET#${meetId}`,
    SK: 'META',
    meetId,
    s3Bucket,
    s3Key,
    processingStatus: 'PROCESSING',
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(item),
    }),
  );

  console.log(`Initialized meet ${meetId} with status PROCESSING`);
  return { ...event, processingStatus: 'PROCESSING' };
}
