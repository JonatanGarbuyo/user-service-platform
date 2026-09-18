import { describe, expect, it } from 'vitest';
import { parseDeployArgs, resolveDeploySelection } from '../../scripts/deploy/cli.js';

// Deploy CLI selection (ticket #78): interactive for humans, deterministic
// CLI/env inputs for automation. Staging is never offered.
describe('deploy CLI selection', () => {
  it('parses explicit target and environment flags', () => {
    expect(parseDeployArgs(['--target', 'rch-rugbychampagne', '--env', 'sandbox'])).toMatchObject({
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
  });

  it('parses confirmation, dry-run, non-interactive and write-config flags', () => {
    expect(
      parseDeployArgs([
        '--target',
        'rch-rugbychampagne',
        '--env',
        'production',
        '--confirm',
        'rch-rugbychampagne-user-service-production',
        '--non-interactive',
        '--dry-run',
        '--write-config',
        '/tmp/keep.json',
      ]),
    ).toMatchObject({
      confirm: 'rch-rugbychampagne-user-service-production',
      nonInteractive: true,
      dryRun: true,
      writeConfig: '/tmp/keep.json',
    });
  });

  it('falls back to DEPLOY_* automation inputs', () => {
    expect(
      parseDeployArgs([], {
        DEPLOY_TARGET: 'rch-rugbychampagne',
        DEPLOY_ENV: 'sandbox',
        DEPLOY_CONFIRM: 'anything',
      }),
    ).toMatchObject({
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
      confirm: 'anything',
    });
  });

  it('prefers explicit flags over automation inputs', () => {
    expect(
      parseDeployArgs(['--env', 'production'], {
        DEPLOY_TARGET: 'rch-rugbychampagne',
        DEPLOY_ENV: 'sandbox',
      }),
    ).toMatchObject({ target: 'rch-rugbychampagne', environment: 'production' });
  });

  it('rejects staging selections', () => {
    expect(() => parseDeployArgs(['--target', 'rch-rugbychampagne', '--env', 'staging'])).toThrow(
      /staging/i,
    );
  });

  it('rejects unknown flags', () => {
    expect(() => parseDeployArgs(['--bogus'])).toThrow(/unknown/i);
  });

  it('requires a target outside interactive mode', () => {
    expect(() =>
      resolveDeploySelection(parseDeployArgs(['--env', 'sandbox', '--non-interactive']), {
        targets: ['rch-rugbychampagne'],
        interactive: false,
      }),
    ).toThrow(/target/i);
  });

  it('requires an environment outside interactive mode', () => {
    expect(() =>
      resolveDeploySelection(
        parseDeployArgs(['--target', 'rch-rugbychampagne', '--non-interactive']),
        {
          targets: ['rch-rugbychampagne'],
          interactive: false,
        },
      ),
    ).toThrow(/environment/i);
  });

  it('resolves a complete non-interactive selection', () => {
    expect(
      resolveDeploySelection(
        parseDeployArgs([
          '--target',
          'rch-rugbychampagne',
          '--env',
          'sandbox',
          '--non-interactive',
        ]),
        { targets: ['rch-rugbychampagne'], interactive: false },
      ),
    ).toEqual({ target: 'rch-rugbychampagne', environment: 'sandbox' });
  });
});
