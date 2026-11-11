import React from 'react';
import { X, Bell, Volume2, Video } from 'lucide-react';
import { MotionAlertConfig } from '../utils/cameraLogic';

interface MotionSettingsModalProps {
  isOpen: boolean;
  config: MotionAlertConfig;
  onChange: (next: MotionAlertConfig) => void;
  onClose: () => void;
}

export const MotionSettingsModal: React.FC<MotionSettingsModalProps> = ({
  isOpen,
  config,
  onChange,
  onClose,
}) => {
  if (!isOpen) return null;

  const handleBrowserNotifToggle = async () => {
    if (!config.browserNotification && 'Notification' in window) {
      if (Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    }
    onChange({ ...config, browserNotification: !config.browserNotification });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="motion-modal-title"
    >
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-sky-400" />
            <h3 id="motion-modal-title" className="text-base font-semibold text-slate-100">
              Alertas de Movimiento
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar configuración de alertas"
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm font-medium text-slate-200">Detección activa</span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
              className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
            />
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-300">Sensibilidad</span>
              <span className="font-mono tabular-nums text-sky-400">{config.sensitivity}%</span>
            </div>
            <input
              type="range"
              min={10}
              max={95}
              value={config.sensitivity}
              onChange={(e) => onChange({ ...config, sensitivity: Number(e.target.value) })}
              className="w-full accent-sky-500 cursor-pointer"
            />
            <p className="text-xs text-slate-500">
              Valores altos detectan cambios sutiles en la imagen.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-300">Intervalo entre alertas</span>
              <span className="font-mono tabular-nums text-slate-200">{config.cooldownSeconds}s</span>
            </div>
            <input
              type="range"
              min={2}
              max={60}
              value={config.cooldownSeconds}
              onChange={(e) => onChange({ ...config, cooldownSeconds: Number(e.target.value) })}
              className="w-full accent-sky-500 cursor-pointer"
            />
          </div>

          <div className="pt-2 border-t border-slate-800 space-y-3">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="flex items-center gap-2 text-sm text-slate-300">
                <Volume2 className="w-4 h-4 text-slate-400" />
                <span>Alerta sonora</span>
              </span>
              <input
                type="checkbox"
                checked={config.soundAlert}
                onChange={(e) => onChange({ ...config, soundAlert: e.target.checked })}
                className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="flex items-center gap-2 text-sm text-slate-300">
                <Bell className="w-4 h-4 text-slate-400" />
                <span>Notificación del navegador</span>
              </span>
              <input
                type="checkbox"
                checked={config.browserNotification}
                onChange={handleBrowserNotifToggle}
                className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="flex items-center gap-2 text-sm text-slate-300">
                <Video className="w-4 h-4 text-slate-400" />
                <span>Auto-grabar clip al detectar</span>
              </span>
              <input
                type="checkbox"
                checked={config.autoRecordOnMotion}
                onChange={(e) => onChange({ ...config, autoRecordOnMotion: e.target.checked })}
                className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
              />
            </label>
          </div>
        </div>

        <div className="px-5 py-3 bg-slate-950/60 border-t border-slate-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-lg transition-colors cursor-pointer"
          >
            Guardar cambios
          </button>
        </div>
      </div>
    </div>
  );
};
