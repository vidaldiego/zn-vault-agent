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
  ownLimit?: { keyId: string; expiresAt: string };
  applied: (ManagedKeyRevision & { expiresAt?: string; predecessorExpiresAt?: string; target?: ManagedKeyTarget })[];
  own?: { keyId: string; rotationCount: number; expiresAt?: string; predecessorExpiresAt?: string };
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
  target: ManagedKeyTarget; generation: number; rotationCount?: number; expiresAt?: string; predecessorExpiresAt?: string;
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
  private requiredConfigVersion = 0;
  private configRefreshRequired = false;
  private own?: ManagedKeyTargetState['own'];
  private ownLimit?: ManagedKeyTargetState['ownLimit'];
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
      const state: State = { target, generation: 0, rotationCount: sameSpec ? applied.rotationCount : undefined, expiresAt: sameSpec ? applied.expiresAt : undefined, predecessorExpiresAt: sameSpec ? applied.predecessorExpiresAt : undefined, state: 'initializing', chain: Promise.resolve() };
      this.states.set(target.id, state);
      if (state.expiresAt && state.rotationCount !== undefined) this.armDeadline(state, state.expiresAt, state.rotationCount);
    }
    this.own = deps.initial?.own;
    this.ownLimit = deps.initial?.ownLimit;
    if (this.ownLimit) this.setOwnAuthorization(this.ownLimit.expiresAt);
    if (this.own?.expiresAt || this.own?.predecessorExpiresAt) this.setOwnAuthorization(this.own.predecessorExpiresAt ?? this.own.expiresAt as string);
  }
  status(): ManagedKeyTargetStatus[] {
    return [...this.states.values()].map(state => ({ targetId: state.target.id, keyId: state.target.keyId, rotationCount: state.rotationCount, expiresAt: state.predecessorExpiresAt ?? state.expiresAt, state: state.state }));
  }
  private save(): void {
    this.deps.persist?.({
      applied: [...this.states.values()].filter(state => state.rotationCount !== undefined && state.state !== 'revoked').map(state => ({ targetId: state.target.id, keyId: state.target.keyId, rotationCount: state.rotationCount ?? 0, expiresAt: state.expiresAt, predecessorExpiresAt: state.predecessorExpiresAt, target: state.target })),
      own: this.own,
      ownLimit: this.ownLimit,
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
      for (const removed of response.removed) {
        const state = this.states.get(removed.targetId);
        if (state?.target.keyId === removed.keyId) this.revoke(state);
      }
      if (response.configChanged || response.targetConfigVersion !== identity.version) {
        this.requireConfiguration(response.targetConfigVersion); await this.deps.configChanged?.(); return;
      }
      if (!this.configurationCurrent()) return;
      if (response.ownChanged && this.deps.ownBind && this.deps.ownMaterial) {
        if (this.own && (this.own.keyId !== response.ownChanged.keyId || this.own.rotationCount < response.ownChanged.rotationCount - 1)) { this.setOwnAuthorization(new Date(0).toISOString()); return; }
        const material = await this.deps.ownBind();
        if (epoch !== this.epoch || material.tenantId !== this.config.tenantId || material.keyId !== response.ownChanged.keyId || material.rotationCount < response.ownChanged.rotationCount) throw new Error('Own identity mismatch');
        if (!this.observeOwnRevision({ keyId: material.keyId, rotationCount: material.rotationCount, expiresAt: material.expiresAt, authorizedUntil: material.authorizedUntil }) || !this.ownAuthorityCurrent(material.keyId)) return;
        await this.deps.ownMaterial(material);
        this.ownApplied({ keyId: material.keyId, rotationCount: material.rotationCount, expiresAt: material.authorizedUntil ?? material.expiresAt });
      }
      await Promise.all(response.changed.map(change => {
        const state = this.states.get(change.targetId);
        if (!state || state.target.keyId !== change.keyId || !this.observeRevision(state, change.rotationCount, change)) return Promise.resolve();
        return this.enqueue(state, change.rotationCount);
      }));
      for (const state of this.states.values()) if (state.state === 'stale' && this.deps.writer.isValid(state.target)) state.state = 'current';
    } catch (error) {
      if ((error as { code?: string }).code === 'REENROLLMENT_REQUIRED' || [401, 403].includes((error as { statusCode?: number }).statusCode ?? 0)) this.setOwnAuthorization(new Date(0).toISOString());
      else if ((error as { code?: string }).code === 'TARGET_CONFIG_CHANGED') { this.requireConfiguration(); await this.deps.configChanged?.(); }
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
      this.requireConfiguration(event.targetConfigVersion);
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
    if (!this.configurationCurrent()) return;
    if (!this.observeRevision(state, event.rotationCount, event)) return;
    if (this.reconciling) { this.buffered.push(event); return; }
    if (state.revoked || state.state === 'reenrollment_required') return;
    if (state.rotationCount !== undefined && event.rotationCount <= state.rotationCount && this.deps.writer.isValid(state.target)) {
      if (event.rotationCount === state.rotationCount && !this.tightenTargetDeadline(state, event)) return;
      if (state.revoked) { if (state.state === 'revoked') this.ack(event, 'removed', state.rotationCount); }
      else this.ack(event, 'applied', state.rotationCount);
      return;
    }
    await this.enqueue(state, event.rotationCount, event);
  }
  private async handleOwnEvent(event: ManagedKeyTargetEvent): Promise<void> {
    if (event.targetConfigVersion !== this.config.configVersion || (this.own && event.keyId !== this.own.keyId)) return;
    if (event.event === 'managed-key-target.revoked') {
      this.setOwnAuthorization(new Date(0).toISOString());
      if ([...this.states.values()].every(state => state.state === 'reenrollment_required')) this.ack(event, 'removed', event.rotationCount);
      return;
    }
    if (!this.configurationCurrent() || this.ownRevoked || !this.deps.ownBind || !this.deps.ownMaterial) return;
    if (!this.observeOwnRevision(event)) return;
    if (this.reconciling) { this.buffered.push(event); return; }
    const epoch = this.epoch;
    const run = async (): Promise<void> => {
      if (epoch !== this.epoch || this.ownRevoked || this.stopped || !this.observeOwnRevision(event)) return;
      if (this.own && event.rotationCount <= this.own.rotationCount) {
        this.ack(event, this.ownRevoked ? 'removed' : 'applied', this.own.rotationCount); return;
      }
      try {
        const material = await this.deps.ownBind?.();
        if (!material || epoch !== this.epoch || this.ownRevoked || this.stopped) return;
        if (material.tenantId !== this.config.tenantId || material.keyId !== event.keyId || material.rotationCount < event.rotationCount) throw new Error('Own identity mismatch');
        if (!this.observeOwnRevision({ keyId: material.keyId, rotationCount: material.rotationCount, expiresAt: material.expiresAt, authorizedUntil: material.authorizedUntil }) || !this.ownAuthorityCurrent(material.keyId)) return;
        await this.deps.ownMaterial?.(material);
        if (epoch !== this.epoch || this.ownRevoked || this.stopped || !this.ownAuthorityCurrent(material.keyId)) return;
        this.ownApplied({ keyId: material.keyId, rotationCount: material.rotationCount, expiresAt: material.authorizedUntil ?? material.expiresAt });
        this.ack(event, 'applied', material.rotationCount);
      } catch (error) {
        if ((error as { code?: string }).code === 'REENROLLMENT_REQUIRED' || [401, 403, 410].includes((error as { statusCode?: number }).statusCode ?? 0)) this.setOwnAuthorization(new Date(0).toISOString());
        else if ((error as { code?: string }).code === 'TARGET_CONFIG_CHANGED') { this.requireConfiguration(); await this.deps.configChanged?.(); }
        else this.disconnected();
      }
    };
    this.ownChain = this.ownChain.then(run, run); await this.ownChain;
  }
  /** Own limits are admitted on receipt, independently of the serialized material callback. */
  private observeOwnRevision(event: { keyId: string; rotationCount: number; expiresAt?: string; authorizedUntil?: string; graceExpiresAt?: string }): boolean {
    if ((this.own && event.keyId !== this.own.keyId) || (this.ownLimit && event.keyId !== this.ownLimit.keyId)) return false;
    if (this.own && event.rotationCount < this.own.rotationCount) return this.ownAuthorityCurrent(event.keyId);
    const supplied = [event.expiresAt, event.authorizedUntil].filter((value): value is string => value !== undefined).map(value => Date.parse(value));
    if (supplied.some(value => !Number.isFinite(value))) { this.setOwnAuthorization(new Date(0).toISOString()); return false; }
    if (supplied.length) {
      const deadline = Math.min(this.own?.expiresAt ? Date.parse(this.own.expiresAt) : Infinity, this.ownLimit ? Date.parse(this.ownLimit.expiresAt) : Infinity, ...supplied);
      this.ownLimit = { keyId: event.keyId, expiresAt: new Date(deadline).toISOString() };
      if (this.own) this.own.expiresAt = this.ownLimit.expiresAt;
      this.setOwnAuthorization(this.ownLimit.expiresAt);
      try { this.save(); } catch { this.setOwnAuthorization(new Date(0).toISOString()); return false; }
    }
    if (this.own && this.own.rotationCount < event.rotationCount - 1) { this.setOwnAuthorization(new Date(0).toISOString()); return false; }
    if (event.graceExpiresAt && this.own?.rotationCount === event.rotationCount - 1) this.armOwnPredecessor(event.graceExpiresAt);
    return this.ownAuthorityCurrent(event.keyId);
  }
  private ownAuthorityCurrent(keyId: string): boolean {
    if (this.ownRevoked || (this.own && this.own.keyId !== keyId) || (this.ownLimit && this.ownLimit.keyId !== keyId)) return false;
    const deadline = Math.min(this.own?.expiresAt ? Date.parse(this.own.expiresAt) : Infinity, this.own?.predecessorExpiresAt ? Date.parse(this.own.predecessorExpiresAt) : Infinity, this.ownLimit ? Date.parse(this.ownLimit.expiresAt) : Infinity);
    if (Number.isNaN(deadline) || deadline <= Date.now()) { this.setOwnAuthorization(new Date(0).toISOString()); return false; }
    return true;
  }
  private configurationCurrent(): boolean {
    return !this.configRefreshRequired && (this.config.configVersion ?? 0) >= this.requiredConfigVersion;
  }
  private requireConfiguration(version = (this.config.configVersion ?? 0) + 1): void {
    this.requiredConfigVersion = Math.max(this.requiredConfigVersion, version, (this.config.configVersion ?? 0) + 1);
    this.configRefreshRequired = true; this.epoch++;
    for (const state of this.states.values()) if (state.state === 'current') state.state = 'stale';
  }
  private observeRevision(state: State, rotationCount: number, limits: { expiresAt?: string; authorizedUntil?: string; graceExpiresAt?: string }): boolean {
    if (!Number.isSafeInteger(rotationCount) || rotationCount < 0 || state.revoked) return false;
    if (state.rotationCount !== undefined && rotationCount < state.rotationCount) return true;
    if (!this.tightenTargetDeadline(state, limits) || state.revoked) return false;
    if (state.rotationCount !== undefined && state.rotationCount < rotationCount - 1) this.retirePredecessor(state);
    else if (limits.graceExpiresAt && state.rotationCount === rotationCount - 1) this.armDeadline(state, limits.graceExpiresAt, state.rotationCount, true);
    return !state.revoked;
  }
  private tightenTargetDeadline(state: State, event: { expiresAt?: string; authorizedUntil?: string }): boolean {
    if (!event.expiresAt && !event.authorizedUntil) return true;
    const supplied = [event.expiresAt, event.authorizedUntil].filter((value): value is string => value !== undefined).map(value => Date.parse(value));
    if (supplied.some(value => !Number.isFinite(value))) { state.state = 'failed'; return false; }
    const deadline = Math.min(state.expiresAt ? Date.parse(state.expiresAt) : Infinity, ...supplied);
    state.expiresAt = new Date(deadline).toISOString();
    this.armDeadline(state, state.expiresAt, state.rotationCount ?? 0);
    try { this.save(); return true; } catch { this.revoke(state); return false; }
  }
  private ack(event: ManagedKeyTargetEvent, outcome: 'applied' | 'removed', rotationCount: number): void {
    try { this.deps.acknowledge({ type: 'managed-key-target.ack', deliveryId: event.deliveryId, hostConfigId: event.hostConfigId, targetId: event.targetId, targetConfigVersion: event.targetConfigVersion, keyId: event.keyId, rotationCount, outcome }); } catch { /* Lost ACK is replayed; installed revision stays authoritative. */ }
  }
  private enqueue(state: State, minimumRotationCount: number, event?: ManagedKeyTargetEvent): Promise<void> {
    const generation = state.generation; const epoch = this.epoch;
    const run = async (): Promise<void> => {
      const current = (): boolean => !this.stopped && this.configurationCurrent() && !state.revoked && epoch === this.epoch && generation === state.generation && state.state !== 'revoked' && state.state !== 'reenrollment_required';
      if (!current()) return;
      if (event && !this.observeRevision(state, event.rotationCount, event)) return;
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
        state.rotationCount = material.rotationCount; state.predecessorExpiresAt = undefined; state.expiresAt = new Date(deadline).toISOString(); state.state = this.connectedNow ? 'current' : 'stale';
        this.armDeadline(state, state.expiresAt, material.rotationCount);
        try { this.save(); } catch { this.revoke(state); throw new Error('Applied revision metadata unavailable'); }
        if (event) this.ack(event, 'applied', material.rotationCount);
      } catch (error) {
        if (!current()) return;
        const statusCode = (error as { statusCode?: number }).statusCode;
        if ((error as { code?: string }).code === 'REENROLLMENT_REQUIRED' || statusCode === 401) this.setOwnAuthorization(new Date(0).toISOString());
        else if (statusCode === 403 || statusCode === 404 || statusCode === 410) this.revoke(state);
        else if ((error as { code?: string }).code === 'TARGET_CONFIG_CHANGED') { this.requireConfiguration(); await this.deps.configChanged?.(); }
        else state.state = 'failed';
      }
    };
    state.chain = state.chain.then(run, run); return state.chain;
  }
  private armDeadline(state: State, expiresAt: string, rotationCount: number, predecessor = false): void {
    const requested = Date.parse(expiresAt);
    if (!Number.isFinite(requested)) return;
    if (predecessor) {
      state.predecessorExpiresAt = new Date(Math.min(requested, state.expiresAt ? Date.parse(state.expiresAt) : Infinity, state.predecessorExpiresAt ? Date.parse(state.predecessorExpiresAt) : Infinity)).toISOString();
    }
    if (state.deadline) clearTimeout(state.deadline);
    const identityDeadline = state.expiresAt ? Date.parse(state.expiresAt) : requested;
    const predecessorDeadline = state.predecessorExpiresAt ? Date.parse(state.predecessorExpiresAt) : Infinity;
    const deadline = Math.min(identityDeadline, predecessorDeadline, requested);
    const expire = (): void => {
      if (Date.now() < deadline) { state.deadline = setTimeout(expire, Math.min(deadline - Date.now(), 2147483647)); state.deadline.unref?.(); return; }
      if (Date.now() >= identityDeadline) this.revoke(state);
      else if (state.rotationCount === rotationCount) this.retirePredecessor(state);
    };
    if (deadline <= Date.now()) { expire(); return; }
    state.deadline = setTimeout(expire, Math.max(0, Math.min(deadline - Date.now(), 2147483647))); state.deadline.unref?.();
    if (predecessor) { try { this.save(); } catch { this.revoke(state); } }
  }
  private retirePredecessor(state: State): void {
    try { this.deps.writer.remove(state.target); state.rotationCount = undefined; state.predecessorExpiresAt = undefined; state.state = 'failed'; this.save(); }
    catch { state.state = 'failed'; }
  }
  private revoke(state: State): void {
    state.revoked = true; state.generation++; if (state.deadline) clearTimeout(state.deadline); state.state = 'revoked';
    try { this.deps.writer.remove(state.target); this.save(); } catch { state.state = 'failed'; }
  }
  ownApplied(own: { keyId: string; rotationCount: number; expiresAt: string }): void {
    if (this.ownRevoked) return;
    if (this.ownLimit && own.keyId !== this.ownLimit.keyId) throw new Error('REENROLLMENT_REQUIRED');
    const deadline = Math.min(Date.parse(own.expiresAt), this.ownLimit ? Date.parse(this.ownLimit.expiresAt) : Infinity, this.own?.keyId === own.keyId && this.own.expiresAt ? Date.parse(this.own.expiresAt) : Infinity);
    if (!Number.isFinite(deadline)) throw new Error('Invalid own authority deadline');
    const predecessorExpiresAt = this.own?.keyId === own.keyId && this.own.rotationCount === own.rotationCount ? this.own.predecessorExpiresAt : undefined;
    this.own = { ...own, expiresAt: new Date(deadline).toISOString(), predecessorExpiresAt }; this.setOwnAuthorization(this.own.expiresAt as string);
    try { this.save(); } catch { this.setOwnAuthorization(new Date(0).toISOString()); throw new Error('Own revision metadata unavailable'); }
  }
  private armOwnPredecessor(expiresAt: string): void {
    if (!this.own) return;
    const deadline = Math.min(Date.parse(expiresAt), this.own.expiresAt ? Date.parse(this.own.expiresAt) : Infinity, this.own.predecessorExpiresAt ? Date.parse(this.own.predecessorExpiresAt) : Infinity);
    if (!Number.isFinite(deadline)) return;
    this.own.predecessorExpiresAt = new Date(deadline).toISOString();
    this.setOwnAuthorization(this.own.predecessorExpiresAt);
    try { this.save(); } catch { this.setOwnAuthorization(new Date(0).toISOString()); }
  }
  setOwnAuthorization(expiresAt: string): void {
    if (this.ownDeadline) clearTimeout(this.ownDeadline);
    const deadline = Math.min(Date.parse(expiresAt), this.ownLimit ? Date.parse(this.ownLimit.expiresAt) : Infinity, this.own?.expiresAt ? Date.parse(this.own.expiresAt) : Infinity, this.own?.predecessorExpiresAt ? Date.parse(this.own.predecessorExpiresAt) : Infinity);
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
    if ((config.configVersion ?? 0) < this.requiredConfigVersion) return;
    this.configRefreshRequired = false;
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
