import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface CognitoStackProps extends cdk.StackProps {
  /**
   * Google OAuth 2.0 Client ID. Store the value in CDK context or pass it in
   * as a plain string (never hard-code secrets directly).
   */
  readonly googleClientId: string;

  /**
   * Google OAuth 2.0 Client Secret.
   * Use SecretValue or CDK context; never hard-code.
   */
  readonly googleClientSecret: cdk.SecretValue;

  /**
   * Allowed OAuth callback URLs for the Cognito User Pool client.
   * Typically the SPA origin plus any localhost URLs used during development.
   */
  readonly callbackUrls: string[];

  /**
   * Allowed logout (sign-out) redirect URLs for the User Pool client.
   */
  readonly logoutUrls: string[];

  /**
   * The prefix used for the Cognito-hosted domain, e.g. "swim-meet-dev".
   * Must be globally unique within the AWS region.
   */
  readonly userPoolDomainPrefix: string;

  /**
   * Identifier URI for the API resource server.
   * Conventionally a URL, e.g. "https://api.swim-meet.example.com".
   */
  readonly apiResourceServerIdentifier: string;

  /**
   * SSM Parameter path prefix, e.g. "/swim-meet/dev".
   * All exported parameters are placed under this prefix.
   */
  readonly ssmPrefix: string;
}

/**
 * Creates a Cognito User Pool federated with Google sign-in, a resource server
 * with OAuth 2.0 scopes suitable for a REST API gateway, and exports key
 * identifiers to SSM Parameter Store so other stacks (SPA, API Gateway, etc.)
 * can consume them without hard-coding values.
 */
export class CognitoStack extends cdk.Stack {
  /** The Cognito User Pool. */
  public readonly userPool: cognito.UserPool;

  /** The public SPA User Pool client. */
  public readonly userPoolClient: cognito.UserPoolClient;

  /** The Cognito-managed hosted domain (full domain URL). */
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);

    // ── User Pool ──────────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Enable advanced security mode via escape hatch (AdvancedSecurityMode enum is deprecated in CDK v2).
    const cfnUserPool = this.userPool.node.defaultChild as cdk.CfnResource;
    cfnUserPool.addPropertyOverride('UserPoolAddOns', { AdvancedSecurityMode: 'ENFORCED' });

    // ── Google Identity Provider ────────────────────────────────────────────
    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleProvider', {
      userPool: this.userPool,
      clientId: props.googleClientId,
      clientSecretValue: props.googleClientSecret,
      scopes: ['email', 'profile', 'openid'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    // ── Hosted Domain ───────────────────────────────────────────────────────
    this.userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: props.userPoolDomainPrefix,
      },
    });

    // ── API Resource Server with OAuth 2.0 Scopes ───────────────────────────
    const apiScope = {
      read: new cognito.ResourceServerScope({
        scopeName: 'read',
        scopeDescription: 'Read-only access to the Swim Meet API',
      }),
      write: new cognito.ResourceServerScope({
        scopeName: 'write',
        scopeDescription: 'Write access to the Swim Meet API',
      }),
    };

    const apiResourceServer = this.userPool.addResourceServer('ApiResourceServer', {
      identifier: props.apiResourceServerIdentifier,
      scopes: [apiScope.read, apiScope.write],
    });

    // ── User Pool Client (SPA) ──────────────────────────────────────────────
    this.userPoolClient = this.userPool.addClient('SpaClient', {
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.resourceServer(apiResourceServer, apiScope.read),
          cognito.OAuthScope.resourceServer(apiResourceServer, apiScope.write),
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      generateSecret: false,
      preventUserExistenceErrors: true,
      refreshTokenValidity: cdk.Duration.days(7),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
    });

    // The client must be created after the identity provider is ready.
    this.userPoolClient.node.addDependency(googleProvider);

    // ── SSM Parameters (consumed by SPA, API Gateway, etc.) ────────────────
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `${props.ssmPrefix}/cognito/user-pool-id`,
      description: 'Cognito User Pool ID',
      stringValue: this.userPool.userPoolId,
    });

    new ssm.StringParameter(this, 'UserPoolClientIdParam', {
      parameterName: `${props.ssmPrefix}/cognito/user-pool-client-id`,
      description: 'Cognito User Pool Client ID (SPA)',
      stringValue: this.userPoolClient.userPoolClientId,
    });

    new ssm.StringParameter(this, 'UserPoolDomainParam', {
      parameterName: `${props.ssmPrefix}/cognito/user-pool-domain`,
      description: 'Cognito hosted-UI base URL',
      stringValue: this.userPoolDomain.baseUrl(),
    });

    new ssm.StringParameter(this, 'ApiResourceServerParam', {
      parameterName: `${props.ssmPrefix}/cognito/api-resource-server-identifier`,
      description: 'API resource server identifier URI',
      stringValue: props.apiResourceServerIdentifier,
    });

    // ── CDK Nag suppressions ────────────────────────────────────────────────
    // MFA with SMS is intentionally disabled; OTP (TOTP) is used instead.
    NagSuppressions.addResourceSuppressions(this.userPool, [
      {
        id: 'AwsSolutions-COG2',
        reason: 'SMS MFA is disabled intentionally; TOTP MFA is configured as optional.',
      },
    ]);
  }
}
