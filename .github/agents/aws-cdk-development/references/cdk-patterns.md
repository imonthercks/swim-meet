# AWS CDK Patterns and Best Practices

This reference provides detailed patterns, anti-patterns, and best practices for AWS CDK development. It is tailored for the swim-meet TypeScript CDK project but applies broadly.

## Table of Contents

- [Naming Conventions](#naming-conventions)
- [Construct Patterns](#construct-patterns)
- [Security Patterns](#security-patterns)
- [Lambda Integration](#lambda-integration)
- [Workflow Orchestration](#workflow-orchestration)
- [Testing Patterns](#testing-patterns)
- [Cost Optimization](#cost-optimization)
- [Anti-Patterns](#anti-patterns)

## Naming Conventions

### Automatic Resource Naming (Recommended)

Let CDK and CloudFormation generate unique resource names automatically:

**Benefits**:
- Enables multiple deployments in the same region/account
- Supports parallel environments (dev, staging, prod)
- Prevents naming conflicts
- Allows stack cloning and testing

**Example**:
```typescript
// ✅ GOOD — automatic naming
const bucket = new s3.Bucket(this, 'DataBucket', {
  // No bucketName specified
  encryption: s3.BucketEncryption.S3_MANAGED,
});
```

### When Explicit Naming is Required

Some scenarios require explicit names:
- Resources referenced by external systems
- Resources that must maintain consistent names across deployments
- Cross-stack references requiring stable names

**Pattern**: Use logical prefixes and environment suffixes
```typescript
// Only when absolutely necessary
const bucket = new s3.Bucket(this, 'DataBucket', {
  bucketName: `${props.projectName}-data-${props.environment}`,
});
```

## Construct Patterns

### L3 Constructs (Patterns)

Prefer high-level patterns that encapsulate best practices:

```typescript
import * as patterns from 'aws-cdk-lib/aws-apigateway';

new patterns.LambdaRestApi(this, 'MyApi', {
  handler: myFunction,
  // Includes CloudWatch Logs, IAM roles, and API Gateway configuration
});
```

### Custom Constructs

Create reusable constructs for repeated patterns:

```typescript
export class ApiWithDatabase extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ApiWithDatabaseProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const handler = new NodejsFunction(this, 'Handler', {
      entry: props.handlerEntry,
      environment: {
        TABLE_NAME: this.table.tableName,
      },
    });

    this.table.grantReadWriteData(handler);

    this.api = new apigateway.LambdaRestApi(this, 'Api', {
      handler,
    });
  }
}
```

## Security Patterns

### IAM Least Privilege

Use grant methods instead of broad policies:

```typescript
// ✅ GOOD — specific grants
const table = new dynamodb.Table(this, 'Table', { /* ... */ });
const fn = new lambda.Function(this, 'Function', { /* ... */ });

table.grantReadWriteData(fn);

// ❌ BAD — overly broad permissions
fn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['dynamodb:*'],
  resources: ['*'],
}));
```

### Secrets Management

Use SSM SecureString or Secrets Manager — never plaintext in templates:

```typescript
// SSM SecureString dynamic reference (resolved by CloudFormation at deploy time)
const secret = cdk.SecretValue.ssmSecure('/swim-meet/dev/my-secret');

// Secrets Manager
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const secret = new secretsmanager.Secret(this, 'DbPassword', {
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'admin' }),
    generateStringKey: 'password',
    excludePunctuation: true,
  },
});
secret.grantRead(myFunction);
```

### VPC Configuration

```typescript
const vpc = new ec2.Vpc(this, 'Vpc', {
  maxAzs: 2,
  natGateways: 1, // use 1 for dev, 2+ for prod
  subnetConfiguration: [
    { name: 'Public',   subnetType: ec2.SubnetType.PUBLIC,             cidrMask: 24 },
    { name: 'Private',  subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED,    cidrMask: 24 },
  ],
});
```

## Lambda Integration

### NodejsFunction (TypeScript/JavaScript)

```typescript
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

const fn = new NodejsFunction(this, 'Function', {
  entry: 'src/handlers/process.ts',
  handler: 'handler',
  runtime: lambda.Runtime.NODEJS_20_X,
  timeout: Duration.seconds(30),
  memorySize: 512,
  environment: {
    TABLE_NAME: table.tableName,
  },
  bundling: {
    minify: true,
    sourceMap: true,
    externalModules: ['@aws-sdk/*'], // Use AWS SDK from Lambda runtime
  },
});
```

### Lambda Layers

Share code across functions:

```typescript
const layer = new lambda.LayerVersion(this, 'CommonLayer', {
  code: lambda.Code.fromAsset('layers/common'),
  compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
  description: 'Common utilities',
});

new NodejsFunction(this, 'Function', {
  entry: 'src/handler.ts',
  layers: [layer],
});
```

## Workflow Orchestration

### ✅ Lambda Durable Functions (Preferred)

**Default choice** for long-running, stateful, checkpointed workflows. AWS Lambda Durable Functions use `@aws/durable-execution-sdk-js` to keep all orchestration logic inside a single Lambda function — no Step Functions state machine needed.

The Lambda Durable Execution service persists each completed `context.step()` result. On re-invocation (e.g. after a timeout), completed steps are replayed instantly from cache — the function resumes from the last checkpoint without re-running earlier work.

#### CDK Construct

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

const orchestratorFn = new NodejsFunction(this, 'OrchestratorFn', {
  entry: 'src/lambda/orchestrator.ts',
  handler: 'handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  timeout: cdk.Duration.minutes(15),   // Lambda per-invocation limit
  memorySize: 1024,
  bundling: {
    externalModules: ['@aws-sdk/*'],   // @aws/durable-execution-sdk-js IS bundled (not @aws-sdk/*)
  },
  durableConfig: {
    executionTimeout: cdk.Duration.hours(1),  // total workflow wall-clock budget
    retentionPeriod: cdk.Duration.days(14),   // execution history retention
  },
  environment: {
    TABLE_NAME: table.tableName,
  },
});
```

#### IAM for Self-Referential Durable Execution Permissions

> ⚠️ **Important**: Adding an IAM policy to a function that references `orchestratorFn.functionArn` creates a **circular CloudFormation dependency** (policy depends on function; function depends on policy). Use CDK pseudo-parameters and a name prefix wildcard instead.

```typescript
// ❌ BAD — creates circular CloudFormation dependency
orchestratorFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['lambda:CheckpointDurableExecution', 'lambda:InvokeFunction'],
  resources: [orchestratorFn.functionArn],  // Ref to self = circular!
}));

// ✅ GOOD — use pseudo-parameters + name prefix wildcard
const region = cdk.Stack.of(this).region;
orchestratorFn.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'lambda:GetDurableExecution',
    'lambda:GetDurableExecutionState',
    'lambda:CheckpointDurableExecution',
    'lambda:InvokeFunction',
  ],
  resources: [
    `arn:${cdk.Aws.PARTITION}:lambda:${region}:${cdk.Stack.of(this).account}:function:my-orchestrator-prefix-*`,
  ],
}));
```

#### projenrc.ts Dependencies

```typescript
// .projenrc.ts
deps: [
  '@aws/durable-execution-sdk-js',   // Bundled into Lambda ZIP (not in @aws-sdk/* namespace)
  '@aws-sdk/client-lambda',           // Peer dep of SDK — used for checkpoint/state APIs
],
devDeps: [
  '@types/aws-lambda',                // Peer type dep — required for TypeScript compilation
],
```

#### Handler Pattern

```typescript
// src/lambda/orchestrator.ts
import {
  withDurableExecution,
  DurableContext,
  DurableExecutionHandler,
} from '@aws/durable-execution-sdk-js';

interface WorkflowInput { id: string; bucket: string; key: string; }

const durableHandler: DurableExecutionHandler<WorkflowInput, void> = async (
  event: WorkflowInput,
  context: DurableContext,
) => {
  context.logger.info('Workflow started', { id: event.id });

  try {
    // Step 1 — result cached after first run; skipped on replay
    await context.step('step-1-initialize', async () => {
      await initializeRecord(event.id);
    });

    // Step 2 — with per-step retry on throttling
    const extracted = await context.step(
      'step-2-extract',
      async () => extractData(event.bucket, event.key),
      {
        retryStrategy: (error, attempt) => ({
          shouldRetry: attempt < 3 && /throttl/i.test(String(error)),
          delay: { seconds: 30 * Math.pow(2, attempt - 1) },
        }),
      },
    );

    // Step 3 — validate
    const validated = await context.step('step-3-validate', async () =>
      validate(extracted),
    );

    // Step 4 — store
    await context.step('step-4-store', async () => store(event.id, validated));

  } catch (err) {
    // Error handling — mark record as FAILED
    await updateStatus(event.id, 'FAILED', err instanceof Error ? err.message : String(err));
    throw err; // Re-throw so the durable framework records the failed execution
  }
};

export const handler = withDurableExecution(durableHandler);
```

#### Triggering the Orchestrator Asynchronously

Use async invocation (`InvocationType: 'Event'`) from a trigger Lambda (e.g. SQS-triggered initiator):

```typescript
// src/lambda/initiator.ts
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});
const ORCHESTRATOR_ARN = process.env.ORCHESTRATOR_ARN!;

await lambdaClient.send(new InvokeCommand({
  FunctionName: ORCHESTRATOR_ARN,
  InvocationType: 'Event',  // async — fire and forget
  Payload: Buffer.from(JSON.stringify({ id, bucket, key })),
}));
```

Grant invoke permission in CDK:
```typescript
orchestratorFn.grantInvoke(initiatorFn);
```

### Step Functions — When To Use It Instead

Use Step Functions only for these scenarios:
- **Visual workflow editor** required (compliance, review, auditing with graphical state machine)
- **Very long inter-step waits** (days/weeks) that exceed both Lambda's 15-min invocation limit AND durable execution timeout
- **Native SDK integrations** with other AWS services (e.g. `tasks.EcsRunTask`, `tasks.GlueStartJobRun`, `tasks.BedrockInvokeModel`)
- **Human-in-the-loop approval** via API Gateway callback tokens

### Anti-Pattern: Using Step Functions for Orchestration That Fits in Durable Lambda

```typescript
// ❌ BAD — Step Functions overkill for sequential Lambda → Lambda orchestration
const sfnChain = initStep.next(extractStep).next(validateStep).next(storeStep);
const stateMachine = new sfn.StateMachine(this, 'SM', {
  definitionBody: sfn.DefinitionBody.fromChainable(sfnChain),
  stateMachineType: sfn.StateMachineType.STANDARD,
});

// ✅ GOOD — single Lambda Durable Function with context.step() calls
const orchestratorFn = new NodejsFunction(this, 'OrchestratorFn', {
  entry: 'src/lambda/orchestrator.ts',
  durableConfig: {
    executionTimeout: cdk.Duration.hours(1),
    retentionPeriod: cdk.Duration.days(14),
  },
});
```

## Testing Patterns

### Snapshot Testing

```typescript
import { Template } from 'aws-cdk-lib/assertions';

test('Stack creates expected resources', () => {
  const app = new cdk.App();
  const stack = new MyStack(app, 'TestStack');

  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});
```

### Fine-Grained Assertions

```typescript
test('Lambda has correct environment', () => {
  const app = new cdk.App();
  const stack = new MyStack(app, 'TestStack');

  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs20.x',
    Timeout: 30,
    Environment: {
      Variables: {
        TABLE_NAME: { Ref: Match.anyValue() },
      },
    },
  });
});
```

### Resource Count Validation

```typescript
test('Stack has correct number of functions', () => {
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Lambda::Function', 3);
});
```

## Cost Optimization

### Right-Sizing Lambda

```typescript
// Development
const devFunction = new NodejsFunction(this, 'DevFunction', {
  memorySize: 256,
  timeout: Duration.seconds(30),
});

// Production
const prodFunction = new NodejsFunction(this, 'ProdFunction', {
  memorySize: 1024,
  timeout: Duration.seconds(10),
  reservedConcurrentExecutions: 10, // Prevent runaway costs
});
```

### DynamoDB Billing Modes

```typescript
// Development / Low Traffic
const devTable = new dynamodb.Table(this, 'DevTable', {
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

// Production / Predictable Load
const prodTable = new dynamodb.Table(this, 'ProdTable', {
  billingMode: dynamodb.BillingMode.PROVISIONED,
  readCapacity: 5,
  writeCapacity: 5,
});
```

## Anti-Patterns

### ❌ Hardcoded Resource Names

```typescript
// BAD — prevents multiple deployments
new lambda.Function(this, 'Function', {
  functionName: 'my-function',
  // ...
});

// GOOD — let CDK generate the name
new NodejsFunction(this, 'Function', {
  entry: 'src/handler.ts',
});
```

### ❌ Overly Broad IAM Permissions

```typescript
// BAD
fn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['*'],
  resources: ['*'],
}));

// GOOD
table.grantReadWriteData(fn);
```

### ❌ Plaintext Secrets in Templates

```typescript
// BAD
new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
  clientSecret: 'my-secret-value', // Appears in CloudFormation template!
});

// GOOD — use SSM SecureString dynamic reference
const secret = cdk.SecretValue.ssmSecure('/swim-meet/dev/google-client-secret');
```

### ❌ Using Step Functions When Lambda Durable Functions Are Sufficient

```typescript
// BAD — Step Functions overkill for sequential Lambda-only workflows
const stateMachine = new sfn.StateMachine(this, 'SM', {
  definitionBody: sfn.DefinitionBody.fromChainable(step1.next(step2).next(step3)),
  stateMachineType: sfn.StateMachineType.STANDARD,
});

// GOOD — single Lambda Durable Function handles checkpointing natively
const orchestratorFn = new NodejsFunction(this, 'OrchestratorFn', {
  entry: 'src/lambda/orchestrator.ts',
  durableConfig: {
    executionTimeout: cdk.Duration.hours(1),
    retentionPeriod: cdk.Duration.days(14),
  },
});
// Each context.step() in the handler is automatically checkpointed
```

### ❌ Self-Referential IAM ARN on Lambda (Creates Circular Dependency)

```typescript
// BAD — circular CloudFormation dependency: policy references function, function references role which references policy
myFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['lambda:InvokeFunction'],
  resources: [myFn.functionArn],  // Fn::GetAtt creates the cycle
}));

// GOOD — use pseudo-parameters + function name prefix wildcard
myFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['lambda:InvokeFunction'],
  resources: [`arn:${cdk.Aws.PARTITION}:lambda:${region}:${account}:function:my-fn-prefix-*`],
}));
```

### ❌ Ignoring cdk-nag Violations

All resources must pass `AwsSolutionsChecks`. When a violation cannot be remediated, suppress it with a documented reason:

```typescript
NagSuppressions.addResourceSuppressions(resource, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'Managed policy is required for X because of Y constraint',
  },
]);
```

### ❌ Editing projen-generated Files Directly

Always edit `.projenrc.ts` and run `pnpm exec projen` to update generated files like `package.json` or workflow YAML files.

## Summary

- **Always** let CDK generate resource names unless explicitly required
- **Use** high-level constructs (L2/L3) over low-level (L1)
- **Prefer** grant methods for IAM permissions
- **Store** secrets in SSM SecureString or Secrets Manager — never plaintext
- **Test** stacks with assertions and snapshots (`pnpm test`)
- **Validate** with cdk-nag before deployment (`cdk synth`)
- **Follow** projen workflow — edit `.projenrc.ts`, not generated files
- **Run** the validation script before deploying to production
- **Use Lambda Durable Functions** (`@aws/durable-execution-sdk-js` + `durableConfig`) for long-running checkpointed workflows — prefer over Step Functions
