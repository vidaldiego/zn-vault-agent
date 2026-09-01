// Path: src/lib/logger.ts
// Centralized Pino logger for zn-vault-agent

import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

const isDev = process.env.NODE_ENV !== 'production';
// systemd captures stdout in journald. File logging is opt-in so an
// unconfigured host cannot accumulate an unrotated duplicate log.
const logFile = process.env.LOG_FILE;

interface ReopenableDestination extends pino.DestinationStream {
  reopen(): void;
}

let fileDestination: ReopenableDestination | undefined;

/**
 * Credential values and credential-derived fragments must never reach an
 * output stream. Explicit fragment names are included as a defence in depth
 * for plugins that still attach the legacy managed-key prefix to a log object.
 */
export const SENSITIVE_LOG_PATHS: string[] = [
  'password',
  'apiKey',
  'bootstrapToken',
  'registrationToken',
  'reprovisionToken',
  'bearerToken',
  'token',
  'secret',
  'keyPrefix',
  'tokenPrefix',
  'valuePrefix',
  'oldPrefix',
  'newPrefix',
  'newKeyPrefix',
  'currentKeyPrefix',
  'backupPrefix',
  'expectedPrefix',
  'configKeyPrefix',
  'fileKeyPrefix',
  'currentPrefix',
  'auth.password',
  'auth.apiKey',
  'auth.bootstrapToken',
  'config.auth.password',
  'config.auth.apiKey',
  'config.auth.bootstrapToken',
  'response.apiKey',
  'response.token',
  'response.secret',
  'response.password',
  'headers.authorization',
  'headers["x-api-key"]',
  '*.keyPrefix',
  '*.tokenPrefix',
  '*.valuePrefix',
  '*.oldPrefix',
  '*.newPrefix',
  '*.newKeyPrefix',
  '*.currentKeyPrefix',
];

/**
 * Create file stream for logging if LOG_FILE is set
 */
function createFileStream(): ReopenableDestination | undefined {
  if (!logFile) return undefined;

  // Ensure log directory exists
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o750 });
    } catch {
      // Can't create log directory, skip file logging
      return undefined;
    }
  }

  try {
    fileDestination = pino.destination({
      dest: logFile,
      sync: false, // Async writes for performance
      mkdir: true,
    }) as ReopenableDestination;
    return fileDestination;
  } catch {
    return undefined;
  }
}

// Cache the result
let pinoPrettyAvailable: boolean | null = null;

/**
 * Create multi-stream transport for dual output (stdout + file)
 */
function createTransport(): pino.TransportSingleOptions | pino.TransportMultiOptions | undefined {
  if (isDev) {
    // Check if pino-pretty is available (sync check using require.resolve)
    if (pinoPrettyAvailable === null) {
      try {
        require.resolve('pino-pretty');
        pinoPrettyAvailable = true;
      } catch {
        pinoPrettyAvailable = false;
      }
    }

    if (pinoPrettyAvailable) {
      // Development: pretty print to stdout only
      return {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      };
    }
    // Fall through to JSON output if pino-pretty not available
  }

  // Production: JSON to stdout (for journald)
  // File output is handled separately via destination stream
  return undefined;
}

/**
 * Base logger instance
 *
 * In development: Uses pino-pretty with colorized output
 * In production: JSON logs to stdout (captured by journald) + optional file
 *
 * Configure via environment variables:
 * - LOG_LEVEL: trace, debug, info, warn, error, fatal (default: debug in dev, info in prod)
 * - LOG_FILE: Optional path that mirrors production JSON logs alongside journald
 */
const productionFileStream = !isDev && logFile ? createFileStream() : undefined;
const productionOutput = productionFileStream
  ? pino.multistream([
      { stream: process.stdout },
      { stream: productionFileStream },
    ])
  : undefined;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    transport: createTransport(),
    base: {
      service: 'zn-vault-agent',
      pid: process.pid,
    },
    // Redact sensitive fields
    redact: {
      paths: SENSITIVE_LOG_PATHS,
      censor: '[REDACTED]',
    },
    // Add timestamp in ISO format
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  // When LOG_FILE is explicit, retain journald stdout and mirror to the file.
  productionOutput
);

/**
 * Create a child logger with additional context
 *
 * @example
 * const log = createLogger({ module: 'deployer' });
 * log.info({ certId: 'xxx' }, 'Certificate deployed');
 */
export function createLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

// Pre-configured module loggers
export const wsLogger = createLogger({ module: 'websocket' });
export const apiLogger = createLogger({ module: 'api' });
export const deployLogger = createLogger({ module: 'deployer' });
export const configLogger = createLogger({ module: 'config' });
export const metricsLogger = createLogger({ module: 'metrics' });
export const healthLogger = createLogger({ module: 'health' });
export const execLogger = createLogger({ module: 'exec' });

/**
 * Flush logs and close file streams
 * Call this before process exit for clean shutdown
 */
export async function flushLogs(): Promise<void> {
  await new Promise((resolve) => {
    logger.flush();
    // Give some time for async writes to complete
    setTimeout(resolve, 100);
  });
}

/** Reopen an optional file destination after external log rotation. */
export function reopenLogDestination(
  destination: Pick<ReopenableDestination, 'reopen'> | undefined = fileDestination
): boolean {
  if (!destination) return false;
  destination.reopen();
  return true;
}

/**
 * Handle log rotation signal (USR1)
 * Reopens the log file destination
 */
export function setupLogRotation(): void {
  if (process.platform !== 'win32') {
    process.on('SIGUSR1', () => {
      logger.info('Received SIGUSR1, reopening log files');
      logger.flush((err) => {
        if (err) {
          logger.error({ err }, 'Could not flush logs before rotation');
          return;
        }
        try {
          reopenLogDestination();
        } catch (reopenError) {
          logger.error({ err: reopenError }, 'Could not reopen log file after rotation');
        }
      });
    });
  }
}

export type Logger = pino.Logger;
