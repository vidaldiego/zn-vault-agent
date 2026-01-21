// Path: src/utils/timer.ts
// Timer management utilities - prevent memory leaks from orphaned timers

/**
 * Managed timer that tracks a single setTimeout or setInterval.
 * Provides safe clear/replace semantics to prevent memory leaks.
 */
export class ManagedTimer {
  private timer: NodeJS.Timeout | null = null;
  private isInterval = false;

  /**
   * Set a timeout (replaces any existing timer).
   *
   * @param callback - Function to call after delay
   * @param delay - Delay in milliseconds
   */
  setTimeout(callback: () => void, delay: number): void {
    this.clear();
    this.isInterval = false;
    this.timer = setTimeout(callback, delay);
  }

  /**
   * Set an interval (replaces any existing timer).
   *
   * @param callback - Function to call repeatedly
   * @param interval - Interval in milliseconds
   */
  setInterval(callback: () => void, interval: number): void {
    this.clear();
    this.isInterval = true;
    this.timer = setInterval(callback, interval);
  }

  /**
   * Clear the current timer.
   */
  clear(): void {
    if (this.timer) {
      if (this.isInterval) {
        clearInterval(this.timer);
      } else {
        clearTimeout(this.timer);
      }
      this.timer = null;
    }
  }

  /**
   * Check if a timer is currently active.
   */
  isActive(): boolean {
    return this.timer !== null;
  }

  /**
   * Refresh the timer (restart from current time).
   * Only works for timeouts, not intervals.
   */
  refresh(): void {
    if (this.timer && !this.isInterval) {
      this.timer.refresh();
    }
  }
}

/**
 * Group of named managed timers.
 * Useful for components that need multiple timers.
 */
export class TimerGroup {
  private readonly timers = new Map<string, ManagedTimer>();

  /**
   * Get or create a timer by name.
   *
   * @param name - Timer name
   * @returns ManagedTimer instance
   */
  get(name: string): ManagedTimer {
    let timer = this.timers.get(name);
    if (!timer) {
      timer = new ManagedTimer();
      this.timers.set(name, timer);
    }
    return timer;
  }

  /**
   * Clear a specific timer by name.
   *
   * @param name - Timer name
   */
  clear(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      timer.clear();
    }
  }

  /**
   * Clear all timers in the group.
   */
  clearAll(): void {
    for (const timer of this.timers.values()) {
      timer.clear();
    }
  }

  /**
   * Check if a specific timer is active.
   *
   * @param name - Timer name
   * @returns true if timer exists and is active
   */
  isActive(name: string): boolean {
    const timer = this.timers.get(name);
    return timer ? timer.isActive() : false;
  }

  /**
   * Get all timer names.
   */
  getNames(): string[] {
    return Array.from(this.timers.keys());
  }

  /**
   * Get count of active timers.
   */
  getActiveCount(): number {
    let count = 0;
    for (const timer of this.timers.values()) {
      if (timer.isActive()) {
        count++;
      }
    }
    return count;
  }
}

/**
 * Create a debounced function that delays execution until after
 * a period of inactivity.
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function with cancel method
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  const timer = new ManagedTimer();

  const debounced = ((...args: unknown[]) => {
    timer.setTimeout(() => { fn(...args); }, delay);
  }) as T & { cancel: () => void };

  debounced.cancel = () => { timer.clear(); };

  return debounced;
}

/**
 * Create a throttled function that only executes at most once
 * per time period.
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between executions in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): T {
  let lastCall = 0;
  let timer: NodeJS.Timeout | null = null;

  return ((...args: unknown[]) => {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCall = now;
      fn(...args);
    } else {
      timer ??= setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  }) as T;
}

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise that rejects after a specified duration.
 *
 * @param ms - Timeout in milliseconds
 * @param message - Error message
 * @returns Promise that rejects after timeout
 */
export function timeout(ms: number, message = 'Operation timed out'): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => { reject(new Error(message)); }, ms);
  });
}

/**
 * Race a promise against a timeout.
 *
 * @param promise - Promise to race
 * @param ms - Timeout in milliseconds
 * @param message - Timeout error message
 * @returns Promise result or timeout error
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = 'Operation timed out'
): Promise<T> {
  return Promise.race([promise, timeout(ms, message)]);
}
