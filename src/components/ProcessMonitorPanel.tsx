import React from 'react';
import { RefreshCw, Square } from 'lucide-react';
import {
  ProcessOperationRecord,
  formatLatency,
  formatProcessTime,
  getProcessStatusLabel,
} from '../utils/processLogic';

interface ProcessMonitorPanelProps {
  operations: ProcessOperationRecord[];
  onRefresh: () => void;
  onKill: (id: string) => void;
}

const KIND_LABELS: Record<ProcessOperationRecord['kind'], string> = {
  scan: 'Escaneo Red',
  nmap: 'Nmap',
  onvif: 'ONVIF',
  ssdp: 'SSDP',
  mdns: 'mDNS',
  arp: 'ARP Vecinos',
  'vendor-udp': 'UDP Fabricante',
  'route-vpn': 'Rutas / VPN',
  wifi: 'Wi-Fi / AP',
  external: 'Red Externa',
  stream: 'Video Stream',
  audio: 'Audio Stream',
  talk: 'Voz (Talk)',
  verify: 'Verificación',
};

export const ProcessMonitorPanel: React.FC<ProcessMonitorPanelProps> = ({
  operations,
  onRefresh,
  onKill,
}) => {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          Registro en tiempo real de subprocesos, tiempos de entrada/salida, latencias y códigos de salida.
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-200 bg-slate-950 border border-slate-800 hover:bg-slate-800 rounded transition-colors shrink-0 cursor-pointer"
        >
          <RefreshCw className="w-3 h-3" />
          <span>Actualizar</span>
        </button>
      </div>

      {operations.length === 0 ? (
        <p className="text-xs text-slate-500 py-5 text-center">
          Sin procesos recientes. Inicia un escaneo o abre un canal de cámara para ver los tiempos de ejecución.
        </p>
      ) : (
        <div className="overflow-x-auto max-h-60 overflow-y-auto border border-slate-800 rounded-lg bg-slate-950/60">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 sticky top-0">
              <tr>
                <th className="py-2 px-2.5 font-medium">Proceso</th>
                <th className="py-2 px-2.5 font-medium">Destino / PID</th>
                <th className="py-2 px-2.5 font-medium">Entrada</th>
                <th className="py-2 px-2.5 font-medium">Salida</th>
                <th className="py-2 px-2.5 font-medium">Duración</th>
                <th className="py-2 px-2.5 font-medium">Estado</th>
                <th className="py-2 px-2.5 font-medium text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {operations.map((op) => {
                const statusColor =
                  op.status === 'running'
                    ? 'text-sky-400'
                    : op.status === 'completed'
                      ? 'text-emerald-400'
                      : op.status === 'cancelled'
                        ? 'text-amber-400'
                        : 'text-red-400';

                return (
                  <tr key={op.id} className="hover:bg-slate-900/50">
                    <td className="py-2 px-2.5 whitespace-nowrap">
                      <div className="font-medium text-slate-200">
                        {KIND_LABELS[op.kind] || op.kind}
                      </div>
                      {op.detail && (
                        <div className="text-[11px] text-slate-500 truncate max-w-[170px]">
                          {op.detail}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2.5 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                      <div className="truncate max-w-[170px]" title={op.target}>
                        {op.target}
                      </div>
                      {op.pid ? (
                        <div className="text-[11px] text-slate-500">PID {op.pid}</div>
                      ) : null}
                    </td>
                    <td className="py-2 px-2.5 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {formatProcessTime(op.startedAt)}
                    </td>
                    <td className="py-2 px-2.5 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {op.endedAt ? formatProcessTime(op.endedAt) : 'En curso'}
                    </td>
                    <td className="py-2 px-2.5 font-mono tabular-nums text-slate-200 whitespace-nowrap">
                      {formatLatency(op.durationMs)}
                    </td>
                    <td className={`py-2 px-2.5 font-medium whitespace-nowrap ${statusColor}`}>
                      {getProcessStatusLabel(op.status)}
                      {op.exitCode !== undefined && op.exitCode !== null ? ` (${op.exitCode})` : ''}
                    </td>
                    <td className="py-2 px-2.5 text-right whitespace-nowrap">
                      {op.status === 'running' ? (
                        <button
                          type="button"
                          onClick={() => onKill(op.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-300 bg-red-950/60 border border-red-900/60 hover:bg-red-900/60 rounded transition-colors cursor-pointer"
                        >
                          <Square className="w-2.5 h-2.5" />
                          <span>Terminar</span>
                        </button>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
