import express from 'express';
import { createServer as createViteServer } from 'vite';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  discoverSsdpDevices,
  fetchWithAuth,
  getAllLocalIPv4Addresses,
  moveOnvifOrCgiPtz,
  probeMediaStream,
  resolveOnvifProfile,
  toggleCameraLight,
} from './server/cameraBridge.ts';
import { processManager } from './server/processManager.ts';
import { parseSubnetInputs, type CameraChannel } from './src/utils/cameraLogic.ts';
import {
  getScanConfigForProfile,
  runWithConcurrency,
  type ScanProfile,
} from './src/utils/processLogic.ts';

const app = express();
app.use(express.json({ limit: '4mb' }));

const PORT = Number(process.env.PORT) || 3000;

function probePortWithLatency(
  ip: string,
  port: number,
  timeoutMs = 200
): Promise<{ open: boolean; latencyMs?: number }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(
        open
          ? { open: true, latencyMs: Math.max(1, Math.round(performance.now() - start)) }
          : { open: false }
      );
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, ip);
  });
}

function discoverOnvifDevices(timeoutMs = 1200, signal?: AbortSignal): Promise<CameraChannel[]> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve([]);
      return;
    }

    const opId = processManager.startOperation('onvif', '239.255.255.250:3702', {
      detail: 'WS-Discovery multicast',
    });

    const found: CameraChannel[] = [];
    const seen = new Set<string>();
    const interfaces = getAllLocalIPv4Addresses();
    const sockets: dgram.Socket[] = [];
    let settled = false;

    const makeProbe = (types: string) =>
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl"
  xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <e:Header>
    <w:MessageID>uuid:${Date.now()}-${Math.random().toString(16).slice(2)}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action a:mustUnderstand="true" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe><d:Types>${types}</d:Types></d:Probe></e:Body>
</e:Envelope>`
      );

    const probe1 = makeProbe('dn:NetworkVideoTransmitter');
    const probe2 = makeProbe('tds:Device');

    const cleanup = (cancelled = false) => {
      if (settled) return;
      settled = true;
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          // Ignore
        }
      }
      processManager.completeOperation(
        opId,
        cancelled ? 'cancelled' : 'completed',
        `${found.length} dispositivos ONVIF`,
        0
      );
      resolve(found);
    };

    signal?.addEventListener('abort', () => cleanup(true), { once: true });

    const bindTargets = interfaces.length > 0 ? interfaces.map((i) => i.address) : [undefined];
    for (const bindIp of bindTargets) {
      const sock = dgram.createSocket('udp4');
      sockets.push(sock);
      const sentAt = performance.now();
      sock.on('message', (msg, rinfo) => {
        if (seen.has(rinfo.address)) return;
        seen.add(rinfo.address);
        const latencyMs = Math.max(1, Math.round(performance.now() - sentAt));
        const text = msg.toString('utf8');
        const xaddrsMatch = text.match(/<[^:]*:?XAddrs>([^<]+)<\/[^:]*:?XAddrs>/i);
        let onvifPort = 80;
        if (xaddrsMatch) {
          const portMatch = xaddrsMatch[1].match(/:(\d+)/);
          if (portMatch) onvifPort = Number(portMatch[1]);
        }
        found.push({
          id: `onvif-${rinfo.address.replace(/\./g, '-')}`,
          name: `ONVIF ${rinfo.address}`,
          ip: rinfo.address,
          port: 554,
          onvifPort,
          protocol: 'ONVIF',
          streamPath: '/onvif1',
          status: 'online',
          resolution: 'Auto',
          fps: 25,
          hasAudio: true,
          location: `ONVIF (${onvifPort})`,
          nightVision: false,
          authStatus: 'unknown',
          latencyMs,
          capabilities: { ptz: true, audio: true, light: true, twoWayAudio: true },
        });
      });
      sock.on('error', () => {});
      sock.bind(0, bindIp, () => {
        try {
          sock.setBroadcast(true);
          sock.send(probe1, 0, probe1.length, 3702, '239.255.255.250');
          sock.send(probe2, 0, probe2.length, 3702, '239.255.255.250');
        } catch {
          // Ignore multicast errors
        }
      });
    }

    setTimeout(() => cleanup(false), timeoutMs);
  });
}

function scanWithNmap(
  subnet: string,
  ports: number[],
  signal?: AbortSignal
): Promise<CameraChannel[]> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve([]);
      return;
    }

    const controller = new AbortController();
    const opId = processManager.startOperation('nmap', `${subnet}.0/24`, {
      controller,
      detail: `Puertos: ${ports.join(',')}`,
    });

    const child = spawn('nmap', [
      '-Pn',
      '-T4',
      '--open',
      '-p',
      ports.join(','),
      `${subnet}.0/24`,
      '-oG',
      '-',
    ]);
    processManager.attachChildProcess(opId, child, 16000);

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    const onAbort = () => {
      processManager.cancelOperation(opId, 'Escaneo nmap cancelado');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      const results: CameraChannel[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('Host:') || !line.includes('Ports:')) continue;
        const ipMatch = line.match(/Host:\s+(\d+\.\d+\.\d+\.\d+)/);
        if (!ipMatch) continue;
        const ip = ipMatch[1];
        const portsPart = line.split('Ports:')[1] || '';
        const portMatches = portsPart.matchAll(/(\d+)\/open\/tcp/g);
        for (const m of portMatches) {
          const port = Number(m[1]);
          const protocol: CameraChannel['protocol'] =
            port === 554 || port === 8554 || port === 10554
              ? 'RTSP'
              : port === 8000 || port === 8899 || port === 5000
                ? 'ONVIF'
                : 'MJPEG';
          const defaultPath =
            protocol === 'RTSP'
              ? '/live/ch00_0'
              : protocol === 'ONVIF'
                ? '/onvif1'
                : port === 81 || port === 82
                  ? '/stream'
                  : '/video';
          results.push({
            id: `nmap-${ip.replace(/\./g, '-')}-${port}`,
            name: `Cámara ${ip}`,
            ip,
            port: protocol === 'ONVIF' ? 554 : port,
            onvifPort: protocol === 'ONVIF' ? port : undefined,
            protocol,
            streamPath: defaultPath,
            status: 'online',
            resolution: 'Auto',
            fps: 25,
            hasAudio: protocol === 'RTSP' || protocol === 'ONVIF',
            location: `Red ${subnet}.0/24`,
            nightVision: false,
            authStatus: 'unknown',
            capabilities: {
              ptz: protocol === 'ONVIF' || protocol === 'RTSP',
              audio: protocol === 'RTSP' || protocol === 'ONVIF',
              light: true,
              twoWayAudio: protocol === 'ONVIF' || protocol === 'RTSP',
            },
          });
        }
      }
      resolve(results);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', onAbort);
      if (err.code === 'ENOENT') {
        processManager.completeOperation(opId, 'completed', 'nmap no disponible (solo TCP)', null);
      }
      resolve([]);
    });
  });
}

function getPortMeta(port: number): { protocol: CameraChannel['protocol']; defaultPath: string } {
  if (port === 554 || port === 8554 || port === 10554) {
    return { protocol: 'RTSP', defaultPath: port === 554 ? '/live/ch00_0' : '/live' };
  }
  if (port === 8000 || port === 8001 || port === 8899 || port === 5000) {
    return { protocol: 'ONVIF', defaultPath: '/onvif1' };
  }
  if (port === 81 || port === 82) {
    return { protocol: 'MJPEG', defaultPath: '/stream' };
  }
  if (port === 8080 || port === 8081) {
    return { protocol: 'MJPEG', defaultPath: '/video' };
  }
  return { protocol: 'MJPEG', defaultPath: '/mjpeg' };
}

interface ScanProgressPayload {
  stage: 'discovery' | 'nmap' | 'tcp-pool' | 'complete' | 'cancelled';
  label: string;
  completed: number;
  total: number;
  elapsedMs: number;
  foundCount: number;
}

async function executeNetworkScan(params: {
  rawSubnet: string;
  profile: ScanProfile;
  customTimeoutMs?: number;
  customConcurrency?: number;
  controller: AbortController;
  onProgress?: (payload: ScanProgressPayload) => void;
  onCamera?: (cam: CameraChannel) => void;
}): Promise<{ subnets: string[]; cameras: CameraChannel[]; cancelled: boolean; durationMs: number }> {
  const { rawSubnet, profile, customTimeoutMs, customConcurrency, controller, onProgress, onCamera } = params;
  const startedAt = Date.now();
  const config = getScanConfigForProfile(profile, customTimeoutMs, customConcurrency);
  const allDetected = Array.from(new Set(getAllLocalIPv4Addresses().map((a) => a.subnet)));
  const nonLinkLocal = allDetected.filter((s) => !s.startsWith('169.254.'));
  const detectedSubnets = nonLinkLocal.length > 0 ? nonLinkLocal : allDetected;
  const subnets = parseSubnetInputs(rawSubnet, detectedSubnets);

  const scanOpId = processManager.startOperation(
    'scan',
    subnets.length > 0 ? subnets.map((s) => `${s}.0/24`).join(', ') : 'Sin subred',
    {
      controller,
      detail: `Perfil ${profile} · timeout ${config.connectTimeoutMs}ms · hilos ${config.concurrency}`,
    }
  );

  const found: CameraChannel[] = [];
  const seenKeys = new Set<string>();
  const pushCamera = (cam: CameraChannel) => {
    const key = `${cam.ip}:${cam.port}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    found.push(cam);
    onCamera?.(cam);
  };

  onProgress?.({
    stage: 'discovery',
    label: 'Descubrimiento ONVIF WS-Discovery y SSDP',
    completed: 0,
    total: 2,
    elapsedMs: Date.now() - startedAt,
    foundCount: found.length,
  });

  const ssdpOpId = processManager.startOperation('ssdp', '239.255.255.250:1900', {
    detail: 'M-SEARCH ssdp:all',
  });

  const [onvifFound, ssdpFound] = await Promise.all([
    discoverOnvifDevices(1100, controller.signal),
    discoverSsdpDevices(1000).then((items) => {
      processManager.completeOperation(ssdpOpId, 'completed', `${items.length} respuestas SSDP`, 0);
      return items;
    }),
  ]);

  for (const cam of onvifFound) pushCamera(cam);
  for (const s of ssdpFound) {
    pushCamera({
      id: `ssdp-${s.ip.replace(/\./g, '-')}-${s.port}`,
      name: s.server ? `${s.server.split('/')[0]} (${s.ip})` : `Cámara SSDP ${s.ip}`,
      ip: s.ip,
      port: s.port === 80 ? 554 : s.port,
      onvifPort: s.port,
      protocol: 'ONVIF',
      streamPath: '/live/ch00_0',
      status: 'online',
      resolution: 'Auto',
      fps: 25,
      hasAudio: true,
      location: `SSDP (${s.port})`,
      nightVision: false,
      authStatus: 'unknown',
      capabilities: { ptz: true, audio: true, light: true, twoWayAudio: true },
    });
  }

  const allTargets: Array<{
    subnet: string;
    ip: string;
    port: number;
    protocol: CameraChannel['protocol'];
    defaultPath: string;
  }> = [];

  for (const subnet of subnets) {
    if (controller.signal.aborted) break;

    onProgress?.({
      stage: 'nmap',
      label: `Analizando subred ${subnet}.0/24 con nmap`,
      completed: 0,
      total: 1,
      elapsedMs: Date.now() - startedAt,
      foundCount: found.length,
    });

    const nmapFound = await scanWithNmap(subnet, config.ports, controller.signal);
    for (const cam of nmapFound) pushCamera(cam);

    for (let host = 1; host <= 254; host++) {
      const ip = `${subnet}.${host}`;
      for (const port of config.ports) {
        const meta = getPortMeta(port);
        allTargets.push({ subnet, ip, port, ...meta });
      }
    }
  }

  if (!controller.signal.aborted && allTargets.length > 0) {
    let lastEmit = 0;
    onProgress?.({
      stage: 'tcp-pool',
      label: `Sondeo TCP (${config.concurrency} hilos, ${config.connectTimeoutMs} ms)`,
      completed: 0,
      total: allTargets.length,
      elapsedMs: Date.now() - startedAt,
      foundCount: found.length,
    });

    await runWithConcurrency(
      allTargets,
      config.concurrency,
      async (t) => {
        const targetPort = t.protocol === 'ONVIF' ? 554 : t.port;
        if (seenKeys.has(`${t.ip}:${targetPort}`)) {
          return null;
        }
        const probe = await probePortWithLatency(t.ip, t.port, config.connectTimeoutMs);
        if (!probe.open) return null;

        const cam: CameraChannel = {
          id: `cam-${t.ip.replace(/\./g, '-')}-${t.port}`,
          name: `Cámara ${t.ip}`,
          ip: t.ip,
          port: targetPort,
          onvifPort: t.protocol === 'ONVIF' ? t.port : undefined,
          protocol: t.protocol,
          streamPath: t.defaultPath,
          status: 'online',
          resolution: 'Auto',
          fps: 25,
          hasAudio: t.protocol === 'RTSP' || t.protocol === 'ONVIF',
          location: `Subred ${t.subnet}.0/24`,
          nightVision: false,
          authStatus: 'unknown',
          latencyMs: probe.latencyMs,
          capabilities: {
            ptz: t.protocol === 'ONVIF' || t.protocol === 'RTSP',
            audio: t.protocol === 'RTSP' || t.protocol === 'ONVIF',
            light: true,
            twoWayAudio: t.protocol === 'ONVIF' || t.protocol === 'RTSP',
          },
        };
        pushCamera(cam);
        return cam;
      },
      controller.signal,
      (completed, total) => {
        const now = Date.now();
        if (completed === total || now - lastEmit >= 160) {
          lastEmit = now;
          onProgress?.({
            stage: 'tcp-pool',
            label: `Sondeo TCP (${config.concurrency} hilos, ${config.connectTimeoutMs} ms)`,
            completed,
            total,
            elapsedMs: now - startedAt,
            foundCount: found.length,
          });
        }
      }
    );
  }

  const cancelled = controller.signal.aborted;
  const durationMs = Date.now() - startedAt;
  processManager.completeOperation(
    scanOpId,
    cancelled ? 'cancelled' : 'completed',
    `${found.length} cámaras encontradas en ${durationMs} ms`,
    cancelled ? null : 0
  );

  onProgress?.({
    stage: cancelled ? 'cancelled' : 'complete',
    label: cancelled ? 'Escaneo cancelado' : 'Escaneo finalizado',
    completed: allTargets.length,
    total: allTargets.length,
    elapsedMs: durationMs,
    foundCount: found.length,
  });

  return { subnets, cameras: found, cancelled, durationMs };
}

// Live SSE scanner with real-time stage progress, per-camera streaming, and cancellation
app.get('/api/scan-stream', async (req, res) => {
  const rawSubnet = typeof req.query.subnet === 'string' ? req.query.subnet.trim() : '';
  const profileParam = typeof req.query.profile === 'string' ? req.query.profile : 'standard';
  const profile: ScanProfile =
    profileParam === 'fast' || profileParam === 'deep' ? profileParam : 'standard';
  const customTimeoutMs = req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined;
  const customConcurrency = req.query.concurrency ? Number(req.query.concurrency) : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
  });

  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
  });

  const sendEvent = (event: string, data: unknown) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  try {
    const result = await executeNetworkScan({
      rawSubnet,
      profile,
      customTimeoutMs,
      customConcurrency,
      controller,
      onProgress: (payload) => sendEvent('progress', payload),
      onCamera: (cam) => sendEvent('camera', cam),
    });
    sendEvent('done', result);
  } catch (err) {
    sendEvent('error', {
      message: err instanceof Error ? err.message : 'Error durante el escaneo',
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// JSON scan endpoint (shares concurrency, latency & processManager tracking)
app.get('/api/scan', async (req, res) => {
  const rawSubnet = typeof req.query.subnet === 'string' ? req.query.subnet.trim() : '';
  const profileParam = typeof req.query.profile === 'string' ? req.query.profile : 'standard';
  const profile: ScanProfile =
    profileParam === 'fast' || profileParam === 'deep' ? profileParam : 'standard';
  const customTimeoutMs = req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined;
  const customConcurrency = req.query.concurrency ? Number(req.query.concurrency) : undefined;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const result = await executeNetworkScan({
    rawSubnet,
    profile,
    customTimeoutMs,
    customConcurrency,
    controller,
  });

  res.json(result);
});

app.post('/api/scan/cancel', (_req, res) => {
  const cancelledScans = processManager.cancelByKind('scan', 'Escaneo cancelado desde UI');
  const cancelledNmap = processManager.cancelByKind('nmap', 'Escaneo cancelado desde UI');
  res.json({ ok: true, cancelled: cancelledScans + cancelledNmap });
});

// Process & Connection Inspection Endpoints
app.get('/api/processes', (_req, res) => {
  res.json({
    operations: processManager.listOperations(),
    activeCount: processManager.getActiveCount(),
  });
});

app.post('/api/processes/:id/kill', (req, res) => {
  const ok = processManager.cancelOperation(req.params.id, 'Terminado manualmente por usuario');
  res.json({ ok });
});

// Verify camera connectivity, latency, credentials, ONVIF profiles, and auto-detect working stream path
app.post('/api/verify-camera', async (req, res) => {
  const { ip, port = 554, onvifPort, protocol = 'RTSP', streamPath = '/live/ch00_0', username, password } =
    req.body as {
      ip?: string;
      port?: number;
      onvifPort?: number;
      protocol?: CameraChannel['protocol'];
      streamPath?: string;
      username?: string;
      password?: string;
    };

  if (!ip) {
    res.status(400).json({ ok: false, error: 'Falta la IP de la cámara' });
    return;
  }

  const verifyOpId = processManager.startOperation('verify', `${ip}:${port}`, {
    detail: `Verificando ${protocol}`,
  });

  try {
    const tcpProbe = await probePortWithLatency(ip, Number(port), 1200);
    const reachable = tcpProbe.open;
    const onvifProfile = await resolveOnvifProfile(
      ip,
      onvifPort || (Number(port) !== 554 ? Number(port) : undefined),
      username,
      password,
      true
    );

    let resolvedPath = streamPath;
    if (onvifProfile?.streamUri) {
      try {
        const u = new URL(onvifProfile.streamUri);
        resolvedPath = u.pathname + u.search;
      } catch {
        // Keep provided path
      }
    }

    const authSegment =
      username && username.trim()
        ? `${encodeURIComponent(username.trim())}:${encodeURIComponent(password || '')}@`
        : '';
    const scheme = protocol === 'RTSP' || protocol === 'ONVIF' ? 'rtsp' : 'http';

    const pathsToTry = Array.from(
      new Set([
        resolvedPath,
        '/live/ch00_0',
        '/stream1',
        '/h264Preview_01_main',
        '/Streaming/Channels/101',
        '/cam/realmonitor?channel=1&subtype=0',
        '/onvif1',
        '/video',
        '/mjpeg',
        '/stream',
      ])
    );

    let probeResult: { ok: boolean; resolution?: string; fps?: number; hasAudio?: boolean; authError?: boolean } = {
      ok: false,
    };

    if (scheme === 'rtsp') {
      for (const candidatePath of pathsToTry.slice(0, 6)) {
        const url = `${scheme}://${authSegment}${ip}:${port}${candidatePath}`;
        const r = await probeMediaStream(url);
        if (r.ok) {
          resolvedPath = candidatePath;
          probeResult = r;
          break;
        }
        if (r.authError) {
          probeResult = r;
          break;
        }
      }
    } else {
      try {
        const r = await fetchWithAuth(`http://${ip}:${port}${resolvedPath}`, {
          method: 'GET',
          username,
          password,
          timeoutMs: 1800,
        });
        probeResult = { ok: r.ok, authError: r.status === 401, resolution: 'Auto', fps: 20, hasAudio: false };
      } catch {
        probeResult = { ok: false };
      }
    }

    const authStatus: CameraChannel['authStatus'] = probeResult.authError
      ? username
        ? 'failed'
        : 'required'
      : probeResult.ok
        ? username
          ? 'verified'
          : 'open'
        : 'unknown';

    const ok = probeResult.ok || Boolean(onvifProfile) || reachable;
    processManager.completeOperation(
      verifyOpId,
      ok ? 'completed' : 'error',
      `${authStatus}${tcpProbe.latencyMs ? ` · ${tcpProbe.latencyMs}ms` : ''}`,
      ok ? 0 : 1
    );

    res.json({
      ok,
      reachable,
      latencyMs: tcpProbe.latencyMs,
      authStatus,
      resolvedStreamPath: resolvedPath,
      resolution: probeResult.resolution || 'Auto',
      fps: probeResult.fps || 25,
      hasAudio: Boolean(probeResult.hasAudio),
      onvifPort: onvifProfile?.onvifPort,
      profileToken: onvifProfile?.profileToken,
      manufacturer: onvifProfile?.manufacturer,
      model: onvifProfile?.model,
      ptzSupported: Boolean(onvifProfile?.ptzSupported),
    });
  } catch (err) {
    processManager.completeOperation(
      verifyOpId,
      'error',
      err instanceof Error ? err.message : 'Fallo de verificación',
      1
    );
    res.status(500).json({ ok: false, error: 'Error interno verificando cámara' });
  }
});

// Real video stream bridge: proxies HTTP/MJPEG (with Digest/Basic auth) or transcodes RTSP -> MJPEG via ffmpeg
app.get('/api/stream', async (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('rtsp://'))) {
    res.status(400).json({ error: 'URL de stream inválida (use rtsp:// o http://)' });
    return;
  }

  let safeTarget = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    safeTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Keep truncated fallback
  }

  if (rawUrl.startsWith('http://')) {
    const opId = processManager.startOperation('stream', safeTarget, { detail: 'HTTP MJPEG Proxy' });
    try {
      const parsed = new URL(rawUrl);
      const user = parsed.username ? decodeURIComponent(parsed.username) : undefined;
      const pass = parsed.password ? decodeURIComponent(parsed.password) : undefined;
      const cleanUrl = `http://${parsed.host}${parsed.pathname}${parsed.search}`;
      const proxyRes = await fetchWithAuth(cleanUrl, { username: user, password: pass, timeoutMs: 8000 });
      if (!proxyRes.ok || !proxyRes.body) {
        processManager.completeOperation(opId, 'error', `HTTP ${proxyRes.status}`, proxyRes.status);
        res.status(proxyRes.status || 502).end();
        return;
      }
      res.writeHead(proxyRes.status, {
        'Content-Type': proxyRes.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      const reader = proxyRes.body.getReader();
      let closedByClient = false;
      req.on('close', () => {
        closedByClient = true;
        reader.cancel().catch(() => {});
        processManager.completeOperation(opId, 'completed', 'Cliente desconectado', 0);
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      if (!closedByClient) {
        processManager.completeOperation(opId, 'completed', 'Stream HTTP finalizado', 0);
      }
      res.end();
    } catch (err) {
      processManager.completeOperation(
        opId,
        'error',
        err instanceof Error ? err.message : 'Fallo HTTP stream',
        1
      );
      if (!res.headersSent) res.status(502).end();
    }
    return;
  }

  // RTSP -> MJPEG via ffmpeg with idle stall watchdog and ProcessManager tracking
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'close',
  });

  const opId = processManager.startOperation('stream', safeTarget, { detail: 'RTSP → MJPEG (ffmpeg)' });
  const ff = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', rawUrl,
    '-f', 'mpjpeg',
    '-q:v', '5',
    '-r', '15',
    '-',
  ]);
  processManager.attachChildProcess(opId, ff);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      processManager.cancelOperation(opId, 'Timeout sin frames (15s)');
    }, 15000);
  };
  resetWatchdog();

  ff.stdout.on('data', (chunk: Buffer) => {
    resetWatchdog();
    if (!res.writableEnded) res.write(chunk);
  });

  ff.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!res.writableEnded) res.end();
  });

  ff.on('error', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    processManager.cancelOperation(opId, 'Stream cerrado por cliente');
  });
});

// Real audio stream bridge via ffmpeg -> universal PCM WAV (works in Termux & all browsers)
app.get('/api/audio', (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('rtsp://'))) {
    res.status(400).json({ error: 'URL de audio inválida' });
    return;
  }

  let safeTarget = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    safeTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Keep fallback
  }

  const opId = processManager.startOperation('audio', safeTarget, { detail: 'Audio PCM WAV (ffmpeg)' });
  const ff = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-probesize', '32768',
    '-analyzeduration', '500000',
    '-i', rawUrl,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    '-f', 'wav',
    '-',
  ]);
  processManager.attachChildProcess(opId, ff);

  let headersSent = false;
  let stderrLog = '';

  const startWatchdog = setTimeout(() => {
    if (!headersSent) {
      processManager.cancelOperation(opId, 'Sin audio tras 8s');
    }
  }, 8000);

  ff.stderr.on('data', (chunk: Buffer) => {
    stderrLog += chunk.toString('utf8').slice(-400);
  });

  ff.stdout.on('data', (chunk: Buffer) => {
    if (!headersSent) {
      clearTimeout(startWatchdog);
      headersSent = true;
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
    }
    if (!res.writableEnded) res.write(chunk);
  });

  ff.on('close', (code) => {
    clearTimeout(startWatchdog);
    if (!headersSent) {
      res.status(502).json({
        error: stderrLog.includes('401')
          ? 'La cámara requiere credenciales para audio'
          : `Sin pista de audio disponible en el stream (código ${code ?? 'ffmpeg'})`,
      });
      return;
    }
    if (!res.writableEnded) res.end();
  });

  ff.on('error', () => {
    clearTimeout(startWatchdog);
    if (!headersSent) {
      res.status(502).json({ error: 'ffmpeg no está disponible para extraer audio' });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.on('close', () => {
    clearTimeout(startWatchdog);
    processManager.cancelOperation(opId, 'Audio cerrado por cliente');
  });
});

// Real two-way audio talkback bridge
app.post('/api/talk', async (req, res) => {
  const { url, ip, port = 80, username, password, audioBase64, mimeType = 'audio/wav' } = req.body as {
    url?: string;
    ip?: string;
    port?: number;
    username?: string;
    password?: string;
    audioBase64?: string;
    mimeType?: string;
  };

  if (!audioBase64 || (!url && !ip)) {
    res.status(400).json({ ok: false, error: 'Falta audio o destino de cámara' });
    return;
  }

  const audioBuffer = Buffer.from(audioBase64, 'base64');

  if (ip) {
    const httpPort = port === 554 ? 80 : port;
    try {
      const isapiRes = await fetchWithAuth(`http://${ip}:${httpPort}/ISAPI/System/TwoWayAudio/channels/1/audioData`, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: audioBuffer,
        username,
        password,
        timeoutMs: 1500,
      });
      if (isapiRes.ok) {
        res.json({ ok: true, method: 'isapi-twoway' });
        return;
      }
    } catch {
      // Fall through to RTSP backchannel
    }
  }

  if (url && url.startsWith('rtsp://')) {
    const opId = processManager.startOperation('talk', ip || 'RTSP backchannel', {
      detail: 'Audio bidireccional G.711',
    });
    const ok = await new Promise<boolean>((resolve) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-i', 'pipe:0',
        '-acodec', 'pcm_mulaw',
        '-ar', '8000',
        '-ac', '1',
        '-f', 'rtsp',
        '-rtsp_transport', 'tcp',
        url,
      ]);
      processManager.attachChildProcess(opId, ff, 2200);
      ff.on('close', (code) => {
        resolve(code === 0);
      });
      ff.on('error', () => {
        resolve(false);
      });
      ff.stdin.write(audioBuffer);
      ff.stdin.end();
    });
    if (ok) {
      res.json({ ok: true, method: 'rtsp-backchannel' });
      return;
    }
  }

  res.status(502).json({
    ok: false,
    error: 'La cámara no aceptó audio bidireccional (verifica soporte de altavoz/ONVIF backchannel o credenciales).',
  });
});

// Real ONVIF PTZ control (RelativeMove + timed ContinuousMove + CGI fallback)
app.post('/api/ptz', async (req, res) => {
  const { ip, port = 80, onvifPort, profileToken, username, password, direction, speed = 0.25, stepMs = 260 } =
    req.body as {
      ip?: string;
      port?: number;
      onvifPort?: number;
      profileToken?: string;
      username?: string;
      password?: string;
      direction?: 'up' | 'down' | 'left' | 'right' | 'stop';
      speed?: number;
      stepMs?: number;
    };

  if (!ip || !direction) {
    res.status(400).json({ ok: false, error: 'Falta ip o direction' });
    return;
  }

  const result = await moveOnvifOrCgiPtz({
    ip,
    port,
    onvifPort,
    profileToken,
    username,
    password,
    direction,
    speed,
    stepMs,
  });

  if (result.ok) {
    res.json(result);
  } else {
    res.status(502).json(result);
  }
});

// Broad spotlight / LED / IR light control for ONVIF & HTTP/ESP32 cameras
app.post('/api/light', async (req, res) => {
  const { ip, port = 80, onvifPort, username, password, on } = req.body as {
    ip?: string;
    port?: number;
    onvifPort?: number;
    username?: string;
    password?: string;
    on?: boolean;
  };
  if (!ip) {
    res.status(400).json({ ok: false, error: 'Falta ip' });
    return;
  }

  const result = await toggleCameraLight({
    ip,
    port,
    onvifPort,
    username,
    password,
    on: Boolean(on),
  });

  if (result.ok) {
    res.json(result);
  } else {
    res.status(502).json(result);
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve('dist')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VigíaLAN corriendo en http://0.0.0.0:${PORT}`);
  });
}

startServer();
