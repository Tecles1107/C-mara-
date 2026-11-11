import React, { useState } from 'react';
import { Check, Copy, Terminal, FolderDown, Radio } from 'lucide-react';
import { buildTermuxScript } from '../utils/cameraLogic';

export const TermuxSetupView: React.FC = () => {
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [port, setPort] = useState(3000);
  const [copied, setCopied] = useState(false);

  const script = buildTermuxScript(subnet, port);

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
        <h2 className="text-2xl font-semibold text-slate-100">
          Ejecución en Termux (Android)
        </h2>
        <p className="text-sm text-slate-400 leading-relaxed">
          Despliega el escáner de red local y puente RTSP/ONVIF/MJPEG directamente en tu dispositivo Android sin root, guardando clips en el almacenamiento interno.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Radio className="w-4 h-4 text-sky-400" />
            <span>Descubrimiento sin autenticación</span>
          </div>
          <p className="text-xs text-slate-400">
            Usa <code className="font-mono text-slate-300">nmap</code> para detectar puertos abiertos 554 (RTSP), 80/81/8080 (MJPEG/HTTP) en cualquier marca o modelo.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <FolderDown className="w-4 h-4 text-emerald-400" />
            <span>Almacenamiento interno</span>
          </div>
          <p className="text-xs text-slate-400">
            Los clips grabados se descargan en <code className="font-mono text-slate-300">/sdcard/DCIM/VigiaLAN_Clips</code> o en la carpeta Descargas del navegador.
          </p>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
