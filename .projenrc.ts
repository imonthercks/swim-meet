import { awscdk, javascript } from 'projen';
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
project.synth();