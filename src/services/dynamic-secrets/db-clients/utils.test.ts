import { describe, expect, it } from 'vitest';
import { parseConnectionString } from './utils.js';

describe('database connection-string output safety', () => {
  it('does not include credential material in parse failures', () => {
    const canary = 'connection-password-canary-DO-NOT-PRINT';
    let error: unknown;

    try {
      parseConnectionString(`${canary} is not a URL`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Invalid database connection string');
    expect((error as Error).message).not.toContain(canary);
  });
});
