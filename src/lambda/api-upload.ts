/**
 * ApiUpload Lambda — POST /meets/upload
 *
 * Validates the Cognito JWT claims (write scope) and returns a presigned
 * S3 PUT URL scoped to the authenticated user's sub claim.
 *
 * The object key is: pdfs/<userSub>/<meetId>.pdf
 * The meetId is generated server-side (UUID v4) and returned alongside the
 * presigned URL so the SPA can later poll /meets/{meetId}/status.
 *
 * URL expiry: 15 minutes (900 seconds).
 *
 * Environment variables:
 *   RAW_PDF_BUCKET_NAME – name of the raw-PDF S3 bucket.
 */

import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const RAW_PDF_BUCKET_NAME = process.env.RAW_PDF_BUCKET_NAME!;
const URL_EXPIRY_SECONDS = 900; // 15 minutes

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

interface JwtClaims {
  'sub': string;
  'scope'?: string;
  'cognito:groups'?: string[];
}

interface ApiGwEvent {
  requestContext?: {
    authorizer?: {
      jwt?: { claims?: JwtClaims };
    };
  };
  body?: string | null;
}

interface UploadBody {
  meetName?: string;
  meetDate?: string;
  meetLocation?: string;
}

export async function handler(event: ApiGwEvent): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  // The Cognito JWT authorizer should have validated the token already,
  // but fail closed here as defense-in-depth before issuing any upload URL.
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const requiredWriteScope = 'meets/write';
  const scopes = new Set((claims?.scope ?? '').split(' ').filter(Boolean));

  if (!claims?.sub?.trim()) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: 'Unauthorized' }),
    };
  }

  if (!scopes.has(requiredWriteScope)) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: 'Forbidden' }),
    };
  }

  const userSub = claims.sub;
  let body: UploadBody = {};
  try {
    if (event.body) body = JSON.parse(event.body) as UploadBody;
  } catch {
    // ignore — body fields are optional metadata
  }

  const meetId = randomUUID();
  const s3Key = `pdfs/${userSub}/${meetId}.pdf`;

  const command = new PutObjectCommand({
    Bucket: RAW_PDF_BUCKET_NAME,
    Key: s3Key,
    ContentType: 'application/pdf',
    // Embed optional meet metadata as S3 object tags so it's available
    // to the ProcessingInitiator without re-parsing the body.
    Tagging: new URLSearchParams({
      meetName: body.meetName ?? '',
      meetDate: body.meetDate ?? '',
      meetLocation: body.meetLocation ?? '',
      uploadedBy: userSub,
    }).toString(),
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: URL_EXPIRY_SECONDS });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      meetId,
      uploadUrl,
      expiresInSeconds: URL_EXPIRY_SECONDS,
      s3Key,
    }),
  };
}
