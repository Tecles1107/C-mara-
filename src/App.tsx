import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Grid2x2,
  Maximize2,
  Mic,
  MicOff,
  Moon,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Square,
  Terminal,
  Video,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bell,
  GripVertical,
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
  formatBytes,
  formatDuration,
  shouldTriggerMotionAlert,
} from './utils/cameraLogic';
import { CameraFeedCanvas } from './components/CameraFeedCanvas';
import { TermuxSetupView } from './components/TermuxSetupView';
import { MotionSettingsModal } from './components/MotionSettingsModal';
import { AppErrorItem, ErrorBanner } from './components/ErrorBanner';

export default function App() {
  const [cameras, setCameras] = useState<CameraChannel[]>(INITIAL_CAMERAS);
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
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  // Single camera controls
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [nightVision, setNightVision] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // Motion & Clips
  const [motionConfig, setMotionConfig] = useState<MotionAlertConfig>(DEFAULT_MOTION_CONFIG);
  const [isMotionModalOpen, setIsMotionModalOpen] = useState(false);
  const [motionEvents, setMotionEvents] = useState<MotionEvent[]>([]);
  const [clips, setClips] = useState<RecordedClip[]>([]);
  const [bottomTab, setBottomTab] = useState<'events' | 'clips'>('events');

  // Manual camera add
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIp, setNewIp] = useState('192.168.1.');
  const [newPort, setNewPort] = useState('554');
  const [newPath, setNewPath] = useState('/live/ch00_0');
  const [newProtocol, setNewProtocol] = useState<CameraProtocol>('RTSP');

  const lastAlertMapRef = useRef<Record<string, number>>({});
  const videoContainerRef = useRef<HTMLDivElement | null>(null);

  const filteredCameras = useMemo(
    () => filterCameras(cameras, searchQuery, onlyOnline),
    [cameras, searchQuery, onlyOnline]
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

  useEffect(() => {
    const onErr = (event: ErrorEvent) => {
      event.preventDefault();
      reportError(event.message || 'Error inesperado en la aplicación');
    };
    const onRej = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || 'Error de promesa no controlada');
      reportError(reason);
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [reportError]);

  // Sync nightVision default when switching camera
  useEffect(() => {
    if (selectedCamera) {
      setNightVision(selectedCamera.nightVision);
      setZoom(1);
      setPanX(0);
      setPanY(0);
      setIsRecording(false);
    }
  }, [selectedCamera?.id]);

  const playAlertChime = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

        if (motionConfig.soundAlert) {
          playAlertChime();
        }
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

      // Trigger download to internal storage
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [selectedCamera]
  );

  const handleScanNetwork = async () => {
    setIsScanning(true);
    setScanMessage('');
    try {
      const res = await fetch('/api/scan');
      const data = await res.json();
      const discovered: CameraChannel[] = data.cameras || [];
      setCameras((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const merged = [...prev];
        for (const cam of discovered) {
          if (!existingIds.has(cam.id)) merged.push(cam);
        }
        return merged;
      });
      if (discovered.length > 0 && !selectedId) {
        setSelectedId(discovered[0].id);
      }
      setScanMessage(
        discovered.length > 0
          ? `Se encontraron ${discovered.length} cámaras en ${data.subnets?.join(', ') || 'red local'}.`
          : `No se detectaron puertos de cámara abiertos en ${data.subnets?.join(', ') || 'la red local'}.`
      );
    } catch {
      setScanMessage('Error al escanear la red local.');
    } finally {
      setIsScanning(false);
    }
  };

  const handleAddCamera = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newIp.trim()) return;
    const newCam: CameraChannel = {
      id: `cam-${Date.now().toString().slice(-4)}`,
      name: newName.trim(),
      ip: newIp.trim(),
      port: Number(newPort) || 554,
      protocol: newProtocol,
      streamPath: newPath.trim() || '/live/ch00_0',
      status: 'online',
      resolution: 'Auto',
      fps: 25,
      hasAudio: newProtocol === 'RTSP' || newProtocol === 'ONVIF',
      location: 'Red Local',
      nightVision: false,
    };
    setCameras((prev) => [newCam, ...prev]);
    setSelectedId(newCam.id);
    setViewMode('single');
    setNewName('');
    setNewIp('192.168.1.');
    setShowAddForm(false);
  };

  const sendPtzCommand = async (direction: 'up' | 'down' | 'left' | 'right' | 'stop') => {
    if (!selectedCamera) return;
    try {
      await fetch('/api/ptz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: selectedCamera.ip,
          port: selectedCamera.port,
          direction,
        }),
      });
    } catch {
      // Ignore PTZ network errors
    }
  };

  const updateZoomPan = (nextZoom: number, nextPanX: number, nextPanY: number) => {
    const clamped = clampZoomPan(nextZoom, nextPanX, nextPanY);
    setZoom(clamped.zoom);
    setPanX(clamped.panX);
    setPanY(clamped.panY);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 zones */}
      <header className="h-14 px-4 lg:px-6 border-b border-slate-800 bg-slate-950 flex items-center justify-between gap-8 shrink-0">
        <span className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 font-display">
          VigíaLAN
        </span>

        <nav aria-label="Modos de vista" className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
          <button
            type="button"
            onClick={() => setViewMode('single')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'single'
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Canal Único</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('mosaic')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'mosaic'
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Grid2x2 className="w-3.5 h-3.5" />
            <span>Mosaico</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('termux')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === 'termux'
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Termux</span>
          </button>
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleScanNetwork}
            disabled={isScanning}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
            <span>{isScanning ? 'Escaneando...' : 'Escanear Red'}</span>
          </button>
        </div>
      </header>

      <ErrorBanner
        errors={errors}
        onDismiss={(id) => setErrors((prev) => prev.filter((e) => e.id !== id))}
        onClearAll={() => setErrors([])}
      />

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Sidebar: Camera List */}
        {viewMode !== 'termux' && (
          <aside className="w-full lg:w-72 border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-900/50 flex flex-col shrink-0">
            <div className="p-4 border-b border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-200">
                  Cámaras en Red ({onlineCameras.length}/{cameras.length})
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAddForm((v) => !v)}
                  aria-label="Agregar cámara manual"
                  className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {showAddForm && (
                <form onSubmit={handleAddCamera} className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2.5">
                  <input
                    type="text"
                    placeholder="Nombre (ej. Entrada)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    required
                    className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="IP local"
                      value={newIp}
                      onChange={(e) => setNewIp(e.target.value)}
                      required
                      className="flex-1 px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                    />
                    <input
                      type="text"
                      placeholder="Puerto"
                      value={newPort}
                      onChange={(e) => setNewPort(e.target.value)}
                      className="w-16 px-2 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <select
                      value={newProtocol}
                      onChange={(e) => setNewProtocol(e.target.value as CameraProtocol)}
                      className="px-2 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs text-slate-200"
                    >
                      <option value="RTSP">RTSP</option>
                      <option value="ONVIF">ONVIF</option>
                      <option value="MJPEG">MJPEG</option>
                      <option value="HTTP-FLV">HTTP-FLV</option>
                    </select>
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded transition-colors cursor-pointer"
                    >
                      Conectar
                    </button>
                  </div>
                </form>
              )}

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filtrar por IP, nombre o protocolo..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-md text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyOnline}
                  onChange={(e) => setOnlyOnline(e.target.checked)}
                  className="w-3.5 h-3.5 accent-sky-500 rounded cursor-pointer"
                />
                <span>Mostrar solo canales en línea</span>
              </label>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
              {filteredCameras.map((cam) => {
                const isSelected = cam.id === selectedCamera.id && viewMode === 'single';
                return (
                  <button
                    key={cam.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(cam.id);
                      setViewMode('single');
                    }}
                    className={`w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-slate-800/80'
                        : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {cam.status === 'online' && (
                        <div className="w-16 h-10 rounded bg-slate-950 border border-slate-800 overflow-hidden shrink-0">
                          <img
                            src={`/api/stream?url=${encodeURIComponent(buildStreamUrl(cam))}`}
                            alt={`Vista previa ${cam.name}`}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-100 truncate">
                            {cam.name}
                          </span>
                          <span
                            className={`text-xs font-medium shrink-0 ${
                              cam.status === 'online' ? 'text-emerald-400' : 'text-slate-500'
                            }`}
                          >
                            {cam.status === 'online' ? 'En línea' : 'Sin señal'}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 font-mono tabular-nums">
                          <span>{cam.ip}</span>
                          <span aria-hidden="true">·</span>
                          <span>{cam.protocol}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 bg-slate-950">
          {viewMode === 'termux' && <TermuxSetupView />}

          {viewMode === 'mosaic' && (
            <div className="p-4 lg:p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-semibold text-slate-100">
                    Vista Mosaico ({onlineCameras.length} canales activos)
                  </h1>
                  <p className="text-xs text-slate-400">
                    Haz clic en cualquier cámara para ampliar, escuchar audio o grabar un clip.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsMotionModalOpen(true)}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>Alertas</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {onlineCameras.map((cam) => (
                  <div
                    key={cam.id}
                    draggable
                    onDragStart={() => setDraggedCamId(cam.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (!draggedCamId || draggedCamId === cam.id) return;
                      const currentIds = onlineCameras.map((c) => c.id);
                      const fromIdx = currentIds.indexOf(draggedCamId);
                      const toIdx = currentIds.indexOf(cam.id);
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
                    }}
                    className={`bg-slate-900 border rounded-lg overflow-hidden flex flex-col transition-opacity ${
                      draggedCamId === cam.id ? 'opacity-50 border-sky-500' : 'border-slate-800'
                    }`}
                  >
                    <div className="aspect-video relative">
                      <CameraFeedCanvas
                        camera={cam}
                        compact
                        onMotionScore={handleMotionScore}
                      />
                    </div>
                    <div className="px-3.5 py-2.5 flex items-center justify-between gap-3 border-t border-slate-800">
                      <div className="flex items-center gap-2 min-w-0">
                        <GripVertical className="w-4 h-4 text-slate-500 cursor-grab shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-100 truncate">
                            {cam.name}
                          </div>
                          <div className="text-xs text-slate-400 font-mono tabular-nums">
                            {cam.ip}:{cam.port} · {cam.protocol}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(cam.id);
                          setViewMode('single');
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 bg-slate-950 border border-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Ampliar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {viewMode === 'single' && !selectedCamera && (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
              <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                <Camera className="w-6 h-6 text-slate-400" />
              </div>
              <div className="space-y-1 max-w-md">
                <h2 className="text-lg font-semibold text-slate-100">
                  Sin cámaras conectadas
                </h2>
                <p className="text-sm text-slate-400">
                  {scanMessage || 'Pulsa "Escanear Red" para buscar cámaras RTSP/ONVIF/MJPEG en tu red local, o agrega una IP manualmente desde el panel izquierdo.'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleScanNetwork}
                  disabled={isScanning}
                  className="px-4 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-lg transition-colors cursor-pointer"
                >
                  {isScanning ? 'Escaneando...' : 'Escanear Red Local'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddForm(true)}
                  className="px-4 py-2 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                >
                  Agregar IP manual
                </button>
              </div>
            </div>
          )}

          {viewMode === 'single' && selectedCamera && (
            <div className="p-4 lg:p-6 space-y-5 max-w-6xl w-full mx-auto">
              {audioEnabled && selectedCamera.status === 'online' && selectedCamera.hasAudio && (
                <audio
                  autoPlay
                  src={`/api/audio?url=${encodeURIComponent(buildStreamUrl(selectedCamera))}`}
                  className="hidden"
                />
              )}
              {/* Camera Header & Controls */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2.5">
                    <Camera className="w-4 h-4 text-sky-400" />
                    <h1 className="text-xl font-semibold text-slate-100">
                      {selectedCamera.name}
                    </h1>
                  </div>
                  <p className="text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                    {selectedCamera.ip}:{selectedCamera.port}{selectedCamera.streamPath} · {selectedCamera.protocol} · {selectedCamera.resolution} · {selectedCamera.fps} FPS
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAudioEnabled((v) => !v)}
                    disabled={!selectedCamera.hasAudio || selectedCamera.status !== 'online'}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-40 ${
                      audioEnabled
                        ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {audioEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                    <span>{audioEnabled ? 'Audio activo' : 'Escuchar'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setNightVision((v) => !v)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                      nightVision
                        ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Moon className="w-3.5 h-3.5" />
                    <span>Visión IR</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsRecording((v) => !v)}
                    disabled={selectedCamera.status !== 'online'}
                    className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
                      isRecording
                        ? 'bg-red-600 hover:bg-red-500 text-white'
                        : 'bg-slate-100 hover:bg-white text-slate-950'
                    }`}
                  >
                    {isRecording ? <Square className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                    <span>{isRecording ? 'Detener y Guardar' : 'Grabar Clip'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsMotionModalOpen(true)}
                    aria-label="Configurar alertas de movimiento"
                    className="p-2 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Video Viewport */}
              <div ref={videoContainerRef} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="aspect-video w-full relative">
                  <CameraFeedCanvas
                    camera={selectedCamera}
                    zoom={zoom}
                    panX={panX}
                    panY={panY}
                    nightVisionOverride={nightVision}
                    isRecording={isRecording}
                    onMotionScore={handleMotionScore}
                    onRecordingComplete={handleRecordingComplete}
                  />
                </div>

                {/* Digital Zoom & Pan Bar */}
                <div className="px-4 py-2.5 bg-slate-950/70 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">Zoom digital:</span>
                    <button
                      type="button"
                      onClick={() => updateZoomPan(zoom - 0.5, panX, panY)}
                      aria-label="Alejar zoom"
                      className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-xs font-mono tabular-nums text-slate-200 w-10 text-center">
                      {zoom.toFixed(1)}x
                    </span>
                    <button
                      type="button"
                      onClick={() => updateZoomPan(zoom + 0.5, panX, panY)}
                      aria-label="Acercar zoom"
                      className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    {zoom > 1 && (
                      <button
                        type="button"
                        onClick={() => updateZoomPan(1, 0, 0)}
                        aria-label="Restablecer zoom"
                        className="p-1.5 text-slate-400 hover:text-slate-200 rounded cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (document.fullscreenElement) {
                          document.exitFullscreen();
                        } else {
                          videoContainerRef.current?.requestFullscreen?.();
                        }
                      }}
                      className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>Pantalla completa</span>
                    </button>
                  </div>

                  {/* PTZ Motorized Camera Control Panel */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400 mr-1">Mover cámara (PTZ):</span>
                    <button
                      type="button"
                      onMouseDown={() => sendPtzCommand('left')}
                      onMouseUp={() => sendPtzCommand('stop')}
                      aria-label="Mover cámara izquierda"
                      className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={() => sendPtzCommand('up')}
                      onMouseUp={() => sendPtzCommand('stop')}
                      aria-label="Mover cámara arriba"
                      className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={() => sendPtzCommand('down')}
                      onMouseUp={() => sendPtzCommand('stop')}
                      aria-label="Mover cámara abajo"
                      className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={() => sendPtzCommand('right')}
                      onMouseUp={() => sendPtzCommand('stop')}
                      aria-label="Mover cámara derecha"
                      className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {zoom > 1 && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => updateZoomPan(zoom, panX + 6, panY)}
                        aria-label="Mover izquierda"
                        className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => updateZoomPan(zoom, panX, panY + 6)}
                        aria-label="Mover arriba"
                        className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => updateZoomPan(zoom, panX, panY - 6)}
                        aria-label="Mover abajo"
                        className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => updateZoomPan(zoom, panX - 6, panY)}
                        aria-label="Mover derecha"
                        className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom Panel: Motion Events & Recorded Clips */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setBottomTab('events')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        bottomTab === 'events'
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Eventos de Movimiento ({motionEvents.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setBottomTab('clips')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        bottomTab === 'clips'
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Clips Grabados ({clips.length})
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsMotionModalOpen(true)}
                    className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
                  >
                    <Bell className="w-3.5 h-3.5" />
                    <span>Sensibilidad: {motionConfig.sensitivity}%</span>
                  </button>
                </div>

                <div className="p-4">
                  {bottomTab === 'events' ? (
                    motionEvents.length === 0 ? (
                      <p className="text-xs text-slate-500 py-4 text-center">
                        Monitoreando cambios en la imagen. Los eventos de movimiento aparecerán aquí.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-800/70 max-h-48 overflow-y-auto">
                        {motionEvents.map((evt) => (
                          <div
                            key={evt.id}
                            className="py-2 flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <Radio className="w-3.5 h-3.5 text-amber-400" />
                              <span className="font-medium text-slate-200">{evt.cameraName}</span>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-400">Intensidad {evt.score}%</span>
                            </div>
                            <span className="font-mono tabular-nums text-slate-500">
                              {new Date(evt.timestamp).toLocaleTimeString('es-ES', { hour12: false })}
                            </span>
                          </div>
                        ))}
                      </div>
                    )
                  ) : clips.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4 text-center">
                      Aún no hay clips grabados. Pulsa "Grabar Clip" para guardar un video en el dispositivo.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-800/70 max-h-48 overflow-y-auto">
                      {clips.map((clip) => (
                        <div
                          key={clip.id}
                          className="py-2 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-slate-200 truncate">
                              {clip.cameraName} — {clip.filename}
                            </div>
                            <div className="text-slate-400 font-mono tabular-nums">
                              {formatDuration(clip.durationSec)} · {formatBytes(clip.sizeBytes)}
                            </div>
                          </div>
                          <a
                            href={clip.url}
                            download={clip.filename}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors shrink-0"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Guardar</span>
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <MotionSettingsModal
        isOpen={isMotionModalOpen}
        config={motionConfig}
        onChange={setMotionConfig}
        onClose={() => setIsMotionModalOpen(false)}
      />
    </div>
  );
}
