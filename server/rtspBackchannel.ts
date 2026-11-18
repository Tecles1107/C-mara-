import crypto from 'node:crypto';
import net from 'node:net';

export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.max(-32768, Math.min(32767, sample));
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find highest set bit
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function linearToAlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, sample));
  const mask = pcm < 0 ? 0x55 : 0xd5;
  if (pcm < 0) pcm = -pcm - 1;
  if (pcm > 32767) pcm = 32767;

  let seg = 7;
  const segEnd = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];
  for (let i = 0; i < segEnd.length; i++) {
    if (pcm <= segEnd[i]) {
      seg = i;
      break;
    }
  }

  const aval =
    seg < 2
      ? (seg << 4) | ((pcm >> 4) & 0x0f)
      : (seg << 4) | ((pcm >> (seg + 3)) & 0x0f);
  return (aval ^ mask) & 0xff;
}

export function extractPcm16Mono8k(inputBuffer: Buffer): Int16Array {
  // Parse WAV RIFF header if present; otherwise treat as raw 16-bit PCM 16kHz mono
  let sampleRate = 16000;
  let channels = 1;
  let dataOffset = 0;
  let dataLength = inputBuffer.length;

  if (inputBuffer.length >= 44 && inputBuffer.toString('ascii', 0, 4) === 'RIFF') {
    let pos = 12;
    while (pos + 8 <= inputBuffer.length) {
      const chunkId = inputBuffer.toString('ascii', pos, pos + 4);
      const chunkSize = inputBuffer.readUInt32LE(pos + 4);
      if (chunkId === 'fmt ' && pos + 24 <= inputBuffer.length) {
        channels = inputBuffer.readUInt16LE(pos + 10) || 1;
        sampleRate = inputBuffer.readUInt32LE(pos + 12) || 16000;
      } else if (chunkId === 'data') {
        dataOffset = pos + 8;
        dataLength = Math.min(chunkSize, inputBuffer.length - dataOffset);
        break;
      }
      pos += 8 + chunkSize + (chunkSize % 2);
    }
  }

  const sampleCount = Math.floor(dataLength / (2 * channels));
  if (sampleCount <= 0) return new Int16Array(0);

  const mono = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    mono[i] = inputBuffer.readInt16LE(dataOffset + i * 2 * channels);
  }

  if (sampleRate === 8000) return mono;

  const outLength = Math.max(1, Math.floor((sampleCount * 8000) / sampleRate));
  const out = new Int16Array(outLength);
  const ratio = sampleCount / outLength;
  for (let i = 0; i < outLength; i++) {
    const idx = Math.min(sampleCount - 1, Math.floor(i * ratio));
    out[i] = mono[idx];
  }
  return out;
}

export function encodePcmToG711(pcm: Int16Array, codec: 'PCMU' | 'PCMA' = 'PCMU'): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = codec === 'PCMA' ? linearToAlaw(pcm[i]) : linearToMulaw(pcm[i]);
  }
  return out;
}

export interface BackchannelTrackInfo {
  controlUrl: string;
  payloadType: number;
  codec: 'PCMU' | 'PCMA';
}

export function parseBackchannelTrackFromSdp(
  sdp: string,
  baseUrl: string
): BackchannelTrackInfo | null {
  const sections = sdp.split(/\r?\nm=/);
  if (sections.length < 2) return null;

  for (let i = 1; i < sections.length; i++) {
    const sec = 'm=' + sections[i];
    const lines = sec.split(/\r?\n/);
    const mLine = lines[0];
    if (!mLine.startsWith('m=audio')) continue;

    const hasSendOnly = lines.some((l) => l.trim().toLowerCase() === 'a=sendonly');
    const isRecvOnlyOrSendRecv = lines.some((l) => {
      const t = l.trim().toLowerCase();
      return t === 'a=recvonly' || t === 'a=sendrecv';
    });
    if (!hasSendOnly && isRecvOnlyOrSendRecv) continue;
    if (!hasSendOnly) continue;

    const parts = mLine.trim().split(/\s+/);
    const payloadTypes = parts.slice(3).map(Number).filter((n) => !Number.isNaN(n));

    let payloadType = payloadTypes.includes(0)
      ? 0
      : payloadTypes.includes(8)
        ? 8
        : payloadTypes[0] ?? 0;
    let codec: 'PCMU' | 'PCMA' = payloadType === 8 ? 'PCMA' : 'PCMU';

    for (const line of lines) {
      const rtpmap = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/i);
      if (rtpmap) {
        const pt = Number(rtpmap[1]);
        const name = rtpmap[2].toUpperCase();
        if (name === 'PCMU') {
          payloadType = pt;
          codec = 'PCMU';
          break;
        }
        if (name === 'PCMA') {
          payloadType = pt;
          codec = 'PCMA';
        }
      }
    }

    const ctrlLine = lines.find((l) => l.toLowerCase().startsWith('a=control:'));
    const rawCtrl = ctrlLine ? ctrlLine.slice('a=control:'.length).trim() : '';
    let controlUrl = baseUrl;
    if (rawCtrl && rawCtrl !== '*') {
      if (rawCtrl.startsWith('rtsp://')) {
        controlUrl = rawCtrl;
      } else {
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        controlUrl = rawCtrl.startsWith('/')
          ? `${new URL(baseUrl).origin}${rawCtrl}`
          : `${normalizedBase}${rawCtrl}`;
      }
    }

    return { controlUrl, payloadType, codec };
  }

  return null;
}

interface RtspResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

function buildRtspAuthHeader(
  wwwAuth: string,
  method: string,
  uri: string,
  username: string,
  password: string
): string {
  if (wwwAuth.toLowerCase().startsWith('digest')) {
    const params: Record<string, string> = {};
    const regex = /(\w+)=(?:"([^"]+)"|([^,\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(wwwAuth)) !== null) {
      params[m[1]] = m[2] ?? m[3];
    }
    const realm = params.realm || '';
    const nonce = params.nonce || '';
    const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
    const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

class RtspBackchannelClient {
  private socket: net.Socket | null = null;
  private cseq = 1;
  private sessionId = '';
  private wwwAuth = '';
  private track: BackchannelTrackInfo | null = null;
  private rtpSeq = 1;
  private rtpTimestamp = 160;
  private ssrc = crypto.randomBytes(4).readUInt32BE(0);
  private cleanUrl: string;
  private username?: string;
  private password?: string;
  private host: string;
  private port: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingPromise: Promise<void> | null = null;
  private ready = false;

  constructor(rtspUrl: string) {
    const parsed = new URL(rtspUrl);
    this.host = parsed.hostname;
    this.port = Number(parsed.port) || 554;
    this.username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    this.password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    this.cleanUrl = `rtsp://${parsed.host}${parsed.pathname}${parsed.search}`;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close();
    }, 12000);
  }

  async ensureConnected(): Promise<BackchannelTrackInfo> {
    if (this.ready && this.socket && !this.socket.destroyed && this.track) {
      this.resetIdleTimer();
      return this.track;
    }
    if (this.connectingPromise) {
      await this.connectingPromise;
      if (this.track) return this.track;
    }

    this.connectingPromise = this.connectAndSetup();
    try {
      await this.connectingPromise;
      if (!this.track) throw new Error('La cámara no anunció pista de audio bidireccional (backchannel)');
      this.resetIdleTimer();
      return this.track;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async connectAndSetup(): Promise<void> {
    this.closeSocketOnly();
    const socket = new net.Socket();
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timeout conectando RTSP backchannel a ${this.host}:${this.port}`));
      }, 2500);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.connect(this.port, this.host);
    });

    // 1. DESCRIBE with Require: www.onvif.org/ver20/backchannel
    let descRes = await this.sendRequest('DESCRIBE', this.cleanUrl, {
      Accept: 'application/sdp',
      Require: 'www.onvif.org/ver20/backchannel',
    });

    if (descRes.statusCode === 401 && descRes.headers['www-authenticate']) {
      this.wwwAuth = descRes.headers['www-authenticate'];
      if (!this.username) {
        throw new Error('La cámara requiere usuario y contraseña (401) para audio bidireccional');
      }
      descRes = await this.sendRequest('DESCRIBE', this.cleanUrl, {
        Accept: 'application/sdp',
        Require: 'www.onvif.org/ver20/backchannel',
      });
    }

    // Fallback DESCRIBE without Require if camera returned 420/551 Option Not Supported
    if (descRes.statusCode === 420 || descRes.statusCode === 551) {
      descRes = await this.sendRequest('DESCRIBE', this.cleanUrl, {
        Accept: 'application/sdp',
      });
    }

    if (descRes.statusCode !== 200) {
      throw new Error(`RTSP DESCRIBE rechazado (${descRes.statusCode} ${descRes.statusText})`);
    }

    const baseUrl = descRes.headers['content-base'] || this.cleanUrl;
    const track = parseBackchannelTrackFromSdp(descRes.body, baseUrl);
    if (!track) {
      throw new Error('La cámara no expone pista RTSP backchannel (a=sendonly)');
    }
    this.track = track;

    // 2. SETUP backchannel track over TCP interleaved
    const setupRes = await this.sendRequest('SETUP', track.controlUrl, {
      Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1',
      Require: 'www.onvif.org/ver20/backchannel',
    });

    if (setupRes.statusCode !== 200) {
      throw new Error(`RTSP SETUP backchannel falló (${setupRes.statusCode} ${setupRes.statusText})`);
    }

    const sessHeader = setupRes.headers['session'] || '';
    this.sessionId = sessHeader.split(';')[0].trim();

    // 3. PLAY
    const playRes = await this.sendRequest('PLAY', this.cleanUrl, {
      Session: this.sessionId,
      Require: 'www.onvif.org/ver20/backchannel',
    });

    if (playRes.statusCode !== 200) {
      throw new Error(`RTSP PLAY backchannel falló (${playRes.statusCode} ${playRes.statusText})`);
    }

    this.ready = true;
  }

  private sendRequest(
    method: string,
    uri: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<RtspResponse> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        reject(new Error('Socket RTSP cerrado'));
        return;
      }

      const headers: Record<string, string> = {
        CSeq: String(this.cseq++),
        'User-Agent': 'VigiaLAN/1.0',
        ...extraHeaders,
      };
      if (this.wwwAuth && this.username !== undefined) {
        headers.Authorization = buildRtspAuthHeader(
          this.wwwAuth,
          method,
          uri,
          this.username,
          this.password || ''
        );
      }

      const rawReq =
        `${method} ${uri} RTSP/1.0\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n';

      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout esperando respuesta RTSP ${method}`));
      }, 2500);

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        // Skip leading interleaved RTP/RTCP '$' frames if any
        while (buffer.length >= 4 && buffer[0] === 0x24) {
          const frameLen = buffer.readUInt16BE(2);
          if (buffer.length < 4 + frameLen) return;
          buffer = buffer.subarray(4 + frameLen);
        }

        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        const lines = headerText.split('\r\n');
        const statusMatch = lines[0].match(/^RTSP\/\d\.\d\s+(\d+)\s*(.*)$/i);
        if (!statusMatch) return;

        const respHeaders: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const idx = lines[i].indexOf(':');
          if (idx > 0) {
            respHeaders[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
          }
        }

        const contentLen = Number(respHeaders['content-length'] || 0);
        const totalExpected = headerEnd + 4 + contentLen;
        if (buffer.length < totalExpected) return;

        const body = buffer.subarray(headerEnd + 4, totalExpected).toString('utf8');
        cleanup();
        resolve({
          statusCode: Number(statusMatch[1]),
          statusText: statusMatch[2] || '',
          headers: respHeaders,
          body,
        });
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.write(rawReq);
    });
  }

  async sendAudioBuffer(wavOrPcmBuffer: Buffer): Promise<{ codec: 'PCMU' | 'PCMA'; bytesSent: number }> {
    const track = await this.ensureConnected();
    const pcm8k = extractPcm16Mono8k(wavOrPcmBuffer);
    if (pcm8k.length === 0) {
      return { codec: track.codec, bytesSent: 0 };
    }

    const encoded = encodePcmToG711(pcm8k, track.codec);
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error('Conexión RTSP backchannel cerrada');
    }

    const frameSize = 160; // 20ms @ 8kHz
    let bytesSent = 0;
    for (let offset = 0; offset < encoded.length; offset += frameSize) {
      const payload = encoded.subarray(offset, Math.min(encoded.length, offset + frameSize));
      const rtpHeader = Buffer.alloc(12);
      rtpHeader[0] = 0x80; // V=2
      rtpHeader[1] = track.payloadType & 0x7f;
      rtpHeader.writeUInt16BE(this.rtpSeq & 0xffff, 2);
      rtpHeader.writeUInt32BE(this.rtpTimestamp >>> 0, 4);
      rtpHeader.writeUInt32BE(this.ssrc >>> 0, 8);

      const rtpPacket = Buffer.concat([rtpHeader, payload]);
      const interleaved = Buffer.alloc(4 + rtpPacket.length);
      interleaved[0] = 0x24; // '$'
      interleaved[1] = 0x00; // channel 0
      interleaved.writeUInt16BE(rtpPacket.length, 2);
      rtpPacket.copy(interleaved, 4);

      socket.write(interleaved);
      this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
      this.rtpTimestamp = (this.rtpTimestamp + payload.length) >>> 0;
      bytesSent += payload.length;
    }

    this.resetIdleTimer();
    return { codec: track.codec, bytesSent };
  }

  private closeSocketOnly(): void {
    this.ready = false;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.closeSocketOnly();
    this.track = null;
    this.sessionId = '';
  }
}

class RtspBackchannelPool {
  private clients = new Map<string, RtspBackchannelClient>();

  async sendAudio(
    rtspUrl: string,
    audioBuffer: Buffer
  ): Promise<{ ok: boolean; codec?: string; bytesSent?: number; error?: string }> {
    let client = this.clients.get(rtspUrl);
    if (!client) {
      client = new RtspBackchannelClient(rtspUrl);
      this.clients.set(rtspUrl, client);
    }

    try {
      const res = await client.sendAudioBuffer(audioBuffer);
      return { ok: true, codec: res.codec, bytesSent: res.bytesSent };
    } catch (err) {
      // Retry once with fresh connection in case session expired
      client.close();
      this.clients.delete(rtspUrl);
      try {
        const retryClient = new RtspBackchannelClient(rtspUrl);
        this.clients.set(rtspUrl, retryClient);
        const res = await retryClient.sendAudioBuffer(audioBuffer);
        return { ok: true, codec: res.codec, bytesSent: res.bytesSent };
      } catch (err2) {
        retryClientCleanup(this.clients, rtspUrl);
        return {
          ok: false,
          error: err2 instanceof Error ? err2.message : err instanceof Error ? err.message : 'Fallo RTSP backchannel',
        };
      }
    }
  }

  stop(rtspUrl?: string): void {
    if (rtspUrl) {
      const c = this.clients.get(rtspUrl);
      c?.close();
      this.clients.delete(rtspUrl);
      return;
    }
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

function retryClientCleanup(map: Map<string, RtspBackchannelClient>, key: string): void {
  const c = map.get(key);
  c?.close();
  map.delete(key);
}

export const rtspBackchannelPool = new RtspBackchannelPool();

export async function probeRtspBackchannel(rtspUrl: string): Promise<{
  supported: boolean;
  codec?: string;
  controlUrl?: string;
  reason: string;
}> {
  const client = new RtspBackchannelClient(rtspUrl);
  try {
    const track = await client.ensureConnected();
    return {
      supported: true,
      codec: track.codec,
      controlUrl: track.controlUrl,
      reason: `Backchannel RTSP activo (${track.codec}, PT=${track.payloadType})`,
    };
  } catch (err) {
    return {
      supported: false,
      reason: err instanceof Error ? err.message : 'No soporta RTSP backchannel',
    };
  } finally {
    client.close();
  }
}
