export type CameraProtocol = 'RTSP' | 'ONVIF' | 'MJPEG' | 'HTTP-FLV';
export type ViewMode = 'single' | 'mosaic' | 'saved' | 'termux';
export type AuthStatus = 'open' | 'verified' | 'required' | 'failed' | 'unknown';
export type ConnectionMode = 'auto' | 'local' | 'remote';

export interface CameraCapabilities {
  ptz: boolean;
  audio: boolean;
  light: boolean;
  twoWayAudio: boolean;
}

export interface CameraChannel {
  id: string;
  name: string;
  ip: string;
  port: number;
  onvifPort?: number;
  protocol: CameraProtocol;
  streamPath: string;
  status: 'online' | 'offline';
  resolution: string;
  fps: number;
  hasAudio: boolean;
  location: string;
  nightVision: boolean;
  username?: string;
  password?: string;
  profileToken?: string;
  manufacturer?: string;
  model?: string;
  authStatus?: AuthStatus;
  latencyMs?: number;
  openPorts?: number[];
  irMode?: 'normal' | 'night' | 'auto';
  capabilities?: CameraCapabilities;
  // Saved & Remote Connection fields
  isSaved?: boolean;
  lastSeenAt?: number;
  remoteHost?: string;
  remotePort?: number;
  remoteOnvifPort?: number;
  connectionMode?: ConnectionMode;
  activeEndpoint?: 'local' | 'remote';
  notes?: string;
}

export interface CameraFilterOptions {
  onlyOnline: boolean;
  protocol?: CameraProtocol | 'ALL';
  onlyAudio?: boolean;
  onlyPtz?: boolean;
}

export interface MotionAlertConfig {
  enabled: boolean;
  sensitivity: number;
  cooldownSeconds: number;
  soundAlert: boolean;
  browserNotification: boolean;
  autoRecordOnMotion: boolean;
}

export interface MotionEvent {
  id: string;
  cameraId: string;
  cameraName: string;
  timestamp: number;
  score: number;
}

export interface RecordedClip {
  id: string;
  cameraId: string;
  cameraName: string;
  timestamp: number;
  durationSec: number;
  sizeBytes: number;
  url: string;
  filename: string;
}

export function resolveEffectiveEndpoint(camera: CameraChannel): {
  host: string;
  port: number;
  onvifPort?: number;
  isRemote: boolean;
} {
  const hasRemote = Boolean(camera.remoteHost && camera.remoteHost.trim());
  const useRemote =
    hasRemote &&
    (camera.connectionMode === 'remote' ||
      (camera.connectionMode !== 'local' && camera.activeEndpoint === 'remote'));

  if (useRemote) {
    return {
      host: camera.remoteHost!.trim(),
      port: camera.remotePort || camera.port,
      onvifPort: camera.remoteOnvifPort || camera.onvifPort,
      isRemote: true,
    };
  }

  return {
    host: camera.ip,
    port: camera.port,
    onvifPort: camera.onvifPort,
    isRemote: false,
  };
}

export function buildStreamUrl(
  camera: CameraChannel,
  overrideEndpoint?: { host: string; port: number }
): string {
  const scheme = camera.protocol === 'RTSP' || camera.protocol === 'ONVIF' ? 'rtsp' : 'http';
  const cleanPath = camera.streamPath.startsWith('/') ? camera.streamPath : `/${camera.streamPath}`;
  const effective = overrideEndpoint || resolveEffectiveEndpoint(camera);
  let authPrefix = '';
  if (camera.username && camera.username.trim()) {
    const user = encodeURIComponent(camera.username.trim());
    const pass = encodeURIComponent(camera.password || '');
    authPrefix = `${user}:${pass}@`;
  }
  return `${scheme}://${authPrefix}${effective.host}:${effective.port}${cleanPath}`;
}

export function mergeCameraLists(
  savedList: CameraChannel[],
  discoveredList: CameraChannel[]
): CameraChannel[] {
  const byIdentity = new Map<string, CameraChannel>();

  for (const saved of savedList) {
    const key = `${saved.ip}:${saved.port}`;
    byIdentity.set(key, { ...saved, isSaved: true });
  }

  for (const disc of discoveredList) {
    const key = `${disc.ip}:${disc.port}`;
    const existing = byIdentity.get(key);
    if (existing) {
      const mergedPorts = Array.from(
        new Set([...(existing.openPorts || []), ...(disc.openPorts || []), disc.port, disc.onvifPort].filter((n): n is number => Boolean(n)))
      );
      byIdentity.set(key, {
        ...disc,
        ...existing,
        status: disc.status,
        latencyMs: disc.latencyMs ?? existing.latencyMs,
        openPorts: mergedPorts.length > 0 ? mergedPorts : existing.openPorts,
        onvifPort: existing.onvifPort || disc.onvifPort,
        manufacturer: existing.manufacturer || disc.manufacturer,
        model: existing.model || disc.model,
        isSaved: true,
      });
    } else {
      byIdentity.set(key, disc);
    }
  }

  return Array.from(byIdentity.values());
}

export function parseSubnetInputs(rawInput: string, fallbackSubnets: string[]): string[] {
  const trimmed = rawInput.trim();
  if (!trimmed) return fallbackSubnets;

  const parts = trimmed
    .split(/[,\s;]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const normalized = new Set<string>();
  for (const part of parts) {
    const clean = part.replace(/\/\d+$/, '').replace(/\.$/, '');
    const octets = clean.split('.');
    if (octets.length === 3 && octets.every((o) => /^\d+$/.test(o) && Number(o) <= 255)) {
      normalized.add(clean);
    } else if (octets.length === 4 && octets.every((o) => /^\d+$/.test(o) && Number(o) <= 255)) {
      normalized.add(`${octets[0]}.${octets[1]}.${octets[2]}`);
    }
  }

  return normalized.size > 0 ? Array.from(normalized) : fallbackSubnets;
}

export const INITIAL_CAMERAS: CameraChannel[] = [];

export const DEFAULT_MOTION_CONFIG: MotionAlertConfig = {
  enabled: true,
  sensitivity: 68,
  cooldownSeconds: 8,
  soundAlert: true,
  browserNotification: false,
  autoRecordOnMotion: false,
};

export function filterCameras(
  cameras: CameraChannel[],
  query: string,
  onlyOnlineOrOpts: boolean | CameraFilterOptions
): CameraChannel[] {
  const opts: CameraFilterOptions =
    typeof onlyOnlineOrOpts === 'boolean'
      ? { onlyOnline: onlyOnlineOrOpts, protocol: 'ALL' }
      : onlyOnlineOrOpts;

  const q = query.trim().toLowerCase();
  return cameras.filter((cam) => {
    if (opts.onlyOnline && cam.status !== 'online') return false;
    if (opts.protocol && opts.protocol !== 'ALL' && cam.protocol !== opts.protocol) return false;
    if (opts.onlyAudio && !cam.hasAudio && !cam.capabilities?.audio) return false;
    if (opts.onlyPtz && !cam.capabilities?.ptz && cam.protocol !== 'ONVIF') return false;
    if (!q) return true;
    return (
      cam.name.toLowerCase().includes(q) ||
      cam.ip.toLowerCase().includes(q) ||
      (cam.remoteHost || '').toLowerCase().includes(q) ||
      String(cam.port).includes(q) ||
      cam.protocol.toLowerCase().includes(q) ||
      cam.location.toLowerCase().includes(q) ||
      (cam.notes || '').toLowerCase().includes(q) ||
      (cam.manufacturer || '').toLowerCase().includes(q) ||
      (cam.model || '').toLowerCase().includes(q)
    );
  });
}

export function clampZoomPan(
  zoom: number,
  panX: number,
  panY: number
): { zoom: number; panX: number; panY: number } {
  const clampedZoom = Math.min(4, Math.max(1, Number(zoom.toFixed(2))));
  if (clampedZoom <= 1) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const maxPan = ((clampedZoom - 1) / clampedZoom) * 50;
  return {
    zoom: clampedZoom,
    panX: Math.min(maxPan, Math.max(-maxPan, panX)),
    panY: Math.min(maxPan, Math.max(-maxPan, panY)),
  };
}

export function calculateMotionScore(
  prevFrame: Uint8ClampedArray,
  currFrame: Uint8ClampedArray,
  sampleStep = 16
): number {
  if (prevFrame.length === 0 || prevFrame.length !== currFrame.length) {
    return 0;
  }
  let diffSum = 0;
  let samples = 0;
  const stride = Math.max(4, sampleStep * 4);
  for (let i = 0; i < currFrame.length; i += stride) {
    const dr = Math.abs(currFrame[i] - prevFrame[i]);
    const dg = Math.abs(currFrame[i + 1] - prevFrame[i + 1]);
    const db = Math.abs(currFrame[i + 2] - prevFrame[i + 2]);
    const avgDiff = (dr + dg + db) / 3;
    if (avgDiff > 18) {
      diffSum += avgDiff;
    }
    samples++;
  }
  if (samples === 0) return 0;
  const rawScore = (diffSum / (samples * 255)) * 400;
  return Math.min(100, Math.round(rawScore));
}

export function shouldTriggerMotionAlert(
  score: number,
  config: MotionAlertConfig,
  lastAlertTimeMs: number,
  nowMs: number
): boolean {
  if (!config.enabled) return false;
  const threshold = Math.max(5, 100 - config.sensitivity);
  if (score < threshold) return false;
  return nowMs - lastAlertTimeMs >= config.cooldownSeconds * 1000;
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildTermuxScript(
  subnet = '192.168.1.0/24',
  port = 3000,
  remoteMethod: 'direct' | 'cloudflared' | 'tailscale' = 'direct'
): string {
  const remoteSection =
    remoteMethod === 'cloudflared'
      ? `\n# 4. Acceso remoto seguro desde datos móviles o cualquier Wi-Fi (Cloudflare Tunnel)
pkg install -y cloudflared || true
cloudflared tunnel --url http://localhost:${port} &`
      : remoteMethod === 'tailscale'
        ? `\n# 4. Acceso remoto privado vía VPN Mesh (Tailscale)
# Abre la app Tailscale en Android para obtener tu IP 100.x.y.z y acceder a http://100.x.y.z:${port}`
        : '';

  return `#!/data/data/com.termux/files/usr/bin/bash
# VigíaLAN — Escáner, puente RTSP/ONVIF y servidor remoto para Termux
export DEBIAN_FRONTEND=noninteractive
pkg update -y && pkg install -y nodejs ffmpeg nmap termux-api git
termux-setup-storage || true
termux-wake-lock || true

# 1. Instalar dependencias de Node.js (evita conflictos ERESOLVE)
npm install --legacy-peer-deps --no-audit --no-fund
npm run build

# 2. Preparar carpeta de clips y respaldo de dispositivos guardados
mkdir -p /sdcard/DCIM/VigiaLAN_Clips ./data

# 3. Verificar subred local (${subnet})
nmap -p 554,8554,80,81,8000,8080,8899 --open ${subnet} -oG - | grep "/open/" || true${remoteSection}

# 5. Iniciar servidor en puerto ${port} (modo producción ligero)
PORT=${port} NODE_ENV=production npx tsx server.ts`;
}
