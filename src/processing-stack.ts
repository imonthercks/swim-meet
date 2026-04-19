import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_event_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { StorageStack } from './storage-stack';

export interface ProcessingStackProps extends cdk.StackProps {
  /** Raw-PDF S3 bucket (from StorageStack). */
  readonly rawPdfBucket: s3.Bucket;
  /** Processed-JSON S3 bucket (from StorageStack). */
  readonly processedBucket: s3.Bucket;
  /** DynamoDB table ARN. */
  readonly tableArn: string;
  /** DynamoDB table name. */
  readonly tableName: string;
  /**
   * Bedrock foundation model ID used for extraction.
   * Defaults to amazon.nova-lite-v1:0 for dev/testing.
   * Switch to amazon.nova-pro-v1:0 or anthropic.claude-3-5-haiku-20241022-v1:0
   * for validation, and anthropic.claude-sonnet-4-5-v1:0 for production.
   */
  readonly bedrockModelId: string;
  /** SSM Parameter path prefix. */
  readonly ssmPrefix: string;
}

/**
 * ProcessingStack wires together the durable PDF-processing pipeline:
 *
 *   S3 PDF upload
 *     → EventBridge "Object Created" rule
 *     → SQS queue (+ DLQ for failed deliveries)
 *     → ProcessingInitiator Lambda
 *     → Step Functions Standard Workflow  ← durable functions
 *         1. InitializeMeet
 *         2. ExtractWithBedrockAgent  ← Bedrock data analysis (Code Interpreter)
 *         3. ValidateExtraction
 *         4. StoreHeats
 *         5. UpdateMeetStatus (READY or FAILED on Catch)
 *
 * The Bedrock Agent is configured with the AMAZON.CodeInterpreter built-in
 * action group, which gives it a sandboxed Python environment to parse PDF
 * bytes and produce structured JSON — this is Bedrock's native data-analysis
 * capability.
 */
export class ProcessingStack extends cdk.Stack {
  /** ARN of the Step Functions state machine (exported to SSM). */
  public readonly stateMachineArn: string;

  /** Bedrock Agent ID (exported to SSM). */
  public readonly agentId: string;

  /** Bedrock Agent Alias ID (exported to SSM). */
  public readonly agentAliasId: string;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;

    // ── Shared Lambda defaults ────────────────────────────────────────────────
    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        // AWS SDK v3 is included in the Node.js 20+ Lambda runtime.
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        TABLE_NAME: props.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    };

    // ── SQS Dead-Letter Queue ─────────────────────────────────────────────────
    const dlq = new sqs.Queue(this, 'ProcessingDlq', {
      queueName: `swim-meet-processing-dlq-${cdk.Stack.of(this).stackName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // ── SQS Main Queue ────────────────────────────────────────────────────────
    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: `swim-meet-processing-${cdk.Stack.of(this).stackName}`,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // ── EventBridge Rule: S3 PDF upload → SQS ────────────────────────────────
    const pdfUploadRule = new events.Rule(this, 'PdfUploadRule', {
      ruleName: `swim-meet-pdf-upload-${cdk.Stack.of(this).stackName}`,
      description: 'Triggers processing pipeline when a PDF is uploaded to the raw-PDF bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.rawPdfBucket.bucketName] },
          object: { key: [{ suffix: '.pdf' }] },
        },
      },
    });
    pdfUploadRule.addTarget(new targets.SqsQueue(queue));

    // ── Bedrock Agent execution role ─────────────────────────────────────────
    // The agent needs permission to invoke the foundation model.
    const agentRole = new iam.Role(this, 'BedrockAgentRole', {
      roleName: `swim-meet-bedrock-agent-${cdk.Stack.of(this).stackName}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${region}:${cdk.Stack.of(this).account}:agent/*` },
        },
      }),
      inlinePolicies: {
        BedrockInvokeModel: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              // Scope to the configured model (cross-region inference profiles use a
              // different ARN pattern; the wildcard covers both).
              resources: [
                `arn:aws:bedrock:${region}::foundation-model/${props.bedrockModelId}`,
                `arn:aws:bedrock:*::foundation-model/${props.bedrockModelId}`,
              ],
            }),
          ],
        }),
      },
    });

    // ── Bedrock Agent — Code Interpreter (data analysis) ─────────────────────
    // The AMAZON.CodeInterpreter built-in action group provides the agent with
    // a sandboxed Python runtime.  The agent writes code at inference time to:
    //   • Parse raw PDF bytes using pdfplumber / pdfminer
    //   • Handle multi-column heat-sheet layouts
    //   • Produce and self-validate the canonical heat JSON schema
    const agent = new bedrock.CfnAgent(this, 'HeatSheetAgent', {
      agentName: `swim-meet-heat-extractor-${cdk.Stack.of(this).stackName}`,
      description: 'Extracts structured heat data from swim meet PDF heat sheets using Code Interpreter',
      foundationModel: props.bedrockModelId,
      agentResourceRoleArn: agentRole.roleArn,
      autoPrepare: true,
      instruction: [
        'You are a swim meet data extraction specialist.',
        'You receive PDF documents containing swim meet heat sheets.',
        'Use the Code Interpreter to read, parse, and extract all structured data from the PDF.',
        '',
        'Your task:',
        '1. Read the attached PDF file using Python (pdfplumber or pdfminer are available).',
        '2. Parse every event, heat, lane, swimmer name, school, seed time, and relay designation.',
        '3. Handle multi-column layouts carefully — ensure columns are not interleaved.',
        '4. Return ONLY a valid JSON array of heat objects. No prose, no markdown fences.',
        '',
        'Each heat object schema:',
        '{',
        '  "id": "E001-H001",',
        '  "event": 1,',
        '  "event_name": "Girls 200 Yard Medley Relay",',
        '  "heat": 1,',
        '  "is_relay": true,',
        '  "entries": [',
        '    { "lane": 1, "school": "Andover", "relay": "A", "seed_time": "2:05.43",',
        '      "swimmers": ["Last, First", "Last, First", "Last, First", "Last, First"] },',
        '    { "lane": 2, "blank": true }',
        '  ]',
        '}',
        '',
        'For individual events each entry has: "name", "age" (string or null), "seed_time".',
        'Seed times prefixed with "X" are exhibition — keep the X prefix.',
        '"NT" means no seed time. Empty lanes: { "lane": N, "blank": true }.',
      ].join('\n'),
      actionGroups: [
        {
          // Built-in Code Interpreter action group — enables Python sandbox
          // for data analysis without any additional Lambda configuration.
          actionGroupName: 'CodeInterpreter',
          parentActionGroupSignature: 'AMAZON.CodeInterpreter',
          actionGroupState: 'ENABLED',
        },
        {
          // Built-in UserInput action group — allows agent to request
          // clarification if the PDF content is ambiguous.
          actionGroupName: 'UserInput',
          parentActionGroupSignature: 'AMAZON.UserInput',
          actionGroupState: 'ENABLED',
        },
      ],
    });

    // ── Bedrock Agent Alias ───────────────────────────────────────────────────
    // The alias points to the auto-prepared agent version so the Lambda always
    // invokes a stable, prepared agent even across model updates.
    const agentAlias = new bedrock.CfnAgentAlias(this, 'HeatSheetAgentAlias', {
      agentId: agent.attrAgentId,
      agentAliasName: 'live',
      description: 'Live alias for the heat sheet extractor agent',
    });
    agentAlias.addDependency(agent);

    this.agentId = agent.attrAgentId;
    this.agentAliasId = agentAlias.attrAgentAliasId;

    // ── Lambda: InitializeMeet ────────────────────────────────────────────────
    const initializeMeetFn = new nodejs.NodejsFunction(this, 'InitializeMeetFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-initialize-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/initialize-meet.ts'),
      handler: 'handler',
      description: 'Step Functions task: creates the MEET#META DynamoDB record',
    });
    initializeMeetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [props.tableArn],
      }),
    );

    // ── Lambda: ExtractWithBedrock ────────────────────────────────────────────
    const extractWithBedrockFn = new nodejs.NodejsFunction(this, 'ExtractWithBedrockFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-extract-bedrock-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/extract-with-bedrock.ts'),
      handler: 'handler',
      description: 'Step Functions task: invokes Bedrock Agent (Code Interpreter) to extract heat data',
      timeout: cdk.Duration.minutes(15), // PDF extraction can take several minutes
      memorySize: 1024,
      environment: {
        ...commonLambdaProps.environment,
        AGENT_ID: agent.attrAgentId,
        AGENT_ALIAS_ID: agentAlias.attrAgentAliasId,
      },
    });
    props.rawPdfBucket.grantRead(extractWithBedrockFn);
    extractWithBedrockFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeAgent',
          'bedrock:InvokeInlineAgent',
        ],
        resources: [
          `arn:aws:bedrock:${region}:${cdk.Stack.of(this).account}:agent/${agent.attrAgentId}`,
          `arn:aws:bedrock:${region}:${cdk.Stack.of(this).account}:agent-alias/${agent.attrAgentId}/${agentAlias.attrAgentAliasId}`,
        ],
      }),
    );

    // ── Lambda: ValidateExtraction ────────────────────────────────────────────
    const validateExtractionFn = new nodejs.NodejsFunction(this, 'ValidateExtractionFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-validate-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/validate-extraction.ts'),
      handler: 'handler',
      description: 'Step Functions task: validates extracted heat JSON schema',
    });

    // ── Lambda: StoreHeats ────────────────────────────────────────────────────
    const storeHeatsFn = new nodejs.NodejsFunction(this, 'StoreHeatsFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-store-heats-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/store-heats.ts'),
      handler: 'handler',
      description: 'Step Functions task: batch-writes heats to DynamoDB',
    });
    storeHeatsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:BatchWriteItem', 'dynamodb:UpdateItem'],
        resources: [props.tableArn],
      }),
    );

    // ── Lambda: UpdateMeetStatus ──────────────────────────────────────────────
    const updateMeetStatusFn = new nodejs.NodejsFunction(this, 'UpdateMeetStatusFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-update-status-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/update-meet-status.ts'),
      handler: 'handler',
      description: 'Step Functions task: updates processingStatus on the META record',
    });
    updateMeetStatusFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
      }),
    );

    // ── Step Functions — Durable Processing Pipeline ──────────────────────────
    //
    // Standard Workflow provides durable, stateful execution:
    //   • State is persisted between steps — Lambda restarts don't lose progress
    //   • Built-in retry with exponential back-off on transient failures
    //   • Execution history retained for 90 days for auditing / debugging
    //   • Error Catch routes failed executions to UpdateMeetStatus(FAILED)
    //
    const sfnLogGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/aws/states/swim-meet-processing-${cdk.Stack.of(this).stackName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Step 1: Initialize meet record
    const initStep = new tasks.LambdaInvoke(this, 'InitializeMeet', {
      lambdaFunction: initializeMeetFn,
      outputPath: '$.Payload',
      comment: 'Create MEET#META record with processingStatus=PROCESSING',
    });

    // Step 2: Extract heats with Bedrock Agent (data analysis / Code Interpreter)
    const extractStep = new tasks.LambdaInvoke(this, 'ExtractWithBedrockAgent', {
      lambdaFunction: extractWithBedrockFn,
      outputPath: '$.Payload',
      comment: 'Invoke Bedrock Agent with Code Interpreter to parse PDF and extract heats',
      // Generous timeout — complex multi-page PDFs may take several minutes
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(20)),
      retryOnServiceExceptions: true,
    });
    // Retry on transient Bedrock throttling
    extractStep.addRetry({
      errors: ['ThrottlingException', 'ServiceUnavailableException'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(30),
    });

    // Step 3: Validate extracted JSON
    const validateStep = new tasks.LambdaInvoke(this, 'ValidateExtraction', {
      lambdaFunction: validateExtractionFn,
      outputPath: '$.Payload',
      comment: 'Validate extracted heats against canonical schema',
    });

    // Step 4: Store heats in DynamoDB
    const storeStep = new tasks.LambdaInvoke(this, 'StoreHeats', {
      lambdaFunction: storeHeatsFn,
      outputPath: '$.Payload',
      comment: 'Batch-write heats to DynamoDB and update META to READY',
    });

    // Step 5a: Update status to READY (terminal success)
    const updateReadyStep = new tasks.LambdaInvoke(this, 'UpdateStatusReady', {
      lambdaFunction: updateMeetStatusFn,
      payload: sfn.TaskInput.fromObject({
        'meetId.$': '$.meetId',
        'targetStatus': 'READY',
      }),
      outputPath: '$.Payload',
      comment: 'Mark meet as READY',
    });

    // Step 5b: Update status to FAILED (error Catch)
    const updateFailedStep = new tasks.LambdaInvoke(this, 'UpdateStatusFailed', {
      lambdaFunction: updateMeetStatusFn,
      payload: sfn.TaskInput.fromObject({
        'meetId.$': '$$.Execution.Input.meetId',
        'targetStatus': 'FAILED',
        'Cause.$': '$.Cause',
        'Error.$': '$.Error',
      }),
      outputPath: '$.Payload',
      comment: 'Mark meet as FAILED and record error details',
    });

    // Wire the happy path
    const definition = initStep
      .next(extractStep)
      .next(validateStep)
      .next(storeStep)
      .next(updateReadyStep);

    // Catch any unhandled error anywhere in the chain → UpdateStatusFailed
    [initStep, extractStep, validateStep, storeStep].forEach(step => {
      step.addCatch(updateFailedStep, {
        errors: ['States.ALL'],
        resultPath: '$',
      });
    });

    const stateMachine = new sfn.StateMachine(this, 'HeatSheetProcessing', {
      stateMachineName: `swim-meet-processing-${cdk.Stack.of(this).stackName}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      // STANDARD = durable (checkpointed) execution — persists state across steps
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(1),
      logs: {
        destination: sfnLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
      tracingEnabled: true,
    });

    this.stateMachineArn = stateMachine.stateMachineArn;

    // ── Lambda: ProcessingInitiator (SQS trigger) ─────────────────────────────
    const processingInitiatorFn = new nodejs.NodejsFunction(this, 'ProcessingInitiatorFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-initiator-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/processing-initiator.ts'),
      handler: 'handler',
      description: 'Reads SQS messages from S3/EventBridge and starts Step Functions executions',
      environment: {
        ...commonLambdaProps.environment,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });
    stateMachine.grantStartExecution(processingInitiatorFn);

    processingInitiatorFn.addEventSource(
      new lambda_event_sources.SqsEventSource(queue, {
        batchSize: 1, // One PDF per execution for clarity
        reportBatchItemFailures: true,
      }),
    );

    // ── SSM Exports ───────────────────────────────────────────────────────────
    new ssm.StringParameter(this, 'StateMachineArnParam', {
      parameterName: `${props.ssmPrefix}/processing/state-machine-arn`,
      description: 'Step Functions state machine ARN for heat sheet processing',
      stringValue: stateMachine.stateMachineArn,
    });

    new ssm.StringParameter(this, 'AgentIdParam', {
      parameterName: `${props.ssmPrefix}/processing/bedrock-agent-id`,
      description: 'Bedrock Agent ID for the heat sheet extractor',
      stringValue: agent.attrAgentId,
    });

    new ssm.StringParameter(this, 'AgentAliasIdParam', {
      parameterName: `${props.ssmPrefix}/processing/bedrock-agent-alias-id`,
      description: 'Bedrock Agent alias ID (live)',
      stringValue: agentAlias.attrAgentAliasId,
    });

    // ── CDK Nag suppressions ─────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      processingInitiatorFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the minimal managed policy for Lambda CloudWatch logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda execution role wildcards are scoped to the state machine and SQS queue arns by CDK grants.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      initializeMeetFn,
      [{ id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole for CloudWatch logging.' }],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      extractWithBedrockFn,
      [
        { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole for CloudWatch logging.' },
        { id: 'AwsSolutions-IAM5', reason: 'S3 read grant scoped to the raw-PDF bucket by CDK.' },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      validateExtractionFn,
      [{ id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole for CloudWatch logging.' }],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      storeHeatsFn,
      [{ id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole for CloudWatch logging.' }],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      updateMeetStatusFn,
      [{ id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole for CloudWatch logging.' }],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      stateMachine,
      [
        {
          id: 'AwsSolutions-SF1',
          reason: 'Logging is enabled at ERROR level; ALL-level logging can be enabled in production hardening.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Step Functions execution role wildcards scoped to Lambda functions by CDK grants.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(agentRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Bedrock agent role resource wildcard covers cross-region inference profile ARN patterns for the configured model.',
      },
    ]);
  }
}

// Re-export StorageStack so consumers can import from a single location.
export { StorageStack };
