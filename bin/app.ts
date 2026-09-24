#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { EscDualstackRdsStack } from '../lib/esc-dualstack-rds-stack';

const app = new App();

// Region defaults to the AWS European Sovereign Cloud region.
const region = process.env.CDK_DEPLOY_REGION ?? 'eusc-de-east-1';
const account = process.env.CDK_DEFAULT_ACCOUNT;

// REQUIRED: the IPv6 CIDR of your clients. No open default — the stack refuses ::/0.
const allowedClientIpv6Cidr = process.env.ALLOWED_CLIENT_IPV6_CIDR;
if (!allowedClientIpv6Cidr) {
  throw new Error(
    'Set ALLOWED_CLIENT_IPV6_CIDR to your clients\' IPv6 CIDR ' +
      '(e.g. export ALLOWED_CLIENT_IPV6_CIDR="2001:db8:abcd::/48"). ::/0 is rejected.',
  );
}

new EscDualstackRdsStack(app, 'EscDualstackRdsStack', {
  env: { account, region },
  allowedClientIpv6Cidr,
  multiAz: (process.env.MULTI_AZ ?? 'true') === 'true',
  description:
    'IPv6 access to an IPv4 RDS PostgreSQL via a dual-stack RDS Proxy (AWS European Sovereign Cloud)',
});

app.synth();
