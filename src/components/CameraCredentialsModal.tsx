import React, { useEffect, useState } from 'react';
import { Globe, KeyRound, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { CameraChannel, CameraProtocol, ConnectionMode } from '../utils/cameraLogic';

interface CameraCredentialsModalProps {
  camera: CameraChannel | null;
  onClose: () => void;
  onSaveOnly?: (updated: CameraChannel) => Promise<void>;
  onSaveAndVerify: (updated: CameraChannel) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

export const CameraCredentialsModal: React.FC<CameraCredentialsModalProps> = ({
  camera,
  onClose,
  onSaveOnly,
  onSaveAndVerify,
  onDelete,
}) => {
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('554');
  const [onvifPort, setOnvifPort] = useState('');
  const [protocol, setProtocol] = useState<CameraProtocol>('RTSP');
  const [streamPath, setStreamPath] = useState('/live/ch00_0');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('');
  const [remoteOnvifPort, setRemoteOnvifPort] = useState('');
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('auto');
  const [notes, setNotes] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!camera) return;
    setName(camera.name);
    setIp(camera.ip);
    setPort(String(camera.port));
    setOnvifPort(camera.onvifPort ? String(camera.onvifPort) : '');
    setProtocol(camera.protocol);
    setStreamPath(camera.streamPath);
    setUsername(camera.username || '');
    setPassword(camera.password || '');
    setRemoteHost(camera.remoteHost || '');
    setRemotePort(camera.remotePort ? String(camera.remotePort) : '');
    setRemoteOnvifPort(camera.remoteOnvifPort ? String(camera.remoteOnvifPort) : '');
    setConnectionMode(camera.connectionMode || 'auto');
    setNotes(camera.notes || '');
    setConfirmDelete(false);
  }, [camera]);

  if (!camera) return null;

  const buildUpdatedCamera = (): CameraChannel => ({
    ...camera,
    name: name.trim() || camera.name,
    ip: ip.trim() || camera.ip,
    port: Number(port) || camera.port,
    onvifPort: onvifPort.trim() ? Number(onvifPort.trim()) : undefined,
    protocol,
    streamPath: streamPath.trim() || '/live/ch00_0',
    username: username.trim() || undefined,
    password: password || undefined,
    remoteHost: remoteHost.trim() || undefined,
    remotePort: remotePort.trim() ? Number(remotePort.trim()) : undefined,
    remoteOnvifPort: remoteOnvifPort.trim() ? Number(remoteOnvifPort.trim()) : undefined,
    connectionMode,
    notes: notes.trim() || undefined,
    isSaved: true,
    lastSeenAt: camera.lastSeenAt || Date.now(),
  });

  const handleSubmitVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifying(true);
    try {
      await onSaveAndVerify(buildUpdatedCamera());
      onClose();
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveOnly = async () => {
    if (!onSaveOnly) return;
    setVerifying(true);
    try {
      await onSaveOnly(buildUpdatedCamera());
      onClose();
    } finally {
      setVerifying(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    await onDelete(camera.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="creds-modal-title"
    >
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-sky-400" />
            <h3 id="creds-modal-title" className="text-base font-semibold text-slate-100">
              Editar Cámara, Red Remota y Credenciales
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar edición de cámara"
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmitVerify} className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Nombre de cámara</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Protocolo</span>
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as CameraProtocol)}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              >
                <option value="RTSP">RTSP</option>
                <option value="ONVIF">ONVIF</option>
                <option value="MJPEG">MJPEG</option>
                <option value="HTTP-FLV">HTTP-FLV</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">IP Local</span>
              <input
                type="text"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                required
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Puerto Video</span>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Puerto ONVIF</span>
              <input
                type="number"
                placeholder="80 / 8899"
                value={onvifPort}
                onChange={(e) => setOnvifPort(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Ruta del stream</span>
            <input
              type="text"
              value={streamPath}
              onChange={(e) => setStreamPath(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </label>

          {/* Remote Access Section */}
          <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-sky-300">
                <Globe className="w-3.5 h-3.5" />
                <span>Conexión Remota (Datos Móviles / Otro Wi-Fi)</span>
              </div>
              <select
                aria-label="Modo de conexión"
                value={connectionMode}
                onChange={(e) => setConnectionMode(e.target.value as ConnectionMode)}
                className="px-2 py-1 bg-slate-900 border border-slate-800 rounded text-[11px] text-slate-200 cursor-pointer"
              >
                <option value="auto">Automático (Local → Remoto)</option>
                <option value="local">Solo Local (LAN)</option>
                <option value="remote">Solo Remoto</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <label className="block space-y-1 sm:col-span-1">
                <span className="text-[11px] text-slate-400">Host Remoto / DDNS / VPN</span>
                <input
                  type="text"
                  placeholder="casa.duckdns.org"
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-slate-400">Puerto Video Remoto</span>
                <input
                  type="number"
                  placeholder={port || '554'}
                  value={remotePort}
                  onChange={(e) => setRemotePort(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-slate-400">Puerto ONVIF Remoto</span>
                <input
                  type="number"
                  placeholder={onvifPort || '80'}
                  value={remoteOnvifPort}
                  onChange={(e) => setRemoteOnvifPort(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500"
                />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Usuario</span>
              <input
                type="text"
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Contraseña</span>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Notas / Ubicación (opcional)</span>
            <input
              type="text"
              placeholder="Ej. Portón exterior · Router principal"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </label>

          <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
            {onDelete ? (
              confirmDelete ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="px-2.5 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors cursor-pointer"
                  >
                    Confirmar eliminar
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-950/50 rounded-md transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Eliminar</span>
                </button>
              )
            ) : (
              <span />
            )}

            <div className="flex flex-wrap items-center gap-2">
              {onSaveOnly && (
                <button
                  type="button"
                  onClick={handleSaveOnly}
                  disabled={verifying}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Guardar</span>
                </button>
              )}
              <button
                type="submit"
                disabled={verifying}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
              >
                {verifying ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                <span>{verifying ? 'Verificando...' : 'Verificar y Guardar'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
