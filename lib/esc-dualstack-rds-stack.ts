import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  Fn,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface EscDualstackRdsStackProps extends StackProps {
  /**
   * IPv6 CIDR allowed to reach the proxy on the DB port.
   * REQUIRED — no default. Set this to the specific IPv6 range of your clients.
   * Do NOT use ::/0 (any IPv6) outside throwaway experiments.
   */
  readonly allowedClientIpv6Cidr: string;

  /** DB engine port (PostgreSQL = 5432). */
  readonly dbPort?: number;

  /** Multi-AZ for the RDS instance (recommended in production). */
  readonly multiAz?: boolean;
}

/**
 * Exposes an IPv4-only RDS PostgreSQL instance to IPv6 clients in the
 * AWS European Sovereign Cloud (eusc-de-east-1), where RDS dual-stack
 * (NetworkType DUAL) is NOT available.
 *
 * Pattern: dual-stack RDS Proxy in front of an IPv4 RDS instance.
 *   Client IPv6 --TLS--> RDS Proxy (EndpointNetworkType=DUAL) --IPv4--> RDS (IPV4)
 */
export class EscDualstackRdsStack extends Stack {
  // Avoid the credentialed AZ context lookup so the stack stays deployable
  // in any region/partition (including aws-eusc) without prior `cdk context`.
  get availabilityZones(): string[] {
    return [Fn.select(0, Fn.getAzs()), Fn.select(1, Fn.getAzs())];
  }

  constructor(scope: Construct, id: string, props: EscDualstackRdsStackProps) {
    super(scope, id, props);

    const dbPort = props.dbPort ?? 5432;
    const allowedClientIpv6Cidr = props.allowedClientIpv6Cidr;
    const multiAz = props.multiAz ?? true;

    // Guard: refuse an open IPv6 range. The proxy is reachable on the DB port,
    // so ::/0 would expose it to the entire IPv6 Internet — never acceptable.
    if (!allowedClientIpv6Cidr || allowedClientIpv6Cidr.trim() === '::/0') {
      throw new Error(
        'allowedClientIpv6Cidr is required and must not be ::/0. ' +
          "Set it to your clients' specific IPv6 CIDR (e.g. 2001:db8:abcd::/48).",
      );
    }

    // --- VPC dual-stack (IPv4 + IPv6), isolated DB subnets across 2 AZs ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      subnetConfiguration: [
        {
          name: 'db',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // --- Security groups ---
    // L1 (hardening): allowAllOutbound=true is convenient for a demo. In production,
    // restrict egress — the DB SG only needs to reply to the proxy SG, and the proxy
    // SG only needs to reach the DB SG on the DB port. Set allowAllOutbound: false
    // and add explicit egress rules.
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'RDS instance - accepts traffic from the proxy only',
      allowAllOutbound: true,
    });
    const proxySg = new ec2.SecurityGroup(this, 'ProxySg', {
      vpc,
      description: 'RDS Proxy - accepts IPv6 client traffic on the DB port',
      allowAllOutbound: true,
    });

    // Proxy -> RDS (IPv4) on the DB port
    dbSg.addIngressRule(
      proxySg,
      ec2.Port.tcp(dbPort),
      'Allow the RDS Proxy to reach the database',
    );

    // IPv6 clients -> Proxy on the DB port
    proxySg.addIngressRule(
      ec2.Peer.ipv6(allowedClientIpv6Cidr),
      ec2.Port.tcp(dbPort),
      'Allow IPv6 clients to reach the proxy',
    );

    // --- RDS PostgreSQL in IPV4 (dual-stack not available in ESC) ---
    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      networkType: rds.NetworkType.IPV4, // key: IPV4, not DUAL (unsupported in ESC)
      port: dbPort,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true, // encryption at rest (recommended, esp. in sovereign context)
      multiAz, // the proxy absorbs the failover transparently
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin'),
      // M3 (hardening): no explicit backup retention here (short default, and 0 is used
      // during tests). In production set e.g. backupRetention: Duration.days(7) and manage
      // deleteAutomatedBackups accordingly for point-in-time recovery.
      // L4 (hardening): no audit/log export configured. In production add
      // cloudwatchLogsExports: ['postgresql'] to ship DB logs to CloudWatch for audit.
      removalPolicy: RemovalPolicy.DESTROY, // DEMO — harden in production
      deletionProtection: false, // DEMO — enable in production
    });

    // --- RDS Proxy: DUAL endpoint (IPv6 front) + IPV4 to the target ---
    // L3 (hardening): the generated secret has no automatic rotation. In production,
    // enable Secrets Manager rotation (e.g. db.addRotationSingleUser()) so the proxy
    // and clients pick up rotated credentials.
    const proxy = new rds.DatabaseProxy(this, 'Proxy', {
      proxyTarget: rds.ProxyTarget.fromInstance(db),
      secrets: [db.secret!],
      vpc,
      securityGroups: [proxySg],
      requireTLS: true,
    });

    // EndpointNetworkType / TargetConnectionNetworkType are not yet exposed
    // by the L2 DatabaseProxy construct -> L1 escape hatch.
    const cfnProxy = proxy.node.defaultChild as rds.CfnDBProxy;
    cfnProxy.addPropertyOverride('EndpointNetworkType', 'DUAL');
    cfnProxy.addPropertyOverride('TargetConnectionNetworkType', 'IPV4');

    // --- Outputs ---
    new CfnOutput(this, 'ProxyEndpoint', {
      value: proxy.endpoint,
      description: 'Dual-stack RDS Proxy endpoint (resolves to A + AAAA)',
    });
    new CfnOutput(this, 'DbSecretArn', {
      value: db.secret!.secretArn,
      description: 'Secrets Manager ARN holding the DB credentials',
    });
    new CfnOutput(this, 'DbEndpoint', {
      value: db.dbInstanceEndpointAddress,
      description: 'Underlying IPv4 RDS endpoint (reached only via the proxy)',
    });
  }
}
