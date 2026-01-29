// Path: src/commands/types.ts
// Type definitions for Commander.js command options

/**
 * Options for the 'available' command
 */
export interface AvailableCommandOptions {
  json?: boolean;
}

/**
 * Options for the 'add' (certificate) command
 */
export interface CertAddCommandOptions {
  cert?: string;
  name?: string;
  combined?: string;
  certFile?: string;
  keyFile?: string;
  chainFile?: string;
  fullchainFile?: string;
  owner?: string;
  mode?: string;
  reloadCmd?: string;
  healthCmd?: string;
  yes?: boolean;
}

/**
 * Options for the 'update' (certificate) command
 */
export interface CertUpdateCommandOptions {
  name?: string;
  combined?: string;
  certFile?: string;
  keyFile?: string;
  chainFile?: string;
  fullchainFile?: string;
  owner?: string;
  mode?: string;
  reloadCmd?: string;
  healthCmd?: string;
}

/**
 * Options for the 'remove' (certificate) command
 */
export interface CertRemoveCommandOptions {
  force?: boolean;
}

/**
 * Options for the 'exec' command
 */
export interface ExecCommandOptions {
  secret?: string[];
  envFile?: string[];
  watch?: boolean;
  output?: string;
  inherit?: boolean;
}

/**
 * Options for the 'login' command
 */
export interface LoginCommandOptions {
  url?: string;
  apiKey?: string;
  managedKey?: string;
  bootstrapToken?: string;
  username?: string;
  password?: string;
  insecure?: boolean;
  yes?: boolean;
  skipTest?: boolean;
  config?: string;
  profile?: string;
}

/**
 * Options for the 'secrets add' command
 */
export interface SecretsAddCommandOptions {
  name?: string;
  format?: 'env' | 'json' | 'yaml' | 'raw' | 'template';
  output?: string;
  key?: string;
  template?: string;
  prefix?: string;
  owner?: string;
  mode?: string;
  reload?: string;
}

/**
 * Options for the 'secrets available' command
 */
export interface SecretsAvailableCommandOptions {
  json?: boolean;
}

/**
 * Options for the 'secrets remove' command
 */
export interface SecretsRemoveCommandOptions {
  force?: boolean;
}

/**
 * Options for the 'secrets list' command
 */
export interface SecretsListCommandOptions {
  json?: boolean;
}

/**
 * Options for the 'secrets sync' command
 */
export interface SecretsSyncCommandOptions {
  name?: string;
}

/**
 * Options for the 'start' command
 */
export interface StartCommandOptions {
  verbose?: boolean;
  healthPort?: number;
  validate?: boolean;
  foreground?: boolean;
  autoUpdate?: boolean;
  pluginAutoUpdate?: boolean;
  exec?: string;
  secret?: string[];
  secretFile?: string[];
  secretsToFiles?: boolean;
  restartOnChange?: boolean;
  restartDelay?: number;
  maxRestarts?: number;
  restartWindow?: number;
  // TLS options for HTTPS health server
  tls?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  tlsHttpsPort?: number;
  tlsKeepHttp?: boolean;
}

/**
 * Options for the 'sync' command
 */
export interface SyncCommandOptions {
  target?: string;
  force?: boolean;
  dryRun?: boolean;
}

/**
 * Options for the 'status' command
 */
export interface StatusCommandOptions {
  json?: boolean;
  port?: string;
}

/**
 * Options for the 'setup' command
 */
export interface SetupCommandOptions {
  uninstall?: boolean;
  purge?: boolean;
  skipUser?: boolean;
  yes?: boolean;
  user?: string;
  systemd?: boolean;
  launchd?: boolean;
  enableNow?: boolean;
}

/**
 * Options for the 'plugin' commands
 */
export interface PluginInstallCommandOptions {
  local?: boolean;
}

export interface PluginListCommandOptions {
  json?: boolean;
}
