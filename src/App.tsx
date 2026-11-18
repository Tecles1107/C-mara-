import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookmarkCheck,
  Camera,
  Grid2x2,
  Maximize2,
  RefreshCw,
  Square,
  Terminal,
} from 'lucide-react';
import {
  CameraChannel,
  CameraProtocol,
  DEFAULT_MOTION_CONFIG,
  INITIAL_CAMERAS,
  MotionAlertConfig,
  MotionEvent,
  RecordedClip,
  ViewMode,
  buildStreamUrl,
  clampZoomPan,
  filterCameras,
  mergeCameraLists,
  resolveEffectiveEndpoint,
  shouldTriggerMotionAlert,
} from './utils/cameraLogic';
import {
  CapabilityCheckItem,
  DiagnosticSample,
  ProcessOperationRecord,
  ScanProfile,
} from './utils/processLogic';
import { VisionMode } from './components/CameraFeedCanvas';
import { CameraSidebar, NearbyWifiInfo, ScanProgressState } from './components/CameraSidebar';
import { BottomTabType, SingleCameraView } from './components/SingleCameraView';
import { MosaicView } from './components/MosaicView';
import { SavedDevicesView } from './components/SavedDevicesView';
import { ProcessMonitorPanel } from './components/ProcessMonitorPanel';
import { TermuxSetupView } from './components/TermuxSetupView';
import { MotionSettingsModal } from './components/MotionSettingsModal';
import { CameraCredentialsModal } from './components/CameraCredentialsModal';
import { AppErrorItem, ErrorBanner } from './components/ErrorBanner';
import { VoiceSessionHandle, startVoiceTalkSession } from './utils/voiceProcessor';

const SAVED_STORAGE_KEY = 'vigialan_saved_cameras';

function readLocalSavedCameras(): CameraChannel[] {
  try {
    const raw = localStorage.getItem(SAVED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((c) => ({ ...c, isSaved: true })) : [];
  } catch {
    return [];
  }
}

function writeLocalSavedCameras(list: CameraChannel[]): void {
  try {
    const onlySaved = list.filter((c) => c.isSaved);
    localStorage.setItem(SAVED_STORAGE_KEY, JSON.stringify(onlySaved));
  } catch {
    // Ignore storage quota errors
  }
}

export default function App() {
  const [cameras, setCameras] = useState<CameraChannel[]>(() =>
    mergeCameraLists(readLocalSavedCameras(), INITIAL_CAMERAS)
  );
  const [selectedId, setSelectedId] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [scanMessage, setScanMessage] = useState<string>('');
  const [mosaicOrder, setMosaicOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('vigialan_mosaic_order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [draggedCamId, setDraggedCamId] = useState<string | null>(null);
  const [errors, setErrors] = useState<AppErrorItem[]>([]);

  // Scan & Search parameters
  const [searchQuery, setSearchQuery] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<CameraProtocol | 'ALL'>('ALL');
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [onlyAudio, setOnlyAudio] = useState(false);
  const [onlyPtz, setOnlyPtz] = useState(false);
  const [scanProfile, setScanProfile] = useState<ScanProfile>('standard');
  const [customSubnet, setCustomSubnet] = useState('');
  const [customTimeoutMs, setCustomTimeoutMs] = useState('');
  const [customConcurrency, setCustomConcurrency] = useState('');
  const [outOfNetworkScan, setOutOfNetworkScan] = useState(false);
  const [externalTargets, setExternalTargets] = useState('');
  const [wifiNetworks, setWifiNetworks] = useState<NearbyWifiInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressState | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Processes, Connections & Diagnostics Monitor
  const [operations, setOperations] = useState<ProcessOperationRecord[]>([]);
  const [activeProcessCount, setActiveProcessCount] = useState(0);
  const [showEmptyProcesses, setShowEmptyProcesses] = useState(false);
  const [diagnosticChecks, setDiagnosticChecks] = useState<CapabilityCheckItem[]>([]);
  const [diagnosticSamples, setDiagnosticSamples] = useState<DiagnosticSample[]>([]);
  const [isRunningDiagnostic, setIsRunningDiagnostic] = useState(false);

  // Single camera controls
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [visionMode, setVisionMode] = useState<VisionMode>('normal');
  const [irStatusLabel, setIrStatusLabel] = useState<string>('');
  const [lightOn, setLightOn] = useState(false);
  const [lightBusy, setLightBusy] = useState(false);
  const [talkActive, setTalkActive] = useState(false);
  const [deepVoice, setDeepVoice] = useState(false);
  const [ptzSpeed, setPtzSpeed] = useState<number>(0.22);
  const [snapshotTrigger, setSnapshotTrigger] = useState(0);
  const [isRecording, setIsRecording] = useState(false);

  // Modals & Logs
  const [motionConfig, setMotionConfig] = useState<MotionAlertConfig>(DEFAULT_MOTION_CONFIG);
  const [isMotionModalOpen, setIsMotionModalOpen] = useState(false);
  const [credsCamera, setCredsCamera] = useState<CameraChannel | null>(null);
  const [motionEvents, setMotionEvents] = useState<MotionEvent[]>([]);
  const [clips, setClips] = useState<RecordedClip[]>([]);
  const [bottomTab, setBottomTab] = useState<BottomTabType>('events');

  const lastAlertMapRef = useRef<Record<string, number>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceSessionRef = useRef<VoiceSessionHandle | null>(null);
  const scanSourceRef = useRef<EventSource | null>(null);

  const savedCameras = useMemo(() => cameras.filter((c) => c.isSaved), [cameras]);

  const filteredCameras = useMemo(
    () =>
      filterCameras(cameras, searchQuery, {
        onlyOnline,
        protocol: protocolFilter,
        onlyAudio,
        onlyPtz,
      }),
    [cameras, searchQuery, onlyOnline, protocolFilter, onlyAudio, onlyPtz]
  );

  const selectedCamera = useMemo(
    () => cameras.find((c) => c.id === selectedId) ?? cameras[0] ?? null,
    [cameras, selectedId]
  );

  const onlineCameras = useMemo(() => {
    const online = cameras.filter((c) => c.status === 'online');
    if (mosaicOrder.length === 0) return online;
    const orderMap = new Map(mosaicOrder.map((id, idx) => [id, idx]));
    return [...online].sort((a, b) => {
      const ia = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
      const ib = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });
  }, [cameras, mosaicOrder]);

  const reportError = useCallback((message: string) => {
    setErrors((prev) => [
      { id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, message, timestamp: Date.now() },
      ...prev.slice(0, 9),
    ]);
  }, []);

  const persistSavedCamera = useCallback(async (cam: CameraChannel) => {
    const toSave: CameraChannel = {
      ...cam,
      isSaved: true,
      lastSeenAt: cam.lastSeenAt || Date.now(),
    };
    setCameras((prev) => {
      const exists = prev.some((c) => c.id === toSave.id);
      const next = exists
        ? prev.map((c) => (c.id === toSave.id ? toSave : c))
        : [toSave, ...prev];
      writeLocalSavedCameras(next);
      return next;
    });
    try {
      await fetch(`/api/saved-cameras/${encodeURIComponent(toSave.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave),
      });
    } catch {
      // LocalStorage still preserves saved device if offline
    }
  }, []);

  // Load saved devices from server & sync with localStorage on startup
  useEffect(() => {
    let active = true;
    fetch('/api/saved-cameras')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active || !data?.cameras) return;
        const serverSaved: CameraChannel[] = data.cameras;
        setCameras((prev) => {
          const merged = mergeCameraLists(serverSaved, prev);
          writeLocalSavedCameras(merged);
          return merged;
        });
        if (serverSaved.length > 0) {
          setSelectedId((prevId) => prevId || serverSaved[0].id);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const fetchProcesses = useCallback(async () => {
    try {
      const res = await fetch('/api/processes');
      if (!res.ok) return;
      const data = await res.json();
      setOperations(data.operations || []);
      setActiveProcessCount(Number(data.activeCount || 0));
    } catch {
      // Non-fatal background refresh
    }
  }, []);

  const fetchDiagnostics = useCallback(async (ip?: string) => {
    try {
      const q = ip ? `?ip=${encodeURIComponent(ip)}` : '';
      const res = await fetch(`/api/diagnostics${q}`);
      if (!res.ok) return;
      const data = await res.json();
      setDiagnosticSamples(data.samples || []);
    } catch {
      // Non-fatal background refresh
    }
  }, []);

  useEffect(() => {
    fetchProcesses();
    fetchDiagnostics(selectedCamera?.ip);
  }, [fetchProcesses, fetchDiagnostics, selectedCamera?.ip]);

  useEffect(() => {
    const shouldPollProcesses = isScanning || bottomTab === 'processes' || showEmptyProcesses;
    const shouldPollDiag = bottomTab === 'diagnostics' || talkActive || audioEnabled;
    if (!shouldPollProcesses && !shouldPollDiag) return;
    if (shouldPollProcesses) fetchProcesses();
    if (shouldPollDiag) fetchDiagnostics(selectedCamera?.ip);
    const timer = window.setInterval(() => {
      if (shouldPollProcesses) fetchProcesses();
      if (shouldPollDiag) fetchDiagnostics(selectedCamera?.ip);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [
    isScanning,
    bottomTab,
    showEmptyProcesses,
    talkActive,
    audioEnabled,
    selectedCamera?.ip,
    fetchProcesses,
    fetchDiagnostics,
  ]);

  useEffect(() => {
    const onErr = (event: ErrorEvent) => {
      event.preventDefault();
      reportError(event.message || 'Error inesperado en la aplicación');
    };
    const onRej = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      const reason =
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason || 'Error de promesa no controlada');
      reportError(reason);
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [reportError]);

  useEffect(() => {
    return () => {
      scanSourceRef.current?.close();
      voiceSessionRef.current?.stop();
    };
  }, []);

  // Reset per-camera states when switching camera
  useEffect(() => {
    if (selectedCamera) {
      setVisionMode(selectedCamera.irMode || (selectedCamera.nightVision ? 'night' : 'normal'));
      setIrStatusLabel('');
      setDiagnosticChecks([]);
      setZoom(1);
      setPanX(0);
      setPanY(0);
      setIsRecording(false);
      setAudioEnabled(false);
      if (voiceSessionRef.current) {
        voiceSessionRef.current.stop();
        voiceSessionRef.current = null;
      }
      setTalkActive(false);
    }
  }, [selectedCamera?.id]);

  // Play live audio stream when audioEnabled is toggled on
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioEnabled || !selectedCamera || selectedCamera.status !== 'online') return;
    el.play().catch(() => {
      reportError('El navegador bloqueó el audio o la cámara no tiene pista de audio disponible.');
      setAudioEnabled(false);
    });
  }, [audioEnabled, selectedCamera?.id, selectedCamera?.status, reportError]);

  useEffect(() => {
    voiceSessionRef.current?.setDeepVoice(deepVoice);
  }, [deepVoice]);

  const playAlertChime = useCallback(() => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch {
      // Ignore audio errors
    }
  }, []);

  const handleMotionScore = useCallback(
    (cameraId: string, score: number) => {
      const now = Date.now();
      const last = lastAlertMapRef.current[cameraId] ?? 0;
      if (shouldTriggerMotionAlert(score, motionConfig, last, now)) {
        lastAlertMapRef.current[cameraId] = now;
        const cam = cameras.find((c) => c.id === cameraId);
        if (!cam) return;

        const event: MotionEvent = {
          id: `evt-${now}-${cameraId}`,
          cameraId,
          cameraName: cam.name,
          timestamp: now,
          score,
        };
        setMotionEvents((prev) => [event, ...prev].slice(0, 30));

        if (motionConfig.soundAlert) playAlertChime();
        if (
          motionConfig.browserNotification &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          new Notification(`Movimiento: ${cam.name}`, {
            body: `Nivel ${score}% detectado en ${cam.ip}`,
          });
        }
      }
    },
    [cameras, motionConfig, playAlertChime]
  );

  const handleRecordingComplete = useCallback(
    (blob: Blob, durationSec: number) => {
      if (!selectedCamera) return;
      const url = URL.createObjectURL(blob);
      const now = Date.now();
      const filename = `vigialan_${selectedCamera.id}_${new Date(now)
        .toISOString()
        .replace(/[:.]/g, '-')}.webm`;

      const clip: RecordedClip = {
        id: `clip-${now}`,
        cameraId: selectedCamera.id,
        cameraName: selectedCamera.name,
        timestamp: now,
        durationSec,
        sizeBytes: blob.size,
        url,
        filename,
      };
      setClips((prev) => [clip, ...prev]);
      setBottomTab('clips');

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [selectedCamera]
  );

  const verifyAndUpdateCamera = async (cam: CameraChannel) => {
    try {
      const res = await fetch('/api/verify-camera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: cam.ip,
          port: cam.port,
          onvifPort: cam.onvifPort,
          remoteHost: cam.remoteHost,
          remotePort: cam.remotePort,
          remoteOnvifPort: cam.remoteOnvifPort,
          connectionMode: cam.connectionMode || 'auto',
          protocol: cam.protocol,
          streamPath: cam.streamPath,
          username: cam.username,
          password: cam.password,
        }),
      });
      const data = await res.json();
      const updated: CameraChannel = {
        ...cam,
        status: data.reachable || data.ok ? 'online' : 'offline',
        streamPath: data.resolvedStreamPath || cam.streamPath,
        resolution: data.resolution || cam.resolution,
        fps: data.fps || cam.fps,
        hasAudio: Boolean(data.hasAudio),
        onvifPort: data.onvifPort || cam.onvifPort,
        openPorts: Array.isArray(data.openPorts) && data.openPorts.length > 0 ? data.openPorts : cam.openPorts,
        profileToken: data.profileToken || cam.profileToken,
        manufacturer: data.manufacturer || cam.manufacturer,
        model: data.model || cam.model,
        authStatus: data.authStatus || 'unknown',
        latencyMs: data.latencyMs ?? cam.latencyMs,
        activeEndpoint: data.activeEndpoint || 'local',
        isSaved: true,
        lastSeenAt: Date.now(),
        capabilities: {
          ptz: Boolean(data.ptzSupported || cam.protocol === 'ONVIF'),
          audio: Boolean(data.hasAudio),
          light: true,
          twoWayAudio: Boolean(data.onvifPort || cam.protocol === 'ONVIF'),
        },
      };
      await persistSavedCamera(updated);
      fetchProcesses();
      fetchDiagnostics(updated.ip);

      if (data.authStatus === 'required' || data.authStatus === 'failed') {
        reportError(`La cámara ${cam.name} (${cam.ip}) requiere usuario y contraseña válidos para mostrar video/audio.`);
      } else if (!data.ok && !data.reachable) {
        reportError(
          cam.remoteHost
            ? `No se pudo alcanzar ${cam.ip}:${cam.port} ni el host remoto ${cam.remoteHost}.`
            : `No se pudo alcanzar ${cam.ip}:${cam.port}. Verifica la IP, subred o configura un Host Remoto en Editar.`
        );
      }
    } catch {
      reportError(`Error verificando conexión con ${cam.ip}`);
    }
  };

  const handleSaveCameraOnly = async (updated: CameraChannel) => {
    await persistSavedCamera(updated);
  };

  const handleDeleteSavedCamera = async (id: string) => {
    setCameras((prev) => {
      const next = prev.filter((c) => c.id !== id);
      writeLocalSavedCameras(next);
      return next;
    });
    if (selectedId === id) {
      setSelectedId('');
    }
    try {
      await fetch(`/api/saved-cameras/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // Ignore network error on delete
    }
  };

  const handleSelectAndAutoSaveCamera = (id: string) => {
    setSelectedId(id);
    setViewMode('single');
    const cam = cameras.find((c) => c.id === id);
    if (cam) {
      persistSavedCamera({ ...cam, lastSeenAt: Date.now() });
    }
  };

  const handleCancelScan = useCallback(async () => {
    if (scanSourceRef.current) {
      scanSourceRef.current.close();
      scanSourceRef.current = null;
    }
    try {
      await fetch('/api/scan/cancel', { method: 'POST' });
    } catch {
      // Ignore cancel error
    }
    setIsScanning(false);
    setScanProgress(null);
    setScanMessage('Escaneo cancelado por el usuario.');
    fetchProcesses();
  }, [fetchProcesses]);

  const handleScanNetwork = (forceOutOfNetwork = false) => {
    if (scanSourceRef.current) {
      scanSourceRef.current.close();
      scanSourceRef.current = null;
    }
    const useOutOfNetwork = forceOutOfNetwork || outOfNetworkScan || Boolean(externalTargets.trim());
    if (forceOutOfNetwork && !outOfNetworkScan) {
      setOutOfNetworkScan(true);
    }
    setIsScanning(true);
    setScanMessage('');
    setWifiNetworks([]);
    setScanProgress({
      stage: 'discovery',
      label: useOutOfNetwork
        ? 'Iniciando escaneo local + fuera de red (VPN, rutas, Wi-Fi)...'
        : 'Iniciando escaneo de red...',
      completed: 0,
      total: 1,
      elapsedMs: 0,
      foundCount: 0,
    });

    const params = new URLSearchParams();
    params.set('profile', scanProfile);
    if (customSubnet.trim()) params.set('subnet', customSubnet.trim());
    if (customTimeoutMs.trim()) params.set('timeoutMs', customTimeoutMs.trim());
    if (customConcurrency.trim()) params.set('concurrency', customConcurrency.trim());
    if (useOutOfNetwork) params.set('outOfNetwork', '1');
    if (externalTargets.trim()) params.set('externalTargets', externalTargets.trim());

    const es = new EventSource(`/api/scan-stream?${params.toString()}`);
    scanSourceRef.current = es;

    es.addEventListener('progress', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as ScanProgressState;
        setScanProgress(data);
      } catch {
        // Ignore parse issues
      }
    });

    es.addEventListener('wifi', (ev) => {
      try {
        const nets = JSON.parse((ev as MessageEvent).data) as NearbyWifiInfo[];
        if (Array.isArray(nets)) setWifiNetworks(nets);
      } catch {
        // Ignore parse issues
      }
    });

    es.addEventListener('camera', (ev) => {
      try {
        const cam = JSON.parse((ev as MessageEvent).data) as CameraChannel;
        setCameras((prev) => mergeCameraLists(prev.filter((c) => c.isSaved), [...prev.filter((c) => !c.isSaved), cam]));
        setSelectedId((prevId) => prevId || cam.id);
      } catch {
        // Ignore parse issues
      }
    });

    es.addEventListener('done', (ev) => {
      es.close();
      scanSourceRef.current = null;
      setIsScanning(false);
      setScanProgress(null);
      try {
        const result = JSON.parse((ev as MessageEvent).data) as {
          subnets?: string[];
          cameras?: CameraChannel[];
          wifiNetworks?: NearbyWifiInfo[];
          externalRoutes?: string[];
          cancelled?: boolean;
          durationMs?: number;
        };
        if (Array.isArray(result.wifiNetworks) && result.wifiNetworks.length > 0) {
          setWifiNetworks(result.wifiNetworks);
        }
        const count = result.cameras?.length ?? 0;
        const routesNote =
          result.externalRoutes && result.externalRoutes.length > 0
            ? ` + rutas externas (${result.externalRoutes.join(', ')})`
            : '';
        setScanMessage(
          result.cancelled
            ? 'Escaneo cancelado.'
            : count > 0
              ? `Se encontraron ${count} cámaras en ${result.subnets?.join(', ') || 'red local'}${routesNote} (${result.durationMs ?? 0} ms).`
              : `No se detectaron cámaras en ${result.subnets?.join(', ') || 'la red local'}${routesNote}.`
        );
      } catch {
        setScanMessage('Escaneo finalizado.');
      }
      fetchProcesses();
    });

    es.onerror = () => {
      es.close();
      scanSourceRef.current = null;
      setIsScanning(false);
      setScanProgress(null);
      reportError('La conexión de escaneo en vivo se interrumpió.');
      fetchProcesses();
    };
  };

  const handleKillProcess = async (id: string) => {
    try {
      await fetch(`/api/processes/${encodeURIComponent(id)}/kill`, { method: 'POST' });
      fetchProcesses();
    } catch {
      reportError('No se pudo terminar el proceso seleccionado.');
    }
  };

  const handleAddManualCamera = async (input: {
    name: string;
    ip: string;
    port: number;
    remoteHost?: string;
    streamPath: string;
    protocol: CameraProtocol;
    username?: string;
    password?: string;
  }) => {
    const newCam: CameraChannel = {
      id: `cam-${Date.now().toString().slice(-4)}`,
      name: input.name,
      ip: input.ip,
      port: input.port,
      remoteHost: input.remoteHost,
      connectionMode: 'auto',
      protocol: input.protocol,
      streamPath: input.streamPath,
      status: 'online',
      resolution: 'Auto',
      fps: 25,
      hasAudio: input.protocol === 'RTSP' || input.protocol === 'ONVIF',
      location: 'Red Local',
      nightVision: false,
      username: input.username,
      password: input.password,
      authStatus: 'unknown',
      isSaved: true,
      lastSeenAt: Date.now(),
    };
    await persistSavedCamera(newCam);
    setSelectedId(newCam.id);
    setViewMode('single');
    setShowAddForm(false);
    await verifyAndUpdateCamera(newCam);
  };

  const sendPtzCommand = async (
    direction: 'up' | 'down' | 'left' | 'right' | 'stop',
    stepMs?: number
  ) => {
    if (!selectedCamera) return;
    const ep = resolveEffectiveEndpoint(selectedCamera);
    try {
      const res = await fetch('/api/ptz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: ep.host,
          port: ep.port,
          onvifPort: ep.onvifPort,
          openPorts: selectedCamera.openPorts,
          profileToken: selectedCamera.profileToken,
          username: selectedCamera.username,
          password: selectedCamera.password,
          direction,
          speed: ptzSpeed,
          stepMs,
        }),
      });
      if (!res.ok && direction !== 'stop') {
        const data = await res.json().catch(() => ({}));
        reportError(data.error || 'La cámara no respondió al movimiento PTZ.');
        fetchDiagnostics(ep.host);
      }
    } catch {
      if (direction !== 'stop') {
        reportError('No se pudo enviar el comando PTZ a la cámara.');
      }
    }
  };

  const handleVisionModeChange = async (mode: VisionMode) => {
    setVisionMode(mode);
    if (!selectedCamera) return;
    const ep = resolveEffectiveEndpoint(selectedCamera);
    setIrStatusLabel(`Aplicando ${mode === 'night' ? 'IR Nocturna' : mode === 'normal' ? 'Día (Sin IR)' : 'IR Auto'}...`);
    try {
      const res = await fetch('/api/ir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: ep.host,
          port: ep.port,
          onvifPort: ep.onvifPort,
          openPorts: selectedCamera.openPorts,
          username: selectedCamera.username,
          password: selectedCamera.password,
          mode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setIrStatusLabel(
          mode === 'night'
            ? 'IR ON (Hardware)'
            : mode === 'normal'
              ? 'Día · Sin IR (Hardware)'
              : 'IR Auto (Hardware)'
        );
      } else {
        setIrStatusLabel(mode === 'night' ? 'Nocturna (Visual)' : mode === 'normal' ? 'Sin IR (Visual)' : 'Auto (Visual)');
        reportError(data.error || 'No se confirmó cambio de infrarrojo en hardware; aplicado en pantalla.');
      }
      persistSavedCamera({
        ...selectedCamera,
        irMode: mode,
        nightVision: mode === 'night',
      });
      fetchDiagnostics(ep.host);
    } catch {
      setIrStatusLabel(mode === 'night' ? 'Nocturna (Visual)' : 'Sin IR (Visual)');
      reportError('Error de conexión enviando comando de infrarrojo.');
    }
  };

  const toggleLight = async () => {
    if (!selectedCamera || lightBusy) return;
    const ep = resolveEffectiveEndpoint(selectedCamera);
    const next = !lightOn;
    setLightBusy(true);
    try {
      const res = await fetch('/api/light', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: ep.host,
          port: ep.port,
          onvifPort: ep.onvifPort,
          openPorts: selectedCamera.openPorts,
          username: selectedCamera.username,
          password: selectedCamera.password,
          on: next,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setLightOn(next);
      } else {
        reportError(data.error || 'No se pudo controlar la linterna de esta cámara.');
      }
      fetchDiagnostics(ep.host);
    } catch {
      reportError('Error de conexión al intentar encender/apagar la luz.');
    } finally {
      setLightBusy(false);
    }
  };

  const toggleTalk = async () => {
    if (!selectedCamera) return;
    const ep = resolveEffectiveEndpoint(selectedCamera);
    const targetUrl = buildStreamUrl(selectedCamera, ep);
    if (talkActive) {
      voiceSessionRef.current?.stop();
      voiceSessionRef.current = null;
      setTalkActive(false);
      fetch('/api/talk/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      }).catch(() => {});
      return;
    }

    try {
      let chunkErrorReported = false;
      const session = await startVoiceTalkSession({
        initialDeepVoice: deepVoice,
        initialLocalMonitor: false,
        onError: (msg) => reportError(msg),
        onChunkReady: async (audioBase64) => {
          const res = await fetch('/api/talk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: targetUrl,
              ip: ep.host,
              port: ep.port,
              onvifPort: ep.onvifPort,
              openPorts: selectedCamera.openPorts,
              username: selectedCamera.username,
              password: selectedCamera.password,
              audioBase64,
              mimeType: 'audio/wav',
            }),
          });
          if (!res.ok && !chunkErrorReported) {
            chunkErrorReported = true;
            const d = await res.json().catch(() => ({}));
            reportError(d.error || 'La cámara no aceptó audio bidireccional.');
            fetchDiagnostics(ep.host);
          }
        },
      });
      voiceSessionRef.current = session;
      setTalkActive(true);
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'No se pudo activar el micrófono.');
      setTalkActive(false);
    }
  };

  const handleRunDiagnostic = async () => {
    if (!selectedCamera) return;
    const ep = resolveEffectiveEndpoint(selectedCamera);
    setIsRunningDiagnostic(true);
    try {
      const res = await fetch('/api/diagnose-camera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: ep.host,
          port: ep.port,
          onvifPort: ep.onvifPort,
          openPorts: selectedCamera.openPorts,
          protocol: selectedCamera.protocol,
          streamPath: selectedCamera.streamPath,
          username: selectedCamera.username,
          password: selectedCamera.password,
        }),
      });
      const data = await res.json();
      if (data.checks) setDiagnosticChecks(data.checks);
      if (data.samples) setDiagnosticSamples(data.samples);
      if (Array.isArray(data.openPorts) && data.openPorts.length > 0) {
        persistSavedCamera({
          ...selectedCamera,
          openPorts: data.openPorts,
        });
      }
    } catch {
      reportError('No se pudo completar el diagnóstico de hardware.');
    } finally {
      setIsRunningDiagnostic(false);
    }
  };

  const handleClearDiagnostics = async () => {
    try {
      await fetch('/api/diagnostics', { method: 'DELETE' });
      setDiagnosticSamples([]);
    } catch {
      // Ignore
    }
  };

  const updateZoomPan = (nextZoom: number, nextPanX: number, nextPanY: number) => {
    const clamped = clampZoomPan(nextZoom, nextPanX, nextPanY);
    setZoom(clamped.zoom);
    setPanX(clamped.panX);
    setPanY(clamped.panY);
  };

  const handleDropOnMosaicCamera = (targetId: string) => {
    if (!draggedCamId || draggedCamId === targetId) return;
    const currentIds = onlineCameras.map((c) => c.id);
    const fromIdx = currentIds.indexOf(draggedCamId);
    const toIdx = currentIds.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...currentIds];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setMosaicOrder(next);
    try {
      localStorage.setItem('vigialan_mosaic_order', JSON.stringify(next));
    } catch {
      // Ignore storage errors
    }
    setDraggedCamId(null);
  };

  const showSidebar = viewMode === 'single' || viewMode === 'mosaic';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Bar: 3 clean zones */}
      <header className="h-14 px-4 lg:px-6 border-b border-slate-800 bg-slate-950 flex items-center justify-between gap-4 shrink-0">
        <span className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 font-display">
          VigíaLAN
        </span>

        <nav
          aria-label="Modos de vista"
          className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setViewMode('single')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'single' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Canal Único</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('mosaic')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'mosaic' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Grid2x2 className="w-3.5 h-3.5" />
            <span>Mosaico</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('saved')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'saved' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <BookmarkCheck className="w-3.5 h-3.5" />
            <span className="tabular-nums">Guardados ({savedCameras.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('termux')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'termux' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Termux</span>
          </button>
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          {isScanning ? (
            <button
              type="button"
              onClick={handleCancelScan}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Cancelar Escaneo</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleScanNetwork(false)}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Escanear Red</span>
            </button>
          )}
        </div>
      </header>

      <ErrorBanner
        errors={errors}
        onDismiss={(id) => setErrors((prev) => prev.filter((e) => e.id !== id))}
        onClearAll={() => setErrors([])}
      />

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {showSidebar && (
          <CameraSidebar
            cameras={cameras}
            filteredCameras={filteredCameras}
            onlineCount={onlineCameras.length}
            selectedCameraId={selectedCamera?.id}
            viewMode={viewMode}
            isScanning={isScanning}
            scanProgress={scanProgress}
            scanProfile={scanProfile}
            customSubnet={customSubnet}
            customTimeoutMs={customTimeoutMs}
            customConcurrency={customConcurrency}
            outOfNetworkScan={outOfNetworkScan}
            externalTargets={externalTargets}
            wifiNetworks={wifiNetworks}
            searchQuery={searchQuery}
            protocolFilter={protocolFilter}
            onlyOnline={onlyOnline}
            onlyAudio={onlyAudio}
            onlyPtz={onlyPtz}
            showAddForm={showAddForm}
            onToggleAddForm={() => setShowAddForm((v) => !v)}
            onScanProfileChange={setScanProfile}
            onCustomSubnetChange={setCustomSubnet}
            onCustomTimeoutChange={setCustomTimeoutMs}
            onCustomConcurrencyChange={setCustomConcurrency}
            onOutOfNetworkScanChange={setOutOfNetworkScan}
            onExternalTargetsChange={setExternalTargets}
            onStartOutOfNetworkScan={() => handleScanNetwork(true)}
            onCancelScan={handleCancelScan}
            onSearchQueryChange={setSearchQuery}
            onProtocolFilterChange={setProtocolFilter}
            onOnlyOnlineChange={setOnlyOnline}
            onOnlyAudioChange={setOnlyAudio}
            onOnlyPtzChange={setOnlyPtz}
            onSelectCamera={handleSelectAndAutoSaveCamera}
            onAddManualCamera={handleAddManualCamera}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0 bg-slate-950">
          {viewMode === 'termux' && <TermuxSetupView />}

          {viewMode === 'saved' && (
            <SavedDevicesView
              savedCameras={savedCameras}
              onConnectCamera={(cam) => {
                handleSelectAndAutoSaveCamera(cam.id);
                verifyAndUpdateCamera(cam);
              }}
              onTestCamera={verifyAndUpdateCamera}
              onEditCamera={(cam) => setCredsCamera(cam)}
              onDeleteCamera={handleDeleteSavedCamera}
            />
          )}

          {viewMode === 'mosaic' && (
            <MosaicView
              cameras={onlineCameras}
              draggedCamId={draggedCamId}
              onDragStart={setDraggedCamId}
              onDropOnCamera={handleDropOnMosaicCamera}
              onOpenCamera={handleSelectAndAutoSaveCamera}
              onOpenMotionSettings={() => setIsMotionModalOpen(true)}
              onMotionScore={handleMotionScore}
            />
          )}

          {viewMode === 'single' && !selectedCamera && (
            <div className="flex-1 flex flex-col items-center justify-center p-6 lg:p-8 space-y-6">
              <div className="text-center space-y-4 max-w-lg">
                <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto">
                  <Camera className="w-6 h-6 text-slate-400" />
                </div>
                <div className="space-y-1.5">
                  <h1 className="text-lg font-semibold text-slate-100">Sin cámaras conectadas</h1>
                  <p className="text-sm text-slate-400">
                    {scanMessage ||
                      'Pulsa "Escanear Red" para descubrir cámaras en tus subredes, agrega una IP manualmente o abre tus Dispositivos Guardados.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={isScanning ? handleCancelScan : () => handleScanNetwork(false)}
                    className={`px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors cursor-pointer ${
                      isScanning ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-600 hover:bg-sky-500'
                    }`}
                  >
                    {isScanning ? 'Cancelar Escaneo' : 'Escanear Red Local'}
                  </button>
                  <button
                    type="button"
                    disabled={isScanning}
                    onClick={() => handleScanNetwork(true)}
                    className="px-4 py-2 text-xs font-medium text-sky-200 bg-sky-950/60 border border-sky-800/70 hover:bg-sky-900/60 disabled:opacity-40 rounded-lg transition-colors cursor-pointer"
                  >
                    Escanear fuera de la red
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(true)}
                    className="px-4 py-2 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    Agregar IP manual
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowEmptyProcesses((v) => !v)}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <Activity className="w-3.5 h-3.5 text-sky-400" />
                    <span>Procesos ({activeProcessCount} activos)</span>
                  </button>
                </div>
              </div>

              {(showEmptyProcesses || operations.length > 0) && (
                <div className="w-full max-w-5xl bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <h2 className="text-xs font-semibold text-slate-200 mb-3">
                    Procesos y Conexiones ({activeProcessCount} activos)
                  </h2>
                  <ProcessMonitorPanel
                    operations={operations}
                    onRefresh={fetchProcesses}
                    onKill={handleKillProcess}
                  />
                </div>
              )}
            </div>
          )}

          {viewMode === 'single' && selectedCamera && (
            <SingleCameraView
              camera={selectedCamera}
              zoom={zoom}
              panX={panX}
              panY={panY}
              audioEnabled={audioEnabled}
              visionMode={visionMode}
              irStatusLabel={irStatusLabel}
              lightOn={lightOn}
              lightBusy={lightBusy}
              talkActive={talkActive}
              deepVoice={deepVoice}
              ptzSpeed={ptzSpeed}
              isRecording={isRecording}
              snapshotTrigger={snapshotTrigger}
              motionConfig={motionConfig}
              motionEvents={motionEvents}
              clips={clips}
              operations={operations}
              activeProcessCount={activeProcessCount}
              diagnosticChecks={diagnosticChecks}
              diagnosticSamples={diagnosticSamples}
              isRunningDiagnostic={isRunningDiagnostic}
              bottomTab={bottomTab}
              audioRef={audioRef}
              onAudioError={() => {
                if (audioEnabled) {
                  reportError(
                    `No se pudo recibir audio desde ${selectedCamera.ip}. Revisa la pestaña Diagnóstico para ver el motivo exacto.`
                  );
                  setAudioEnabled(false);
                  fetchDiagnostics(selectedCamera.ip);
                }
              }}
              onOpenCredentials={() => setCredsCamera(selectedCamera)}
              onToggleAudio={() => setAudioEnabled((v) => !v)}
              onVisionModeChange={handleVisionModeChange}
              onToggleRecord={() => setIsRecording((v) => !v)}
              onOpenMotionSettings={() => setIsMotionModalOpen(true)}
              onZoomPanChange={updateZoomPan}
              onMotionScore={handleMotionScore}
              onRecordingComplete={handleRecordingComplete}
              onPtzCommand={sendPtzCommand}
              onPtzSpeedChange={setPtzSpeed}
              onToggleLight={toggleLight}
              onSnapshot={() => setSnapshotTrigger((n) => n + 1)}
              onToggleTalk={toggleTalk}
              onToggleDeepVoice={() => setDeepVoice((v) => !v)}
              onBottomTabChange={setBottomTab}
              onRefreshProcesses={fetchProcesses}
              onKillProcess={handleKillProcess}
              onRunDiagnostic={handleRunDiagnostic}
              onRefreshDiagnostics={() => fetchDiagnostics(selectedCamera.ip)}
              onClearDiagnostics={handleClearDiagnostics}
              onRetryVerify={() => verifyAndUpdateCamera(selectedCamera)}
            />
          )}
        </main>
      </div>

      <MotionSettingsModal
        isOpen={isMotionModalOpen}
        config={motionConfig}
        onChange={setMotionConfig}
        onClose={() => setIsMotionModalOpen(false)}
      />

      <CameraCredentialsModal
        camera={credsCamera}
        onClose={() => setCredsCamera(null)}
        onSaveOnly={handleSaveCameraOnly}
        onSaveAndVerify={verifyAndUpdateCamera}
        onDelete={handleDeleteSavedCamera}
      />
    </div>
  );
}
