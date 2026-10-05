import { describe, expect, it } from 'vitest';
import {
  parseProvisionArgs,
  resolveProvisionSelection,
} from '../../scripts/deploy/provision-cli.js';

// Provision CLI (ticket #80): one entry point for first-time target
// provisioning. Plan is the default no-mutation mode; apply performs the
// declared provisioning actions. Production apply requires the exact Worker
// name as confirmation at the orchestration boundary.
describe('provision CLI selection', () => {
  it('parses target and environment flags and defaults to plan', () => {
    expect(
      parseProvisionArgs(['--target', 'rch-rugbychampagne', '--env', 'sandbox']),
    ).toMatchObject({
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
      mode: 'plan',
    });
  });

  it('selects apply mode explicitly', () => {
    expect(
      parseProvisionArgs(['--target', 'rch-rugbychampagne', '--env', 'sandbox', '--apply']),
    ).toMatchObject({ mode: 'apply' });
  });

  it('accepts an explicit plan flag', () => {
    expect(
      parseProvisionArgs(['--target', 'rch-rugbychampagne', '--env', 'sandbox', '--plan']),
    ).toMatchObject({ mode: 'plan' });
  });

  it('rejects combining plan and apply', () => {
    expect(() =>
      parseProvisionArgs([
        '--target',
        'rch-rugbychampagne',
        '--env',
        'sandbox',
        '--plan',
        '--apply',
      ]),
    ).toThrow(/plan.*apply|apply.*plan/i);
  });

  it('parses the production confirmation value', () => {
    expect(
      parseProvisionArgs([
        '--target',
        'rch-rugbychampagne',
        '--env',
        'production',
        '--apply',
        '--confirm',
        'rch-rugbychampagne-user-service-production',
      ]),
    ).toMatchObject({
      mode: 'apply',
      confirm: 'rch-rugbychampagne-user-service-production',
    });
  });

  it('falls back to PROVISION_* automation inputs', () => {
    expect(
      parseProvisionArgs([], {
        PROVISION_TARGET: 'rch-rugbychampagne',
        PROVISION_ENV: 'sandbox',
        PROVISION_CONFIRM: 'anything',
      }),
    ).toMatchObject({
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
      confirm: 'anything',
    });
  });

  it('prefers explicit flags over automation inputs', () => {
    expect(
      parseProvisionArgs(['--env', 'production'], {
        PROVISION_TARGET: 'rch-rugbychampagne',
        PROVISION_ENV: 'sandbox',
      }),
    ).toMatchObject({ target: 'rch-rugbychampagne', environment: 'production' });
  });

  it('rejects staging selections', () => {
    expect(() =>
      parseProvisionArgs(['--target', 'rch-rugbychampagne', '--env', 'staging']),
    ).toThrow(/staging/i);
  });

  it('rejects unknown flags', () => {
    expect(() => parseProvisionArgs(['--bogus'])).toThrow(/unknown/i);
  });

  it('rejects secret values as CLI flags', () => {
    expect(() => parseProvisionArgs(['--secret', 'value'])).toThrow(/unknown/i);
  });

  it('requires a target outside interactive mode', () => {
    expect(() =>
      resolveProvisionSelection(parseProvisionArgs(['--env', 'sandbox']), {
        targets: ['rch-rugbychampagne'],
        interactive: false,
      }),
    ).toThrow(/target/i);
  });

  it('requires an environment outside interactive mode', () => {
    expect(() =>
      resolveProvisionSelection(parseProvisionArgs(['--target', 'rch-rugbychampagne']), {
        targets: ['rch-rugbychampagne'],
        interactive: false,
      }),
    ).toThrow(/environment/i);
  });

  it('resolves a complete selection', () => {
    expect(
      resolveProvisionSelection(
        parseProvisionArgs(['--target', 'rch-rugbychampagne', '--env', 'sandbox']),
        { targets: ['rch-rugbychampagne'], interactive: false },
      ),
    ).toEqual({ target: 'rch-rugbychampagne', environment: 'sandbox' });
  });
});
