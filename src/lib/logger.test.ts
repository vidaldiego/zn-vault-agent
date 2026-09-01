import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { reopenLogDestination, SENSITIVE_LOG_PATHS } from './logger.js';

describe('credential log redaction', () => {
  it('covers full credentials and known credential-fragment fields', () => {
    expect(SENSITIVE_LOG_PATHS).toEqual(expect.arrayContaining([
      'apiKey',
      'bootstrapToken',
      'registrationToken',
      'reprovisionToken',
      'bearerToken',
      'keyPrefix',
      'tokenPrefix',
      'valuePrefix',
      'oldPrefix',
      'newPrefix',
      'currentKeyPrefix',
      'auth.apiKey',
      'config.auth.apiKey',
      'headers.authorization',
    ]));
  });

  it('redacts full credentials and fragments before writing the stream', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const canary = 'znv_secret-canary-DO-NOT-LOG';
    const testLogger = pino({
      redact: { paths: SENSITIVE_LOG_PATHS, censor: '[REDACTED]' },
    }, sink);

    testLogger.info({
      apiKey: canary,
      newPrefix: canary.substring(0, 8),
      response: { apiKey: canary },
    }, 'redaction probe');

    const output = chunks.join('');
    expect(output).not.toContain(canary);
    expect(output).not.toContain(canary.substring(0, 8));
    expect(output).toContain('[REDACTED]');
  });
});

describe('log file rotation', () => {
  it('reopens an explicitly configured destination', () => {
    const reopen = vi.fn();

    expect(reopenLogDestination({ reopen })).toBe(true);
    expect(reopen).toHaveBeenCalledOnce();
  });

  it('is a no-op when file logging is not configured', () => {
    expect(reopenLogDestination(undefined)).toBe(false);
  });
});
