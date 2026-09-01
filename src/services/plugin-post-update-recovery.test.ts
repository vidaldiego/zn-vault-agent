import { describe, expect, it, vi } from 'vitest';
import {
  PAYARA_PLUGIN_CHANNEL,
  PAYARA_PLUGIN_PACKAGE,
  PluginUpdateRailError,
  inspectPayaraPostUpdateRecoveryEvidence,
  type PayaraPostUpdateRecoveryRail,
  type PluginUpdateActiveOperation,
  type PluginUpdateLocalTerminal,
  type PluginUpdateReceipt,
} from './plugin-update-rail.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTED_AT = '2026-09-01T01:00:00.000Z';

const active: PluginUpdateActiveOperation = {
  requestId: REQUEST_ID,
  package: PAYARA_PLUGIN_PACKAGE,
  channel: PAYARA_PLUGIN_CHANNEL,
  expectedCurrentVersion: '2.9.0',
  expectedVersion: '3.0.0',
  requestedAt: REQUESTED_AT,
};

const receipt: PluginUpdateReceipt = {
  requestId: REQUEST_ID,
  package: PAYARA_PLUGIN_PACKAGE,
  channel: PAYARA_PLUGIN_CHANNEL,
  previousVersion: '2.9.0',
  targetVersion: '3.0.0',
  installedVersion: '3.0.0',
  success: true,
  requestedAt: REQUESTED_AT,
  startedAt: '2026-09-01T01:00:01.000Z',
  finishedAt: '2026-09-01T01:00:02.000Z',
  reason: 'installed',
};

function rail(overrides: Partial<{
  active: PluginUpdateActiveOperation | null;
  receipt: PluginUpdateReceipt | null;
  terminal: PluginUpdateLocalTerminal | null;
  marker: boolean;
}> = {}): PayaraPostUpdateRecoveryRail {
  const state = {
    active,
    receipt,
    terminal: null,
    marker: true,
    ...overrides,
  };
  return {
    readActive: vi.fn(() => state.active),
    readReceipt: vi.fn(() => state.receipt),
    readLocalTerminal: vi.fn(() => state.terminal),
    hasRestartMarker: vi.fn(() => state.marker),
  };
}

describe('Payara post-update recovery evidence', () => {
  it('recognizes only the exact pending root-attested 2.x to 3.x tuple', () => {
    expect(inspectPayaraPostUpdateRecoveryEvidence(rail())).toEqual({
      requestId: REQUEST_ID,
      previousVersion: '2.9.0',
      targetVersion: '3.0.0',
    });
  });

  it.each([
    ['active operation', { active: null }],
    ['successful receipt', { receipt: null }],
    ['successful receipt', { receipt: { ...receipt, success: false } }],
    ['restart marker', { marker: false }],
  ] as const)('does not authorize incomplete evidence without a %s', (_label, override) => {
    expect(inspectPayaraPostUpdateRecoveryEvidence(rail(override))).toBeNull();
  });

  it('does not replay an operation that already has a local terminal', () => {
    const terminal: PluginUpdateLocalTerminal = {
      requestId: REQUEST_ID,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: '2.9.0',
      targetVersion: '3.0.0',
      installedVersion: '3.0.0',
      success: true,
      requestedAt: REQUESTED_AT,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      code: 'STARTUP_CONFIRMED',
    };
    expect(inspectPayaraPostUpdateRecoveryEvidence(rail({ terminal }))).toBeNull();
  });

  it.each([
    ['requestId', { requestId: '22222222-2222-4222-8222-222222222222' }],
    ['previousVersion', { previousVersion: '2.8.0' }],
    ['targetVersion', { targetVersion: '3.0.1', installedVersion: '3.0.1' }],
    ['installedVersion', { installedVersion: '3.0.1' }],
    ['requestedAt', { requestedAt: '2026-09-01T01:00:00.001Z' }],
  ] as const)('fails closed when receipt %s contradicts active', (_label, override) => {
    expect(() => inspectPayaraPostUpdateRecoveryEvidence(rail({
      receipt: { ...receipt, ...override },
    }))).toThrowError(PluginUpdateRailError);
  });

  it('rejects a same-major operation as outside the bounded bootstrap rail', () => {
    expect(() => inspectPayaraPostUpdateRecoveryEvidence(rail({
      active: {
        ...active,
        expectedCurrentVersion: '3.0.0',
        expectedVersion: '3.0.1',
      },
    }))).toThrow('not an exact Payara 2.x to 3.x operation');
  });

  it('propagates a corrupt restart marker as fail-closed evidence', () => {
    const corrupt = rail();
    vi.mocked(corrupt.hasRestartMarker).mockImplementation(() => {
      throw new PluginUpdateRailError('INVALID_RESTART_MARKER', 'Invalid restart marker');
    });
    expect(() => inspectPayaraPostUpdateRecoveryEvidence(corrupt)).toThrow(
      'Invalid restart marker'
    );
  });
});
