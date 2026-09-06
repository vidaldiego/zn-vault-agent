// Path: src/lib/secret-deployer.test.ts
// Unit tests for the deploy-skip decision. Regression coverage for the
// lastSync-across-reboot bug: when tmpfs wipes the output file but
// config.json still has lastVersion === remoteVersion, the deployer
// must NOT short-circuit. See issue #1.

import { describe, it, expect, vi } from 'vitest';
import {
  findSecretRefreshTargets,
  listSecretRefreshTargets,
  shouldSkipDeploy,
} from './secret-deployer.js';

describe('shouldSkipDeploy', () => {
  const fileExists = (paths: string[]) => vi.fn((p: string) => paths.includes(p));

  it('skips when versions match and the output file is on disk', () => {
    const result = shouldSkipDeploy(
      { lastVersion: 5, format: 'raw', output: '/run/secret' },
      5,
      fileExists(['/run/secret']),
    );
    expect(result).toBe(true);
  });

  it('does NOT skip when versions match but the output file is missing (tmpfs wipe)', () => {
    const result = shouldSkipDeploy(
      { lastVersion: 5, format: 'raw', output: '/run/secret' },
      5,
      fileExists([]),
    );
    expect(result).toBe(false);
  });

  it('does NOT skip when versions differ, regardless of file presence', () => {
    expect(
      shouldSkipDeploy(
        { lastVersion: 5, format: 'raw', output: '/run/secret' },
        6,
        fileExists(['/run/secret']),
      ),
    ).toBe(false);
    expect(
      shouldSkipDeploy(
        { lastVersion: 5, format: 'raw', output: '/run/secret' },
        6,
        fileExists([]),
      ),
    ).toBe(false);
  });

  it('does NOT skip when lastVersion is undefined (never deployed)', () => {
    expect(
      shouldSkipDeploy(
        { lastVersion: undefined, format: 'raw', output: '/run/secret' },
        1,
        fileExists(['/run/secret']),
      ),
    ).toBe(false);
  });

  it("skips for format='none' regardless of output (subscribe-only mode)", () => {
    // 'none' targets have no file on disk — the existence check would
    // always be false, so we must bypass it.
    expect(
      shouldSkipDeploy(
        { lastVersion: 5, format: 'none', output: undefined },
        5,
        fileExists([]),
      ),
    ).toBe(true);
    expect(
      shouldSkipDeploy(
        { lastVersion: 5, format: 'none', output: '/run/secret' },
        5,
        fileExists([]),
      ),
    ).toBe(true);
  });

  it('does NOT skip when output is missing for a file-format target', () => {
    // Bizarre config (no output but format='raw'); deploy path will
    // throw "Output path required" — but we shouldn't pretend the
    // file is up-to-date.
    expect(
      shouldSkipDeploy(
        { lastVersion: 5, format: 'raw', output: undefined },
        5,
        fileExists([]),
      ),
    ).toBe(false);
  });

  it('calls fileExists exactly once with the target output path', () => {
    const spy = fileExists(['/run/secret']);
    shouldSkipDeploy(
      { lastVersion: 5, format: 'raw', output: '/run/secret' },
      5,
      spy,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('/run/secret');
  });

  it("does NOT call fileExists for format='none' targets", () => {
    const spy = fileExists([]);
    shouldSkipDeploy(
      { lastVersion: 5, format: 'none', output: undefined },
      5,
      spy,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT call fileExists when versions differ', () => {
    // Performance: don't stat the FS when we already know we're deploying.
    const spy = fileExists(['/run/secret']);
    shouldSkipDeploy(
      { lastVersion: 5, format: 'raw', output: '/run/secret' },
      6,
      spy,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('referenced secret targets', () => {
  const target = {
    secretId: 'alias:app/runtime-env',
    refreshOn: [
      'alias:credentials/openai',
      'alias:credentials/mistral',
      'alias:credentials/mistral',
    ],
    name: 'runtime-env',
    format: 'env' as const,
    output: '/run/app/runtime.env',
  };

  it('deduplicates dependencies with stable per-reference keys', () => {
    expect(listSecretRefreshTargets([target])).toEqual([
      {
        target,
        reference: 'alias:credentials/openai',
        key: 'refresh:alias:app/runtime-env:credentials/openai',
      },
      {
        target,
        reference: 'alias:credentials/mistral',
        key: 'refresh:alias:app/runtime-env:credentials/mistral',
      },
    ]);
  });

  it('matches an event alias exactly and keeps equal child versions independent', () => {
    expect(findSecretRefreshTargets(
      [target],
      'child-uuid',
      'credentials/mistral'
    )).toEqual([{
      target,
      reference: 'alias:credentials/mistral',
      key: 'refresh:alias:app/runtime-env:credentials/mistral',
    }]);
    expect(findSecretRefreshTargets(
      [target],
      'child-uuid',
      'credentials/mistral-extra'
    )).toEqual([]);
  });
});
