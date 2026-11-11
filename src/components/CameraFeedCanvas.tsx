import React, { useEffect, useRef, useState } from 'react';
import {
  CameraChannel,
  buildStreamUrl,
  calculateMotionScore,
  clampZoomPan,
  formatDuration,
} from '../utils/cameraLogic';

interface CameraFeedCanvasProps {
  camera: CameraChannel;
  zoom?: number;
  panX?: number;
  panY?: number;
  nightVisionOverride?: boolean;
  isRecording?: boolean;
  onMotionScore?: (cameraId: string, score: number) => void;
  onRecordingComplete?: (blob: Blob, durationSec: number) => void;
  compact?: boolean;
}

export const CameraFeedCanvas: React.FC<CameraFeedCanvasProps> = ({
  camera,
  zoom = 1,
  panX = 0,
  panY = 0,
  nightVisionOverride,
  isRecording = false,
  onMotionScore,
  onRecordingComplete,
}) => {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordStartRef = useRef<number>(0);

  const [recSeconds, setRecSeconds] = useState(0);
  const [streamError, setStreamError] = useState(false);

  const isNight = nightVisionOverride ?? camera.nightVision;
  const rawStreamUrl = buildStreamUrl(camera);
  const proxyUrl = `/api/stream?url=${encodeURIComponent(rawStreamUrl)}`;

  useEffect(() => {
    setStreamError(false);
  }, [proxyUrl]);

  // Draw live <img> stream frames onto <canvas> for recording & motion detection
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
              // Ignore tainted canvas if any
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

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950 select-none flex items-center justify-center">
      {camera.status === 'offline' || streamError ? (
        <div className="text-center px-4 space-y-1.5">
          <p className="text-sm font-mono font-semibold text-slate-400">
            {camera.status === 'offline' ? 'CÁMARA SIN SEÑAL' : 'NO SE PUDO CONECTAR AL STREAM'}
          </p>
          <p className="text-xs font-mono text-slate-500 break-all">{rawStreamUrl}</p>
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
