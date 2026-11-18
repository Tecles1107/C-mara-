import React from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  CapabilityCheckItem,
  DiagnosticFeature,
  DiagnosticSample,
  formatLatency,
  formatProcessTime,
} from '../utils/processLogic';

interface DiagnosticsPanelProps {
  cameraIp: string;
  openPorts?: number[];
  checks: CapabilityCheckItem[];
  samples: DiagnosticSample[];
  isRunningCheck: boolean;
  onRunDiagnostic: () => void;
  onRefreshSamples: () => void;
  onClearSamples: () => void;
}

const FEATURE_LABELS: Record<DiagnosticFeature, string> = {
  video: 'Video',
  audio: 'Audio (Escuchar)',
  talk: 'Voz (Hablar)',
  ptz: 'PTZ',
  light: 'Luz / Linterna',
  ir: 'Infrarrojo / IR',
  verify: 'Red / ONVIF',
  scan: 'Escaneo',
};

export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  cameraIp,
  openPorts = [],
  checks,
  samples,
  isRunningCheck,
  onRunDiagnostic,
  onRefreshSamples,
  onClearSamples,
}) => {
  const renderStatusIcon = (status: 'ok' | 'warn' | 'error') => {
    if (status === 'ok') return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
    if (status === 'warn') return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
    return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          <span>
            Diagnóstico de capacidades y muestreo de errores en tiempo real para{' '}
            <span className="font-mono text-slate-200">{cameraIp}</span>
          </span>
          {openPorts.length > 0 && (
            <span className="ml-2 font-mono text-[11px] text-sky-300">
              Puertos abiertos: {openPorts.join(', ')}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRunDiagnostic}
            disabled={isRunningCheck}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-md transition-colors cursor-pointer"
          >
            <Activity className={`w-3.5 h-3.5 ${isRunningCheck ? 'animate-pulse' : ''}`} />
            <span>{isRunningCheck ? 'Probando hardware...' : 'Ejecutar Diagnóstico Completo'}</span>
          </button>
          <button
            type="button"
            onClick={onRefreshSamples}
            aria-label="Actualizar muestras de diagnóstico"
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-200 bg-slate-950 border border-slate-800 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Actualizar</span>
          </button>
          {samples.length > 0 && (
            <button
              type="button"
              onClick={onClearSamples}
              aria-label="Limpiar registros de diagnóstico"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 bg-slate-950 border border-slate-800 hover:text-slate-200 rounded-md transition-colors cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>Limpiar</span>
            </button>
          )}
        </div>
      </div>

      {checks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {checks.map((chk) => (
            <div
              key={chk.feature}
              className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {renderStatusIcon(chk.status)}
                  <span className="text-xs font-semibold text-slate-100 truncate">{chk.label}</span>
                </div>
                {chk.latencyMs !== undefined && (
                  <span className="text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
                    {formatLatency(chk.latencyMs)}
                  </span>
                )}
              </div>
              {chk.method && (
                <div className="text-[11px] font-mono text-sky-300 truncate">{chk.method}</div>
              )}
              <p className="text-xs text-slate-300 leading-snug">{chk.reason}</p>
              {chk.suggestion && (
                <p className="text-[11px] text-amber-300/90 leading-snug">{chk.suggestion}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300">
          Muestreo de eventos y fallos en tiempo real ({samples.length})
        </h3>
        {samples.length === 0 ? (
          <p className="text-xs text-slate-500 py-4 text-center border border-slate-800/80 rounded-lg bg-slate-950/40">
            Sin fallos ni eventos muestreados todavía. Al probar Escuchar, Hablar, Luz, IR o PTZ, o al ejecutar el Diagnóstico Completo, aquí aparecerá el motivo exacto de cada respuesta.
          </p>
        ) : (
          <div className="divide-y divide-slate-800/70 max-h-60 overflow-y-auto border border-slate-800 rounded-lg bg-slate-950/60">
            {samples.map((s) => (
              <div key={s.id} className="p-2.5 flex items-start justify-between gap-3 text-xs">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="mt-0.5">{renderStatusIcon(s.status)}</div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-100">
                        {FEATURE_LABELS[s.feature] || s.feature}
                      </span>
                      {s.method && (
                        <span className="text-[11px] font-mono text-sky-300">{s.method}</span>
                      )}
                      {s.code !== undefined && (
                        <span className="text-[11px] font-mono text-slate-400">
                          Código: {String(s.code)}
                        </span>
                      )}
                    </div>
                    <p className="text-slate-300 break-words">{s.reason}</p>
                    {s.suggestion && (
                      <p className="text-[11px] text-amber-300/90 break-words">{s.suggestion}</p>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0 font-mono tabular-nums text-[11px] text-slate-500">
                  <div>{formatProcessTime(s.timestamp)}</div>
                  {s.latencyMs !== undefined && <div>{formatLatency(s.latencyMs)}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
