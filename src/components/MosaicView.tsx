import React, { useState } from 'react';
import { GripVertical, Settings } from 'lucide-react';
import { CameraChannel } from '../utils/cameraLogic';
import { formatLatency } from '../utils/processLogic';
import { CameraFeedCanvas } from './CameraFeedCanvas';

interface MosaicViewProps {
  cameras: CameraChannel[];
  draggedCamId: string | null;
  onDragStart: (id: string) => void;
  onDropOnCamera: (targetId: string) => void;
  onOpenCamera: (id: string) => void;
  onOpenMotionSettings: () => void;
  onMotionScore: (cameraId: string, score: number) => void;
}

export const MosaicView: React.FC<MosaicViewProps> = ({
  cameras,
  draggedCamId,
  onDragStart,
  onDropOnCamera,
  onOpenCamera,
  onOpenMotionSettings,
  onMotionScore,
}) => {
  const [columns, setColumns] = useState<2 | 3>(2);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            Vista Mosaico ({cameras.length} canales activos)
          </h1>
          <p className="text-xs text-slate-400">
            Arrastra las tarjetas para ordenarlas o pulsa Ampliar para control individual.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setColumns(2)}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                columns === 2 ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              2×2
            </button>
            <button
              type="button"
              onClick={() => setColumns(3)}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                columns === 3 ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              3×3
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenMotionSettings}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Alertas</span>
          </button>
        </div>
      </div>

      {cameras.length === 0 ? (
        <div className="p-8 border border-slate-800 rounded-xl bg-slate-900/40 text-center text-sm text-slate-400">
          No hay cámaras en línea para mostrar en el mosaico. Escanea la red o agrega una IP manual.
        </div>
      ) : (
        <div
          className={`grid grid-cols-1 ${
            columns === 3 ? 'md:grid-cols-2 xl:grid-cols-3' : 'md:grid-cols-2'
          } gap-4`}
        >
          {cameras.map((cam) => (
            <div
              key={cam.id}
              draggable
              onDragStart={() => onDragStart(cam.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDropOnCamera(cam.id)}
              className={`bg-slate-900 border rounded-lg overflow-hidden flex flex-col transition-opacity ${
                draggedCamId === cam.id ? 'opacity-50 border-sky-500' : 'border-slate-800'
              }`}
            >
              <div className="aspect-video relative">
                <CameraFeedCanvas camera={cam} compact onMotionScore={onMotionScore} />
              </div>
              <div className="px-3.5 py-2.5 flex items-center justify-between gap-3 border-t border-slate-800">
                <div className="flex items-center gap-2 min-w-0">
                  <GripVertical className="w-4 h-4 text-slate-500 cursor-grab shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-100 truncate">{cam.name}</div>
                    <div className="text-xs text-slate-400 font-mono tabular-nums">
                      {cam.ip}:{cam.port} · {cam.protocol}
                      {cam.latencyMs !== undefined ? ` · ${formatLatency(cam.latencyMs)}` : ''}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenCamera(cam.id)}
                  className="px-3 py-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 bg-slate-950 border border-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Ampliar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
