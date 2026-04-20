/**
 * ApiMeetStatus Lambda — GET /meets/{meetId}/status
 *
 * Returns the current processing status of a meet so the SPA can poll
 * after uploading a PDF.
 *
 * Environment variables:
 *   TABLE_NAME – DynamoDB table name.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

interface ApiGwEvent {
  pathParameters?: { meetId?: string };
}

export async function handler(event: ApiGwEvent): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const meetId = event.pathParameters?.meetId;
  if (!meetId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'meetId path parameter is required' }),
    };
  }

  const result = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `MEET#${meetId}` },
        SK: { S: 'META' },
      },
      ProjectionExpression: 'meetId, processingStatus, heatCount, createdAt, updatedAt, errorMessage',
    }),
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Meet ${meetId} not found` }),
    };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(unmarshall(result.Item)),
  };
}
