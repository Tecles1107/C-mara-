export interface VoiceSessionHandle {
  stop: () => void;
  setDeepVoice: (enabled: boolean) => void;
  setLocalMonitor: (enabled: boolean) => void;
}

function encodeWavFromFloat32(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error('Error leyendo audio'));
    reader.readAsDataURL(blob);
  });
}

export async function startVoiceTalkSession(options: {
  initialDeepVoice: boolean;
  initialLocalMonitor?: boolean;
  onChunkReady: (audioBase64: string) => Promise<void>;
  onError: (msg: string) => void;
}): Promise<VoiceSessionHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('El navegador no permite acceso al micrófono (requiere HTTPS o localhost).');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);

  // Bass boost + low-pass shaping for deep voice ("Voz gruesa")
  const bassBoost = ctx.createBiquadFilter();
  bassBoost.type = 'lowshelf';
  bassBoost.frequency.value = 260;
  bassBoost.gain.value = options.initialDeepVoice ? 10 : 0;

  const lowPass = ctx.createBiquadFilter();
  lowPass.type = 'lowpass';
  lowPass.frequency.value = options.initialDeepVoice ? 1800 : 7500;

  let deepVoiceEnabled = options.initialDeepVoice;
  let localMonitorEnabled = Boolean(options.initialLocalMonitor);
  const monitorGain = ctx.createGain();
  monitorGain.gain.value = localMonitorEnabled ? 0.6 : 0;

  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const sampleBuffer: number[] = [];
  let readPhase = 0;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    if (deepVoiceEnabled) {
      // Real-time pitch shift down (~0.72x) with overlap smoothing
      const pitchFactor = 0.72;
      for (let i = 0; i < input.length; i++) {
        const idx = Math.floor(readPhase) % input.length;
        const nextIdx = (idx + 1) % input.length;
        const frac = readPhase - Math.floor(readPhase);
        const sample = input[idx] * (1 - frac) + input[nextIdx] * frac;
        output[i] = sample;
        sampleBuffer.push(sample);
        readPhase += pitchFactor;
        if (readPhase >= input.length) {
          readPhase -= input.length;
        }
      }
    } else {
      for (let i = 0; i < input.length; i++) {
        output[i] = input[i];
        sampleBuffer.push(input[i]);
      }
    }

    // Flush ~1 second chunks (16000 samples @ 16kHz)
    if (sampleBuffer.length >= 16000) {
      const chunk = new Float32Array(sampleBuffer.splice(0, 16000));
      const wav = encodeWavFromFloat32(chunk, ctx.sampleRate);
      blobToBase64(wav)
        .then((b64) => options.onChunkReady(b64))
        .catch((err) => options.onError(err instanceof Error ? err.message : 'Error enviando voz'));
    }
  };

  source.connect(bassBoost);
  bassBoost.connect(lowPass);
  lowPass.connect(processor);
  processor.connect(monitorGain);
  monitorGain.connect(ctx.destination);

  return {
    setDeepVoice: (enabled: boolean) => {
      deepVoiceEnabled = enabled;
      bassBoost.gain.value = enabled ? 10 : 0;
      lowPass.frequency.value = enabled ? 1800 : 7500;
    },
    setLocalMonitor: (enabled: boolean) => {
      localMonitorEnabled = enabled;
      monitorGain.gain.value = enabled ? 0.6 : 0;
    },
    stop: () => {
      stopped = true;
      try {
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}
