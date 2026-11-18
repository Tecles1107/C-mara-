export type ScanProfile = 'fast' | 'standard' | 'deep';

export interface ScanConfig {
  profile: ScanProfile;
  connectTimeoutMs: number;
  concurrency: number;
  ports: number[];
}

export type ProcessStatus = 'running' | 'completed' | 'cancelled' | 'timeout' | 'error';

export interface ProcessOperationRecord {
  id: string;
  kind: 'scan' | 'nmap' | 'onvif' | 'ssdp' | 'mdns' | 'arp' | 'vendor-udp' | 'stream' | 'audio' | 'talk' | 'verify';
  target: string;
  pid?: number;
  status: ProcessStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  detail?: string;
}

export type DiagnosticFeature = 'video' | 'audio' | 'talk' | 'ptz' | 'light' | 'ir' | 'verify' | 'scan';

export interface DiagnosticSample {
  id: string;
  timestamp: number;
  ip: string;
  feature: DiagnosticFeature;
  status: 'ok' | 'warn' | 'error';
  method?: string;
  code?: string | number;
  latencyMs?: number;
  reason: string;
  suggestion?: string;
}

export interface CapabilityCheckItem {
  feature: DiagnosticFeature;
  label: string;
  supported: boolean;
  status: 'ok' | 'warn' | 'error';
  method?: string;
  latencyMs?: number;
  reason: string;
  suggestion?: string;
}

export function getScanConfigForProfile(
  profile: ScanProfile,
  customTimeoutMs?: number,
  customConcurrency?: number
): ScanConfig {
  const presets: Record<ScanProfile, Omit<ScanConfig, 'profile'>> = {
    fast: {
      connectTimeoutMs: 140,
      concurrency: 96,
      ports: [554, 80, 8080, 8000, 8899],
    },
    standard: {
      connectTimeoutMs: 220,
      concurrency: 64,
      ports: [554, 8554, 80, 81, 8000, 8080, 8081, 8899],
    },
    deep: {
      connectTimeoutMs: 420,
      concurrency: 48,
      ports: [554, 8554, 10554, 80, 81, 82, 5000, 8000, 8001, 8080, 8081, 8899, 9000, 34567, 37777],
    },
  };

  const base = presets[profile] || presets.standard;
  return {
    profile,
    connectTimeoutMs:
      customTimeoutMs && customTimeoutMs >= 80 && customTimeoutMs <= 3000
        ? Math.round(customTimeoutMs)
        : base.connectTimeoutMs,
    concurrency:
      customConcurrency && customConcurrency >= 8 && customConcurrency <= 128
        ? Math.round(customConcurrency)
        : base.concurrency,
    ports: base.ports,
  };
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number, result: R) => void
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let completed = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      if (signal?.aborted) return;
      const current = nextIndex++;
      const res = await worker(items[current], current);
      results[current] = res;
      completed++;
      onProgress?.(completed, items.length, res);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

export function formatLatency(ms?: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatProcessTime(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleTimeString('es-ES', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function getProcessStatusLabel(status: ProcessStatus): string {
  switch (status) {
    case 'running':
      return 'En ejecución';
    case 'completed':
      return 'Completado';
    case 'cancelled':
      return 'Cancelado';
    case 'timeout':
      return 'Tiempo agotado';
    case 'error':
      return 'Error';
    default:
      return status;
  }
}

