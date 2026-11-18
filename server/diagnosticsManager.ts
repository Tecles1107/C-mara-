import type { DiagnosticFeature, DiagnosticSample } from '../src/utils/processLogic.ts';

const MAX_SAMPLES = 120;

export class DiagnosticsManager {
  private samples: DiagnosticSample[] = [];

  recordSample(input: {
    ip: string;
    feature: DiagnosticFeature;
    status: 'ok' | 'warn' | 'error';
    method?: string;
    code?: string | number;
    latencyMs?: number;
    reason: string;
    suggestion?: string;
  }): DiagnosticSample {
    const sample: DiagnosticSample = {
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      ...input,
    };
    this.samples.unshift(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.length = MAX_SAMPLES;
    }
    return sample;
  }

  listSamples(ip?: string): DiagnosticSample[] {
    if (!ip) return [...this.samples];
    return this.samples.filter((s) => s.ip === ip);
  }

  clearSamples(): void {
    this.samples = [];
  }
}

export const diagnosticsManager = new DiagnosticsManager();
