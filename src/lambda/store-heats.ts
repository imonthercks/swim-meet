/**
 * StoreHeats Lambda — Step Functions task
 *
 * Batch-writes all heat items to DynamoDB and updates the MEET#META record
 * to processingStatus = READY.
 *
 * DynamoDB item layout:
 *   PK  = MEET#<meetId>
 *   SK  = HEAT#E{event_zero_padded_3}#H{heat_zero_padded_3}
 *
 * BatchWriteItem is limited to 25 items per call; the handler chunks
 * accordingly.
 *
 * Input (from Step Functions):
 *   { meetId, s3Bucket, s3Key, heats: Heat[], heatCount: number }
 *
 * Output:
 *   { meetId, itemCount: number, processingStatus: 'READY' }
 *
 * Environment variables:
 *   TABLE_NAME – DynamoDB table name.
 */

import {
  BatchWriteItemCommand,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const BATCH_SIZE = 25;

// Inline type definitions — Lambda handlers are isolated entry points.
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

interface StepInput {
  meetId: string;
  s3Bucket: string;
  s3Key: string;
  heats: Heat[];
  heatCount: number;
}

interface StepOutput {
  meetId: string;
  itemCount: number;
  processingStatus: string;
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

export async function handler(event: StepInput): Promise<StepOutput> {
  const { meetId, heats } = event;
  const now = new Date().toISOString();

  const writeRequests = heats.map(heat => ({
    PutRequest: {
      Item: marshall({
        PK: `MEET#${meetId}`,
        SK: heatSortKey(heat),
        ...heat,
        schools: [...new Set(heat.entries.filter(e => e.school).map(e => e.school!))],
        updatedAt: now,
      }),
    },
  }));

  for (const batch of chunk(writeRequests, BATCH_SIZE)) {
    await ddb.send(
      new BatchWriteItemCommand({
        RequestItems: { [TABLE_NAME]: batch },
      }),
    );
  }

  // Update the META record to READY
  await ddb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ PK: `MEET#${meetId}`, SK: 'META' }),
      UpdateExpression: 'SET processingStatus = :s, heatCount = :c, updatedAt = :t',
      ExpressionAttributeValues: marshall({
        ':s': 'READY',
        ':c': heats.length,
        ':t': now,
      }),
    }),
  );

  console.log(`Stored ${heats.length} heats for meet ${meetId}`);
  return { meetId, itemCount: heats.length, processingStatus: 'READY' };
}
