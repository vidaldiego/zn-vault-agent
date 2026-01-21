// Path: src/utils/error.ts
// Error handling utilities - consolidate common error extraction patterns

/**
 * Extract error message from unknown error type.
 * Safely handles Error objects, strings, and other types.
 *
 * @param err - Unknown error value
 * @returns Error message string
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/**
 * Check if an error is retryable (network-related).
 * Identifies transient errors that may succeed on retry.
 *
 * @param err - Unknown error value
 * @returns true if error is retryable
 */
export function isRetryableError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase();
  return /econnrefused|enotfound|etimedout|socket hang up|econnreset|epipe|network/i.test(msg);
}

/**
 * Check if an error is an authentication error.
 *
 * @param err - Unknown error value
 * @returns true if error is auth-related
 */
export function isAuthError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase();
  return msg.includes('401') ||
         msg.includes('unauthorized') ||
         msg.includes('authentication') ||
         msg.includes('invalid api key') ||
         msg.includes('expired');
}

/**
 * Check if an error is a not found error.
 *
 * @param err - Unknown error value
 * @returns true if error is not found
 */
export function isNotFoundError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase();
  return msg.includes('404') || msg.includes('not found');
}

/**
 * Check if an error is a permission/access error.
 *
 * @param err - Unknown error value
 * @returns true if error is permission-related
 */
export function isPermissionError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase();
  return msg.includes('403') ||
         msg.includes('forbidden') ||
         msg.includes('permission') ||
         msg.includes('eacces');
}

/**
 * Check if an error is a rate limit error.
 *
 * @param err - Unknown error value
 * @returns true if error is rate-limit related
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase();
  return msg.includes('429') ||
         msg.includes('rate limit') ||
         msg.includes('too many requests');
}

/**
 * Safely get error stack trace.
 *
 * @param err - Unknown error value
 * @returns Stack trace or undefined
 */
export function getErrorStack(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.stack;
  }
  return undefined;
}

/**
 * Create a standardized error with code and metadata.
 */
export class AgentError extends Error {
  readonly code: string;
  readonly metadata?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    options?: {
      cause?: Error;
      metadata?: Record<string, unknown>;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.metadata = options?.metadata;
    this.retryable = options?.retryable ?? false;

    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Wrap an unknown error into an AgentError.
 *
 * @param err - Unknown error value
 * @param code - Error code
 * @param metadata - Additional metadata
 * @returns AgentError instance
 */
export function wrapError(
  err: unknown,
  code: string,
  metadata?: Record<string, unknown>
): AgentError {
  const message = extractErrorMessage(err);
  const cause = err instanceof Error ? err : undefined;
  const retryable = isRetryableError(err);

  return new AgentError(message, code, { cause, metadata, retryable });
}
