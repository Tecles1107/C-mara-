import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

export interface AppErrorItem {
  id: string;
  message: string;
  timestamp: number;
}

interface ErrorBannerProps {
  errors: AppErrorItem[];
  onDismiss: (id: string) => void;
  onClearAll: () => void;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  errors,
  onDismiss,
  onClearAll,
}) => {
  if (errors.length === 0) return null;

  const latest = errors[0];

  return (
    <div
      role="alert"
      className="bg-red-950/90 border-b border-red-800/80 px-4 lg:px-6 py-2.5 flex items-center justify-between gap-4 text-xs text-red-100"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
        <span className="font-medium truncate">{latest.message}</span>
        {errors.length > 1 && (
          <span className="text-red-300 font-mono tabular-nums shrink-0">
            (+{errors.length - 1} más)
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {errors.length > 1 && (
          <button
            type="button"
            onClick={onClearAll}
            className="px-2 py-1 text-xs text-red-200 hover:text-white hover:bg-red-900/60 rounded transition-colors cursor-pointer"
          >
            Limpiar todo
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(latest.id)}
          aria-label="Cerrar reporte de error"
          className="p-1 text-red-300 hover:text-white hover:bg-red-900/60 rounded transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
