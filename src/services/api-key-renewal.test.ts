import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ requests: 0 }));
vi.mock('../lib/config.js', () => ({
  loadConfig: () => ({ vaultUrl: 'https://vault.test', auth: { apiKey: 'synthetic-key' } }),
  updateApiKey: vi.fn(),
}));
vi.mock('node:https', () => ({ default: { request: (_options: unknown, response: (res: EventEmitter) => void) => {
  state.requests++;
  const req = new EventEmitter() as EventEmitter & { end(): void };
  req.end = () => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    response(res);
    res.emit('data', JSON.stringify({ expiresInDays: 365, isExpiringSoon: false }));
    res.emit('end');
  };
  return req;
} } }));
import { startApiKeyRenewal, stopApiKeyRenewal } from './api-key-renewal.js';
describe('static key startup validation', () => {
  afterEach(() => { stopApiKeyRenewal(); vi.useRealTimers(); state.requests = 0; });
  it('reads expiry once at startup without periodic authentication discovery', async () => {
    vi.useFakeTimers();
    startApiKeyRenewal();
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
    expect(state.requests).toBe(1);
  });
});
