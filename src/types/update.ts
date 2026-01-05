// Path: zn-vault-agent/src/types/update.ts

/**
 * Simplified Update Types for npm-based Auto-Update
 *
 * Replaces the complex S3/GPG update system (~170 lines) with
 * a simple npm-based approach (~30 lines).
 */

export interface NpmVersionInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export type UpdateChannel = 'latest' | 'beta' | 'next';

export interface UpdateConfig {
  enabled: boolean;
  checkIntervalMs: number;
  channel: UpdateChannel;
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  channel: 'latest',
};
