import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiStack } from './api-stack';
import { CognitoStack } from './cognito-stack';
import { ProcessingStack } from './processing-stack';
import { StorageStack } from './storage-stack';

/**
 * Props for the SwimMeetStage.
 */
export interface SwimMeetStageProps extends cdk.StageProps {
  /**
   * Google OAuth 2.0 Client ID (from CDK context or environment-specific config).
   */
  readonly googleClientId: string;

  /**
   * Google OAuth 2.0 Client Secret as a CDK SecretValue.
   */
  readonly googleClientSecret: cdk.SecretValue;

  /**
   * Allowed OAuth callback URLs for the SPA.
   */
  readonly callbackUrls: string[];

  /**
   * Allowed logout redirect URLs for the SPA.
   */
  readonly logoutUrls: string[];

  /**
   * Prefix for the Cognito-hosted domain (must be globally unique).
   */
  readonly userPoolDomainPrefix: string;

  /**
   * Identifier URI for the API resource server.
   */
  readonly apiResourceServerIdentifier: string;

  /**
   * SSM Parameter path prefix, e.g. "/swim-meet/dev".
   */
  readonly ssmPrefix: string;

  /**
   * Bedrock foundation model ID used for PDF extraction.
   * Defaults to "amazon.nova-lite-v1:0" for cost-efficient dev/testing.
   * Upgrade to "amazon.nova-pro-v1:0" or "anthropic.claude-3-5-haiku-20241022-v1:0"
   * for validation, and "anthropic.claude-sonnet-4-5-v1:0" for production.
   */
  readonly bedrockModelId?: string;
}

/**
 * A CDK Stage that groups all Swim Meet stacks.
 * Adding stacks here (rather than directly to the App) allows pipelines to
 * promote the same artifact from dev → staging → prod.
 *
 * Stack dependency order (each stack depends on the ones above it):
 *   CognitoStack    — Cognito User Pool + Google federation
 *   StorageStack    — S3 buckets + DynamoDB single-table
 *   ProcessingStack — Bedrock Agent (Code Interpreter) + Lambda Durable orchestrator + SQS
 *   ApiStack        — HTTP API Gateway + Cognito JWT routes
 */
export class SwimMeetStage extends cdk.Stage {
  public readonly cognitoStack: CognitoStack;
  public readonly storageStack: StorageStack;
  public readonly processingStack: ProcessingStack;
  public readonly apiStack: ApiStack;

  constructor(scope: Construct, id: string, props: SwimMeetStageProps) {
    super(scope, id, props);

    const bedrockModelId = props.bedrockModelId ?? 'amazon.nova-lite-v1:0';

    // ── Cognito ──────────────────────────────────────────────────────────────
    this.cognitoStack = new CognitoStack(this, 'CognitoStack', {
      env: props.env,
      googleClientId: props.googleClientId,
      googleClientSecret: props.googleClientSecret,
      callbackUrls: props.callbackUrls,
      logoutUrls: props.logoutUrls,
      userPoolDomainPrefix: props.userPoolDomainPrefix,
      apiResourceServerIdentifier: props.apiResourceServerIdentifier,
      ssmPrefix: props.ssmPrefix,
    });

    // ── Storage (S3 + DynamoDB) ───────────────────────────────────────────────
    this.storageStack = new StorageStack(this, 'StorageStack', {
      env: props.env,
      ssmPrefix: props.ssmPrefix,
    });

    // ── Processing (Bedrock Agent + Lambda Durable Functions + SQS) ─────────
    this.processingStack = new ProcessingStack(this, 'ProcessingStack', {
      env: props.env,
      rawPdfBucket: this.storageStack.rawPdfBucket,
      processedBucket: this.storageStack.processedBucket,
      tableArn: this.storageStack.table.tableArn,
      tableName: this.storageStack.table.tableName,
      bedrockModelId,
      ssmPrefix: props.ssmPrefix,
    });
    this.processingStack.addDependency(this.storageStack);

    // ── API (HTTP API Gateway) ────────────────────────────────────────────────
    this.apiStack = new ApiStack(this, 'ApiStack', {
      env: props.env,
      userPool: this.cognitoStack.userPool,
      userPoolClientId: this.cognitoStack.userPoolClient.userPoolClientId,
      cognitoDomainUrl: this.cognitoStack.userPoolDomain.baseUrl(),
      apiResourceServerIdentifier: props.apiResourceServerIdentifier,
      tableArn: this.storageStack.table.tableArn,
      tableName: this.storageStack.table.tableName,
      rawPdfBucket: this.storageStack.rawPdfBucket,
      ssmPrefix: props.ssmPrefix,
    });
    this.apiStack.addDependency(this.cognitoStack);
    this.apiStack.addDependency(this.storageStack);
  }
}
