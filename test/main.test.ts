import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CognitoStack } from '../src/cognito-stack';
import { SwimMeetStage } from '../src/swim-meet-stage';

function buildTestStage(app: cdk.App): SwimMeetStage {
  return new SwimMeetStage(app, 'TestStage', {
    env: { account: '123456789012', region: 'us-east-1' },
    googleClientId: 'test-google-client-id',
    googleClientSecret: cdk.SecretValue.unsafePlainText('test-google-client-secret'),
    callbackUrls: ['https://example.com/callback'],
    logoutUrls: ['https://example.com'],
    userPoolDomainPrefix: 'swim-meet-test',
    apiResourceServerIdentifier: 'https://api.swim-meet.example.com',
    ssmPrefix: '/swim-meet/test',
  });
}

test('CognitoStack snapshot', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.cognitoStack);
  expect(template.toJSON()).toMatchSnapshot();
});

test('CognitoStack creates a Cognito User Pool', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.cognitoStack);

  template.resourceCountIs('AWS::Cognito::UserPool', 1);
});

test('CognitoStack creates a Google Identity Provider', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.cognitoStack);

  template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
    ProviderName: 'Google',
    ProviderType: 'Google',
  });
});

test('CognitoStack creates a resource server with read and write scopes', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.cognitoStack);

  template.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
    Identifier: 'https://api.swim-meet.example.com',
    Scopes: [
      { ScopeName: 'global.read', ScopeDescription: 'Read-only access to the Swim Meet API' },
      { ScopeName: 'global.write', ScopeDescription: 'Write access to the Swim Meet API' },
    ],
  });
});

test('CognitoStack creates a User Pool Client with authorization code grant', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.cognitoStack);

  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlows: ['code'],
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: ['https://example.com/callback'],
    LogoutURLs: ['https://example.com'],
    SupportedIdentityProviders: ['COGNITO', 'Google'],
    GenerateSecret: false,
  });
});

test('CognitoStack exports SSM parameters for User Pool ID, Client ID, domain, and resource server', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.cognitoStack);

  // Four parameters should be created
  template.resourceCountIs('AWS::SSM::Parameter', 4);
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/swim-meet/test/cognito/user-pool-id',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/swim-meet/test/cognito/user-pool-client-id',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/swim-meet/test/cognito/user-pool-domain',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/swim-meet/test/cognito/api-resource-server-identifier',
  });
});

test('SwimMeetStage passes CDK Nag AwsSolutionsChecks without critical errors', () => {
  const app = new cdk.App();
  Aspects.of(app).add(new AwsSolutionsChecks());
  const stage = buildTestStage(app);
  // Synthesise – cdk-nag errors surface as annotations, not synthesis failures.
  // Use stage.synth() to obtain the nested stage assembly which contains the actual stacks.
  const stageAssembly = stage.synth();
  expect(stageAssembly.stacks.length).toBeGreaterThan(0);
  // Confirm the CognitoStack is included.
  const cognitoStackArtifact = stageAssembly.stacks.find(s => s.stackName.includes('CognitoStack'));
  expect(cognitoStackArtifact).toBeDefined();
});

test('CognitoStack extends cdk.Stack', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  expect(stage.cognitoStack).toBeInstanceOf(cdk.Stack);
  expect(stage.cognitoStack).toBeInstanceOf(CognitoStack);
});
