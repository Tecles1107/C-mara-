import React, { useEffect, useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { CameraChannel, CameraProtocol } from '../utils/cameraLogic';

interface CameraCredentialsModalProps {
  camera: CameraChannel | null;
  onClose: () => void;
  onSaveAndVerify: (updated: CameraChannel) => Promise<void>;
}

export const CameraCredentialsModal: React.FC<CameraCredentialsModalProps> = ({
  camera,
  onClose,
  onSaveAndVerify,
}) => {
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('554');
  const [onvifPort, setOnvifPort] = useState('');
  const [protocol, setProtocol] = useState<CameraProtocol>('RTSP');
  const [streamPath, setStreamPath] = useState('/live/ch00_0');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);

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
  }, [camera]);

  if (!camera) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifying(true);
    try {
      await onSaveAndVerify({
        ...camera,
        name: name.trim() || camera.name,
        ip: ip.trim() || camera.ip,
        port: Number(port) || camera.port,
        onvifPort: onvifPort.trim() ? Number(onvifPort.trim()) : undefined,
        protocol,
        streamPath: streamPath.trim() || '/live/ch00_0',
        username: username.trim() || undefined,
        password: password || undefined,
      });
      onClose();
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="creds-modal-title"
    >
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-sky-400" />
            <h3 id="creds-modal-title" className="text-base font-semibold text-slate-100">
              Conexión y Credenciales
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar conexión y credenciales"
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Nombre</span>
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
            <label className="block space-y-1 col-span-1">
              <span className="text-xs text-slate-400">IP</span>
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
              <span className="text-xs text-slate-400">Puerto ONVIF/HTTP</span>
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
            <span className="text-xs text-slate-400">Ruta del stream (se autodetecta al verificar)</span>
            <input
              type="text"
              value={streamPath}
              onChange={(e) => setStreamPath(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </label>

          <div className="pt-2 border-t border-slate-800 grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Usuario (opcional)</span>
              <input
                type="text"
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Contraseña (opcional)</span>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </label>
          </div>

          <div className="pt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={verifying}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              {verifying ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5" />
              )}
              <span>{verifying ? 'Verificando...' : 'Verificar y Guardar'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
