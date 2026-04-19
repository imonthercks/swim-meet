import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SwimMeetStage } from './swim-meet-stage';

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

