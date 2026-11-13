# Managed key deadline snapshot correction

Local maintenance worktree, baseline b5c64b19 (agent1.23.5). No production,
release/version change, publish, remote commands or credential access.

Reconnect now sends the exact public deadline snapshot received for an installed
revision. Persisted `serverSnapshot` (targets) and `ownSnapshot` (own identity)
include rotationCount to prevent mixing snapshots with another revision. They
are separate from the earliest known enforced expiry/predecessor deadline.
A server extension can update the snapshot without extending local authority;
therefore the next reconnect compares equal rather than repeatedly reporting
metadata_changed. State serialization explicitly selects public fields only.

Full snapshots contain expiresAt and authorizedUntil. Absence of graceExpiresAt
means no predecessor grace. Own metadata fences authority before any target
async work. All target metadata is admitted before awaiting a self-bind. Equal
revision metadata changes perform no bind, material rewrite or fabricated ACK.
HTTP reconciliation has no deliveryId; only actual WS deliveries receive ACKs.
Existing revocation/config generation fences and late-bind guards remain active.

TDD evidence:

- Three initial real ManagedKeyTargets class regressions RED: target reconnect
  lacked snapshot; own equal-revision metadata caused self-bind; an ignored
  extension repeated metadata_changed on the next reconnect.
- Those three became GREEN with exact raw snapshots stored separately from the
  known minimum and equal-revision handling through metadata admission only.
- A full own-material DTO test exposed a missing predecessor-grace propagation
  before own installation (RED), then became GREEN while proving the new own
  material survives the predecessor grace deadline.
- Added checks cover own snapshot stability, no-grace target retirement, own
  explicit reenrollment outside grace and persistence excluding excess material.

Validation uses the cached Node20.20.2 binary and direct Vitest/TypeScript/ESLint
entrypoints. The pre-existing npm test wrapper still references an unavailable
sibling script; this change does not modify that harness or claim live-server
integration coverage. Unit fixtures use synthetic material and temporary files.

Final local gates on Node20.20.2: focal4 files43 tests PASS; full unit30 files489
tests PASS; tsc --noEmit PASS; tsc build PASS; ESLint0 errors /14 unchanged
warnings in child-process-manager.test.ts and dynamic-secrets/handler.test.ts.

Review follow-up: a reconnect announcing a newer config generation previously
returned into configChanged before target deadline admission. The exact RED
fixture installed a target with expiry+100s, received same-ID/key/count metadata
with expiry+1s and blocked reload: the file survived+1.001s and the old snapshot
remained. Matching target limits now admit synchronously before config reload;
the existing config fence still blocks all binds/material writes. The regression
checks removal while reload is pending, exact persisted snapshot and no extra
bind/self-bind or fabricated ACK. No wire or authority-extension change.

Review-fix gates on Node20.20.2: focal4 files44 tests PASS; full unit30 files490
tests PASS; typecheck/build PASS; lint0 errors /14 unchanged baseline warnings.
