/**
 * ApiListMeets Lambda — GET /meets
 *
 * Scans the DynamoDB table for all MEET#META records and returns a summary
 * list for the SPA's meet-picker UI.
 *
 * Environment variables:
 *   TABLE_NAME – DynamoDB table name.
 */

import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function handler(): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'SK = :meta',
      ExpressionAttributeValues: { ':meta': { S: 'META' } },
      ProjectionExpression: 'meetId, #nm, #dt, #loc, processingStatus, heatCount, createdAt',
      ExpressionAttributeNames: { '#nm': 'name', '#dt': 'date', '#loc': 'location' },
    }),
  );

  const meets = (result.Items ?? []).map(item => unmarshall(item));
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ meets }),
  };
}
