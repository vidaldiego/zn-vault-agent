/** Host-scoped managed-key wire contract. Material DTOs must never reach logs or health. */
export const MANAGED_KEY_TARGET_CAPABILITY = 'managed-key-targets-v1';
export interface ManagedKeyTarget { id: string; keyId: string; output: string; owner: string; mode: string }
export interface ManagedKeyRevision { targetId: string; keyId: string; rotationCount: number }
export interface ManagedKeyMaterial {
  tenantId: string; keyId: string; name: string; key: string; rotationCount: number;
  expiresAt: string; graceExpiresAt?: string; nextRotationAt?: string; authorizedUntil?: string;
}
export interface ManagedKeyTargetsReconcileRequest {
  agentId: string; targetConfigVersion?: number; applied: ManagedKeyRevision[];
  own?: { keyId: string; rotationCount: number };
}
export interface ManagedKeyTargetsReconcileResponse {
  tenantId: string; hostConfigId: string; targetConfigVersion: number; configChanged: boolean;
  changed: (ManagedKeyRevision & { reason: 'initial' | 'rotated' | 'target_changed'; graceExpiresAt?: string })[];
  removed: { targetId: string; keyId: string; reason: 'removed' | 'revoked' }[];
  ownChanged?: { keyId: string; rotationCount: number; reason: 'initial' | 'rotated' };
}
export interface ManagedKeyTargetBindRequest {
  agentId: string; targetConfigVersion: number; keyId: string; minimumRotationCount?: number;
}
export interface ManagedKeyTargetBindResponse {
  hostConfigId: string; targetId: string; targetConfigVersion: number; material: ManagedKeyMaterial;
}
export interface ManagedKeyTargetEvent extends ManagedKeyRevision {
  event: 'managed-key-target.changed' | 'managed-key-target.revoked'; deliveryId: string;
  tenantId: string; hostConfigId: string; targetConfigVersion: number;
  /** Applies to the predecessor only, never the newly bound current material. */
  graceExpiresAt?: string;
  expiresAt?: string;
  authorizedUntil?: string;
}
export interface ManagedKeyTargetAck extends ManagedKeyRevision {
  type: 'managed-key-target.ack'; deliveryId: string; hostConfigId: string; targetConfigVersion: number;
  outcome: 'applied' | 'removed';
}
export interface ManagedKeyTargetStatus {
  targetId: string; keyId: string; rotationCount?: number; expiresAt?: string;
  state: 'initializing' | 'current' | 'stale' | 'failed' | 'revoked' | 'unsupported' | 'reenrollment_required';
}
