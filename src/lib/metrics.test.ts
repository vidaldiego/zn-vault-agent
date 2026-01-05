// Path: src/lib/metrics.test.ts
// Unit tests for Prometheus metrics

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCounter,
  incCounter,
  registerGauge,
  setGauge,
  registerHistogram,
  observeHistogram,
  exportMetrics,
  resetMetrics,
} from './metrics.js';

describe('Prometheus Metrics', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('Counter', () => {
    it('should register and increment counter', () => {
      registerCounter('test_counter', 'Test counter description');
      incCounter('test_counter');
      incCounter('test_counter');
      incCounter('test_counter');

      const output = exportMetrics();
      expect(output).toContain('# HELP test_counter Test counter description');
      expect(output).toContain('# TYPE test_counter counter');
      expect(output).toContain('test_counter 3');
    });

    it('should support labels', () => {
      registerCounter('test_labeled', 'Labeled counter');
      incCounter('test_labeled', { method: 'GET', status: '200' });
      incCounter('test_labeled', { method: 'GET', status: '200' });
      incCounter('test_labeled', { method: 'POST', status: '201' });

      const output = exportMetrics();
      expect(output).toContain('test_labeled{method="GET",status="200"} 2');
      expect(output).toContain('test_labeled{method="POST",status="201"} 1');
    });

    it('should increment by custom value', () => {
      registerCounter('test_inc', 'Increment test');
      incCounter('test_inc', {}, 5);
      incCounter('test_inc', {}, 3);

      const output = exportMetrics();
      expect(output).toContain('test_inc 8');
    });
  });

  describe('Gauge', () => {
    it('should register and set gauge', () => {
      registerGauge('test_gauge', 'Test gauge');
      setGauge('test_gauge', 42);

      const output = exportMetrics();
      expect(output).toContain('# HELP test_gauge Test gauge');
      expect(output).toContain('# TYPE test_gauge gauge');
      expect(output).toContain('test_gauge 42');
    });

    it('should update gauge value', () => {
      registerGauge('test_update', 'Update test');
      setGauge('test_update', 10);
      setGauge('test_update', 20);
      setGauge('test_update', 15);

      const output = exportMetrics();
      expect(output).toContain('test_update 15');
    });

    it('should support labels', () => {
      registerGauge('test_labeled_gauge', 'Labeled gauge');
      setGauge('test_labeled_gauge', 100, { cert_id: 'abc' });
      setGauge('test_labeled_gauge', 200, { cert_id: 'def' });

      const output = exportMetrics();
      expect(output).toContain('test_labeled_gauge{cert_id="abc"} 100');
      expect(output).toContain('test_labeled_gauge{cert_id="def"} 200');
    });
  });

  describe('Histogram', () => {
    it('should register and observe histogram', () => {
      registerHistogram('test_histogram', 'Test histogram', [0.1, 0.5, 1, 5]);
      observeHistogram('test_histogram', 0.3);
      observeHistogram('test_histogram', 0.7);
      observeHistogram('test_histogram', 2);

      const output = exportMetrics();
      expect(output).toContain('# HELP test_histogram Test histogram');
      expect(output).toContain('# TYPE test_histogram histogram');
      expect(output).toContain('test_histogram_bucket{le="0.1"} 0');
      expect(output).toContain('test_histogram_bucket{le="0.5"} 1');
      expect(output).toContain('test_histogram_bucket{le="1"} 2');
      expect(output).toContain('test_histogram_bucket{le="5"} 3');
      expect(output).toContain('test_histogram_bucket{le="+Inf"} 3');
      expect(output).toContain('test_histogram_count 3');
    });

    it('should calculate sum correctly', () => {
      registerHistogram('test_sum', 'Sum test', [1, 10]);
      observeHistogram('test_sum', 1);
      observeHistogram('test_sum', 2);
      observeHistogram('test_sum', 3);

      const output = exportMetrics();
      expect(output).toContain('test_sum_sum 6');
    });
  });

  describe('exportMetrics', () => {
    it('should include process metrics', () => {
      const output = exportMetrics();
      expect(output).toContain('process_uptime_seconds');
      expect(output).toContain('process_heap_bytes');
    });

    it('should format output in Prometheus text format', () => {
      registerCounter('my_counter', 'My counter');
      incCounter('my_counter');

      const output = exportMetrics();
      const lines = output.split('\n');

      // Check format: HELP, TYPE, then value
      const helpIdx = lines.findIndex(l => l.includes('# HELP my_counter'));
      const typeIdx = lines.findIndex(l => l.includes('# TYPE my_counter'));
      const valueIdx = lines.findIndex(l => l.match(/^my_counter(\{.*\})? \d+/));

      expect(helpIdx).toBeLessThan(typeIdx);
      expect(typeIdx).toBeLessThan(valueIdx);
    });
  });

  describe('resetMetrics', () => {
    it('should clear all metric values', () => {
      registerCounter('reset_test', 'Reset test');
      incCounter('reset_test');
      incCounter('reset_test');

      resetMetrics();

      const output = exportMetrics();
      // After reset, counter should show 0 (no values recorded)
      expect(output).toContain('reset_test 0');
    });
  });
});
