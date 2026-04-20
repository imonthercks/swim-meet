/**
 * ApiGetHeats Lambda — GET /meets/{meetId}/heats
 *
 * Queries the DynamoDB table for all HEAT# items for a given meetId.
 * Returns the heat array that the SPA consumes directly for its heat tracker.
 *
 * Environment variables:
 *   TABLE_NAME – DynamoDB table name.
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
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
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `MEET#${meetId}` },
        ':prefix': { S: 'HEAT#' },
      },
    }),
  );

  const heats = (result.Items ?? []).map(item => {
    const raw = unmarshall(item);
    // Strip internal table keys before returning to the SPA
    const { PK, SK, updatedAt, ...heatData } = raw;
    void PK; void SK; void updatedAt;
    return heatData;
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ meetId, heats }),
  };
}
