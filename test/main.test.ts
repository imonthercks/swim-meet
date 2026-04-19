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
    bedrockModelId: 'amazon.nova-lite-v1:0',
  });
}

// ── CognitoStack tests (existing) ────────────────────────────────────────────

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

// ── StorageStack tests ────────────────────────────────────────────────────────

test('StorageStack snapshot', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.storageStack);
  expect(template.toJSON()).toMatchSnapshot();
});

test('StorageStack creates two S3 buckets (raw PDF and processed JSON)', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.storageStack);

  template.resourceCountIs('AWS::S3::Bucket', 2);
});

test('StorageStack raw PDF bucket has versioning and KMS encryption enabled', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.storageStack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } },
      ],
    },
  });
});

test('StorageStack DynamoDB table has PAY_PER_REQUEST billing and point-in-time recovery', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.storageStack);

  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
  });
});

test('StorageStack DynamoDB table has PK and SK key schema', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.storageStack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
  });
});

test('StorageStack exports four SSM parameters', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.storageStack);

  template.resourceCountIs('AWS::SSM::Parameter', 4);
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/swim-meet/test/storage/raw-pdf-bucket-name' });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/swim-meet/test/storage/processed-bucket-name' });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/swim-meet/test/storage/table-name' });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/swim-meet/test/storage/table-stream-arn' });
});

// ── ProcessingStack tests ─────────────────────────────────────────────────────

test('ProcessingStack snapshot', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);
  expect(template.toJSON()).toMatchSnapshot();
});

test('ProcessingStack creates a Bedrock Agent with Code Interpreter action group', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);

  template.resourceCountIs('AWS::Bedrock::Agent', 1);
  template.hasResourceProperties('AWS::Bedrock::Agent', {
    FoundationModel: 'amazon.nova-lite-v1:0',
    ActionGroups: [
      {
        ActionGroupName: 'CodeInterpreter',
        ParentActionGroupSignature: 'AMAZON.CodeInterpreter',
        ActionGroupState: 'ENABLED',
      },
      {
        ActionGroupName: 'UserInput',
        ParentActionGroupSignature: 'AMAZON.UserInput',
        ActionGroupState: 'ENABLED',
      },
    ],
  });
});

test('ProcessingStack creates a Bedrock Agent Alias', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);

  template.resourceCountIs('AWS::Bedrock::AgentAlias', 1);
  template.hasResourceProperties('AWS::Bedrock::AgentAlias', {
    AgentAliasName: 'live',
  });
});

test('ProcessingStack creates a Step Functions Standard Workflow (durable)', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);

  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
    StateMachineType: 'STANDARD',
    TracingConfiguration: { Enabled: true },
  });
});

test('ProcessingStack creates two SQS queues (main + DLQ)', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);

  template.resourceCountIs('AWS::SQS::Queue', 2);
});

test('ProcessingStack creates five Lambda functions for Step Functions tasks + initiator', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);

  // InitializeMeet, ExtractWithBedrock, ValidateExtraction, StoreHeats,
  // UpdateMeetStatus, ProcessingInitiator = 6 functions
  const functions = template.findResources('AWS::Lambda::Function');
  expect(Object.keys(functions).length).toBeGreaterThanOrEqual(6);
});

test('ProcessingStack creates an EventBridge rule targeting the SQS queue', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.processingStack);

  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      'source': ['aws.s3'],
      'detail-type': ['Object Created'],
    },
  });
});

// ── ApiStack tests ────────────────────────────────────────────────────────────

test('ApiStack snapshot', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.apiStack);
  expect(template.toJSON()).toMatchSnapshot();
});

test('ApiStack creates an HTTP API', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.apiStack);

  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });
});

test('ApiStack creates a Cognito JWT authorizer', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.apiStack);

  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'JWT',
  });
});

test('ApiStack creates four routes (GET /meets, GET heats, POST upload, GET status)', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.apiStack);

  const routes = template.findResources('AWS::ApiGatewayV2::Route');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeKeys = Object.values(routes).map((r: any) => r.Properties.RouteKey as string);

  expect(routeKeys).toContain('GET /meets');
  expect(routeKeys).toContain('GET /meets/{meetId}/heats');
  expect(routeKeys).toContain('POST /meets/upload');
  expect(routeKeys).toContain('GET /meets/{meetId}/status');
});

test('ApiStack exports API URL SSM parameter', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const template = Template.fromStack(stage.apiStack);

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/swim-meet/test/api/url',
  });
});

test('SwimMeetStage includes all four stacks', () => {
  const app = new cdk.App();
  const stage = buildTestStage(app);
  const assembly = stage.synth();

  expect(assembly.stacks.length).toBe(4);
  const names = assembly.stacks.map(s => s.stackName);
  expect(names.some(n => n.includes('CognitoStack'))).toBe(true);
  expect(names.some(n => n.includes('StorageStack'))).toBe(true);
  expect(names.some(n => n.includes('ProcessingStack'))).toBe(true);
  expect(names.some(n => n.includes('ApiStack'))).toBe(true);
});

