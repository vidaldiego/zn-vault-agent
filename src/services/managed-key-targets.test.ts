import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ManagedKeyTargets, type ManagedKeyTargetState } from './managed-key-targets.js';
import { ManagedKeyTargetWriter } from '../lib/managed-key-target-writer.js';
import type { ManagedKeyTargetEvent, ManagedKeyTargetAck, ManagedKeyMaterial, ManagedKeyTargetsReconcileRequest, ManagedKeyTargetsReconcileResponse } from '../types/managed-key-targets.js';

let root: string;
beforeEach(() => { vi.useFakeTimers(); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-key-flow-'))); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
const expiry = () => new Date(Date.now() + 86400000).toISOString();
function setup(initial?: ManagedKeyTargetState) {
  const target = { id: 'reader', keyId: 'key-reader', output: path.join(root, 'reader'), owner: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, mode: '0600' };
  let material: ManagedKeyMaterial = { tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-first', rotationCount: 1, expiresAt: expiry() };
  const acks: ManagedKeyTargetAck[] = []; let reads = 0;
  const ownKeys: string[] = [];
  const ownMaterial: ManagedKeyMaterial = { tenantId: 'tenant', keyId: 'key-agent', name: 'agent', key: 'synthetic-own-new', rotationCount: 2, expiresAt: expiry() };
  let ownBind = async (): Promise<ManagedKeyMaterial> => ownMaterial;
  let configChanged = async (): Promise<void> => {};
  let bind = async () => ({ hostConfigId: 'host', targetId: 'reader', targetConfigVersion: 14, material });
  let reconcile = async (request: ManagedKeyTargetsReconcileRequest): Promise<ManagedKeyTargetsReconcileResponse> => ({ tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, removed: [], changed: request.applied.length ? [] : [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 1, reason: 'initial', expiresAt: material.expiresAt, authorizedUntil: material.authorizedUntil ?? material.expiresAt }] });
  const saved: ManagedKeyTargetState[] = [];
  const service = new ManagedKeyTargets({
    initial,
    config: { tenantId: 'tenant', hostConfigId: 'host', agentId: 'agent', configVersion: 14, managedKeyTargets: [target] },
    writer: new ManagedKeyTargetWriter(root),
    reconcile: async request => { reads++; return await reconcile(request); },
    persist: state => { saved.push(structuredClone(state)); },
    configChanged: async () => { await configChanged(); },
    ownBind: async () => await ownBind(), ownMaterial: async material => { ownKeys.push(material.key); },
    bind: async () => { reads++; return await bind(); }, acknowledge: ack => { acks.push(ack); return true; },
  });
  const event = (rotationCount = 2): ManagedKeyTargetEvent => ({ event: 'managed-key-target.changed', deliveryId: `delivery-${rotationCount}`, tenantId: 'tenant', hostConfigId: 'host', targetId: 'reader', targetConfigVersion: 14, keyId: 'key-reader', rotationCount });
  return { target, service, acks, event, ownKeys, saved, setConfigChanged: (value: typeof configChanged) => { configChanged = value; }, setOwnBind: (value: typeof ownBind) => { ownBind = value; }, setReconcile: (value: typeof reconcile) => { reconcile = value; }, reads: () => reads, setMaterial: (value: ManagedKeyMaterial) => { material = value; }, setBind: (value: typeof bind) => { bind = value; } };
}

describe('event-driven target delivery', () => {
  it('materializes initially, reconciles narrowly and never queries while idle/disconnected', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    expect(fs.readFileSync(f.target.output, 'utf8')).toBe('synthetic-first');
    const reads = f.reads(); await vi.advanceTimersByTimeAsync(3600000); f.service.disconnected(); await vi.advanceTimersByTimeAsync(3600000);
    expect(f.reads()).toBe(reads); await f.service.connected(['managed-key-targets-v1']);
    expect(f.reads()).toBe(reads + 1); f.service.stop();
  });
  it('fences a late bind after revocation and never ACKs it as applied', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    let finish!: (value: Awaited<ReturnType<Parameters<typeof f.setBind>[0]>>) => void;
    f.setBind(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.handleEvent(f.event()); await Promise.resolve();
    const revoke = f.service.handleEvent({ ...f.event(), event: 'managed-key-target.revoked', deliveryId: 'revoke' });
    finish({ hostConfigId: 'host', targetId: 'reader', targetConfigVersion: 14, material: { tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-late', rotationCount: 2, expiresAt: expiry() } });
    await Promise.all([pending, revoke]);
    expect(fs.existsSync(f.target.output)).toBe(false);
    expect(f.acks.filter(ack => ack.deliveryId === 'delivery-2' && ack.outcome === 'applied')).toEqual([]); f.service.stop();
  });
  it('replays a lost ACK idempotently and rejects an older rotation', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.setMaterial({ tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-new', rotationCount: 3, expiresAt: expiry() });
    await f.service.handleEvent(f.event(3)); const reads = f.reads();
    await f.service.handleEvent(f.event(3)); await f.service.handleEvent(f.event(2));
    expect(f.reads()).toBe(reads); expect(fs.readFileSync(f.target.output, 'utf8')).toBe('synthetic-new');
    expect(f.acks.filter(ack => ack.deliveryId === 'delivery-3')).toHaveLength(2); f.service.stop();
  });
  it('does not expire new current material at the predecessor grace deadline', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.setMaterial({ tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-new', rotationCount: 2, expiresAt: expiry(), graceExpiresAt: new Date(Date.now() + 1000).toISOString() });
    await f.service.handleEvent(f.event()); await vi.advanceTimersByTimeAsync(1001);
    expect(fs.readFileSync(f.target.output, 'utf8')).toBe('synthetic-new'); f.service.stop();
  });
  it('removes known expired material while disconnected without querying', async () => {
    const f = setup(); f.setMaterial({ tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-first', rotationCount: 1, expiresAt: new Date(Date.now() + 1000).toISOString() });
    await f.service.connected(['managed-key-targets-v1']); f.service.disconnected(); const reads = f.reads();
    await vi.advanceTimersByTimeAsync(1001); expect(fs.existsSync(f.target.output)).toBe(false); expect(f.reads()).toBe(reads); f.service.stop();
  });
  it('fails closed when the server does not negotiate target support', async () => {
    const f = setup(); await f.service.connected([]); expect(f.reads()).toBe(0); expect(f.service.status()[0].state).toBe('unsupported'); f.service.stop();
  });
  it('does not acknowledge removal when file custody prevents deletion', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    fs.chmodSync(f.target.output, 0o666);
    await f.service.handleEvent({ ...f.event(), event: 'managed-key-target.revoked', deliveryId: 'revoke-failed' });
    expect(fs.existsSync(f.target.output)).toBe(true);
    expect(f.acks.filter(ack => ack.deliveryId === 'revoke-failed')).toEqual([]); f.service.stop();
  });
  it('materializes a missing tmpfs output despite persisted applied revision', async () => {
    const f = setup({ applied: [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 1 }] });
    await f.service.connected(['managed-key-targets-v1']);
    expect(fs.readFileSync(f.target.output, 'utf8')).toBe('synthetic-first'); f.service.stop();
  });
  it('preserves installed material and sends no applied ACK after custody failure', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    fs.chmodSync(f.target.output, 0o666);
    f.setMaterial({ tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-new', rotationCount: 2, expiresAt: expiry() });
    await f.service.handleEvent(f.event());
    expect(fs.readFileSync(f.target.output, 'utf8')).toBe('synthetic-first');
    expect(f.acks).toEqual([]); expect(f.service.status()[0].state).toBe('failed'); f.service.stop();
  });
  it('removes all target material immediately when own authority is revoked', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.service.setOwnAuthorization(new Date(0).toISOString());
    expect(fs.existsSync(f.target.output)).toBe(false);
    expect(f.service.status()[0].state).toBe('reenrollment_required'); f.service.stop();
  });

  it('binds the reserved self event through own custody and preserves target material', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.service.ownApplied({ keyId: 'key-agent', rotationCount: 1, expiresAt: expiry() });
    await f.service.handleEvent({ ...f.event(), targetId: '$self', keyId: 'key-agent' });
    expect(f.ownKeys).toEqual(['synthetic-own-new']);
    expect(fs.readFileSync(f.target.output, 'utf8')).toBe('synthetic-first');
    expect(f.acks.at(-1)).toMatchObject({ targetId: '$self', keyId: 'key-agent', rotationCount: 2, outcome: 'applied' }); f.service.stop();
  });

  it('applies authoritative revocation at a newer config generation before config reload', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    await f.service.handleEvent({ ...f.event(), event: 'managed-key-target.revoked', targetConfigVersion: 15 });
    expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
  it('blocks own identity outside predecessor grace without attempting bind', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.service.ownApplied({ keyId: 'key-agent', rotationCount: 0, expiresAt: expiry() });
    await f.service.handleEvent({ ...f.event(3), targetId: '$self', keyId: 'key-agent', graceExpiresAt: expiry() });
    expect(f.ownKeys).toEqual([]); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });

  it('removes material when a target bind confirms that its identity expired', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.setBind(async () => { throw Object.assign(new Error('Expired'), { statusCode: 410 }); });
    await f.service.handleEvent(f.event()); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });

  it('enforces a persisted deadline after offline restart regardless of JSON property order', async () => {
    const savedTarget = { mode: '0600', owner: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, output: path.join(root, 'reader'), keyId: 'key-reader', id: 'reader' };
    const f = setup({ applied: [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 1, expiresAt: new Date(Date.now() + 1000).toISOString(), target: savedTarget }] });
    fs.writeFileSync(f.target.output, 'synthetic-old', { mode: 0o600 });
    f.service.disconnected(); await vi.advanceTimersByTimeAsync(1001);
    expect(fs.existsSync(f.target.output)).toBe(false); expect(f.reads()).toBe(0); f.service.stop();
  });

  it('blocks authority when a scoped conflict explicitly requires reenrollment', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.setBind(async () => { throw Object.assign(new Error('Conflict'), { statusCode: 409, code: 'REENROLLMENT_REQUIRED' }); });
    await f.service.handleEvent(f.event()); expect(fs.existsSync(f.target.output)).toBe(false);
    expect(f.service.status()[0].state).toBe('reenrollment_required'); f.service.stop();
  });

  it('tightens a known deadline without fetching equal-revision material again', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']); const reads = f.reads();
    await f.service.handleEvent({ ...f.event(1), expiresAt: new Date(Date.now() + 1000).toISOString(), authorizedUntil: new Date(Date.now() + 1000).toISOString() });
    f.service.disconnected(); await vi.advanceTimersByTimeAsync(1001);
    expect(fs.existsSync(f.target.output)).toBe(false); expect(f.reads()).toBe(reads); f.service.stop();
  });

  it('enforces own metadata expiry even when previous local metadata omitted its deadline', async () => {
    const f = setup({ applied: [], own: { keyId: 'key-agent', rotationCount: 1 } });
    await f.service.connected(['managed-key-targets-v1']);
    await f.service.handleEvent({ ...f.event(1), targetId: '$self', keyId: 'key-agent', expiresAt: new Date(Date.now() + 1000).toISOString() });
    await vi.advanceTimersByTimeAsync(1001); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });

  it('review 1: captures equal pending revision deadline before the stale bind resolves', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    let finish!: (value: Awaited<ReturnType<Parameters<typeof f.setBind>[0]>>) => void;
    f.setBind(() => new Promise(resolve => { finish = resolve; }));
    const first = f.service.handleEvent(f.event(2)); await Promise.resolve();
    const deadline = new Date(Date.now() + 1000).toISOString();
    const second = f.service.handleEvent({ ...f.event(2), deliveryId: 'deadline-rev2', expiresAt: deadline, authorizedUntil: deadline });
    finish({ hostConfigId: 'host', targetId: 'reader', targetConfigVersion: 14, material: { tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-stale-bind', rotationCount: 2, expiresAt: new Date(Date.now() + 100000).toISOString() } });
    await Promise.all([first, second]); await vi.advanceTimersByTimeAsync(1001);
    expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
  it('review 2: predecessor grace cannot extend an earlier installed identity expiry', async () => {
    const f = setup(); const deadline = new Date(Date.now() + 1000).toISOString();
    f.setMaterial({ tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-first', rotationCount: 1, expiresAt: deadline });
    await f.service.connected(['managed-key-targets-v1']);
    f.setBind(async () => { throw new Error('Unavailable'); });
    await f.service.handleEvent({ ...f.event(2), graceExpiresAt: new Date(Date.now() + 10000).toISOString() });
    await vi.advanceTimersByTimeAsync(1001);
    expect(fs.existsSync(f.target.output)).toBe(false);
    expect(f.saved.at(-1)?.applied.every(item => !item.expiresAt || Date.parse(item.expiresAt) <= Date.parse(deadline))).toBe(true); f.service.stop();
  });
  it('review 3: reconnect retires an expired predecessor even when current material bind fails', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.setBind(async () => { throw new Error('Unavailable'); });
    f.setReconcile(async () => ({ tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, removed: [], changed: [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 2, reason: 'rotated', expiresAt: expiry(), authorizedUntil: expiry(), graceExpiresAt: new Date(Date.now() - 1).toISOString() }] }));
    await f.service.connected(['managed-key-targets-v1']);
    expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
  it('review 4: future config reconciliation revokes before a no-op reload and fences pending writes', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    let finish!: (value: Awaited<ReturnType<Parameters<typeof f.setBind>[0]>>) => void;
    f.setBind(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.handleEvent(f.event(2)); await Promise.resolve();
    f.setReconcile(async () => ({ tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 15, configChanged: true, changed: [], removed: [{ targetId: 'reader', keyId: 'key-reader', reason: 'removed' }] }));
    await f.service.connected(['managed-key-targets-v1']);
    expect(fs.existsSync(f.target.output)).toBe(false);
    finish({ hostConfigId: 'host', targetId: 'reader', targetConfigVersion: 14, material: { tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-late', rotationCount: 2, expiresAt: expiry() } });
    await pending; expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
  it('review 4b: config mismatch with no completed reload cannot admit an old config write', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.setReconcile(async () => ({ tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 15, configChanged: true, changed: [], removed: [] }));
    await f.service.connected(['managed-key-targets-v1']); const reads = f.reads();
    expect(f.service.status()[0].state).toBe('stale');
    await f.service.handleEvent(f.event(2)); expect(f.reads()).toBe(reads); f.service.stop();
  });

  it('review 3 own: reconnect blocks a missing own predecessor instead of binding past its grace', async () => {
    const f = setup({ applied: [], own: { keyId: 'key-agent', rotationCount: 0, expiresAt: expiry() } });
    await f.service.connected(['managed-key-targets-v1']);
    f.setReconcile(async () => ({ tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, changed: [], removed: [], ownChanged: { keyId: 'key-agent', rotationCount: 2, reason: 'rotated', expiresAt: expiry(), authorizedUntil: expiry() } }));
    await f.service.connected(['managed-key-targets-v1']);
    expect(f.ownKeys).toEqual([]); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });

  it('review own pending: expires authority before a queued same-revision deadline and fences the late own callback', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.service.ownApplied({ keyId: 'key-agent', rotationCount: 1, expiresAt: expiry() });
    let finish!: (material: ManagedKeyMaterial) => void;
    f.setOwnBind(() => new Promise(resolve => { finish = resolve; }));
    const first = f.service.handleEvent({ ...f.event(2), targetId: '$self', keyId: 'key-agent' });
    await Promise.resolve();
    const deadline = new Date(Date.now() + 1000).toISOString();
    const second = f.service.handleEvent({ ...f.event(2), deliveryId: 'own-deadline', targetId: '$self', keyId: 'key-agent', expiresAt: deadline, authorizedUntil: deadline, graceExpiresAt: expiry() });
    await vi.advanceTimersByTimeAsync(1001);
    const remainedAfterDeadline = fs.existsSync(f.target.output);
    finish({ tenantId: 'tenant', keyId: 'key-agent', name: 'agent', key: 'synthetic-stale-own', rotationCount: 2, expiresAt: new Date(Date.now() + 100000).toISOString() });
    await Promise.all([first, second]);
    expect.soft(remainedAfterDeadline).toBe(false);
    expect.soft(f.saved.at(-1)?.ownLimit).toEqual({ keyId: 'key-agent', expiresAt: deadline });
    expect.soft(f.ownKeys).toEqual([]);
    expect.soft(f.acks.filter(ack => ack.targetId === '$self' && ack.outcome === 'applied')).toEqual([]);
    f.service.stop();
  });

});

describe('reconnect deadline snapshots', () => {
  it('learns a missed target deadline at the same revision without bind, rewrite or ACK, then sends its exact snapshot', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    const inode = fs.statSync(f.target.output).ino; const reads = f.reads();
    const deadline = new Date(Date.now() + 1000).toISOString(); const requests: ManagedKeyTargetsReconcileRequest[] = [];
    f.setReconcile(async request => {
      requests.push(structuredClone(request));
      const known = request.applied[0] as typeof request.applied[0] & { expiresAt?: string; authorizedUntil?: string };
      return { tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, removed: [], changed: known?.expiresAt === deadline && known.authorizedUntil === deadline ? [] : [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 1, reason: 'metadata_changed', expiresAt: deadline, authorizedUntil: deadline }] };
    });
    f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
    expect(fs.statSync(f.target.output).ino).toBe(inode); expect(f.reads()).toBe(reads + 1); expect(f.acks).toEqual([]);
    f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
    expect(requests[1].applied[0]).toMatchObject({ expiresAt: deadline, authorizedUntil: deadline });
    await vi.advanceTimersByTimeAsync(1001); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
  it('learns a missed own deadline at the same revision without self-bind and fences a pending target bind immediately', async () => {
    const f = setup(); await f.service.connected(['managed-key-targets-v1']);
    f.service.ownApplied({ keyId: 'key-agent', rotationCount: 1, expiresAt: expiry() });
    let ownBinds = 0; f.setOwnBind(async () => { ownBinds++; return { tenantId: 'tenant', keyId: 'key-agent', name: 'agent', key: 'synthetic-own', rotationCount: 1, expiresAt: expiry() }; });
    let finish!: (value: Awaited<ReturnType<Parameters<typeof f.setBind>[0]>>) => void;
    f.setBind(() => new Promise(resolve => { finish = resolve; }));
    const deadline = new Date(Date.now() + 1000).toISOString();
    f.setReconcile(async () => ({ tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, removed: [],
      ownChanged: { keyId: 'key-agent', rotationCount: 1, reason: 'metadata_changed', expiresAt: deadline, authorizedUntil: deadline },
      changed: [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 2, reason: 'rotated', expiresAt: expiry(), authorizedUntil: deadline, graceExpiresAt: expiry() }] }));
    f.service.disconnected(); const pending = f.service.connected(['managed-key-targets-v1']);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); await vi.advanceTimersByTimeAsync(1001);
    expect.soft(ownBinds).toBe(0); expect.soft(f.ownKeys).toEqual([]); expect.soft(fs.existsSync(f.target.output)).toBe(false);
    finish({ hostConfigId: 'host', targetId: 'reader', targetConfigVersion: 14, material: { tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-late', rotationCount: 2, expiresAt: expiry() } });
    await pending; expect(f.acks).toEqual([]); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
  it('remembers the exact extended server snapshot while retaining the earlier enforced minimum', async () => {
    const f = setup(); const early = new Date(Date.now() + 1000).toISOString(); const extended = expiry();
    f.setMaterial({ tenantId: 'tenant', keyId: 'key-reader', name: 'reader', key: 'synthetic-first', rotationCount: 1, expiresAt: early, authorizedUntil: early });
    await f.service.connected(['managed-key-targets-v1']); const requests: ManagedKeyTargetsReconcileRequest[] = [];
    let metadataResponses = 0;
    f.setReconcile(async request => {
      requests.push(structuredClone(request)); const known = request.applied[0] as typeof request.applied[0] & { expiresAt?: string; authorizedUntil?: string };
      const changed = known?.expiresAt === extended && known.authorizedUntil === extended ? [] : [{ targetId: 'reader', keyId: 'key-reader', rotationCount: 1, reason: 'metadata_changed' as const, expiresAt: extended, authorizedUntil: extended }];
      if (changed.length) metadataResponses++;
      return { tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, removed: [], changed };
    });
    f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
    f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
    expect(metadataResponses).toBe(1); expect(requests[1].applied[0]).toMatchObject({ expiresAt: extended, authorizedUntil: extended });
    expect(f.saved.at(-1)?.applied[0].expiresAt).toBe(early);
    await vi.advanceTimersByTimeAsync(1001); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
  });
});

it('sends an exact own snapshot once learned without extending its enforced deadline or self-binding', async () => {
  const f = setup(); await f.service.connected(['managed-key-targets-v1']);
  const early = new Date(Date.now() + 1000).toISOString(); const extended = expiry();
  f.service.ownApplied({ keyId: 'key-agent', rotationCount: 1, expiresAt: early });
  const requests: ManagedKeyTargetsReconcileRequest[] = []; let changes = 0;
  f.setOwnBind(async () => { throw new Error('Unexpected self-bind'); });
  f.setReconcile(async request => {
    requests.push(structuredClone(request));
    const ownChanged = request.own?.expiresAt === extended && request.own.authorizedUntil === extended ? undefined : { keyId: 'key-agent', rotationCount: 1, reason: 'metadata_changed' as const, expiresAt: extended, authorizedUntil: extended };
    if (ownChanged) changes++;
    return { tenantId: 'tenant', hostConfigId: 'host', targetConfigVersion: 14, configChanged: false, changed: [], removed: [], ownChanged };
  });
  f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
  f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
  expect(changes).toBe(1); expect(requests[1].own).toMatchObject({ expiresAt: extended, authorizedUntil: extended });
  expect(f.saved.at(-1)?.own?.expiresAt).toBe(early); expect(f.ownKeys).toEqual([]); expect(f.acks).toEqual([]);
  await vi.advanceTimersByTimeAsync(1001); expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
});

it('a full snapshot without grace retires a target predecessor before a failed bind', async () => {
  const f = setup(); await f.service.connected(['managed-key-targets-v1']);
  f.setBind(async () => { throw new Error('Unavailable'); });
  await f.service.handleEvent({ ...f.event(2), expiresAt: expiry(), authorizedUntil: expiry() });
  expect(fs.existsSync(f.target.output)).toBe(false); f.service.stop();
});

it('a full own snapshot without grace blocks the predecessor without self-bind', async () => {
  const f = setup(); await f.service.connected(['managed-key-targets-v1']);
  f.service.ownApplied({ keyId: 'key-agent', rotationCount: 1, expiresAt: expiry() });
  let binds=0; f.setOwnBind(async () => { binds++; throw new Error('Unexpected'); });
  f.setReconcile(async () => ({ tenantId:'tenant',hostConfigId:'host',targetConfigVersion:14,configChanged:false,changed:[],removed:[],ownChanged:{keyId:'key-agent',rotationCount:2,reason:'rotated',expiresAt:expiry(),authorizedUntil:expiry()} }));
  f.service.disconnected(); await f.service.connected(['managed-key-targets-v1']);
  expect(binds).toBe(0); expect(fs.existsSync(f.target.output)).toBe(false); expect(f.service.status()[0].state).toBe('reenrollment_required'); f.service.stop();
});

it('binds a full own DTO within predecessor grace and never applies that grace to the new current material', async () => {
  const f = setup(); await f.service.connected(['managed-key-targets-v1']);
  f.service.ownApplied({ keyId:'key-agent',rotationCount:1,expiresAt:expiry() });
  const grace = new Date(Date.now()+1000).toISOString();
  f.setOwnBind(async () => ({ tenantId:'tenant',keyId:'key-agent',name:'agent',key:'synthetic-full-own',rotationCount:2,expiresAt:expiry(),authorizedUntil:expiry(),graceExpiresAt:grace }));
  await f.service.handleEvent({ ...f.event(2),targetId:'$self',keyId:'key-agent',expiresAt:expiry(),authorizedUntil:expiry(),graceExpiresAt:grace });
  expect(f.ownKeys).toEqual(['synthetic-full-own']);
  await vi.advanceTimersByTimeAsync(1001); expect(fs.existsSync(f.target.output)).toBe(true); f.service.stop();
});

it('review: admits a matching target deadline before a future-config reload blocks', async () => {
  const f = setup(); const previous = new Date(Date.now() + 100000).toISOString();
  f.setMaterial({ tenantId:'tenant',keyId:'key-reader',name:'reader',key:'synthetic-current',rotationCount:1,expiresAt:previous,authorizedUntil:previous });
  await f.service.connected(['managed-key-targets-v1']);
  f.service.ownApplied({ keyId:'key-agent',rotationCount:1,expiresAt:previous });
  const deadline = new Date(Date.now()+1000).toISOString(); const before = f.reads();
  let finishReload!: () => void;
  f.setConfigChanged(() => new Promise(resolve => { finishReload=resolve; }));
  f.setReconcile(async () => ({ tenantId:'tenant',hostConfigId:'host',targetConfigVersion:15,configChanged:true,removed:[],
    ownChanged:{keyId:'key-agent',rotationCount:1,reason:'metadata_changed',expiresAt:previous,authorizedUntil:previous},
    changed:[{targetId:'reader',keyId:'key-reader',rotationCount:1,reason:'metadata_changed',expiresAt:deadline,authorizedUntil:deadline}] }));
  f.service.disconnected(); const pending = f.service.connected(['managed-key-targets-v1']);
  await vi.waitFor(() => expect(finishReload).toBeTypeOf('function'));
  const savedBeforeReload = structuredClone(f.saved.at(-1));
  await vi.advanceTimersByTimeAsync(1001); const existsWhileReloadPending=fs.existsSync(f.target.output);
  finishReload(); await pending;
  expect.soft(existsWhileReloadPending).toBe(false);
  expect.soft(savedBeforeReload?.applied[0].serverSnapshot).toEqual({rotationCount:1,expiresAt:deadline,authorizedUntil:deadline});
  expect(f.reads()).toBe(before+1); expect(f.ownKeys).toEqual([]); expect(f.acks).toEqual([]); f.service.stop();
});
