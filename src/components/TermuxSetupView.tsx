import React, { useEffect, useState } from 'react';
import { Check, Copy, FolderDown, Globe, Radio, Terminal } from 'lucide-react';
import { buildTermuxScript } from '../utils/cameraLogic';

interface NetworkInfoResponse {
  port: number;
  interfaces: Array<{ address: string; subnet: string }>;
  tools: {
    ffmpeg: boolean;
    nmap: boolean;
    cloudflared: boolean;
    tailscale: boolean;
  };
}

export const TermuxSetupView: React.FC = () => {
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [port, setPort] = useState(3000);
  const [remoteMethod, setRemoteMethod] = useState<'direct' | 'cloudflared' | 'tailscale'>('direct');
  const [copied, setCopied] = useState(false);
  const [netInfo, setNetInfo] = useState<NetworkInfoResponse | null>(null);

  useEffect(() => {
    fetch('/api/network-info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setNetInfo(data);
      })
      .catch(() => {});
  }, []);

  const script = buildTermuxScript(subnet, port, remoteMethod);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-slate-100">
          Instalación y Ejecución en Termux (Android)
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          Despliega VigíaLAN en tu dispositivo Android sin root con persistencia de dispositivos guardados y acceso remoto seguro desde datos móviles o cualquier red Wi-Fi.
        </p>
      </div>

      {/* Host Tool Readiness */}
      {netInfo && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="space-y-0.5">
            <span className="text-slate-400">Interfaces locales detectadas: </span>
            <span className="font-mono text-slate-200">
              {netInfo.interfaces.length > 0
                ? netInfo.interfaces.map((i) => `${i.address}`).join(', ')
                : 'Solo localhost'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono">
            <span className={netInfo.tools.ffmpeg ? 'text-emerald-400' : 'text-amber-400'}>
              ffmpeg: {netInfo.tools.ffmpeg ? 'OK' : 'Falta'}
            </span>
            <span className={netInfo.tools.nmap ? 'text-emerald-400' : 'text-slate-400'}>
              nmap: {netInfo.tools.nmap ? 'OK' : 'Opcional'}
            </span>
            <span className={netInfo.tools.cloudflared ? 'text-emerald-400' : 'text-slate-400'}>
              cloudflared: {netInfo.tools.cloudflared ? 'OK' : 'Opcional'}
            </span>
            <span className={netInfo.tools.tailscale ? 'text-emerald-400' : 'text-slate-400'}>
              tailscale: {netInfo.tools.tailscale ? 'OK' : 'Opcional'}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Radio className="w-4 h-4 text-sky-400" />
            <span>Instalación automática</span>
          </div>
          <p className="text-xs text-slate-400">
            Ejecuta <code className="font-mono text-slate-300">bash install-termux.sh</code> para instalar paquetes, compilar en modo ligero y generar <code className="font-mono text-slate-300">./start-vigialan.sh</code>.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <FolderDown className="w-4 h-4 text-emerald-400" />
            <span>Clips y guardados</span>
          </div>
          <p className="text-xs text-slate-400">
            Los clips se guardan en <code className="font-mono text-slate-300">/sdcard/DCIM/VigiaLAN_Clips</code> y tus cámaras vistas se respaldan en <code className="font-mono text-slate-300">./data/saved-cameras.json</code>.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Globe className="w-4 h-4 text-indigo-400" />
            <span>Acceso con datos móviles</span>
          </div>
          <p className="text-xs text-slate-400">
            Usa <code className="font-mono text-slate-300">cloudflared</code> o <code className="font-mono text-slate-300">Tailscale</code> en el dispositivo en casa para ver tus cámaras guardadas desde cualquier red.
          </p>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">Subred local (CIDR)</span>
            <input
              type="text"
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-sm font-mono text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">Puerto del servidor web</span>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 3000)}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-sm font-mono text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">Método de ejecución / remoto</span>
            <select
              value={remoteMethod}
              onChange={(e) => setRemoteMethod(e.target.value as 'direct' | 'cloudflared' | 'tailscale')}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-sm text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
            >
              <option value="direct">Solo Red Local (LAN)</option>
              <option value="cloudflared">Remoto con Cloudflare Tunnel</option>
              <option value="tailscale">Remoto con Tailscale VPN</option>
            </select>
          </label>
        </div>

        <div className="relative">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-950 border border-b-0 border-slate-800 rounded-t-md">
            <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
              <Terminal className="w-3.5 h-3.5" />
              <span>termux-vigialan.sh</span>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copiado' : 'Copiar script'}</span>
            </button>
          </div>
          <pre className="p-4 bg-slate-950 border border-slate-800 rounded-b-md text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">
            {script}
          </pre>
        </div>
      </div>
    </div>
  );
};
