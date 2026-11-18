import React, { useMemo, useState } from 'react';
import {
  BookmarkCheck,
  Camera,
  Globe,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
} from 'lucide-react';
import { CameraChannel } from '../utils/cameraLogic';
import { formatLatency } from '../utils/processLogic';

interface SavedDevicesViewProps {
  savedCameras: CameraChannel[];
  onConnectCamera: (cam: CameraChannel) => void;
  onTestCamera: (cam: CameraChannel) => Promise<void>;
  onEditCamera: (cam: CameraChannel) => void;
  onDeleteCamera: (id: string) => Promise<void>;
}

export const SavedDevicesView: React.FC<SavedDevicesViewProps> = ({
  savedCameras,
  onConnectCamera,
  onTestCamera,
  onEditCamera,
  onDeleteCamera,
}) => {
  const [query, setQuery] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return savedCameras;
    return savedCameras.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.ip.toLowerCase().includes(q) ||
        (c.remoteHost || '').toLowerCase().includes(q) ||
        (c.notes || '').toLowerCase().includes(q) ||
        c.protocol.toLowerCase().includes(q)
    );
  }, [savedCameras, query]);

  const handleTest = async (cam: CameraChannel) => {
    setTestingId(cam.id);
    try {
      await onTestCamera(cam);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="p-4 lg:p-6 space-y-5 max-w-5xl w-full mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">
            Dispositivos Guardados ({savedCameras.length})
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Todas las cámaras que abres o conectas se guardan automáticamente para reconexión en red local o remota.
          </p>
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Filtrar guardados..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Remote Access Architecture Guide */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div className="flex items-start gap-2.5">
          <Globe className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-medium text-slate-200">
              Conexión directa por Datos o Wi-Fi externo
            </div>
            <p className="text-slate-400 leading-relaxed">
              Pulsa <strong className="text-slate-300">Editar</strong> en cualquier cámara para añadir su Host Remoto (DDNS, IP pública o VPN) y activar el cambio automático Local → Remoto.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <Wifi className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-medium text-slate-200">
              Acceso al servidor VigíaLAN desde fuera de casa
            </div>
            <p className="text-slate-400 leading-relaxed">
              Si dejas VigíaLAN activo en Termux/PC con <code className="font-mono text-slate-300">Tailscale</code> o <code className="font-mono text-slate-300">Cloudflare Tunnel</code>, podrás abrir esta lista desde tus datos móviles y ver tus cámaras LAN sin exponer puertos.
            </p>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-10 bg-slate-900/40 border border-slate-800 rounded-xl text-center space-y-2">
          <BookmarkCheck className="w-7 h-7 text-slate-500 mx-auto" />
          <p className="text-sm font-medium text-slate-300">
            {savedCameras.length === 0
              ? 'Aún no hay dispositivos guardados'
              : 'Ningún dispositivo guardado coincide con tu búsqueda'}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Escanea tu red o agrega una cámara manualmente. En cuanto la abras o verifiques, quedará guardada aquí de forma permanente.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((cam) => {
            const isRemoteActive = cam.activeEndpoint === 'remote' || cam.connectionMode === 'remote';
            const lastSeenStr = cam.lastSeenAt
              ? new Date(cam.lastSeenAt).toLocaleString('es-ES', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })
              : 'Reciente';

            return (
              <div
                key={cam.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Camera className="w-4 h-4 text-sky-400 shrink-0" />
                        <h2 className="text-sm font-semibold text-slate-100 truncate">{cam.name}</h2>
                      </div>
                      {cam.notes && (
                        <p className="text-xs text-slate-400 mt-0.5 truncate">{cam.notes}</p>
                      )}
                    </div>
                    <span
                      className={`text-xs font-medium shrink-0 ${
                        cam.status === 'online' ? 'text-emerald-400' : 'text-slate-400'
                      }`}
                    >
                      {cam.status === 'online'
                        ? isRemoteActive
                          ? 'En línea (Remoto)'
                          : 'En línea'
                        : 'Sin verificar'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs bg-slate-950/70 border border-slate-800/80 rounded-lg p-2.5">
                    <div>
                      <span className="block text-[11px] text-slate-500">IP Local</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {cam.ip}:{cam.port}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-slate-500">Host Remoto</span>
                      <span className="font-mono tabular-nums text-slate-300 truncate block">
                        {cam.remoteHost
                          ? `${cam.remoteHost}:${cam.remotePort || cam.port}`
                          : 'No configurado'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-slate-500">Protocolo · Latencia</span>
                      <span className="font-mono tabular-nums text-slate-300">
                        {cam.protocol} · {formatLatency(cam.latencyMs)}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-slate-500">Última vista</span>
                      <span className="font-mono tabular-nums text-slate-300">{lastSeenStr}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onEditCamera(cam)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-800 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Editar</span>
                    </button>

                    {confirmDeleteId === cam.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={async () => {
                            await onDeleteCamera(cam.id);
                            setConfirmDeleteId(null);
                          }}
                          className="px-2 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors cursor-pointer"
                        >
                          Sí, eliminar
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(cam.id)}
                        aria-label={`Eliminar ${cam.name}`}
                        className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/40 rounded-md transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleTest(cam)}
                      disabled={testingId === cam.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-950 border border-slate-800 hover:bg-slate-800 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${testingId === cam.id ? 'animate-spin' : ''}`} />
                      <span>Probar</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onConnectCamera(cam)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md transition-colors cursor-pointer"
                    >
                      Conectar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
