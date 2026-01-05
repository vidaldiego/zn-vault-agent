// Path: src/lib/metrics.ts
// Prometheus metrics for zn-vault-agent

import { metricsLogger as log } from './logger.js';

/**
 * Simple Prometheus metrics implementation without external dependencies.
 * Exports metrics in Prometheus text format (0.0.4).
 */

interface CounterValue {
  value: number;
  labels: Record<string, string>;
}

interface GaugeValue {
  value: number;
  labels: Record<string, string>;
  timestamp?: number;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface HistogramValue {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
  labels: Record<string, string>;
}

// Metric storage
const counters = new Map<string, CounterValue[]>();
const gauges = new Map<string, GaugeValue[]>();
const histograms = new Map<string, HistogramValue[]>();

// Metric metadata
const metricHelp = new Map<string, string>();
const metricType = new Map<string, 'counter' | 'gauge' | 'histogram'>();

// Default histogram buckets (in seconds)
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Register a counter metric
 */
export function registerCounter(name: string, help: string): void {
  if (!counters.has(name)) {
    counters.set(name, []);
    metricHelp.set(name, help);
    metricType.set(name, 'counter');
  }
}

/**
 * Increment a counter
 */
export function incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  const values = counters.get(name);
  if (!values) {
    log.warn({ name }, 'Counter not registered');
    return;
  }

  const labelKey = JSON.stringify(labels);
  const existing = values.find((v) => JSON.stringify(v.labels) === labelKey);

  if (existing) {
    existing.value += value;
  } else {
    values.push({ value, labels });
  }
}

/**
 * Register a gauge metric
 */
export function registerGauge(name: string, help: string): void {
  if (!gauges.has(name)) {
    gauges.set(name, []);
    metricHelp.set(name, help);
    metricType.set(name, 'gauge');
  }
}

/**
 * Set a gauge value
 */
export function setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
  const values = gauges.get(name);
  if (!values) {
    log.warn({ name }, 'Gauge not registered');
    return;
  }

  const labelKey = JSON.stringify(labels);
  const existing = values.find((v) => JSON.stringify(v.labels) === labelKey);

  if (existing) {
    existing.value = value;
    existing.timestamp = Date.now();
  } else {
    values.push({ value, labels, timestamp: Date.now() });
  }
}

/**
 * Register a histogram metric
 */
export function registerHistogram(
  name: string,
  help: string,
  buckets: number[] = DEFAULT_BUCKETS
): void {
  if (!histograms.has(name)) {
    histograms.set(name, []);
    metricHelp.set(name, help);
    metricType.set(name, 'histogram');
    // Store bucket boundaries in help text for reference
    metricHelp.set(`${name}_buckets`, buckets.join(','));
  }
}

/**
 * Observe a histogram value
 */
export function observeHistogram(
  name: string,
  value: number,
  labels: Record<string, string> = {}
): void {
  const values = histograms.get(name);
  if (!values) {
    log.warn({ name }, 'Histogram not registered');
    return;
  }

  const bucketBoundaries = metricHelp.get(`${name}_buckets`)?.split(',').map(Number) || DEFAULT_BUCKETS;
  const labelKey = JSON.stringify(labels);
  let existing = values.find((v) => JSON.stringify(v.labels) === labelKey);

  if (!existing) {
    existing = {
      buckets: bucketBoundaries.map((le) => ({ le, count: 0 })),
      sum: 0,
      count: 0,
      labels,
    };
    values.push(existing);
  }

  // Update buckets
  for (const bucket of existing.buckets) {
    if (value <= bucket.le) {
      bucket.count++;
    }
  }
  existing.sum += value;
  existing.count++;
}

/**
 * Format labels for Prometheus output
 */
function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

/**
 * Export all metrics in Prometheus text format
 */
export function exportMetrics(): string {
  const lines: string[] = [];

  // Add process metrics
  lines.push('# HELP process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${process.uptime().toFixed(3)}`);

  lines.push('# HELP process_heap_bytes Process heap memory in bytes');
  lines.push('# TYPE process_heap_bytes gauge');
  lines.push(`process_heap_bytes ${process.memoryUsage().heapUsed}`);

  lines.push('');

  // Export counters
  for (const [name, values] of counters) {
    const help = metricHelp.get(name);
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const v of values) {
      lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
    }
    // Add total if no labels
    if (values.length === 0) {
      lines.push(`${name} 0`);
    }
    lines.push('');
  }

  // Export gauges
  for (const [name, values] of gauges) {
    const help = metricHelp.get(name);
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const v of values) {
      lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
    }
    if (values.length === 0) {
      lines.push(`${name} 0`);
    }
    lines.push('');
  }

  // Export histograms
  for (const [name, values] of histograms) {
    const help = metricHelp.get(name);
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const v of values) {
      const labelStr = formatLabels(v.labels);
      for (const bucket of v.buckets) {
        const leLabel = v.labels ? { ...v.labels, le: String(bucket.le) } : { le: String(bucket.le) };
        lines.push(`${name}_bucket${formatLabels(leLabel)} ${bucket.count}`);
      }
      const infLabel = v.labels ? { ...v.labels, le: '+Inf' } : { le: '+Inf' };
      lines.push(`${name}_bucket${formatLabels(infLabel)} ${v.count}`);
      lines.push(`${name}_sum${labelStr} ${v.sum.toFixed(6)}`);
      lines.push(`${name}_count${labelStr} ${v.count}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  for (const values of counters.values()) {
    values.length = 0;
  }
  for (const values of gauges.values()) {
    values.length = 0;
  }
  for (const values of histograms.values()) {
    values.length = 0;
  }
}

// Register agent-specific metrics
export function initializeMetrics(): void {
  // Counters
  registerCounter('znvault_agent_sync_total', 'Total certificate sync operations');
  registerCounter('znvault_agent_sync_failures_total', 'Total failed sync operations');
  registerCounter('znvault_agent_secret_sync_total', 'Total secret sync operations');
  registerCounter('znvault_agent_secret_sync_failures_total', 'Total failed secret sync operations');
  registerCounter('znvault_agent_websocket_reconnects_total', 'Total WebSocket reconnection attempts');
  registerCounter('znvault_agent_api_requests_total', 'Total API requests made');
  registerCounter('znvault_agent_update_checks_total', 'Total update checks performed');
  registerCounter('znvault_agent_updates_total', 'Total update installations');

  // Gauges
  registerGauge('znvault_agent_connected', 'WebSocket connection status (1=connected, 0=disconnected)');
  registerGauge('znvault_agent_certs_tracked', 'Number of certificates being tracked');
  registerGauge('znvault_agent_secrets_tracked', 'Number of secrets being tracked');
  registerGauge('znvault_agent_last_sync_timestamp', 'Timestamp of last successful sync');
  registerGauge('znvault_agent_cert_expiry_days', 'Days until certificate expiry');
  registerGauge('znvault_agent_version_info', 'Agent version information');

  // Histograms
  registerHistogram('znvault_agent_sync_duration_seconds', 'Certificate sync duration in seconds');
  registerHistogram('znvault_agent_secret_sync_duration_seconds', 'Secret sync duration in seconds');
  registerHistogram('znvault_agent_api_request_duration_seconds', 'API request duration in seconds');

  log.debug('Metrics initialized');
}

// Convenience functions for common operations
export const metrics = {
  // Sync operations
  syncSuccess: (certName: string) => {
    incCounter('znvault_agent_sync_total', { status: 'success', cert_name: certName });
    setGauge('znvault_agent_last_sync_timestamp', Date.now() / 1000, { cert_name: certName });
  },
  syncFailure: (certName: string, reason: string) => {
    incCounter('znvault_agent_sync_total', { status: 'failure', cert_name: certName });
    incCounter('znvault_agent_sync_failures_total', { cert_name: certName, reason });
  },
  syncDuration: (certName: string, durationMs: number) => {
    observeHistogram('znvault_agent_sync_duration_seconds', durationMs / 1000, { cert_name: certName });
  },

  // WebSocket
  wsConnected: () => setGauge('znvault_agent_connected', 1),
  wsDisconnected: () => setGauge('znvault_agent_connected', 0),
  wsReconnect: () => incCounter('znvault_agent_websocket_reconnects_total'),

  // API
  apiRequest: (method: string, status: number, durationMs: number) => {
    incCounter('znvault_agent_api_requests_total', { method, status: String(status) });
    observeHistogram('znvault_agent_api_request_duration_seconds', durationMs / 1000, { method });
  },

  // Certificate tracking
  setCertsTracked: (count: number) => setGauge('znvault_agent_certs_tracked', count),
  setCertExpiry: (certId: string, certName: string, days: number) => {
    setGauge('znvault_agent_cert_expiry_days', days, { cert_id: certId, cert_name: certName });
  },

  // Secret operations
  secretDeployed: (secretName: string, success: boolean, durationMs: number) => {
    incCounter('znvault_agent_secret_sync_total', { status: success ? 'success' : 'failure', secret_name: secretName });
    if (!success) {
      incCounter('znvault_agent_secret_sync_failures_total', { secret_name: secretName });
    }
    observeHistogram('znvault_agent_secret_sync_duration_seconds', durationMs / 1000, { secret_name: secretName });
    if (success) {
      setGauge('znvault_agent_last_sync_timestamp', Date.now() / 1000, { secret_name: secretName });
    }
  },
  setSecretsTracked: (count: number) => setGauge('znvault_agent_secrets_tracked', count),

  // Auto-update
  updateCheck: (status: 'success' | 'error') => {
    incCounter('znvault_agent_update_checks_total', { status });
  },
  updateInstall: (status: 'success' | 'error' | 'permission_denied') => {
    incCounter('znvault_agent_updates_total', { status });
  },
  setVersionInfo: (version: string, channel: string) => {
    setGauge('znvault_agent_version_info', 1, { version, channel });
  },
};
