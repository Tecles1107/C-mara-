import express from 'express';
import { createServer as createViteServer } from 'vite';
import net from 'node:net';
import os from 'node:os';
import dgram from 'node:dgram';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

interface DiscoveredCamera {
  id: string;
  name: string;
  ip: string;
  port: number;
  protocol: 'RTSP' | 'ONVIF' | 'MJPEG' | 'HTTP-FLV';
  streamPath: string;
  status: 'online' | 'offline';
  resolution: string;
  fps: number;
  hasAudio: boolean;
  location: string;
  nightVision: boolean;
}

function getLocalSubnets(): string[] {
  const interfaces = os.networkInterfaces();
  const subnets = new Set<string>();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        const parts = info.address.split('.');
        if (parts.length === 4) {
          subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      }
    }
  }
  return Array.from(subnets);
}

function probePort(ip: string, port: number, timeoutMs = 220): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, ip);
  });
}

function discoverOnvifDevices(timeoutMs = 1200): Promise<DiscoveredCamera[]> {
  return new Promise((resolve) => {
    const found: DiscoveredCamera[] = [];
    const seen = new Set<string>();
    const socket = dgram.createSocket('udp4');
    const probeMsg = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${Date.now()}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action a:mustUnderstand="true" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`
    );

    socket.on('message', (msg, rinfo) => {
      if (seen.has(rinfo.address)) return;
      seen.add(rinfo.address);
      const text = msg.toString('utf8');
      const xaddrsMatch = text.match(/<[^:]*:?XAddrs>([^<]+)<\/[^:]*:?XAddrs>/i);
      let port = 80;
      if (xaddrsMatch) {
        const portMatch = xaddrsMatch[1].match(/:(\d+)/);
        if (portMatch) port = Number(portMatch[1]);
      }
      found.push({
        id: `onvif-${rinfo.address.replace(/\./g, '-')}`,
        name: `ONVIF ${rinfo.address}`,
        ip: rinfo.address,
        port: 554,
        protocol: 'ONVIF',
        streamPath: '/onvif1',
        status: 'online',
        resolution: 'Auto',
        fps: 25,
        hasAudio: true,
        location: `ONVIF (${port})`,
        nightVision: false,
      });
    });

    socket.on('error', () => {
      socket.close();
      resolve(found);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(probeMsg, 0, probeMsg.length, 3702, '239.255.255.250');
      } catch {
        // Ignore multicast send errors
      }
    });

    setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore close errors
      }
      resolve(found);
    }, timeoutMs);
  });
}

async function scanWithNmap(subnet: string): Promise<DiscoveredCamera[]> {
  try {
    const { stdout } = await execFileAsync(
      'nmap',
      ['-Pn', '-T4', '--open', '-p', '554,8554,80,81,8000,8080,8081,8899,37777,34567', `${subnet}.0/24`, '-oG', '-'],
      { timeout: 15000 }
    );
    const results: DiscoveredCamera[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('Host:') || !line.includes('Ports:')) continue;
      const ipMatch = line.match(/Host:\s+(\d+\.\d+\.\d+\.\d+)/);
      if (!ipMatch) continue;
      const ip = ipMatch[1];
      const portsPart = line.split('Ports:')[1] || '';
      const portMatches = portsPart.matchAll(/(\d+)\/open\/tcp/g);
      for (const m of portMatches) {
        const port = Number(m[1]);
        const protocol: DiscoveredCamera['protocol'] =
          port === 554 || port === 8554 ? 'RTSP' : port === 8000 || port === 8899 ? 'ONVIF' : 'MJPEG';
        const defaultPath =
          protocol === 'RTSP' ? '/live/ch00_0' : protocol === 'ONVIF' ? '/onvif1' : port === 81 ? '/stream' : '/video';
        results.push({
          id: `nmap-${ip.replace(/\./g, '-')}-${port}`,
          name: `Cámara ${ip}`,
          ip,
          port,
          protocol,
          streamPath: defaultPath,
          status: 'online',
          resolution: 'Auto',
          fps: 25,
          hasAudio: protocol === 'RTSP' || protocol === 'ONVIF',
          location: `nmap ${subnet}.0/24`,
          nightVision: false,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

// Real local network camera scanner (ONVIF WS-Discovery + nmap + TCP port probing)
app.get('/api/scan', async (req, res) => {
  const customSubnet = typeof req.query.subnet === 'string' ? req.query.subnet.trim() : '';
  const subnets = customSubnet ? [customSubnet] : getLocalSubnets();
  const ports: Array<{ port: number; protocol: DiscoveredCamera['protocol']; defaultPath: string }> = [
    { port: 554, protocol: 'RTSP', defaultPath: '/live/ch00_0' },
    { port: 8554, protocol: 'RTSP', defaultPath: '/live' },
    { port: 8080, protocol: 'MJPEG', defaultPath: '/video' },
    { port: 8081, protocol: 'MJPEG', defaultPath: '/video' },
    { port: 81, protocol: 'MJPEG', defaultPath: '/stream' },
    { port: 8000, protocol: 'ONVIF', defaultPath: '/onvif1' },
    { port: 8899, protocol: 'ONVIF', defaultPath: '/onvif1' },
    { port: 80, protocol: 'MJPEG', defaultPath: '/mjpeg' },
  ];

  const onvifFound = await discoverOnvifDevices(1000);
  const found: DiscoveredCamera[] = [...onvifFound];
  const seenKeys = new Set(onvifFound.map((c) => `${c.ip}:${c.port}`));
  const batchSize = 48;

  for (const subnet of subnets) {
    const nmapFound = await scanWithNmap(subnet);
    for (const cam of nmapFound) {
      const key = `${cam.ip}:${cam.port}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        found.push(cam);
      }
    }
    const targets: Array<{ ip: string; port: number; protocol: DiscoveredCamera['protocol']; defaultPath: string }> = [];
    for (let host = 1; host <= 254; host++) {
      const ip = `${subnet}.${host}`;
      for (const p of ports) {
        targets.push({ ip, ...p });
      }
    }

    for (let i = 0; i < targets.length; i += batchSize) {
      const chunk = targets.slice(i, i + batchSize);
      const results = await Promise.all(
        chunk.map(async (t) => ({
          ...t,
          open: await probePort(t.ip, t.port, 160),
        }))
      );
      for (const r of results) {
        const key = `${r.ip}:${r.port}`;
        if (r.open && !seenKeys.has(key)) {
          seenKeys.add(key);
          found.push({
            id: `cam-${r.ip.replace(/\./g, '-')}-${r.port}`,
            name: `Cámara ${r.ip}`,
            ip: r.ip,
            port: r.port,
            protocol: r.protocol,
            streamPath: r.defaultPath,
            status: 'online',
            resolution: 'Auto',
            fps: 25,
            hasAudio: r.protocol === 'RTSP' || r.protocol === 'ONVIF',
            location: `Subred ${subnet}.0/24`,
            nightVision: false,
          });
        }
      }
    }
  }

  res.json({ subnets, cameras: found });
});

// Real video stream bridge: proxies HTTP/MJPEG or transcodes RTSP -> MJPEG via ffmpeg
app.get('/api/stream', (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('rtsp://'))) {
    res.status(400).json({ error: 'URL de stream inválida (use rtsp:// o http://)' });
    return;
  }

  if (rawUrl.startsWith('http://')) {
    const proxyReq = http.get(rawUrl, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, {
        'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(502).end();
    });
    req.on('close', () => proxyReq.destroy());
    return;
  }

  // RTSP -> MJPEG via ffmpeg
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'close',
  });

  const ff = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rawUrl,
    '-f', 'mpjpeg',
    '-q:v', '5',
    '-r', '15',
    '-',
  ]);

  ff.stdout.pipe(res);
  ff.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  req.on('close', () => {
    ff.kill('SIGKILL');
  });
});

// Real audio stream bridge via ffmpeg
app.get('/api/audio', (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('rtsp://'))) {
    res.status(400).json({ error: 'URL de audio inválida' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });

  const ff = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rawUrl,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ab', '128k',
    '-f', 'mp3',
    '-',
  ]);

  ff.stdout.pipe(res);
  ff.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  req.on('close', () => {
    ff.kill('SIGKILL');
  });
});

// Real ONVIF PTZ control (ContinuousMove / Stop) for motorized local cameras
app.post('/api/ptz', async (req, res) => {
  const { ip, port = 80, direction } = req.body as {
    ip?: string;
    port?: number;
    direction?: 'up' | 'down' | 'left' | 'right' | 'stop';
  };
  if (!ip || !direction) {
    res.status(400).json({ error: 'Falta ip o direction' });
    return;
  }

  const x = direction === 'left' ? -0.5 : direction === 'right' ? 0.5 : 0;
  const y = direction === 'up' ? 0.5 : direction === 'down' ? -0.5 : 0;

  const soapBody =
    direction === 'stop'
      ? `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body><tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:ProfileToken>Profile_1</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom></tptz:Stop></s:Body>
</s:Envelope>`
      : `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body><tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:ProfileToken>Profile_1</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${x}" y="${y}" xmlns:tt="http://www.onvif.org/ver10/schema"/></tptz:Velocity></tptz:ContinuousMove></s:Body>
</s:Envelope>`;

  const targetPort = port === 554 ? 80 : port;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    await fetch(`http://${ip}:${targetPort}/onvif/ptz_service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: soapBody,
      signal: controller.signal,
    });
    clearTimeout(timer);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ ok: false, error: 'La cámara no respondió al comando PTZ ONVIF' });
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
