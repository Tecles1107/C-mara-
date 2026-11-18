import React, { useState } from 'react';
import { Camera, Globe, Plus, Search, SlidersHorizontal, Wifi, X } from 'lucide-react';
import { CameraChannel, CameraProtocol, buildStreamUrl } from '../utils/cameraLogic';
import { ScanProfile, formatLatency } from '../utils/processLogic';

export interface ScanProgressState {
  stage: string;
  label: string;
  completed: number;
  total: number;
  elapsedMs: number;
  foundCount: number;
}

export interface NearbyWifiInfo {
  ssid: string;
  bssid?: string;
  signal?: number;
  frequency?: string;
  hidden: boolean;
  cameraLikely: boolean;
  source: string;
}

interface CameraSidebarProps {
  cameras: CameraChannel[];
  filteredCameras: CameraChannel[];
  onlineCount: number;
  selectedCameraId?: string;
  viewMode: string;
  isScanning: boolean;
  scanProgress: ScanProgressState | null;
  scanProfile: ScanProfile;
  customSubnet: string;
  customTimeoutMs: string;
  customConcurrency: string;
  outOfNetworkScan: boolean;
  externalTargets: string;
  wifiNetworks: NearbyWifiInfo[];
  searchQuery: string;
  protocolFilter: CameraProtocol | 'ALL';
  onlyOnline: boolean;
  onlyAudio: boolean;
  onlyPtz: boolean;
  showAddForm: boolean;
  onToggleAddForm: () => void;
  onScanProfileChange: (profile: ScanProfile) => void;
  onCustomSubnetChange: (val: string) => void;
  onCustomTimeoutChange: (val: string) => void;
  onCustomConcurrencyChange: (val: string) => void;
  onOutOfNetworkScanChange: (enabled: boolean) => void;
  onExternalTargetsChange: (val: string) => void;
  onStartOutOfNetworkScan: () => void;
  onCancelScan: () => void;
  onSearchQueryChange: (val: string) => void;
  onProtocolFilterChange: (proto: CameraProtocol | 'ALL') => void;
  onOnlyOnlineChange: (checked: boolean) => void;
  onOnlyAudioChange: (checked: boolean) => void;
  onOnlyPtzChange: (checked: boolean) => void;
  onSelectCamera: (id: string) => void;
  onAddManualCamera: (cam: {
    name: string;
    ip: string;
    port: number;
    remoteHost?: string;
    streamPath: string;
    protocol: CameraProtocol;
    username?: string;
    password?: string;
  }) => Promise<void>;
}

export const CameraSidebar: React.FC<CameraSidebarProps> = ({
  cameras,
  filteredCameras,
  onlineCount,
  selectedCameraId,
  viewMode,
  isScanning,
  scanProgress,
  scanProfile,
  customSubnet,
  customTimeoutMs,
  customConcurrency,
  outOfNetworkScan,
  externalTargets,
  wifiNetworks,
  searchQuery,
  protocolFilter,
  onlyOnline,
  onlyAudio,
  onlyPtz,
  showAddForm,
  onToggleAddForm,
  onScanProfileChange,
  onCustomSubnetChange,
  onCustomTimeoutChange,
  onCustomConcurrencyChange,
  onOutOfNetworkScanChange,
  onExternalTargetsChange,
  onStartOutOfNetworkScan,
  onCancelScan,
  onSearchQueryChange,
  onProtocolFilterChange,
  onOnlyOnlineChange,
  onOnlyAudioChange,
  onOnlyPtzChange,
  onSelectCamera,
  onAddManualCamera,
}) => {
  const [showScanOptions, setShowScanOptions] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIp, setNewIp] = useState('192.168.1.');
  const [newPort, setNewPort] = useState('554');
  const [newRemoteHost, setNewRemoteHost] = useState('');
  const [newPath, setNewPath] = useState('/live/ch00_0');
  const [newProtocol, setNewProtocol] = useState<CameraProtocol>('RTSP');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const handleSubmitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newIp.trim()) return;
    await onAddManualCamera({
      name: newName.trim(),
      ip: newIp.trim(),
      port: Number(newPort) || 554,
      remoteHost: newRemoteHost.trim() || undefined,
      streamPath: newPath.trim() || '/live/ch00_0',
      protocol: newProtocol,
      username: newUsername.trim() || undefined,
      password: newPassword || undefined,
    });
    setNewName('');
    setNewIp('192.168.1.');
    setNewRemoteHost('');
    setNewUsername('');
    setNewPassword('');
  };

  const progressPct =
    scanProgress && scanProgress.total > 0
      ? Math.min(100, Math.round((scanProgress.completed / scanProgress.total) * 100))
      : 0;

  return (
    <aside className="w-full lg:w-80 border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-900/50 flex flex-col shrink-0">
      <div className="p-4 border-b border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-200 tabular-nums">
            Cámaras ({onlineCount}/{cameras.length})
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowScanOptions((v) => !v)}
              aria-label="Opciones de escaneo"
              title="Opciones de escaneo y subredes"
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                showScanOptions
                  ? 'bg-slate-800 text-sky-400'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
              }`}
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onToggleAddForm}
              aria-label="Agregar cámara manual"
              title="Agregar cámara por IP"
              className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                showAddForm
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-300 bg-slate-950 border border-slate-800 hover:bg-slate-800'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>IP</span>
            </button>
          </div>
        </div>

        {/* Live Scan Progress Bar + Cancel */}
        {isScanning && scanProgress && (
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-sky-400 font-medium truncate">{scanProgress.label}</span>
              <button
                type="button"
                onClick={onCancelScan}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-red-300 hover:text-white bg-red-950/60 border border-red-900/60 rounded cursor-pointer shrink-0"
              >
                <X className="w-3 h-3" />
                <span>Cancelar</span>
              </button>
            </div>
            <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-500 transition-all duration-150"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
              <span>
                {scanProgress.completed}/{scanProgress.total} ({progressPct}%)
              </span>
              <span>
                {scanProgress.foundCount} enc. · {formatLatency(scanProgress.elapsedMs)}
              </span>
            </div>
          </div>
        )}

        {/* Collapsible Scan Profile & Concurrency Parameters */}
        {showScanOptions && (
          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="scan-profile-select" className="text-xs text-slate-400">
                Perfil de búsqueda
              </label>
              <select
                id="scan-profile-select"
                value={scanProfile}
                onChange={(e) => onScanProfileChange(e.target.value as ScanProfile)}
                className="px-2 py-1 bg-slate-900 border border-slate-800 rounded text-xs text-slate-200 cursor-pointer"
              >
                <option value="fast">Rápido (5 puertos)</option>
                <option value="standard">Estándar (8 puertos)</option>
                <option value="deep">Profundo (15 puertos)</option>
              </select>
            </div>

            <input
              type="text"
              placeholder="Subredes (ej. 192.168.1, 192.168.0)"
              value={customSubnet}
              onChange={(e) => onCustomSubnetChange(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Timeout (ms)</label>
                <input
                  type="number"
                  min={80}
                  max={3000}
                  placeholder="Auto"
                  value={customTimeoutMs}
                  onChange={(e) => onCustomTimeoutChange(e.target.value)}
                  className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Hilos (8–128)</label>
                <input
                  type="number"
                  min={8}
                  max={128}
                  placeholder="Auto"
                  value={customConcurrency}
                  onChange={(e) => onCustomConcurrencyChange(e.target.value)}
                  className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div className="pt-1.5 border-t border-slate-800/80 space-y-2">
              <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={outOfNetworkScan}
                  onChange={(e) => onOutOfNetworkScanChange(e.target.checked)}
                  className="w-3.5 h-3.5 mt-0.5 accent-sky-500 rounded cursor-pointer shrink-0"
                />
                <span>
                  Escanear fuera de la red (VPN Tailscale, rutas, AP de fábrica y Wi-Fi oculto)
                </span>
              </label>

              <div>
                <label htmlFor="external-targets-input" className="block text-[11px] text-slate-400 mb-1">
                  IPs externas, rangos o DDNS
                </label>
                <input
                  id="external-targets-input"
                  type="text"
                  placeholder="10.0.0.1-30, cam.duckdns.org:8554"
                  value={externalTargets}
                  onChange={(e) => onExternalTargetsChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                />
              </div>

              <button
                type="button"
                disabled={isScanning}
                onClick={onStartOutOfNetworkScan}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-sky-200 bg-sky-950/60 border border-sky-800/70 hover:bg-sky-900/60 disabled:opacity-40 rounded transition-colors cursor-pointer"
              >
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span>Buscar fuera de la red ahora</span>
              </button>
            </div>
          </div>
        )}

        {wifiNetworks.length > 0 && (
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-300">
              <span className="flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-sky-400" />
                <span>Wi-Fi / AP cercanos ({wifiNetworks.length})</span>
              </span>
              <span className="text-slate-500 font-mono">
                {wifiNetworks.filter((n) => n.cameraLikely).length} cámaras/ocultas
              </span>
            </div>
            <div className="max-h-28 overflow-y-auto divide-y divide-slate-800/60">
              {wifiNetworks.slice(0, 8).map((net, idx) => (
                <div
                  key={`${net.bssid || net.ssid}-${idx}`}
                  className="py-1 flex items-center justify-between gap-2 text-[11px]"
                >
                  <span
                    className={`truncate font-mono ${
                      net.hidden ? 'text-amber-300' : net.cameraLikely ? 'text-emerald-300' : 'text-slate-400'
                    }`}
                    title={net.bssid || net.ssid}
                  >
                    {net.ssid}
                    {net.hidden ? ' (Oculta)' : ''}
                  </span>
                  <span className="text-slate-500 font-mono shrink-0">
                    {net.signal !== undefined ? `${net.signal} dBm` : net.frequency || net.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Manual Camera Form */}
        {showAddForm && (
          <form onSubmit={handleSubmitManual} className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2.5">
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
                placeholder="IP (ej. 192.168.1.50)"
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
            <input
              type="text"
              placeholder="Ruta stream (ej. /live/ch00_0)"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <input
              type="text"
              placeholder="Host remoto / DDNS / VPN (opc.)"
              value={newRemoteHost}
              onChange={(e) => setNewRemoteHost(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Usuario (opc.)"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
              <input
                type="password"
                placeholder="Clave (opc.)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
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
                Conectar y Verificar
              </button>
            </div>
          </form>
        )}

        {/* Search Input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Buscar nombre, IP, marca, puerto..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-md text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* Protocol & Capability Filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(['ALL', 'RTSP', 'ONVIF', 'MJPEG'] as const).map((proto) => (
            <button
              key={proto}
              type="button"
              onClick={() => onProtocolFilterChange(proto)}
              className={`px-2 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                protocolFilter === proto
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
              }`}
            >
              {proto === 'ALL' ? 'Todos' : proto}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyOnline}
              onChange={(e) => onOnlyOnlineChange(e.target.checked)}
              className="w-3.5 h-3.5 accent-sky-500 rounded cursor-pointer"
            />
            <span>En línea</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyAudio}
              onChange={(e) => onOnlyAudioChange(e.target.checked)}
              className="w-3.5 h-3.5 accent-sky-500 rounded cursor-pointer"
            />
            <span>Audio</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyPtz}
              onChange={(e) => onOnlyPtzChange(e.target.checked)}
              className="w-3.5 h-3.5 accent-sky-500 rounded cursor-pointer"
            />
            <span>PTZ</span>
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
        {filteredCameras.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            {cameras.length === 0
              ? 'No hay cámaras descubiertas todavía.'
              : 'Ninguna cámara coincide con los filtros.'}
          </div>
        ) : (
          filteredCameras.map((cam) => {
            const isSelected = cam.id === selectedCameraId && viewMode === 'single';
            return (
              <button
                key={cam.id}
                type="button"
                onClick={() => onSelectCamera(cam.id)}
                className={`w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                  isSelected ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center gap-3">
                  {cam.status === 'online' && !isSelected && (
                    <div className="w-16 h-10 rounded bg-slate-950 border border-slate-800 overflow-hidden shrink-0">
                      <img
                        src={`/api/stream?url=${encodeURIComponent(buildStreamUrl(cam))}`}
                        alt={`Vista previa ${cam.name}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                  {cam.status === 'online' && isSelected && (
                    <div className="w-10 h-10 rounded bg-sky-950/60 border border-sky-800/70 flex items-center justify-center shrink-0">
                      <Camera className="w-4 h-4 text-sky-400" />
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
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 font-mono tabular-nums truncate">
                      <span>{cam.ip}:{cam.port}</span>
                      <span aria-hidden="true">·</span>
                      <span>{cam.protocol}</span>
                      {cam.activeEndpoint === 'remote' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-sky-400">Remoto</span>
                        </>
                      )}
                      {cam.latencyMs !== undefined && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{formatLatency(cam.latencyMs)}</span>
                        </>
                      )}
                      {(cam.authStatus === 'required' || cam.authStatus === 'failed') && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-400">Clave</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
