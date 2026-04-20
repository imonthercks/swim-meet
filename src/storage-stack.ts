import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  /**
   * SSM Parameter path prefix, e.g. "/swim-meet/dev".
   */
  readonly ssmPrefix: string;
}

/**
 * Provisions all durable storage for the Swim Meet application:
 *   - KMS key for encryption at rest
 *   - S3 bucket for raw PDF uploads (versioned, EventBridge events enabled)
 *   - S3 bucket for validated JSON snapshots (audit / cache)
 *   - DynamoDB single-table ("swim-meets") with PAY_PER_REQUEST billing,
 *     point-in-time recovery, and a NEW_IMAGE stream for future real-time features
 *
 * Access patterns supported by the table design:
 *   PK=MEET#<meetId>  SK=META               → meet metadata + processing status
 *   PK=MEET#<meetId>  SK=HEAT#E{003}#H{002} → individual heat item
 */
export class StorageStack extends cdk.Stack {
  /** KMS key used for S3 and DynamoDB encryption. */
  public readonly encryptionKey: kms.Key;

  /** S3 bucket that receives raw PDF uploads from the SPA. */
  public readonly rawPdfBucket: s3.Bucket;

  /** S3 bucket for processed/validated JSON snapshots. */
  public readonly processedBucket: s3.Bucket;

  /** Single-table DynamoDB table for meets and heats. */
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // ── KMS Key ─────────────────────────────────────────────────────────────
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'Swim Meet — S3 and DynamoDB encryption key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Raw PDF Bucket ───────────────────────────────────────────────────────
    // EventBridge notifications are enabled so Step Functions can react to
    // new PDF uploads without polling.
    this.rawPdfBucket = new s3.Bucket(this, 'RawPdfBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Archive original PDFs to Glacier after one year to minimise cost
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
        },
      ],
    });

    // ── Processed JSON Bucket ────────────────────────────────────────────────
    this.processedBucket = new s3.Bucket(this, 'ProcessedBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── DynamoDB Single-Table ────────────────────────────────────────────────
    this.table = new dynamodb.Table(this, 'MeetsTable', {
      tableName: `swim-meets-${cdk.Stack.of(this).stackName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── SSM Parameters ───────────────────────────────────────────────────────
    new ssm.StringParameter(this, 'RawPdfBucketNameParam', {
      parameterName: `${props.ssmPrefix}/storage/raw-pdf-bucket-name`,
      description: 'S3 bucket name for raw PDF uploads',
      stringValue: this.rawPdfBucket.bucketName,
    });

    new ssm.StringParameter(this, 'ProcessedBucketNameParam', {
      parameterName: `${props.ssmPrefix}/storage/processed-bucket-name`,
      description: 'S3 bucket name for processed JSON snapshots',
      stringValue: this.processedBucket.bucketName,
    });

    new ssm.StringParameter(this, 'TableNameParam', {
      parameterName: `${props.ssmPrefix}/storage/table-name`,
      description: 'DynamoDB table name for swim meets data',
      stringValue: this.table.tableName,
    });

    new ssm.StringParameter(this, 'TableStreamArnParam', {
      parameterName: `${props.ssmPrefix}/storage/table-stream-arn`,
      description: 'DynamoDB stream ARN for real-time integrations',
      stringValue: this.table.tableStreamArn ?? 'stream-not-enabled',
    });

    // ── CDK Nag suppressions ─────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      this.rawPdfBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'Server-access logging for the raw-PDF bucket is acceptable to omit in dev; add a dedicated log bucket in production hardening phase.',
        },
      ],
    );

    NagSuppressions.addResourceSuppressions(
      this.processedBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'Server-access logging for the processed-JSON bucket is acceptable to omit in dev; add a dedicated log bucket in production hardening phase.',
        },
      ],
    );
  }
}
