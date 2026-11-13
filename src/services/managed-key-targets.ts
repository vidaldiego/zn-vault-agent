import type { ManagedKeyTargetWriter } from '../lib/managed-key-target-writer.js';
import {
  MANAGED_KEY_TARGET_CAPABILITY,
  type ManagedKeyTarget, type ManagedKeyRevision, type ManagedKeyMaterial,
  type ManagedKeyTargetEvent, type ManagedKeyTargetAck, type ManagedKeyTargetStatus,
  type ManagedKeyTargetsReconcileRequest, type ManagedKeyTargetsReconcileResponse,
  type ManagedKeyTargetBindRequest, type ManagedKeyTargetBindResponse,
} from '../types/managed-key-targets.js';

interface TargetConfig {
  tenantId?: string; hostConfigId?: string; agentId?: string; configVersion?: number;
  managedKeyTargets?: ManagedKeyTarget[];
}
export interface ManagedKeyTargetState {
  applied: (ManagedKeyRevision & { expiresAt?: string; target?: ManagedKeyTarget })[];
  own?: { keyId: string; rotationCount: number; expiresAt?: string };
}
interface Dependencies {
  config: TargetConfig;
  writer: Pick<ManagedKeyTargetWriter, 'write' | 'remove' | 'isValid'>;
  reconcile(request: ManagedKeyTargetsReconcileRequest): Promise<ManagedKeyTargetsReconcileResponse>;
  bind(targetId: string, request: ManagedKeyTargetBindRequest): Promise<ManagedKeyTargetBindResponse>;
  acknowledge(ack: ManagedKeyTargetAck): boolean;
  initial?: ManagedKeyTargetState;
  persist?(state: ManagedKeyTargetState): void;
  ownBind?(): Promise<ManagedKeyMaterial>;
  ownMaterial?(material: ManagedKeyMaterial): Promise<void>;
  configChanged?(): Promise<void>;
}
interface State {
  target: ManagedKeyTarget; generation: number; rotationCount?: number; expiresAt?: string;
  revoked?: boolean;
  state: ManagedKeyTargetStatus['state']; chain: Promise<void>; deadline?: ReturnType<typeof setTimeout>;
}

function sameTarget(left: ManagedKeyTarget, right: ManagedKeyTarget): boolean {
  return left.id === right.id && left.keyId === right.keyId && left.output === right.output && left.owner === right.owner && left.mode === right.mode;
}

/** Event/reconnect driven state machine. Timers only enforce already known expiry. */
export class ManagedKeyTargets {
  private config: TargetConfig;
  private readonly states = new Map<string, State>();
  private connectedNow = false;
  private supported = false;
  private stopped = false;
  private epoch = 0;
  private own?: ManagedKeyTargetState['own'];
  private ownRevoked = false;
  private ownChain: Promise<void> = Promise.resolve();
  private ownDeadline?: ReturnType<typeof setTimeout>;
  private readonly buffered: ManagedKeyTargetEvent[] = [];
  private reconciling = false;

  constructor(private readonly deps: Dependencies) {
    this.config = deps.config;
    for (const target of this.config.managedKeyTargets ?? []) {
      const applied = deps.initial?.applied.find(item => item.targetId === target.id && item.keyId === target.keyId);
      const sameSpec = applied?.target && sameTarget(applied.target, target);
      const state: State = { target, generation: 0, rotationCount: sameSpec ? applied.rotationCount : undefined, expiresAt: sameSpec ? applied.expiresAt : undefined, state: 'initializing', chain: Promise.resolve() };
      this.states.set(target.id, state);
      if (state.expiresAt && state.rotationCount !== undefined) this.armDeadline(state, state.expiresAt, state.rotationCount);
    }
    this.own = deps.initial?.own;
    if (this.own?.expiresAt) this.setOwnAuthorization(this.own.expiresAt);
  }
  status(): ManagedKeyTargetStatus[] {
    return [...this.states.values()].map(state => ({ targetId: state.target.id, keyId: state.target.keyId, rotationCount: state.rotationCount, expiresAt: state.expiresAt, state: state.state }));
  }
  private save(): void {
    this.deps.persist?.({
      applied: [...this.states.values()].filter(state => state.rotationCount !== undefined && state.state !== 'revoked').map(state => ({ targetId: state.target.id, keyId: state.target.keyId, rotationCount: state.rotationCount ?? 0, expiresAt: state.expiresAt, target: state.target })),
      own: this.own,
    });
  }
  private identity(): { agentId: string; hostConfigId: string; version: number } {
    if (!this.config.tenantId || !this.config.agentId || !this.config.hostConfigId || this.config.configVersion === undefined) throw new Error('REENROLLMENT_REQUIRED');
    return { agentId: this.config.agentId, hostConfigId: this.config.hostConfigId, version: this.config.configVersion };
  }
  async connected(capabilities: string[]): Promise<void> {
    if (this.stopped || this.ownRevoked) return;
    this.connectedNow = true; this.supported = capabilities.includes(MANAGED_KEY_TARGET_CAPABILITY);
    if (!this.supported) { for (const state of this.states.values()) state.state = 'unsupported'; return; }
    this.reconciling = true;
    const epoch = this.epoch;
    try {
      const identity = this.identity();
      const response = await this.deps.reconcile({ agentId: identity.agentId, targetConfigVersion: identity.version,
        applied: [...this.states.values()].filter(state => state.rotationCount !== undefined && this.deps.writer.isValid(state.target)).map(state => ({ targetId: state.target.id, keyId: state.target.keyId, rotationCount: state.rotationCount ?? 0 })),
        ...(this.own ? { own: { keyId: this.own.keyId, rotationCount: this.own.rotationCount } } : {}),
      });
      if (epoch !== this.epoch || this.stopped) return;
      if (response.tenantId !== this.config.tenantId || response.hostConfigId !== identity.hostConfigId) throw new Error('Reconciliation identity mismatch');
      if (response.configChanged || response.targetConfigVersion !== identity.version) { await this.deps.configChanged?.(); return; }
      if (response.ownChanged && this.deps.ownBind && this.deps.ownMaterial) {
        const material = await this.deps.ownBind();
        if (epoch !== this.epoch || material.tenantId !== this.config.tenantId || material.keyId !== response.ownChanged.keyId || material.rotationCount < response.ownChanged.rotationCount) throw new Error('Own identity mismatch');
        await this.deps.ownMaterial(material);
        this.ownApplied({ keyId: material.keyId, rotationCount: material.rotationCount, expiresAt: material.authorizedUntil ?? material.expiresAt });
      }
      for (const removed of response.removed) {
        const state = this.states.get(removed.targetId);
        if (state?.target.keyId === removed.keyId) this.revoke(state);
      }
      await Promise.all(response.changed.map(change => {
        const state = this.states.get(change.targetId);
        return state?.target.keyId === change.keyId ? this.enqueue(state, change.rotationCount) : Promise.resolve();
      }));
      for (const state of this.states.values()) if (state.state === 'stale' && this.deps.writer.isValid(state.target)) state.state = 'current';
    } catch (error) {
      if ((error as { code?: string }).code === 'REENROLLMENT_REQUIRED' || [401, 403].includes((error as { statusCode?: number }).statusCode ?? 0)) this.setOwnAuthorization(new Date(0).toISOString());
      else if ((error as { code?: string }).code === 'TARGET_CONFIG_CHANGED') { this.epoch++; await this.deps.configChanged?.(); }
      else for (const state of this.states.values()) if (state.state !== 'revoked') state.state = 'failed';
    }
    finally {
      this.reconciling = false;
      const events = this.buffered.splice(0);
      for (const event of events) await this.handleEvent(event);
    }
  }
  disconnected(): void {
    this.connectedNow = false;
    for (const state of this.states.values()) if (state.state === 'current') state.state = 'stale';
  }
  async handleEvent(event: ManagedKeyTargetEvent): Promise<void> {
    if (this.stopped || !this.supported || !event.deliveryId || !Number.isSafeInteger(event.rotationCount) || event.rotationCount < 0 || event.tenantId !== this.config.tenantId || event.hostConfigId !== this.config.hostConfigId) return;
    if (event.targetConfigVersion < (this.config.configVersion ?? 0)) return;
    if (event.targetConfigVersion > (this.config.configVersion ?? 0)) {
      this.epoch++;
      if (event.event === 'managed-key-target.revoked') {
        if (event.targetId === '$self' && this.own?.keyId === event.keyId) this.setOwnAuthorization(new Date(0).toISOString());
        const existing = this.states.get(event.targetId);
        if (existing?.target.keyId === event.keyId && event.rotationCount >= (existing.rotationCount ?? 0)) {
          this.revoke(existing);
          if (existing.state === 'revoked') this.ack(event, 'removed', event.rotationCount);
        }
      }
      await this.deps.configChanged?.(); return;
    }
    if (event.targetId === '$self') { await this.handleOwnEvent(event); return; }
    const state = this.states.get(event.targetId);
    if (!state || state.target.keyId !== event.keyId) return;
    if (event.event === 'managed-key-target.revoked') {
      if (state.rotationCount !== undefined && event.rotationCount < state.rotationCount) return;
      this.revoke(state); if (state.state === 'revoked') this.ack(event, 'removed', event.rotationCount); return;
    }
    if (this.reconciling) { this.buffered.push(event); return; }
    if (state.revoked || state.state === 'reenrollment_required') return;
    if (state.rotationCount !== undefined && event.rotationCount <= state.rotationCount && this.deps.writer.isValid(state.target)) {
      if (event.rotationCount === state.rotationCount && !this.tightenTargetDeadline(state, event)) return;
      if (state.revoked) { if (state.state === 'revoked') this.ack(event, 'removed', state.rotationCount); }
      else this.ack(event, 'applied', state.rotationCount);
      return;
    }
    // The announced grace only fences material already installed before this event.
    if (state.rotationCount !== undefined && state.rotationCount < event.rotationCount - 1) this.retirePredecessor(state);
    else if (event.graceExpiresAt && state.rotationCount === event.rotationCount - 1) this.armDeadline(state, event.graceExpiresAt, state.rotationCount, true);
    await this.enqueue(state, event.rotationCount, event);
  }
  private async handleOwnEvent(event: ManagedKeyTargetEvent): Promise<void> {
    if (event.targetConfigVersion !== this.config.configVersion || (this.own && event.keyId !== this.own.keyId)) return;
    if (event.event === 'managed-key-target.revoked') {
      this.setOwnAuthorization(new Date(0).toISOString());
      if ([...this.states.values()].every(state => state.state === 'reenrollment_required')) this.ack(event, 'removed', event.rotationCount);
      return;
    }
    if (this.ownRevoked || !this.deps.ownBind || !this.deps.ownMaterial) return;
    if (this.reconciling) { this.buffered.push(event); return; }
    const epoch = this.epoch;
    const run = async (): Promise<void> => {
      if (epoch !== this.epoch || this.ownRevoked || this.stopped) return;
      if (this.own && event.rotationCount <= this.own.rotationCount) {
        if (event.rotationCount === this.own.rotationCount && (event.expiresAt || event.authorizedUntil)) {
          const deadline = Math.min(this.own.expiresAt ? Date.parse(this.own.expiresAt) : Infinity, ...[event.expiresAt, event.authorizedUntil].filter((value): value is string => value !== undefined).map(value => Date.parse(value)));
          if (!Number.isFinite(deadline)) return;
          this.ownApplied({ ...this.own, expiresAt: new Date(deadline).toISOString() });
        }
        this.ack(event, this.ownRevoked ? 'removed' : 'applied', this.own.rotationCount); return;
      }
      if (this.own && this.own.rotationCount < event.rotationCount - 1) { this.setOwnAuthorization(new Date(0).toISOString()); return; }
      if (event.graceExpiresAt && this.own?.rotationCount === event.rotationCount - 1) this.setOwnAuthorization(event.graceExpiresAt);
      try {
        const material = await this.deps.ownBind?.();
        if (!material || epoch !== this.epoch || this.ownRevoked || this.stopped) return;
        if (material.tenantId !== this.config.tenantId || material.keyId !== event.keyId || material.rotationCount < event.rotationCount) throw new Error('Own identity mismatch');
        await this.deps.ownMaterial?.(material);
        if (epoch !== this.epoch || this.ownRevoked || this.stopped) return;
        this.ownApplied({ keyId: material.keyId, rotationCount: material.rotationCount, expiresAt: material.authorizedUntil ?? material.expiresAt });
        this.ack(event, 'applied', material.rotationCount);
      } catch (error) {
        if ((error as { code?: string }).code === 'REENROLLMENT_REQUIRED' || [401, 403, 410].includes((error as { statusCode?: number }).statusCode ?? 0)) this.setOwnAuthorization(new Date(0).toISOString());
        else if ((error as { code?: string }).code === 'TARGET_CONFIG_CHANGED') { this.epoch++; await this.deps.configChanged?.(); }
        else this.disconnected();
      }
    };
    this.ownChain = this.ownChain.then(run, run); await this.ownChain;
  }
  private tightenTargetDeadline(state: State, event: ManagedKeyTargetEvent): boolean {
    if (!event.expiresAt && !event.authorizedUntil) return true;
    const supplied = [event.expiresAt, event.authorizedUntil].filter((value): value is string => value !== undefined).map(value => Date.parse(value));
    if (supplied.some(value => !Number.isFinite(value))) { state.state = 'failed'; return false; }
    const deadline = Math.min(state.expiresAt ? Date.parse(state.expiresAt) : Infinity, ...supplied);
    state.expiresAt = new Date(deadline).toISOString();
    this.armDeadline(state, state.expiresAt, state.rotationCount ?? 0);
    try { this.save(); return true; } catch { state.state = 'failed'; return false; }
  }
  private ack(event: ManagedKeyTargetEvent, outcome: 'applied' | 'removed', rotationCount: number): void {
    try { this.deps.acknowledge({ type: 'managed-key-target.ack', deliveryId: event.deliveryId, hostConfigId: event.hostConfigId, targetId: event.targetId, targetConfigVersion: event.targetConfigVersion, keyId: event.keyId, rotationCount, outcome }); } catch { /* Lost ACK is replayed; installed revision stays authoritative. */ }
  }
  private enqueue(state: State, minimumRotationCount: number, event?: ManagedKeyTargetEvent): Promise<void> {
    const generation = state.generation; const epoch = this.epoch;
    const run = async (): Promise<void> => {
      const current = (): boolean => !this.stopped && !state.revoked && epoch === this.epoch && generation === state.generation && state.state !== 'revoked' && state.state !== 'reenrollment_required';
      if (!current()) return;
      if (state.rotationCount !== undefined && minimumRotationCount <= state.rotationCount && this.deps.writer.isValid(state.target)) { if (event) this.ack(event, 'applied', state.rotationCount); return; }
      try {
        const identity = this.identity();
        const response = await this.deps.bind(state.target.id, { agentId: identity.agentId, targetConfigVersion: identity.version, keyId: state.target.keyId, minimumRotationCount });
        if (!current()) return;
        const material = response.material;
        if (response.hostConfigId !== identity.hostConfigId || response.targetId !== state.target.id || response.targetConfigVersion !== identity.version || material.tenantId !== this.config.tenantId || material.keyId !== state.target.keyId || !Number.isSafeInteger(material.rotationCount) || material.rotationCount < Math.max(minimumRotationCount, state.rotationCount ?? 0) || !material.key) throw new Error('Invalid bind identity or revision');
        const deadline = Math.min(state.expiresAt ? Date.parse(state.expiresAt) : Infinity, Date.parse(material.expiresAt), Date.parse(material.authorizedUntil ?? material.expiresAt), this.own?.expiresAt ? Date.parse(this.own.expiresAt) : Infinity);
        if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Material authorization expired');
        this.deps.writer.write(state.target, material.key, current);
        if (!current()) return;
        state.rotationCount = material.rotationCount; state.expiresAt = new Date(deadline).toISOString(); state.state = this.connectedNow ? 'current' : 'stale';
        this.armDeadline(state, state.expiresAt, material.rotationCount); this.save();
        if (event) this.ack(event, 'applied', material.rotationCount);
      } catch (error) {
        if (!current()) return;
        const statusCode = (error as { statusCode?: number }).statusCode;
        if ((error as { code?: string }).code === 'REENROLLMENT_REQUIRED' || statusCode === 401) this.setOwnAuthorization(new Date(0).toISOString());
        else if (statusCode === 403 || statusCode === 404 || statusCode === 410) this.revoke(state);
        else if ((error as { code?: string }).code === 'TARGET_CONFIG_CHANGED') { this.epoch++; await this.deps.configChanged?.(); }
        else state.state = 'failed';
      }
    };
    state.chain = state.chain.then(run, run); return state.chain;
  }
  private armDeadline(state: State, expiresAt: string, rotationCount: number, predecessor = false): void {
    if (state.deadline) clearTimeout(state.deadline);
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return;
    const expire = (): void => {
      if (Date.now() < deadline) { state.deadline = setTimeout(expire, Math.min(deadline - Date.now(), 2147483647)); state.deadline.unref?.(); return; }
      if (state.rotationCount === rotationCount) {
        if (predecessor) {
          this.retirePredecessor(state);
        } else this.revoke(state);
      }
    };
    if (deadline <= Date.now()) { expire(); return; }
    state.deadline = setTimeout(expire, Math.max(0, Math.min(deadline - Date.now(), 2147483647))); state.deadline.unref?.();
  }
  private retirePredecessor(state: State): void {
    try { this.deps.writer.remove(state.target); state.rotationCount = undefined; state.state = 'failed'; this.save(); }
    catch { state.state = 'failed'; }
  }
  private revoke(state: State): void {
    state.revoked = true; state.generation++; if (state.deadline) clearTimeout(state.deadline); state.state = 'revoked';
    try { this.deps.writer.remove(state.target); this.save(); } catch { state.state = 'failed'; }
  }
  ownApplied(own: { keyId: string; rotationCount: number; expiresAt: string }): void {
    if (this.ownRevoked) return;
    const deadline = Math.min(Date.parse(own.expiresAt), this.own?.keyId === own.keyId && this.own.expiresAt ? Date.parse(this.own.expiresAt) : Infinity);
    if (!Number.isFinite(deadline)) throw new Error('Invalid own authority deadline');
    this.own = { ...own, expiresAt: new Date(deadline).toISOString() }; this.setOwnAuthorization(this.own.expiresAt as string); this.save();
  }
  setOwnAuthorization(expiresAt: string): void {
    if (this.ownDeadline) clearTimeout(this.ownDeadline);
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return;
    const expire = (): void => {
      if (Date.now() < deadline) { this.ownDeadline = setTimeout(expire, Math.min(deadline - Date.now(), 2147483647)); this.ownDeadline.unref?.(); return; }
      this.epoch++; this.ownRevoked = true;
      for (const state of this.states.values()) { this.revoke(state); if (state.state === 'revoked') state.state = 'reenrollment_required'; }
    };
    if (deadline <= Date.now()) { expire(); return; }
    this.ownDeadline = setTimeout(expire, Math.max(0, Math.min(deadline - Date.now(), 2147483647))); this.ownDeadline.unref?.();
  }
  reconfigure(config: TargetConfig): void {
    this.epoch++;
    for (const [id, state] of this.states) {
      const next = config.managedKeyTargets?.find(target => target.id === id);
      if (!next || !sameTarget(next, state.target)) { this.revoke(state); this.states.delete(id); }
    }
    this.config = config;
    for (const target of config.managedKeyTargets ?? []) if (!this.states.has(target.id)) this.states.set(target.id, { target, generation: 0, state: 'initializing', chain: Promise.resolve() });
  }
  stop(): void {
    this.stopped = true; this.epoch++; if (this.ownDeadline) clearTimeout(this.ownDeadline);
    for (const state of this.states.values()) if (state.deadline) clearTimeout(state.deadline);
  }
}
