import { awscdk, github, javascript } from 'projen';
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.189.1',
  defaultReleaseBranch: 'main',
  name: 'swim-meet',
  packageManager: javascript.NodePackageManager.PNPM,
  projenrcTs: true,

  deps: ['cdk-nag'],
  description: 'Swim Meet CDK infrastructure including Cognito User Pool with Google federation',
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
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