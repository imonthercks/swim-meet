# AWS CDK Patterns and Best Practices

This reference provides detailed patterns, anti-patterns, and best practices for AWS CDK development. It is tailored for the swim-meet TypeScript CDK project but applies broadly.

## Table of Contents

- [Naming Conventions](#naming-conventions)
- [Construct Patterns](#construct-patterns)
- [Security Patterns](#security-patterns)
- [Lambda Integration](#lambda-integration)
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
