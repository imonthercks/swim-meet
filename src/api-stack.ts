import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigw_auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigw_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  /** Cognito User Pool (from CognitoStack) for JWT authorizer. */
  readonly userPool: cognito.UserPool;
  /** Cognito User Pool Client ID (for JWT audience validation). */
  readonly userPoolClientId: string;
  /** Cognito hosted-domain base URL (e.g. https://swim-meet-dev.auth.us-east-1.amazoncognito.com). */
  readonly cognitoDomainUrl: string;
  /**
   * Identifier URI of the Cognito resource server (e.g. "https://api.swim-meet.example.com").
   * Used to build full OAuth scope strings: `<identifier>/global.read` and `<identifier>/global.write`.
   */
  readonly apiResourceServerIdentifier: string;
  /** DynamoDB table ARN. */
  readonly tableArn: string;
  /** DynamoDB table name. */
  readonly tableName: string;
  /** Raw-PDF S3 bucket (to grant Lambda PutObject for presigned URL generation). */
  readonly rawPdfBucket: s3.Bucket;
  /** SSM Parameter path prefix. */
  readonly ssmPrefix: string;
}

/**
 * ApiStack provisions the HTTP API Gateway that serves the SPA:
 *
 *   GET  /meets                    → list all meets (meet-picker UI)
 *   GET  /meets/{meetId}/heats     → full heat array for one meet (primary SPA data call)
 *   POST /meets/upload             → generate presigned S3 PUT URL (write scope required)
 *   GET  /meets/{meetId}/status    → poll processing progress
 *
 * All routes are protected by a Cognito JWT authorizer except the CORS pre-flight OPTIONS.
 */
export class ApiStack extends cdk.Stack {
  /** The HTTP API URL (exported to SSM for the SPA configuration). */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // ── Shared Lambda defaults ────────────────────────────────────────────────
    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        TABLE_NAME: props.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    };

    // ── Lambda: ListMeets ─────────────────────────────────────────────────────
    const listMeetsFn = new nodejs.NodejsFunction(this, 'ListMeetsFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-api-list-meets-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/api-list-meets.ts'),
      handler: 'handler',
      description: 'GET /meets — returns summary list of swim meets',
    });
    listMeetsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [props.tableArn],
      }),
    );

    // ── Lambda: GetHeats ──────────────────────────────────────────────────────
    const getHeatsFn = new nodejs.NodejsFunction(this, 'GetHeatsFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-api-get-heats-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/api-get-heats.ts'),
      handler: 'handler',
      description: 'GET /meets/{meetId}/heats — returns full heat array for the SPA',
    });
    getHeatsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [props.tableArn],
      }),
    );

    // ── Lambda: Upload (presigned URL) ────────────────────────────────────────
    const uploadFn = new nodejs.NodejsFunction(this, 'UploadFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-api-upload-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/api-upload.ts'),
      handler: 'handler',
      description: 'POST /meets/upload — generates presigned S3 PUT URL (write scope required)',
      environment: {
        ...commonLambdaProps.environment,
        RAW_PDF_BUCKET_NAME: props.rawPdfBucket.bucketName,
      },
    });
    props.rawPdfBucket.grantPut(uploadFn);

    // ── Lambda: MeetStatus ────────────────────────────────────────────────────
    const meetStatusFn = new nodejs.NodejsFunction(this, 'MeetStatusFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-api-meet-status-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/api-meet-status.ts'),
      handler: 'handler',
      description: 'GET /meets/{meetId}/status — returns current processing status',
    });
    meetStatusFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [props.tableArn],
      }),
    );

    // ── HTTP API Gateway ──────────────────────────────────────────────────────
    const httpApi = new apigw.HttpApi(this, 'SwimMeetApi', {
      apiName: `swim-meet-api-${cdk.Stack.of(this).stackName}`,
      description: 'Swim Meet SPA backend — heat sheet data and PDF upload',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // ── Cognito JWT Authorizer ────────────────────────────────────────────────
    const authorizer = new apigw_auth.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      // issuer URL must be the Cognito User Pool endpoint
      `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClientId],
        authorizerName: 'CognitoJwtAuthorizer',
        identitySource: ['$request.header.Authorization'],
      },
    );

    // ── Routes ────────────────────────────────────────────────────────────────
    // Full OAuth scope strings: <resourceServerIdentifier>/scopeName
    const readScope = `${props.apiResourceServerIdentifier}/global.read`;
    const writeScope = `${props.apiResourceServerIdentifier}/global.write`;

    httpApi.addRoutes({
      path: '/meets',
      methods: [apigw.HttpMethod.GET],
      integration: new apigw_integrations.HttpLambdaIntegration('ListMeetsIntegration', listMeetsFn),
      authorizer,
      authorizationScopes: [readScope],
    });

    httpApi.addRoutes({
      path: '/meets/{meetId}/heats',
      methods: [apigw.HttpMethod.GET],
      integration: new apigw_integrations.HttpLambdaIntegration('GetHeatsIntegration', getHeatsFn),
      authorizer,
      authorizationScopes: [readScope],
    });

    httpApi.addRoutes({
      path: '/meets/upload',
      methods: [apigw.HttpMethod.POST],
      integration: new apigw_integrations.HttpLambdaIntegration('UploadIntegration', uploadFn),
      authorizer,
      authorizationScopes: [writeScope],
    });

    httpApi.addRoutes({
      path: '/meets/{meetId}/status',
      methods: [apigw.HttpMethod.GET],
      integration: new apigw_integrations.HttpLambdaIntegration('MeetStatusIntegration', meetStatusFn),
      authorizer,
      authorizationScopes: [readScope],
    });

    this.apiUrl = httpApi.apiEndpoint;

    // ── SSM Export ────────────────────────────────────────────────────────────
    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: `${props.ssmPrefix}/api/url`,
      description: 'HTTP API Gateway endpoint URL',
      stringValue: httpApi.apiEndpoint,
    });

    // ── CDK Nag suppressions ─────────────────────────────────────────────────
    [listMeetsFn, getHeatsFn, uploadFn, meetStatusFn].forEach(fn => {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole for CloudWatch logging.' },
          { id: 'AwsSolutions-IAM5', reason: 'DynamoDB and S3 permissions are scoped to the specific table/bucket.' },
        ],
        true,
      );
    });

    NagSuppressions.addResourceSuppressions(
      httpApi,
      [
        {
          id: 'AwsSolutions-APIG4',
          reason: 'All data routes use the Cognito JWT authorizer; OPTIONS pre-flight routes are intentionally unauthenticated.',
        },
        {
          id: 'AwsSolutions-HTTP2',
          reason: 'HTTP API does not support access-log format strings the same way as REST API; CloudWatch metrics are enabled by default.',
        },
      ],
      true,
    );
  }
}
