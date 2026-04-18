import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { CognitoStack } from './cognito-stack';

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
}

/**
 * A CDK Stage that groups all Swim Meet stacks.
 * Adding stacks here (rather than directly to the App) allows pipelines to
 * promote the same artifact from dev → staging → prod.
 */
export class SwimMeetStage extends cdk.Stage {
  public readonly cognitoStack: CognitoStack;

  constructor(scope: Construct, id: string, props: SwimMeetStageProps) {
    super(scope, id, props);

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
  }
}

// ── App entry-point ──────────────────────────────────────────────────────────

const app = new cdk.App();

// Apply AWS Solutions CDK Nag checks to the entire app.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Read Google credentials from CDK context so they are never hard-coded.
// Pass them via: cdk deploy --context googleClientId=... --context googleClientSecret=...
const googleClientId: string = app.node.tryGetContext('googleClientId') ?? 'GOOGLE_CLIENT_ID_PLACEHOLDER';
const googleClientSecret: cdk.SecretValue = cdk.SecretValue.unsafePlainText(
  app.node.tryGetContext('googleClientSecret') ?? 'GOOGLE_CLIENT_SECRET_PLACEHOLDER',
);

new SwimMeetStage(app, 'swim-meet-dev', {
  env: devEnv,
  googleClientId,
  googleClientSecret,
  callbackUrls: ['http://localhost:3000/callback', 'https://dev.swim-meet.example.com/callback'],
  logoutUrls: ['http://localhost:3000', 'https://dev.swim-meet.example.com'],
  userPoolDomainPrefix: 'swim-meet-dev',
  apiResourceServerIdentifier: 'https://api.swim-meet.example.com',
  ssmPrefix: '/swim-meet/dev',
});

// Uncomment and configure for production:
// new SwimMeetStage(app, 'swim-meet-prod', {
//   env: { account: '123456789012', region: 'us-east-1' },
//   googleClientId: app.node.tryGetContext('googleClientId') ?? '',
//   googleClientSecret: cdk.SecretValue.ssmSecure('/swim-meet/prod/google-client-secret'),
//   callbackUrls: ['https://swim-meet.example.com/callback'],
//   logoutUrls: ['https://swim-meet.example.com'],
//   userPoolDomainPrefix: 'swim-meet-prod',
//   apiResourceServerIdentifier: 'https://api.swim-meet.example.com',
//   ssmPrefix: '/swim-meet/prod',
// });

app.synth();
