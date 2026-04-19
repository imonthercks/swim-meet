import { awscdk, github, javascript } from 'projen';
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.189.1',
  defaultReleaseBranch: 'main',
  name: 'swim-meet',
  packageManager: javascript.NodePackageManager.PNPM,
  projenrcTs: true,

  deps: [
    'cdk-nag',
    // AWS SDK v3 packages imported by Lambda handler sources.
    // NodejsFunction (esbuild) marks @aws-sdk/* as external for Node.js 22+ runtimes
    // so these are not bundled into the Lambda ZIP — they are available from the
    // Lambda runtime environment.  Listing them as deps (not devDeps) satisfies the
    // eslint import/no-extraneous-dependencies rule.
    '@aws-sdk/client-bedrock-agent-runtime@^3.0.0',
    '@aws-sdk/client-dynamodb@^3.0.0',
    '@aws-sdk/client-s3@^3.0.0',
    '@aws-sdk/s3-request-presigner@^3.0.0',
    '@aws-sdk/util-dynamodb@^3.0.0',
    // AWS Lambda Durable Execution SDK — provides withDurableExecution wrapper and
    // DurableContext for writing checkpointed, long-running Lambda orchestrators.
    // This package is NOT in the @aws-sdk/* namespace so esbuild bundles it into
    // the Lambda ZIP automatically (it is not available in the runtime environment).
    '@aws/durable-execution-sdk-js@^1.0.0',
    // @aws-sdk/client-lambda is a peer dep of the durable execution SDK (used by
    // the SDK to call CheckpointDurableExecution / GetDurableExecutionState APIs).
    '@aws-sdk/client-lambda@^3.0.0',
  ],
  description: 'Swim Meet CDK infrastructure including Cognito User Pool with Google federation',
  devDeps: [
    // aws-lambda types are a peer dependency of @aws/durable-execution-sdk-js
    '@types/aws-lambda',
  ],
});

// Copilot Setup Steps workflow — pre-installs Node, pnpm, project deps, uv/uvx,
// and pre-caches the AWS CDK MCP server so Copilot cloud-agent sessions start fast.
const copilotSetupWorkflow = new github.GithubWorkflow(project.github!, 'copilot-setup-steps');
copilotSetupWorkflow.on({
  workflowDispatch: {},
  push: { paths: ['.github/workflows/copilot-setup-steps.yml'] },
  pullRequest: { paths: ['.github/workflows/copilot-setup-steps.yml'] },
});
copilotSetupWorkflow.addJob('copilot-setup-steps', {
  name: 'Copilot Setup Steps',
  runsOn: ['ubuntu-latest'],
  permissions: {
    contents: github.workflows.JobPermission.READ,
  },
  steps: [
    { name: 'Checkout code', uses: 'actions/checkout@v4' },
    {
      name: 'Set up Node.js 20',
      uses: 'actions/setup-node@v4',
      with: { 'node-version': '20' },
    },
    {
      name: 'Set up pnpm',
      uses: 'pnpm/action-setup@v5',
      with: { version: '10.33.0' },
    },
    { name: 'Install project dependencies', run: 'pnpm install --frozen-lockfile' },
    {
      name: 'Install uv (provides uvx for running AWS MCP servers)',
      uses: 'astral-sh/setup-uv@v6',
    },
    {
      name: 'Pre-cache AWS CDK MCP server',
      run: 'uvx awslabs.cdk-mcp-server@latest --help',
    },
  ],
});

project.synth();