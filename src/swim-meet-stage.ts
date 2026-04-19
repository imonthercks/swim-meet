import * as cdk from 'aws-cdk-lib';
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
