// Path: src/lib/logger.ts
// Centralized Pino logger for zn-vault-agent

import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

const isDev = process.env.NODE_ENV !== 'production';
const logFile = process.env.LOG_FILE ?? (isDev ? undefined : '/var/log/zn-vault-agent/agent.log');

/**
 * Create file stream for logging if LOG_FILE is set
 */
function createFileStream(): pino.DestinationStream | undefined {
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
    return pino.destination({
      dest: logFile,
      sync: false, // Async writes for performance
      mkdir: true,
    });
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
 * - LOG_FILE: Path to log file (default: /var/log/zn-vault-agent/agent.log in prod)
 */
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
      paths: [
        'password',
        'apiKey',
        'token',
        'secret',
        'auth.password',
        'auth.apiKey',
        'config.auth.password',
        'config.auth.apiKey',
        'headers.authorization',
        'headers["x-api-key"]',
      ],
      censor: '[REDACTED]',
    },
    // Add timestamp in ISO format
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  // In production without transport, we can use multistream for file output
  !isDev && logFile ? createFileStream() : undefined
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

/**
 * Handle log rotation signal (USR1)
 * Reopens the log file destination
 */
export function setupLogRotation(): void {
  if (process.platform !== 'win32') {
    process.on('SIGUSR1', () => {
      logger.info('Received SIGUSR1, reopening log files');
      // Pino destination handles file reopening on next write
      logger.flush();
    });
  }
}

export type Logger = pino.Logger;
