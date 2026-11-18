export type CameraProtocol = 'RTSP' | 'ONVIF' | 'MJPEG' | 'HTTP-FLV';
export type ViewMode = 'single' | 'mosaic' | 'termux';
export type AuthStatus = 'open' | 'verified' | 'required' | 'failed' | 'unknown';

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
  capabilities?: CameraCapabilities;
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

export function buildStreamUrl(camera: CameraChannel): string {
  const scheme = camera.protocol === 'RTSP' || camera.protocol === 'ONVIF' ? 'rtsp' : 'http';
  const cleanPath = camera.streamPath.startsWith('/') ? camera.streamPath : `/${camera.streamPath}`;
  let authPrefix = '';
  if (camera.username && camera.username.trim()) {
    const user = encodeURIComponent(camera.username.trim());
    const pass = encodeURIComponent(camera.password || '');
    authPrefix = `${user}:${pass}@`;
  }
  return `${scheme}://${authPrefix}${camera.ip}:${camera.port}${cleanPath}`;
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
    // Strip CIDR suffix like /24 or trailing dot
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
      String(cam.port).includes(q) ||
      cam.protocol.toLowerCase().includes(q) ||
      cam.location.toLowerCase().includes(q) ||
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

export function buildTermuxScript(subnet = '192.168.1.0/24', port = 3000): string {
  return `#!/data/data/com.termux/files/usr/bin/bash
# VigíaLAN — Escáner y puente RTSP/ONVIF para Termux
pkg update -y && pkg install -y nodejs ffmpeg nmap termux-api
termux-setup-storage

# 1. Escanear cámaras en la red local (${subnet})
echo "Escaneando puertos RTSP (554, 8554) y HTTP/ONVIF (80, 81, 8000, 8080, 8899)..."
nmap -p 554,8554,80,81,8000,8080,8899 --open ${subnet} -oG - | grep "/open/"

# 2. Guardar clips directamente en almacenamiento interno
mkdir -p /sdcard/DCIM/VigiaLAN_Clips

# 3. Iniciar servidor web local en el puerto ${port}
npx tsx server.ts --port=${port} --clips=/sdcard/DCIM/VigiaLAN_Clips`;
}
