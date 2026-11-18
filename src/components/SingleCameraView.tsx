import React, { useRef } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Camera,
  Download,
  Image as ImageIcon,
  KeyRound,
  Lightbulb,
  Maximize2,
  Mic,
  MicOff,
  Radio,
  RotateCcw,
  Settings,
  ShieldCheck,
  Square,
  Video,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  CameraChannel,
  MotionAlertConfig,
  MotionEvent,
  RecordedClip,
  buildStreamUrl,
  formatBytes,
  formatDuration,
} from '../utils/cameraLogic';
import { ProcessOperationRecord, formatLatency } from '../utils/processLogic';
import { CameraFeedCanvas, VisionMode } from './CameraFeedCanvas';
import { ProcessMonitorPanel } from './ProcessMonitorPanel';

interface SingleCameraViewProps {
  camera: CameraChannel;
  zoom: number;
  panX: number;
  panY: number;
  audioEnabled: boolean;
  visionMode: VisionMode;
  lightOn: boolean;
  talkActive: boolean;
  deepVoice: boolean;
  ptzSpeed: number;
  isRecording: boolean;
  snapshotTrigger: number;
  motionConfig: MotionAlertConfig;
  motionEvents: MotionEvent[];
  clips: RecordedClip[];
  operations: ProcessOperationRecord[];
  activeProcessCount: number;
  bottomTab: 'events' | 'clips' | 'processes';
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onAudioError: () => void;
  onOpenCredentials: () => void;
  onToggleAudio: () => void;
  onVisionModeChange: (mode: VisionMode) => void;
  onToggleRecord: () => void;
  onOpenMotionSettings: () => void;
  onZoomPanChange: (zoom: number, panX: number, panY: number) => void;
  onMotionScore: (cameraId: string, score: number) => void;
  onRecordingComplete: (blob: Blob, durationSec: number) => void;
  onPtzCommand: (dir: 'up' | 'down' | 'left' | 'right' | 'stop', stepMs?: number) => void;
  onPtzSpeedChange: (speed: number) => void;
  onToggleLight: () => void;
  onSnapshot: () => void;
  onToggleTalk: () => void;
  onToggleDeepVoice: () => void;
  onBottomTabChange: (tab: 'events' | 'clips' | 'processes') => void;
  onRefreshProcesses: () => void;
  onKillProcess: (id: string) => void;
}

export const SingleCameraView: React.FC<SingleCameraViewProps> = ({
  camera,
  zoom,
  panX,
  panY,
  audioEnabled,
  visionMode,
  lightOn,
  talkActive,
  deepVoice,
  ptzSpeed,
  isRecording,
  snapshotTrigger,
  motionConfig,
  motionEvents,
  clips,
  operations,
  activeProcessCount,
  bottomTab,
  audioRef,
  onAudioError,
  onOpenCredentials,
  onToggleAudio,
  onVisionModeChange,
  onToggleRecord,
  onOpenMotionSettings,
  onZoomPanChange,
  onMotionScore,
  onRecordingComplete,
  onPtzCommand,
  onPtzSpeedChange,
  onToggleLight,
  onSnapshot,
  onToggleTalk,
  onToggleDeepVoice,
  onBottomTabChange,
  onRefreshProcesses,
  onKillProcess,
}) => {
  const videoContainerRef = useRef<HTMLDivElement | null>(null);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      videoContainerRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  const needsAuth = camera.authStatus === 'required' || camera.authStatus === 'failed';

  return (
    <div className="p-4 lg:p-6 space-y-5 max-w-6xl w-full mx-auto">
      <audio
        ref={audioRef}
        src={
          audioEnabled && camera.status === 'online'
            ? `/api/audio?url=${encodeURIComponent(buildStreamUrl(camera))}`
            : undefined
        }
        onError={onAudioError}
        className="hidden"
      />

      {/* Camera Header & Primary Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-sky-400 shrink-0" />
            <h1 className="text-xl font-semibold text-slate-100 truncate">{camera.name}</h1>
            {camera.authStatus === 'verified' && (
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-label="Credenciales verificadas" />
            )}
          </div>
          <p className="text-xs text-slate-400 font-mono tabular-nums mt-0.5 truncate">
            {camera.ip}:{camera.port}{camera.streamPath} · {camera.protocol} · {camera.resolution} · {camera.fps} FPS
            {camera.latencyMs !== undefined ? ` · ${formatLatency(camera.latencyMs)}` : ''}
            {camera.manufacturer ? ` · ${camera.manufacturer}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenCredentials}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
              needsAuth
                ? 'bg-amber-950/50 border-amber-700/60 text-amber-200 hover:bg-amber-900/50'
                : 'bg-slate-900 border-slate-800 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <KeyRound className={`w-3.5 h-3.5 ${needsAuth ? 'text-amber-400' : 'text-sky-400'}`} />
            <span>{needsAuth ? 'Clave requerida' : 'Credenciales'}</span>
          </button>

          <button
            type="button"
            onClick={onToggleAudio}
            disabled={camera.status !== 'online'}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-40 ${
              audioEnabled
                ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {audioEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
            <span>{audioEnabled ? 'Audio activo' : 'Escuchar'}</span>
          </button>

          <select
            aria-label="Modo de visión"
            value={visionMode}
            onChange={(e) => onVisionModeChange(e.target.value as VisionMode)}
            className="px-3 py-2 text-xs font-medium rounded-lg border bg-slate-900 border-slate-800 text-slate-200 cursor-pointer"
          >
            <option value="normal">Visión: Normal</option>
            <option value="night">Visión: Nocturna</option>
            <option value="auto">Visión: Automático</option>
          </select>

          <button
            type="button"
            onClick={onToggleRecord}
            disabled={camera.status !== 'online'}
            className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
              isRecording
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-slate-100 hover:bg-white text-slate-950'
            }`}
          >
            {isRecording ? <Square className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
            <span>{isRecording ? 'Detener Clip' : 'Grabar Clip'}</span>
          </button>

          <button
            type="button"
            onClick={onOpenMotionSettings}
            aria-label="Configurar alertas de movimiento"
            className="p-2 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Video Viewport & Unified Control Dock */}
      <div ref={videoContainerRef} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="aspect-video w-full relative">
          <CameraFeedCanvas
            camera={camera}
            zoom={zoom}
            panX={panX}
            panY={panY}
            onZoomPanChange={onZoomPanChange}
            visionMode={visionMode}
            isRecording={isRecording}
            snapshotTrigger={snapshotTrigger}
            onMotionScore={onMotionScore}
            onRecordingComplete={onRecordingComplete}
          />

          {/* Compact In-Video Quick Action HUD (No duplicate PTZ or Record buttons) */}
          <div className="absolute bottom-3 right-3 flex flex-wrap items-center gap-1.5 bg-slate-950/85 backdrop-blur-sm border border-slate-800 rounded-lg p-1.5">
            <button
              type="button"
              onClick={onToggleLight}
              title="Encender o apagar luz"
              aria-label="Encender o apagar luz"
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                lightOn ? 'bg-amber-500/25 text-amber-300' : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Lightbulb className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{lightOn ? 'Luz ON' : 'Luz'}</span>
            </button>
            <button
              type="button"
              onClick={onSnapshot}
              title="Tomar foto"
              aria-label="Tomar foto"
              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 rounded transition-colors cursor-pointer"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Foto</span>
            </button>
            <button
              type="button"
              onClick={onToggleTalk}
              title="Hablar por cámara"
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                talkActive ? 'bg-sky-600 text-white' : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>{talkActive ? 'Hablando' : 'Hablar'}</span>
            </button>
            <button
              type="button"
              onClick={onToggleDeepVoice}
              title="Activar voz gruesa"
              className={`px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                deepVoice ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              Voz gruesa
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              title="Expandir pantalla"
              aria-label="Expandir pantalla"
              className="p-1.5 text-slate-200 hover:bg-slate-800 rounded transition-colors cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Single Unified Control Dock (PTZ + Digital Zoom/Pan) */}
        <div className="px-4 py-3 bg-slate-950/75 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-400">PTZ</span>
            <select
              aria-label="Velocidad PTZ"
              value={ptzSpeed}
              onChange={(e) => onPtzSpeedChange(Number(e.target.value))}
              className="px-2 py-1 text-xs bg-slate-900 border border-slate-800 text-slate-200 rounded cursor-pointer"
            >
              <option value={0.12}>Fino</option>
              <option value={0.22}>Normal</option>
              <option value={0.45}>Rápido</option>
            </select>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onPointerDown={() => onPtzCommand('left', 240)}
                onPointerUp={() => onPtzCommand('stop')}
                onPointerCancel={() => onPtzCommand('stop')}
                onPointerLeave={() => onPtzCommand('stop')}
                aria-label="Mover cámara izquierda"
                className="p-1.5 text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onPointerDown={() => onPtzCommand('up', 240)}
                onPointerUp={() => onPtzCommand('stop')}
                onPointerCancel={() => onPtzCommand('stop')}
                onPointerLeave={() => onPtzCommand('stop')}
                aria-label="Mover cámara arriba"
                className="p-1.5 text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onPointerDown={() => onPtzCommand('down', 240)}
                onPointerUp={() => onPtzCommand('stop')}
                onPointerCancel={() => onPtzCommand('stop')}
                onPointerLeave={() => onPtzCommand('stop')}
                aria-label="Mover cámara abajo"
                className="p-1.5 text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onPointerDown={() => onPtzCommand('right', 240)}
                onPointerUp={() => onPtzCommand('stop')}
                onPointerCancel={() => onPtzCommand('stop')}
                onPointerLeave={() => onPtzCommand('stop')}
                aria-label="Mover cámara derecha"
                className="p-1.5 text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
              >
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-400">Zoom</span>
            <button
              type="button"
              onClick={() => onZoomPanChange(zoom - 0.5, panX, panY)}
              aria-label="Alejar zoom"
              className="p-1.5 text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-200 w-10 text-center">
              {zoom.toFixed(1)}x
            </span>
            <button
              type="button"
              onClick={() => onZoomPanChange(zoom + 0.5, panX, panY)}
              aria-label="Acercar zoom"
              className="p-1.5 text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            {zoom > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => onZoomPanChange(1, 0, 0)}
                  aria-label="Restablecer zoom"
                  className="p-1.5 text-slate-400 hover:text-slate-100 rounded cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <div className="flex items-center gap-1 pl-2 border-l border-slate-800">
                  <button
                    type="button"
                    onClick={() => onZoomPanChange(zoom, panX + 6, panY)}
                    aria-label="Desplazar encuadre izquierda"
                    className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                  >
                    <ArrowLeft className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onZoomPanChange(zoom, panX, panY + 6)}
                    aria-label="Desplazar encuadre arriba"
                    className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onZoomPanChange(zoom, panX, panY - 6)}
                    aria-label="Desplazar encuadre abajo"
                    className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onZoomPanChange(zoom, panX - 6, panY)}
                    aria-label="Desplazar encuadre derecha"
                    className="p-1.5 text-slate-300 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded cursor-pointer"
                  >
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Tabbed Panel: Motion Events, Clips, Processes & Connections */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onBottomTabChange('events')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                bottomTab === 'events'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Eventos ({motionEvents.length})
            </button>
            <button
              type="button"
              onClick={() => onBottomTabChange('clips')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                bottomTab === 'clips'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Clips ({clips.length})
            </button>
            <button
              type="button"
              onClick={() => onBottomTabChange('processes')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                bottomTab === 'processes'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Procesos y Conexiones ({activeProcessCount} activos)
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenMotionSettings}
            className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
          >
            <Bell className="w-3.5 h-3.5" />
            <span className="tabular-nums">Sensibilidad: {motionConfig.sensitivity}%</span>
          </button>
        </div>

        <div className="p-4">
          {bottomTab === 'events' && (
            motionEvents.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                Monitoreando cambios en la imagen. Los eventos de movimiento aparecerán aquí.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/70 max-h-52 overflow-y-auto">
                {motionEvents.map((evt) => (
                  <div key={evt.id} className="py-2 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Radio className="w-3.5 h-3.5 text-amber-400" />
                      <span className="font-medium text-slate-200">{evt.cameraName}</span>
                      <span className="text-slate-500">·</span>
                      <span className="text-slate-400 tabular-nums">Intensidad {evt.score}%</span>
                    </div>
                    <span className="font-mono tabular-nums text-slate-500">
                      {new Date(evt.timestamp).toLocaleTimeString('es-ES', { hour12: false })}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}

          {bottomTab === 'clips' && (
            clips.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                Aún no hay clips grabados. Pulsa "Grabar Clip" para guardar un video en el dispositivo.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/70 max-h-52 overflow-y-auto">
                {clips.map((clip) => (
                  <div key={clip.id} className="py-2 flex items-center justify-between gap-3 text-xs">
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
            )
          )}

          {bottomTab === 'processes' && (
            <ProcessMonitorPanel
              operations={operations}
              onRefresh={onRefreshProcesses}
              onKill={onKillProcess}
            />
          )}
        </div>
      </div>
    </div>
  );
};
