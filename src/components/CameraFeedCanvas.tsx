import React, { useEffect, useRef, useState } from 'react';
import {
  CameraChannel,
  buildStreamUrl,
  calculateMotionScore,
  clampZoomPan,
  formatDuration,
} from '../utils/cameraLogic';

export type VisionMode = 'normal' | 'night' | 'auto';

interface CameraFeedCanvasProps {
  camera: CameraChannel;
  zoom?: number;
  panX?: number;
  panY?: number;
  onZoomPanChange?: (zoom: number, panX: number, panY: number) => void;
  visionMode?: VisionMode;
  isRecording?: boolean;
  onMotionScore?: (cameraId: string, score: number) => void;
  onRecordingComplete?: (blob: Blob, durationSec: number) => void;
  snapshotTrigger?: number;
  compact?: boolean;
}

export const CameraFeedCanvas: React.FC<CameraFeedCanvasProps> = ({
  camera,
  zoom = 1,
  panX = 0,
  panY = 0,
  onZoomPanChange,
  visionMode = 'normal',
  isRecording = false,
  onMotionScore,
  onRecordingComplete,
  snapshotTrigger = 0,
}) => {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordStartRef = useRef<number>(0);

  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const [recSeconds, setRecSeconds] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const isNight =
    visionMode === 'night' ||
    (visionMode === 'auto' && (new Date().getHours() >= 19 || new Date().getHours() < 6));
  const rawStreamUrl = buildStreamUrl(camera);
  const proxyUrl = `/api/stream?url=${encodeURIComponent(rawStreamUrl)}&r=${retryCount}`;

  useEffect(() => {
    setStreamError(false);
  }, [proxyUrl]);

  // Snapshot photo download
  useEffect(() => {
    if (snapshotTrigger <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `foto_${camera.id}_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // Ignore tainted canvas
    }
  }, [snapshotTrigger, camera.id]);

  // Draw live <img> stream frames onto <canvas> for recording, snapshots & motion detection
  useEffect(() => {
    if (camera.status !== 'online' || streamError) return;
    let animId = 0;
    let frameCount = 0;

    const tick = () => {
      frameCount++;
      const img = imgRef.current;
      const canvas = canvasRef.current;
      if (img && canvas && img.complete && img.naturalWidth > 0) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          if (onMotionScore && frameCount % 15 === 0) {
            try {
              const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              if (prevFrameRef.current) {
                const score = calculateMotionScore(prevFrameRef.current, frameData, 24);
                onMotionScore(camera.id, score);
              }
              prevFrameRef.current = new Uint8ClampedArray(frameData);
            } catch {
              // Ignore tainted canvas
            }
          }
        }
      }
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [camera.id, camera.status, streamError, onMotionScore]);

  // Real MediaRecorder on the live canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || camera.status !== 'online' || streamError) return;

    if (isRecording) {
      try {
        const stream = canvas.captureStream(15);
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9'
          : 'video/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: 'video/webm' });
          const duration = Math.max(1, Math.round((Date.now() - recordStartRef.current) / 1000));
          onRecordingComplete?.(blob, duration);
        };
        recordStartRef.current = Date.now();
        setRecSeconds(0);
        recorder.start(250);
        recorderRef.current = recorder;

        const timer = window.setInterval(() => {
          setRecSeconds(Math.round((Date.now() - recordStartRef.current) / 1000));
        }, 500);

        return () => {
          window.clearInterval(timer);
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        };
      } catch {
        // MediaRecorder unavailable
      }
    } else if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
  }, [isRecording, camera.status, streamError, onRecordingComplete]);

  const { zoom: safeZoom, panX: safePanX, panY: safePanY } = clampZoomPan(zoom, panX, panY);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      pinchStartDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartZoomRef.current = safeZoom;
      dragStartRef.current = null;
    } else if (activePointersRef.current.size === 1 && safeZoom > 1) {
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: safePanX,
        panY: safePanY,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onZoomPanChange || !activePointersRef.current.has(e.pointerId)) return;
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 2 && pinchStartDistRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStartDistRef.current > 0) {
        const nextZoom = pinchStartZoomRef.current * (dist / pinchStartDistRef.current);
        const clamped = clampZoomPan(nextZoom, safePanX, safePanY);
        onZoomPanChange(clamped.zoom, clamped.panX, clamped.panY);
      }
    } else if (activePointersRef.current.size === 1 && dragStartRef.current && safeZoom > 1) {
      const dx = (e.clientX - dragStartRef.current.x) * 0.15;
      const dy = (e.clientY - dragStartRef.current.y) * 0.15;
      const clamped = clampZoomPan(
        safeZoom,
        dragStartRef.current.panX + dx,
        dragStartRef.current.panY + dy
      );
      onZoomPanChange(clamped.zoom, clamped.panX, clamped.panY);
    }
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartDistRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      dragStartRef.current = null;
    }
  };

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-slate-950 select-none flex items-center justify-center touch-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
    >
      {camera.status === 'offline' || streamError ? (
        <div className="text-center px-4 space-y-2">
          <p className="text-sm font-mono font-semibold text-slate-400">
            {camera.status === 'offline' ? 'CÁMARA SIN SEÑAL' : 'NO SE PUDO CONECTAR AL STREAM'}
          </p>
          <p className="text-xs font-mono text-slate-500 break-all">{camera.ip}:{camera.port}{camera.streamPath}</p>
          {streamError && camera.status === 'online' && (
            <button
              type="button"
              onClick={() => {
                setStreamError(false);
                setRetryCount((n) => n + 1);
              }}
              className="px-3 py-1.5 text-xs font-medium text-sky-300 bg-slate-900 border border-slate-700 hover:bg-slate-800 rounded-md cursor-pointer"
            >
              Reintentar conexión
            </button>
          )}
        </div>
      ) : (
        <>
          <img
            ref={imgRef}
            src={proxyUrl}
            alt={`Stream en vivo de ${camera.name}`}
            crossOrigin="anonymous"
            onError={() => setStreamError(true)}
            className="w-full h-full object-contain transition-transform duration-150 ease-out"
            style={{
              transform: `scale(${safeZoom}) translate(${safePanX}%, ${safePanY}%)`,
              filter: isNight ? 'grayscale(100%) contrast(125%) brightness(115%) sepia(30%) hue-rotate(85deg)' : undefined,
            }}
          />
          <canvas
            ref={canvasRef}
            width={640}
            height={360}
            data-testid={`camera-canvas-${camera.id}`}
            className="hidden"
          />
          {isRecording && (
            <div className="absolute top-3 right-3 px-2.5 py-1 bg-red-600/90 text-white text-xs font-mono rounded">
              REC {formatDuration(recSeconds)}
            </div>
          )}
        </>
      )}
    </div>
  );
};
