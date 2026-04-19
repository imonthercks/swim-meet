import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_event_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
 * ProcessingStack wires together the durable PDF-processing pipeline using
 * **AWS Lambda Durable Functions** — no Step Functions state machine required.
 *
 *   S3 PDF upload
 *     → EventBridge "Object Created" rule
 *     → SQS queue (+ DLQ for failed deliveries)
 *     → ProcessingInitiator Lambda      ← SQS trigger; async-invokes orchestrator
 *     → Orchestrator Lambda             ← Lambda Durable Function (checkpointed)
 *         step 1: initialize-meet       ← write MEET#META to DynamoDB
 *         step 2: extract-heats         ← Bedrock Agent + Code Interpreter (data analysis)
 *         step 3: validate-heats        ← schema validation
 *         step 4: store-heats           ← DynamoDB BatchWriteItem + status=READY
 *         (catch): update-status-failed ← status=FAILED
 *
 * The Orchestrator is a durable function — the Lambda Durable Execution service
 * persists each completed step's result.  If the invocation is interrupted, the
 * function resumes from the last checkpoint without re-running earlier steps.
 *
 * The Bedrock Agent is equipped with the AMAZON.CodeInterpreter built-in action
 * group, giving it a sandboxed Python runtime to parse multi-column PDF layouts
 * without any additional Lambda.
 */
export class ProcessingStack extends cdk.Stack {
  /** ARN of the durable Orchestrator Lambda (exported to SSM). */
  public readonly orchestratorFunctionArn: string;

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
        // @aws/durable-execution-sdk-js is NOT in @aws-sdk/* so it is bundled.
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

    // ── Lambda Durable Function: Orchestrator ─────────────────────────────────
    //
    // The Orchestrator is a single Lambda Durable Function that runs the entire
    // PDF processing pipeline.  The AWS Lambda Durable Execution service:
    //   • Persists the result of each context.step() to durable storage
    //   • Re-invokes the function from the last checkpoint on interruption
    //   • Provides at-least-once delivery of each step with configurable retry
    //
    // durableConfig enables durable execution on this function:
    //   executionTimeout – max wall-clock time for the full workflow
    //   retentionPeriod  – how long execution history is retained (for auditing)
    const orchestratorFn = new nodejs.NodejsFunction(this, 'OrchestratorFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-orchestrator-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/orchestrator.ts'),
      handler: 'handler',
      description: 'Durable orchestrator: runs the full PDF heat sheet extraction pipeline with automatic checkpointing',
      timeout: cdk.Duration.minutes(15), // per-invocation timeout (Lambda max)
      memorySize: 1024,
      durableConfig: {
        // Total wall-clock budget for the entire workflow across all invocations.
        // Complex multi-page PDFs with Bedrock extraction can take up to 30 minutes.
        executionTimeout: cdk.Duration.hours(1),
        // Keep execution history for 14 days — useful for debugging failed extractions.
        retentionPeriod: cdk.Duration.days(14),
      },
      environment: {
        ...commonLambdaProps.environment,
        AGENT_ID: agent.attrAgentId,
        AGENT_ALIAS_ID: agentAlias.attrAgentAliasId,
      },
    });

    // Grant S3 read access for the raw PDF bucket
    props.rawPdfBucket.grantRead(orchestratorFn);

    // Grant DynamoDB read/write for pipeline steps
    orchestratorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:UpdateItem'],
        resources: [props.tableArn],
      }),
    );

    // Grant Bedrock Agent invocation
    orchestratorFn.addToRolePolicy(
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

    // Grant the orchestrator permission to call the Lambda Durable Execution APIs
    // on itself.  The SDK calls these to checkpoint step results and retrieve state
    // on re-invocation.  We use a wildcard on the function name prefix so that
    // CDK does not create a circular dependency (policy → function → policy).
    orchestratorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:GetDurableExecution',
          'lambda:GetDurableExecutionState',
          'lambda:CheckpointDurableExecution',
          'lambda:InvokeFunction', // required for durable re-invocation
        ],
        // Scoped to the orchestrator function name prefix in this account/region.
        // Using Aws pseudo-parameters avoids a circular CloudFormation dependency.
        resources: [
          `arn:${cdk.Aws.PARTITION}:lambda:${region}:${cdk.Stack.of(this).account}:function:swim-meet-orchestrator-*`,
        ],
      }),
    );

    this.orchestratorFunctionArn = orchestratorFn.functionArn;

    // ── Lambda: ProcessingInitiator (SQS trigger) ─────────────────────────────
    const processingInitiatorFn = new nodejs.NodejsFunction(this, 'ProcessingInitiatorFn', {
      ...commonLambdaProps,
      functionName: `swim-meet-initiator-${cdk.Stack.of(this).stackName}`,
      entry: path.join(__dirname, 'lambda/processing-initiator.ts'),
      handler: 'handler',
      description: 'Reads SQS messages from S3/EventBridge and async-invokes the durable Orchestrator Lambda',
      environment: {
        ...commonLambdaProps.environment,
        ORCHESTRATOR_ARN: orchestratorFn.functionArn,
      },
    });

    // Allow initiator to async-invoke the orchestrator
    orchestratorFn.grantInvoke(processingInitiatorFn);

    processingInitiatorFn.addEventSource(
      new lambda_event_sources.SqsEventSource(queue, {
        batchSize: 1, // One PDF per execution for clarity
        reportBatchItemFailures: true,
      }),
    );

    // ── SSM Exports ───────────────────────────────────────────────────────────
    new ssm.StringParameter(this, 'OrchestratorArnParam', {
      parameterName: `${props.ssmPrefix}/processing/orchestrator-function-arn`,
      description: 'Durable Orchestrator Lambda ARN for the heat sheet processing pipeline',
      stringValue: orchestratorFn.functionArn,
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
      orchestratorFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the minimal managed policy for Lambda CloudWatch logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 read grant scoped to the raw-PDF bucket by CDK; Bedrock grant scoped to this agent/alias; durable execution grant scoped to this function ARN.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      processingInitiatorFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the minimal managed policy for Lambda CloudWatch logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda invoke grant scoped to the orchestrator function ARN by CDK.',
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
