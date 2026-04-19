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

// Read the Google Client ID from CDK context and fail fast if it is absent.
// Pass via: cdk deploy --context googleClientId=<id>
const googleClientId: string = app.node.tryGetContext('googleClientId');
if (!googleClientId) {
  throw new Error(
    'Missing required CDK context value "googleClientId". ' +
      'Pass it with: cdk deploy --context googleClientId=<your-google-client-id>',
  );
}

// Resolve the Google Client Secret from SSM Parameter Store (SecureString dynamic reference).
// Store the secret before deploying: aws ssm put-parameter --name /swim-meet/dev/google-client-secret
//   --value <secret> --type SecureString
// Using a dynamic reference keeps the secret out of the synthesised CloudFormation template and
// cdk.out artifacts entirely — it is resolved by CloudFormation at deploy time.
const googleClientSecret = cdk.SecretValue.ssmSecure('/swim-meet/dev/google-client-secret');

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
//   googleClientId: (() => {
//     const id = app.node.tryGetContext('googleClientId');
//     if (!id) throw new Error('Missing required CDK context value "googleClientId".');
//     return id;
//   })(),
//   googleClientSecret: cdk.SecretValue.ssmSecure('/swim-meet/prod/google-client-secret'),
//   callbackUrls: ['https://swim-meet.example.com/callback'],
//   logoutUrls: ['https://swim-meet.example.com'],
//   userPoolDomainPrefix: 'swim-meet-prod',
//   apiResourceServerIdentifier: 'https://api.swim-meet.example.com',
//   ssmPrefix: '/swim-meet/prod',
// });

app.synth();

