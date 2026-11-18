import express from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  COMMON_OUT_OF_NETWORK_CAMERA_IPS,
  buildCandidateHttpPorts,
  discoverArpNeighbors,
  discoverMdnsCameras,
  discoverNearbyWifiNetworks,
  discoverRouteAndVpnTargets,
  discoverSsdpDevices,
  discoverVendorUdpCameras,
  fetchWithAuth,
  getAllLocalIPv4Addresses,
  moveOnvifOrCgiPtz,
  probeMediaStream,
  resolveOnvifProfile,
  sendHttpTwoWayAudio,
  setCameraIrMode,
  toggleCameraLight,
  type NearbyWifiNetwork,
} from './server/cameraBridge.ts';
import { diagnosticsManager } from './server/diagnosticsManager.ts';
import { processManager } from './server/processManager.ts';
import { probeRtspBackchannel, rtspBackchannelPool } from './server/rtspBackchannel.ts';
import { savedCamerasStore } from './server/savedCamerasStore.ts';
import {
  classifyStreamFailure,
  parseExternalScanTargets,
  parseSubnetInputs,
  type CameraChannel,
  type ConnectionMode,
} from './src/utils/cameraLogic.ts';
import {
  getScanConfigForProfile,
  runWithConcurrency,
  type CapabilityCheckItem,
  type ScanProfile,
} from './src/utils/processLogic.ts';

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '4mb' }));

function resolveListenPort(): number {
  const portFlagIdx = process.argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
  if (portFlagIdx !== -1) {
    const arg = process.argv[portFlagIdx];
    const val = arg.includes('=') ? arg.split('=')[1] : process.argv[portFlagIdx + 1];
    const parsed = Number(val);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  if (envPort > 0 && nginxPort > 0 && envPort === nginxPort) {
    return Number(process.env.DEFAULT_APP_PORT) || 3000;
  }
  return envPort > 0 ? envPort : 3000;
}

const PORT = resolveListenPort();

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
  stage: 'discovery' | 'external' | 'nmap' | 'tcp-pool' | 'complete' | 'cancelled';
  label: string;
  completed: number;
  total: number;
  elapsedMs: number;
  foundCount: number;
}

async function executeNetworkScan(params: {
  rawSubnet: string;
  externalTargets?: string;
  outOfNetwork?: boolean;
  profile: ScanProfile;
  customTimeoutMs?: number;
  customConcurrency?: number;
  controller: AbortController;
  onProgress?: (payload: ScanProgressPayload) => void;
  onCamera?: (cam: CameraChannel) => void;
  onWifiNetworks?: (networks: NearbyWifiNetwork[]) => void;
}): Promise<{
  subnets: string[];
  cameras: CameraChannel[];
  wifiNetworks: NearbyWifiNetwork[];
  externalRoutes: string[];
  cancelled: boolean;
  durationMs: number;
}> {
  const {
    rawSubnet,
    externalTargets = '',
    outOfNetwork = false,
    profile,
    customTimeoutMs,
    customConcurrency,
    controller,
    onProgress,
    onCamera,
    onWifiNetworks,
  } = params;
  const startedAt = Date.now();
  const config = getScanConfigForProfile(profile, customTimeoutMs, customConcurrency);
  const allDetected = Array.from(new Set(getAllLocalIPv4Addresses().map((a) => a.subnet)));
  const nonLinkLocal = allDetected.filter((s) => !s.startsWith('169.254.'));
  const detectedSubnets = nonLinkLocal.length > 0 ? nonLinkLocal : allDetected;
  const parsedExternal = parseExternalScanTargets(externalTargets);
  const baseSubnets = parseSubnetInputs(rawSubnet, detectedSubnets);

  const scanOpId = processManager.startOperation(
    'scan',
    baseSubnets.length > 0 ? baseSubnets.map((s) => `${s}.0/24`).join(', ') : 'Red local + externa',
    {
      controller,
      detail: `Perfil ${profile}${outOfNetwork ? ' · Fuera de red' : ''} · timeout ${config.connectTimeoutMs}ms`,
    }
  );

  const found: CameraChannel[] = [];
  const seenKeys = new Set<string>();
  const portsByIp = new Map<string, Set<number>>();
  const recordIpPort = (ip: string, p?: number) => {
    if (!p || p <= 0) return;
    let set = portsByIp.get(ip);
    if (!set) {
      set = new Set<number>();
      portsByIp.set(ip, set);
    }
    set.add(p);
    for (const existing of found) {
      if (existing.ip === ip) {
        existing.openPorts = Array.from(set);
      }
    }
  };
  const pushCamera = (cam: CameraChannel) => {
    recordIpPort(cam.ip, cam.port);
    recordIpPort(cam.ip, cam.onvifPort);
    const key = `${cam.ip}:${cam.port}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const ipPorts = portsByIp.get(cam.ip);
    cam.openPorts = ipPorts ? Array.from(ipPorts) : [cam.port];
    found.push(cam);
    onCamera?.(cam);
  };

  onProgress?.({
    stage: 'discovery',
    label: outOfNetwork
      ? 'Descubrimiento local + rutas VPN / Wi-Fi / dispositivos externos'
      : 'Descubrimiento ONVIF, SSDP, mDNS, UDP fabricantes y ARP',
    completed: 0,
    total: 5,
    elapsedMs: Date.now() - startedAt,
    foundCount: found.length,
  });

  const ssdpOpId = processManager.startOperation('ssdp', '239.255.255.250:1900', {
    detail: 'M-SEARCH ssdp:all',
  });
  const mdnsOpId = processManager.startOperation('mdns', '224.0.0.251:5353', {
    detail: 'mDNS _rtsp/_onvif/_http',
  });
  const vendorUdpOpId = processManager.startOperation('vendor-udp', '34569,37810,37020', {
    detail: 'XMeye / Dahua / Hikvision SADP',
  });
  const arpOpId = processManager.startOperation('arp', 'Tabla ARP local', {
    detail: 'ip neigh / /proc/net/arp',
  });

  const shouldRunOutOfNetwork = outOfNetwork || parsedExternal.hosts.length > 0 || parsedExternal.subnets.length > 0;
  const routeOpId = shouldRunOutOfNetwork
    ? processManager.startOperation('route-vpn', 'Rutas IP / Tailscale VPN', {
        detail: 'Buscando subredes y nodos fuera de LAN',
      })
    : null;
  const wifiOpId = shouldRunOutOfNetwork
    ? processManager.startOperation('wifi', 'Wi-Fi cercanos y ocultos', {
        detail: 'termux-wifi-scaninfo / nmcli',
      })
    : null;

  const [onvifFound, ssdpFound, mdnsFound, vendorUdpFound, arpFound, routeVpn, wifiNetworks] = await Promise.all([
    discoverOnvifDevices(1100, controller.signal),
    discoverSsdpDevices(1000).then((items) => {
      processManager.completeOperation(ssdpOpId, 'completed', `${items.length} respuestas SSDP`, 0);
      return items;
    }),
    discoverMdnsCameras(1000).then((items) => {
      processManager.completeOperation(mdnsOpId, 'completed', `${items.length} servicios mDNS`, 0);
      return items;
    }),
    discoverVendorUdpCameras(1000).then((items) => {
      processManager.completeOperation(vendorUdpOpId, 'completed', `${items.length} respuestas UDP`, 0);
      return items;
    }),
    discoverArpNeighbors().then((items) => {
      processManager.completeOperation(arpOpId, 'completed', `${items.length} vecinos ARP`, 0);
      return items;
    }),
    shouldRunOutOfNetwork
      ? discoverRouteAndVpnTargets().then((res) => {
          if (routeOpId) {
            processManager.completeOperation(
              routeOpId,
              'completed',
              `${res.subnets.length} subredes · ${res.vpnHosts.length} nodos VPN/GW`,
              0
            );
          }
          return res;
        })
      : Promise.resolve({ subnets: [], vpnHosts: [], gateways: [], routesSummary: [] }),
    shouldRunOutOfNetwork
      ? discoverNearbyWifiNetworks().then((nets) => {
          if (wifiOpId) {
            processManager.completeOperation(
              wifiOpId,
              'completed',
              `${nets.length} redes Wi-Fi (${nets.filter((n) => n.cameraLikely).length} cámaras/ocultas)`,
              0
            );
          }
          return nets;
        })
      : Promise.resolve([]),
  ]);

  if (wifiNetworks.length > 0) {
    onWifiNetworks?.(wifiNetworks);
  }

  for (const cam of onvifFound) pushCamera(cam);
  for (const s of ssdpFound) {
    recordIpPort(s.ip, s.port);
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
  for (const m of mdnsFound) {
    recordIpPort(m.ip, m.port);
    pushCamera({
      id: `mdns-${m.ip.replace(/\./g, '-')}-${m.port}`,
      name: `${m.serviceName} (${m.ip})`,
      ip: m.ip,
      port: m.port === 80 ? 554 : m.port,
      onvifPort: m.port === 80 ? 80 : undefined,
      protocol: m.port === 554 ? 'RTSP' : 'ONVIF',
      streamPath: '/live/ch00_0',
      status: 'online',
      resolution: 'Auto',
      fps: 25,
      hasAudio: true,
      location: 'mDNS Multicast',
      nightVision: false,
      authStatus: 'unknown',
      capabilities: { ptz: true, audio: true, light: true, twoWayAudio: true },
    });
  }
  for (const v of vendorUdpFound) {
    pushCamera({
      id: `udp-${v.ip.replace(/\./g, '-')}-${v.port}`,
      name: `${v.vendor} (${v.ip})`,
      ip: v.ip,
      port: v.port,
      protocol: v.protocol,
      streamPath: '/live/ch00_0',
      status: 'online',
      resolution: 'Auto',
      fps: 25,
      hasAudio: true,
      manufacturer: v.vendor,
      location: `UDP ${v.vendor}`,
      nightVision: false,
      authStatus: 'unknown',
      capabilities: { ptz: true, audio: true, light: true, twoWayAudio: true },
    });
  }

  // Merge local subnets + explicitly requested external subnets + discovered route subnets (up to 3 extra routes)
  const extraRouteSubnets = outOfNetwork ? routeVpn.subnets.slice(0, 3) : [];
  const subnets = Array.from(new Set([...baseSubnets, ...parsedExternal.subnets, ...extraRouteSubnets]));

  const allTargets: Array<{
    locationLabel: string;
    ip: string;
    port: number;
    timeoutMs: number;
    protocol: CameraChannel['protocol'];
    defaultPath: string;
  }> = [];
  const scheduledTargetSet = new Set<string>();
  const addTarget = (locationLabel: string, ip: string, port: number, timeoutMs: number) => {
    const tk = `${ip}:${port}`;
    if (scheduledTargetSet.has(tk)) return;
    scheduledTargetSet.add(tk);
    const meta = getPortMeta(port);
    allTargets.push({ locationLabel, ip, port, timeoutMs, ...meta });
  };

  for (const neighbor of arpFound) {
    const parts = neighbor.ip.split('.');
    const nSubnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
    for (const port of config.ports) {
      addTarget(`Subred ${nSubnet}.0/24 (ARP)`, neighbor.ip, port, config.connectTimeoutMs);
    }
  }

  // Out-of-network targets: VPN peers, gateways, AP/factory camera IPs, saved remote devices, and user external IPs/DDNS
  if (shouldRunOutOfNetwork) {
    const externalTimeout = Math.max(config.connectTimeoutMs, 650);
    const extOpId = processManager.startOperation(
      'external',
      `${parsedExternal.hosts.length + routeVpn.vpnHosts.length} destinos externos`,
      { detail: 'VPN Tailscale, rutas, AP cámaras y DDNS' }
    );

    onProgress?.({
      stage: 'external',
      label: 'Preparando destinos fuera de la red (VPN / Rutas / DDNS / AP)',
      completed: 1,
      total: 2,
      elapsedMs: Date.now() - startedAt,
      foundCount: found.length,
    });

    for (const vh of routeVpn.vpnHosts) {
      const label = vh.source === 'tailscale' ? `VPN Tailscale (${vh.name || vh.ip})` : `Ruta Externa (${vh.ip})`;
      for (const port of config.ports) {
        addTarget(label, vh.ip, port, externalTimeout);
      }
    }

    if (outOfNetwork) {
      for (const apIp of COMMON_OUT_OF_NETWORK_CAMERA_IPS) {
        for (const port of config.ports) {
          addTarget('AP / IP de fábrica externa', apIp, port, Math.max(config.connectTimeoutMs, 420));
        }
      }
    }

    for (const saved of savedCamerasStore.list()) {
      if (saved.ip) {
        for (const p of Array.from(new Set([saved.port, saved.onvifPort, ...config.ports].filter((n): n is number => Boolean(n))))) {
          addTarget('Guardado (IP)', saved.ip, p, externalTimeout);
        }
      }
      if (saved.remoteHost && saved.remoteHost.trim()) {
        const rpList = Array.from(
          new Set([saved.remotePort || saved.port, saved.remoteOnvifPort, 554, 8554, 80, 8000].filter((n): n is number => Boolean(n)))
        );
        for (const rp of rpList) {
          addTarget(`Remoto (${saved.remoteHost.trim()})`, saved.remoteHost.trim(), rp, Math.max(externalTimeout, 900));
        }
      }
    }

    for (const ext of parsedExternal.hosts) {
      const targetPorts = ext.port ? [ext.port, ...config.ports] : config.ports;
      const label = ext.source === 'ddns' ? `DDNS / Host (${ext.host})` : `Externa (${ext.host})`;
      for (const p of Array.from(new Set(targetPorts))) {
        addTarget(label, ext.host, p, Math.max(externalTimeout, 850));
      }
    }

    processManager.completeOperation(
      extOpId,
      'completed',
      `${allTargets.length} sondas externas en cola`,
      0
    );
  }

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
        addTarget(`Subred ${subnet}.0/24`, ip, port, config.connectTimeoutMs);
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
        const probe = await probePortWithLatency(t.ip, t.port, t.timeoutMs);
        if (!probe.open) return null;
        recordIpPort(t.ip, t.port);

        const targetPort = t.protocol === 'ONVIF' ? 554 : t.port;
        if (seenKeys.has(`${t.ip}:${targetPort}`)) {
          return null;
        }

        const isExternalLoc =
          t.locationLabel.includes('VPN') ||
          t.locationLabel.includes('Externa') ||
          t.locationLabel.includes('DDNS') ||
          t.locationLabel.includes('Remoto') ||
          t.locationLabel.includes('fábrica');

        const cam: CameraChannel = {
          id: `cam-${t.ip.replace(/[^a-zA-Z0-9]/g, '-')}-${t.port}`,
          name: isExternalLoc ? `Cámara Externa ${t.ip}` : `Cámara ${t.ip}`,
          ip: t.ip,
          port: targetPort,
          onvifPort: t.protocol === 'ONVIF' ? t.port : undefined,
          protocol: t.protocol,
          streamPath: t.defaultPath,
          status: 'online',
          resolution: 'Auto',
          fps: 25,
          hasAudio: t.protocol === 'RTSP' || t.protocol === 'ONVIF',
          location: t.locationLabel,
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

  return {
    subnets,
    cameras: found,
    wifiNetworks,
    externalRoutes: routeVpn.subnets,
    cancelled,
    durationMs,
  };
}

// Live SSE scanner with real-time stage progress, per-camera streaming, and cancellation
app.get('/api/scan-stream', async (req, res) => {
  const rawSubnet = typeof req.query.subnet === 'string' ? req.query.subnet.trim() : '';
  const externalTargets = typeof req.query.externalTargets === 'string' ? req.query.externalTargets.trim() : '';
  const outOfNetwork = req.query.outOfNetwork === '1' || req.query.outOfNetwork === 'true';
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
      externalTargets,
      outOfNetwork,
      profile,
      customTimeoutMs,
      customConcurrency,
      controller,
      onProgress: (payload) => sendEvent('progress', payload),
      onCamera: (cam) => sendEvent('camera', cam),
      onWifiNetworks: (nets) => sendEvent('wifi', nets),
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
  const externalTargets = typeof req.query.externalTargets === 'string' ? req.query.externalTargets.trim() : '';
  const outOfNetwork = req.query.outOfNetwork === '1' || req.query.outOfNetwork === 'true';
  const profileParam = typeof req.query.profile === 'string' ? req.query.profile : 'standard';
  const profile: ScanProfile =
    profileParam === 'fast' || profileParam === 'deep' ? profileParam : 'standard';
  const customTimeoutMs = req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined;
  const customConcurrency = req.query.concurrency ? Number(req.query.concurrency) : undefined;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const result = await executeNetworkScan({
    rawSubnet,
    externalTargets,
    outOfNetwork,
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

// Saved Devices & Remote Connection Persistence API
app.get('/api/saved-cameras', (_req, res) => {
  res.json({ cameras: savedCamerasStore.list() });
});

app.post('/api/saved-cameras', (req, res) => {
  const cam = req.body as CameraChannel;
  if (!cam || !cam.ip) {
    res.status(400).json({ ok: false, error: 'Datos de cámara inválidos' });
    return;
  }
  const cameras = savedCamerasStore.upsert(cam);
  res.json({ ok: true, cameras });
});

app.put('/api/saved-cameras/:id', (req, res) => {
  const cam = { ...(req.body as CameraChannel), id: req.params.id };
  if (!cam.ip) {
    res.status(400).json({ ok: false, error: 'Falta IP de la cámara' });
    return;
  }
  const cameras = savedCamerasStore.upsert(cam);
  res.json({ ok: true, cameras });
});

app.delete('/api/saved-cameras/:id', (req, res) => {
  const result = savedCamerasStore.remove(req.params.id);
  res.json({ ok: true, ...result });
});

async function hasBinary(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 1200 });
    return true;
  } catch {
    return false;
  }
}

app.get('/api/network-info', async (_req, res) => {
  const interfaces = getAllLocalIPv4Addresses();
  const [ffmpeg, nmap, cloudflared, tailscale] = await Promise.all([
    hasBinary('ffmpeg'),
    hasBinary('nmap'),
    hasBinary('cloudflared'),
    hasBinary('tailscale'),
  ]);
  res.json({
    port: PORT,
    interfaces,
    tools: { ffmpeg, nmap, cloudflared, tailscale },
  });
});

// Verify camera connectivity (local + remote DDNS/VPN fallback), latency, credentials, ONVIF profiles & stream path
app.post('/api/verify-camera', async (req, res) => {
  const {
    ip,
    port = 554,
    onvifPort,
    remoteHost,
    remotePort,
    remoteOnvifPort,
    connectionMode = 'auto',
    protocol = 'RTSP',
    streamPath = '/live/ch00_0',
    username,
    password,
  } = req.body as {
    ip?: string;
    port?: number;
    onvifPort?: number;
    remoteHost?: string;
    remotePort?: number;
    remoteOnvifPort?: number;
    connectionMode?: ConnectionMode;
    protocol?: CameraChannel['protocol'];
    streamPath?: string;
    username?: string;
    password?: string;
  };

  if (!ip && !remoteHost) {
    res.status(400).json({ ok: false, error: 'Falta la IP o host de la cámara' });
    return;
  }

  const cleanRemote = remoteHost?.trim();
  const targetLocalHost = ip || cleanRemote!;
  const targetLocalPort = Number(port) || 554;
  const targetRemoteHost = cleanRemote || '';
  const targetRemotePort = Number(remotePort) || targetLocalPort;

  const verifyOpId = processManager.startOperation(
    'verify',
    connectionMode === 'remote' && targetRemoteHost
      ? `${targetRemoteHost}:${targetRemotePort}`
      : `${targetLocalHost}:${targetLocalPort}`,
    { detail: `Verificando ${protocol} (${connectionMode})` }
  );

  try {
    let activeEndpoint: 'local' | 'remote' = 'local';
    let activeHost = targetLocalHost;
    let activePort = targetLocalPort;
    let activeOnvifPort = onvifPort;
    let tcpProbe: { open: boolean; latencyMs?: number } = { open: false };

    if (connectionMode === 'remote' && targetRemoteHost) {
      activeEndpoint = 'remote';
      activeHost = targetRemoteHost;
      activePort = targetRemotePort;
      activeOnvifPort = remoteOnvifPort || onvifPort;
      tcpProbe = await probePortWithLatency(activeHost, activePort, 1600);
    } else {
      tcpProbe = await probePortWithLatency(targetLocalHost, targetLocalPort, 1200);
      if (!tcpProbe.open && connectionMode === 'auto' && targetRemoteHost) {
        const remoteProbe = await probePortWithLatency(targetRemoteHost, targetRemotePort, 1600);
        if (remoteProbe.open) {
          activeEndpoint = 'remote';
          activeHost = targetRemoteHost;
          activePort = targetRemotePort;
          activeOnvifPort = remoteOnvifPort || onvifPort;
          tcpProbe = remoteProbe;
        }
      }
    }

    const reachable = tcpProbe.open;
    const candidateHttpPorts = buildCandidateHttpPorts(activePort, activeOnvifPort);
    const openHttpProbes = await Promise.all(
      candidateHttpPorts.slice(0, 6).map(async (hp) => ({
        port: hp,
        ...(await probePortWithLatency(activeHost, hp, 550)),
      }))
    );
    const openPorts = Array.from(
      new Set([
        ...(reachable ? [activePort] : []),
        ...openHttpProbes.filter((p) => p.open).map((p) => p.port),
      ])
    );

    const onvifProfile = await resolveOnvifProfile(
      activeHost,
      activeOnvifPort || (activePort !== 554 ? activePort : undefined),
      username,
      password,
      true,
      openPorts
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
        const url = `${scheme}://${authSegment}${activeHost}:${activePort}${candidatePath}`;
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
        const r = await fetchWithAuth(`http://${activeHost}:${activePort}${resolvedPath}`, {
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
      `${activeEndpoint === 'remote' ? 'Remoto · ' : ''}${authStatus}${tcpProbe.latencyMs ? ` · ${tcpProbe.latencyMs}ms` : ''}`,
      ok ? 0 : 1
    );

    diagnosticsManager.recordSample({
      ip: activeHost,
      feature: 'verify',
      status: probeResult.authError ? 'warn' : ok ? 'ok' : 'error',
      method: onvifProfile ? `ONVIF:${onvifProfile.onvifPort}` : `${protocol}:${activePort}`,
      latencyMs: tcpProbe.latencyMs,
      reason: probeResult.authError
        ? 'Autenticación rechazada o requerida (401)'
        : ok
          ? `Conectividad verificada (puertos abiertos: ${openPorts.join(', ') || activePort})`
          : `Sin respuesta TCP ni ONVIF en ${activeHost}:${activePort}`,
      suggestion: probeResult.authError
        ? 'Verifica usuario y contraseña RTSP/ONVIF en Editar / Red.'
        : !ok
          ? 'Revisa la IP, subred o configura Host Remoto (Tailscale / DDNS).'
          : undefined,
    });

    res.json({
      ok,
      reachable,
      activeEndpoint,
      activeHost,
      activePort,
      openPorts,
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
    diagnosticsManager.recordSample({
      ip: targetLocalHost,
      feature: 'verify',
      status: 'error',
      reason: err instanceof Error ? err.message : 'Error interno verificando cámara',
    });
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
  let targetHost = '';
  let targetPort = 554;
  let targetPath = '/';
  try {
    const parsed = new URL(rawUrl);
    safeTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    targetHost = parsed.hostname;
    targetPort = Number(parsed.port) || (parsed.protocol === 'http:' ? 80 : 554);
    targetPath = parsed.pathname + parsed.search;
  } catch {
    // Keep fallback
  }

  const startedAt = Date.now();

  if (rawUrl.startsWith('http://')) {
    const opId = processManager.startOperation('stream', safeTarget, { detail: 'HTTP MJPEG Proxy' });
    try {
      const parsed = new URL(rawUrl);
      const user = parsed.username ? decodeURIComponent(parsed.username) : undefined;
      const pass = parsed.password ? decodeURIComponent(parsed.password) : undefined;
      const cleanUrl = `http://${parsed.host}${parsed.pathname}${parsed.search}`;
      const proxyRes = await fetchWithAuth(cleanUrl, { username: user, password: pass, timeoutMs: 8000 });
      if (!proxyRes.ok || !proxyRes.body) {
        const diag = classifyStreamFailure(`HTTP ${proxyRes.status}`, {
          host: targetHost,
          port: targetPort,
          path: targetPath,
        });
        diagnosticsManager.recordSample({
          ip: targetHost || safeTarget,
          feature: 'video',
          status: 'error',
          code: diag.code,
          latencyMs: Date.now() - startedAt,
          reason: diag.reason,
          suggestion: diag.suggestion,
        });
        processManager.completeOperation(opId, 'error', `HTTP ${proxyRes.status}`, proxyRes.status);
        res.status(proxyRes.status || 502).json({
          error: diag.reason,
          code: diag.code,
          suggestion: diag.suggestion,
        });
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
      const msg = err instanceof Error ? err.message : 'Fallo HTTP stream';
      const diag = classifyStreamFailure(msg, { host: targetHost, port: targetPort, path: targetPath });
      diagnosticsManager.recordSample({
        ip: targetHost || safeTarget,
        feature: 'video',
        status: 'error',
        code: diag.code,
        latencyMs: Date.now() - startedAt,
        reason: diag.reason,
        suggestion: diag.suggestion,
      });
      processManager.completeOperation(opId, 'error', msg, 1);
      if (!res.headersSent) {
        res.status(502).json({ error: diag.reason, code: diag.code, suggestion: diag.suggestion });
      }
    }
    return;
  }

  // RTSP -> MJPEG via ffmpeg: defer HTTP 200 headers until first decoded JPEG chunk so errors report real cause!
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

  let headersSent = false;
  let clientClosed = false;
  let stderrLog = '';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const startWatchdog = setTimeout(() => {
    if (!headersSent) {
      stderrLog = `${stderrLog}\nConnection timed out esperando primer frame`;
      processManager.cancelOperation(opId, 'Timeout esperando primer frame (10s)');
    }
  }, 10000);

  const resetWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      processManager.cancelOperation(opId, 'Timeout sin frames (15s)');
    }, 15000);
  };

  ff.stderr.on('data', (chunk: Buffer) => {
    stderrLog = (stderrLog + chunk.toString('utf8')).slice(-1200);
  });

  ff.stdout.on('data', (chunk: Buffer) => {
    if (!headersSent) {
      clearTimeout(startWatchdog);
      headersSent = true;
      diagnosticsManager.recordSample({
        ip: targetHost || safeTarget,
        feature: 'video',
        status: 'ok',
        method: 'rtsp-mjpeg',
        latencyMs: Date.now() - startedAt,
        reason: `Stream RTSP conectado (${targetHost}:${targetPort}${targetPath}).`,
      });
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'close',
      });
    }
    resetWatchdog();
    if (!res.writableEnded) res.write(chunk);
  });

  ff.on('close', (code) => {
    clearTimeout(startWatchdog);
    if (idleTimer) clearTimeout(idleTimer);
    if (!headersSent && !clientClosed) {
      const diag = classifyStreamFailure(stderrLog || `ffmpeg exit ${code ?? 'unknown'}`, {
        host: targetHost,
        port: targetPort,
        path: targetPath,
      });
      diagnosticsManager.recordSample({
        ip: targetHost || safeTarget,
        feature: 'video',
        status: 'error',
        code: diag.code,
        latencyMs: Date.now() - startedAt,
        reason: diag.reason,
        suggestion: diag.suggestion,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: diag.reason, code: diag.code, suggestion: diag.suggestion });
      }
      return;
    }
    if (!res.writableEnded) res.end();
  });

  ff.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(startWatchdog);
    if (idleTimer) clearTimeout(idleTimer);
    if (!headersSent && !clientClosed) {
      const diag = classifyStreamFailure(err.code || err.message || 'ffmpeg error', {
        host: targetHost,
        port: targetPort,
        path: targetPath,
      });
      diagnosticsManager.recordSample({
        ip: targetHost || safeTarget,
        feature: 'video',
        status: 'error',
        code: diag.code,
        latencyMs: Date.now() - startedAt,
        reason: diag.reason,
        suggestion: diag.suggestion,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: diag.reason, code: diag.code, suggestion: diag.suggestion });
      }
      return;
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    clientClosed = true;
    clearTimeout(startWatchdog);
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
  let targetIp = String(req.query.ip || '');
  try {
    const parsed = new URL(rawUrl);
    safeTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    if (!targetIp) targetIp = parsed.hostname;
  } catch {
    // Keep fallback
  }

  const startedAt = Date.now();
  const opId = processManager.startOperation('audio', safeTarget, { detail: 'Audio PCM WAV (ffmpeg)' });
  const ff = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-probesize', '512000',
    '-analyzeduration', '1500000',
    '-err_detect', 'ignore_err',
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
      processManager.cancelOperation(opId, 'Sin audio tras 9s');
    }
  }, 9000);

  ff.stderr.on('data', (chunk: Buffer) => {
    stderrLog = (stderrLog + chunk.toString('utf8')).slice(-800);
  });

  ff.stdout.on('data', (chunk: Buffer) => {
    if (!headersSent) {
      clearTimeout(startWatchdog);
      headersSent = true;
      diagnosticsManager.recordSample({
        ip: targetIp || safeTarget,
        feature: 'audio',
        status: 'ok',
        method: 'ffmpeg-pcm-wav',
        latencyMs: Date.now() - startedAt,
        reason: 'Audio entrante de la cámara activo (PCM 16kHz).',
      });
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
      const is401 = stderrLog.includes('401') || stderrLog.toLowerCase().includes('unauthorized');
      const noAudioTrack = stderrLog.includes('does not contain any stream') || stderrLog.includes('Output file #0 does not contain any stream');
      const reason = is401
        ? 'La cámara rechazó las credenciales para audio (HTTP/RTSP 401).'
        : noAudioTrack
          ? 'El stream RTSP actual no incluye pista de audio (revisa si el sub-stream o codec G.711/AAC está habilitado en la cámara).'
          : `Sin pista de audio disponible en el stream (código ffmpeg ${code ?? 'cancelado'}).`;
      diagnosticsManager.recordSample({
        ip: targetIp || safeTarget,
        feature: 'audio',
        status: 'error',
        code: is401 ? 401 : (code ?? 'ffmpeg'),
        latencyMs: Date.now() - startedAt,
        reason,
        suggestion: is401
          ? 'Guarda usuario y contraseña en Editar / Red.'
          : 'Activa el audio/micrófono en la configuración del canal principal de la cámara o prueba /stream1 o /live/ch00_0.',
      });
      res.status(502).json({ error: reason });
      return;
    }
    if (!res.writableEnded) res.end();
  });

  ff.on('error', () => {
    clearTimeout(startWatchdog);
    if (!headersSent) {
      diagnosticsManager.recordSample({
        ip: targetIp || safeTarget,
        feature: 'audio',
        status: 'error',
        reason: 'El binario ffmpeg no está disponible en el sistema para decodificar audio.',
        suggestion: 'Instala ffmpeg en Termux (pkg install ffmpeg) o ejecuta install-termux.sh.',
      });
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

// Real two-way audio talkback bridge (RTSP ONVIF Backchannel G.711 + ISAPI/Dahua/Hi3510 HTTP)
app.post('/api/talk', async (req, res) => {
  const {
    url,
    ip,
    port = 80,
    onvifPort,
    openPorts,
    username,
    password,
    audioBase64,
    mimeType = 'audio/wav',
  } = req.body as {
    url?: string;
    ip?: string;
    port?: number;
    onvifPort?: number;
    openPorts?: number[];
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
  const targetIp = ip || (() => {
    try {
      return url ? new URL(url).hostname : 'camara';
    } catch {
      return 'camara';
    }
  })();

  const startedAt = Date.now();
  const attempts: string[] = [];

  // 1. Real RTSP ONVIF Backchannel (DESCRIBE Require: www.onvif.org/ver20/backchannel -> SETUP -> PLAY -> G.711 RTP)
  let rtspError: string | undefined;
  if (url && url.startsWith('rtsp://')) {
    const rtspRes = await rtspBackchannelPool.sendAudio(url, audioBuffer);
    if (rtspRes.ok) {
      diagnosticsManager.recordSample({
        ip: targetIp,
        feature: 'talk',
        status: 'ok',
        method: `rtsp-backchannel:${rtspRes.codec}`,
        latencyMs: Date.now() - startedAt,
        reason: `Voz enviada por ONVIF RTSP Backchannel (${rtspRes.codec}, ${rtspRes.bytesSent} bytes).`,
      });
      res.json({ ok: true, method: `rtsp-backchannel:${rtspRes.codec}`, bytesSent: rtspRes.bytesSent });
      return;
    }
    rtspError = rtspRes.error;
    if (rtspError) attempts.push(`RTSP Backchannel: ${rtspError}`);
  }

  // 2. Fallback: HTTP Two-Way Audio (Hikvision ISAPI open->audioData, Dahua audio.cgi, Hi3510 talk.cgi)
  if (targetIp) {
    const httpRes = await sendHttpTwoWayAudio({
      ip: targetIp,
      port,
      onvifPort,
      openPorts,
      username,
      password,
      audioBuffer,
      mimeType,
    });
    attempts.push(...httpRes.attempts);
    if (httpRes.ok) {
      diagnosticsManager.recordSample({
        ip: targetIp,
        feature: 'talk',
        status: 'ok',
        method: httpRes.method,
        latencyMs: Date.now() - startedAt,
        reason: `Voz bidireccional activa vía ${httpRes.method}.`,
      });
      res.json({ ok: true, method: httpRes.method });
      return;
    }
  }

  const isAuthErr = attempts.some((a) => a.includes('401'));
  const finalError = isAuthErr
    ? `Credenciales rechazadas (401) para audio bidireccional en ${targetIp}.`
    : rtspError ||
      'La cámara no anunció pista RTSP backchannel (a=sendonly) ni endpoint HTTP de audio entrante.';

  diagnosticsManager.recordSample({
    ip: targetIp,
    feature: 'talk',
    status: 'error',
    code: isAuthErr ? 401 : 'backchannel-unsupported',
    latencyMs: Date.now() - startedAt,
    reason: finalError,
    suggestion: isAuthErr
      ? 'Actualiza usuario y contraseña de la cámara en Editar / Red.'
      : 'Algunas cámaras exigen usar el stream principal (/live/ch00_0 o /stream1) y activar Audio Bidireccional / G.711 en su menú web.',
  });

  res.status(502).json({
    ok: false,
    error: finalError,
    attempts,
  });
});

app.post('/api/talk/stop', (req, res) => {
  const { url } = req.body as { url?: string };
  rtspBackchannelPool.stop(url);
  res.json({ ok: true });
});

// Real ONVIF PTZ control (RelativeMove + timed ContinuousMove + CGI fallback)
app.post('/api/ptz', async (req, res) => {
  const { ip, port = 80, onvifPort, openPorts, profileToken, username, password, direction, speed = 0.25, stepMs = 260 } =
    req.body as {
      ip?: string;
      port?: number;
      onvifPort?: number;
      openPorts?: number[];
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

  const startedAt = Date.now();
  const result = await moveOnvifOrCgiPtz({
    ip,
    port,
    onvifPort,
    openPorts,
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
    diagnosticsManager.recordSample({
      ip,
      feature: 'ptz',
      status: 'error',
      code: result.authError ? 401 : 'ptz-failed',
      latencyMs: Date.now() - startedAt,
      reason: result.error || 'Sin respuesta PTZ',
      suggestion: result.authError ? 'Verifica credenciales en Editar / Red.' : 'Verifica el puerto ONVIF (80, 8000, 8899).',
    });
    res.status(502).json(result);
  }
});

// Broad spotlight / LED / floodlight control for ONVIF Relay/Aux & HTTP/CGI cameras
app.post('/api/light', async (req, res) => {
  const { ip, port = 80, onvifPort, openPorts, username, password, on } = req.body as {
    ip?: string;
    port?: number;
    onvifPort?: number;
    openPorts?: number[];
    username?: string;
    password?: string;
    on?: boolean;
  };
  if (!ip) {
    res.status(400).json({ ok: false, error: 'Falta ip' });
    return;
  }

  const startedAt = Date.now();
  const result = await toggleCameraLight({
    ip,
    port,
    onvifPort,
    openPorts,
    username,
    password,
    on: Boolean(on),
  });

  diagnosticsManager.recordSample({
    ip,
    feature: 'light',
    status: result.ok ? 'ok' : 'error',
    method: result.method,
    code: result.authError ? 401 : result.ok ? 200 : 'light-unsupported',
    latencyMs: Date.now() - startedAt,
    reason: result.ok
      ? `Luz ${on ? 'encendida' : 'apagada'} vía ${result.method}.`
      : result.error || 'La cámara no respondió al comando de luz.',
    suggestion: !result.ok
      ? result.authError
        ? 'Ingresa usuario y contraseña válidos en Editar / Red.'
        : `Intentos realizados: ${result.attempts.slice(0, 6).join(' · ') || 'sin respuesta HTTP/ONVIF'}`
      : undefined,
  });

  if (result.ok) {
    res.json(result);
  } else {
    res.status(502).json(result);
  }
});

// Real hardware Infrared / Night Vision control (ONVIF Imaging IrCutFilter + ISAPI/Dahua/Hi3510 CGI)
app.post('/api/ir', async (req, res) => {
  const { ip, port = 80, onvifPort, openPorts, username, password, mode } = req.body as {
    ip?: string;
    port?: number;
    onvifPort?: number;
    openPorts?: number[];
    username?: string;
    password?: string;
    mode?: 'normal' | 'night' | 'auto';
  };

  if (!ip || !mode) {
    res.status(400).json({ ok: false, error: 'Falta ip o mode' });
    return;
  }

  const startedAt = Date.now();
  const result = await setCameraIrMode({
    ip,
    port,
    onvifPort,
    openPorts,
    username,
    password,
    mode,
  });

  diagnosticsManager.recordSample({
    ip,
    feature: 'ir',
    status: result.ok ? 'ok' : 'warn',
    method: result.method,
    code: result.authError ? 401 : result.ok ? 200 : 'ir-software-only',
    latencyMs: Date.now() - startedAt,
    reason: result.ok
      ? `Modo IR/Visión "${mode}" aplicado en hardware vía ${result.method}.`
      : result.error || 'Sin respuesta de hardware IR; aplicado filtro visual.',
    suggestion: !result.ok
      ? `Intentos: ${result.attempts.slice(0, 5).join(' · ') || 'sin respuesta ONVIF/CGI'}`
      : undefined,
  });

  res.status(result.ok ? 200 : 502).json(result);
});

// Real-Time Error Sampling & Live Hardware Capabilities Diagnostic Endpoints
app.get('/api/diagnostics', (req, res) => {
  const ip = typeof req.query.ip === 'string' ? req.query.ip.trim() : undefined;
  res.json({ samples: diagnosticsManager.listSamples(ip || undefined) });
});

app.delete('/api/diagnostics', (_req, res) => {
  diagnosticsManager.clearSamples();
  res.json({ ok: true });
});

app.post('/api/diagnose-camera', async (req, res) => {
  const {
    ip,
    port = 554,
    onvifPort,
    openPorts,
    protocol = 'RTSP',
    streamPath = '/live/ch00_0',
    username,
    password,
  } = req.body as {
    ip?: string;
    port?: number;
    onvifPort?: number;
    openPorts?: number[];
    protocol?: CameraChannel['protocol'];
    streamPath?: string;
    username?: string;
    password?: string;
  };

  if (!ip) {
    res.status(400).json({ ok: false, error: 'Falta IP de cámara' });
    return;
  }

  const checks: CapabilityCheckItem[] = [];
  const authPrefix =
    username && username.trim()
      ? `${encodeURIComponent(username.trim())}:${encodeURIComponent(password || '')}@`
      : '';
  const scheme = protocol === 'RTSP' || protocol === 'ONVIF' ? 'rtsp' : 'http';
  const cleanPath = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
  const fullUrl = `${scheme}://${authPrefix}${ip}:${port}${cleanPath}`;

  // 1. TCP Reachability + Open Ports
  const candidateHttp = buildCandidateHttpPorts(port, onvifPort, openPorts);
  const [tcpMain, ...httpProbes] = await Promise.all([
    probePortWithLatency(ip, port, 1200),
    ...candidateHttp.slice(0, 6).map(async (hp) => ({ port: hp, ...(await probePortWithLatency(ip, hp, 700)) })),
  ]);
  const detectedPorts = Array.from(
    new Set([
      ...(openPorts || []),
      ...(tcpMain.open ? [port] : []),
      ...httpProbes.filter((p) => p.open).map((p) => p.port),
    ])
  );

  // 2. ONVIF Profile & Capabilities
  const onvifStart = Date.now();
  const onvifProfile = await resolveOnvifProfile(
    ip,
    onvifPort || (port !== 554 ? port : undefined),
    username,
    password,
    true,
    detectedPorts
  );
  const onvifLat = Date.now() - onvifStart;

  checks.push({
    feature: 'verify',
    label: 'Red, Puertos y ONVIF',
    supported: tcpMain.open || Boolean(onvifProfile),
    status: tcpMain.open ? (onvifProfile ? 'ok' : 'warn') : 'error',
    method: onvifProfile ? `ONVIF :${onvifProfile.onvifPort}` : `TCP :${port}`,
    latencyMs: tcpMain.latencyMs ?? onvifLat,
    reason: tcpMain.open
      ? onvifProfile
        ? `Puerto ${port} activo. ONVIF detectado (${onvifProfile.manufacturer || 'Genérico'} ${onvifProfile.model || ''}). Puertos abiertos: ${detectedPorts.join(', ')}.`
        : `Puerto ${port} accesible, pero ONVIF no respondió en ${candidateHttp.slice(0, 4).join(', ')}.`
      : `No se pudo abrir conexión TCP hacia ${ip}:${port}.`,
    suggestion: !tcpMain.open
      ? 'Comprueba que la cámara esté encendida, en la red o configurada con Host Remoto.'
      : !onvifProfile
        ? 'Si la cámara usa puerto ONVIF especial (ej. 8899, 8000, 2020), ingrésalo en Editar / Red.'
        : undefined,
  });

  // 3. Video + Audio Incoming Probe (ffprobe)
  const mediaStart = Date.now();
  const media = await probeMediaStream(fullUrl);
  const mediaLat = Date.now() - mediaStart;

  checks.push({
    feature: 'video',
    label: 'Video en Vivo',
    supported: media.ok,
    status: media.ok ? 'ok' : 'error',
    method: scheme.toUpperCase(),
    latencyMs: mediaLat,
    reason: media.ok
      ? `Stream válido (${media.resolution}, ${media.fps} FPS).`
      : media.authError
        ? 'Credenciales rechazadas (401 Unauthorized) al abrir video.'
        : `ffprobe no detectó stream válido en ${cleanPath}.`,
    suggestion: media.authError
      ? 'Actualiza usuario/contraseña en Editar / Red.'
      : !media.ok
        ? 'Prueba rutas como /live/ch00_0, /stream1 o /Streaming/Channels/101.'
        : undefined,
  });

  checks.push({
    feature: 'audio',
    label: 'Audio Entrante (Escuchar)',
    supported: Boolean(media.hasAudio),
    status: media.hasAudio ? 'ok' : media.ok ? 'warn' : 'error',
    method: media.audioCodec ? `Codec ${media.audioCodec}` : 'RTSP Audio',
    latencyMs: mediaLat,
    reason: media.hasAudio
      ? `Pista de audio detectada (${media.audioCodec || 'PCM/AAC'}).`
      : media.ok
        ? 'El video funciona, pero la cámara no envió pista de audio en esta ruta RTSP.'
        : 'Sin stream accesible para inspeccionar audio.',
    suggestion: !media.hasAudio
      ? 'Activa Audio/Micrófono en el menú de la cámara o verifica que el stream principal tenga audio habilitado.'
      : undefined,
  });

  // 4. Two-Way Audio Backchannel Probe
  let talkCheck: CapabilityCheckItem;
  if (scheme === 'rtsp') {
    const bcStart = Date.now();
    const bc = await probeRtspBackchannel(fullUrl);
    talkCheck = {
      feature: 'talk',
      label: 'Audio Bidireccional (Hablar)',
      supported: bc.supported,
      status: bc.supported ? 'ok' : 'warn',
      method: bc.supported ? `RTSP Backchannel (${bc.codec})` : 'RTSP/HTTP',
      latencyMs: Date.now() - bcStart,
      reason: bc.reason,
      suggestion: !bc.supported
        ? 'Si la cámara sí tiene altavoz pero falló aquí, revisa usuario/contraseña o activa el canal principal RTSP / ISAPI HTTP.'
        : undefined,
    };
  } else {
    talkCheck = {
      feature: 'talk',
      label: 'Audio Bidireccional (Hablar)',
      supported: false,
      status: 'warn',
      method: 'HTTP',
      reason: 'Stream MJPEG HTTP no soporta RTSP backchannel; intentará CGI HTTP si es Hikvision/Dahua.',
    };
  }
  checks.push(talkCheck);

  // 5. PTZ, IR & Light capability summary
  checks.push({
    feature: 'ptz',
    label: 'Movimiento PTZ',
    supported: Boolean(onvifProfile?.ptzSupported || detectedPorts.some((p) => p === 80 || p === 8000 || p === 8899)),
    status: onvifProfile?.ptzSupported ? 'ok' : 'warn',
    method: onvifProfile?.ptzSupported ? `ONVIF PTZ (${onvifProfile.profileToken})` : 'CGI / Sin confirmar',
    reason: onvifProfile?.ptzSupported
      ? `Servicio ONVIF PTZ disponible (token ${onvifProfile.profileToken}).`
      : 'ONVIF no reportó nodo PTZ directo; se intentará RelativeMove o HTTP CGI.',
  });

  checks.push({
    feature: 'ir',
    label: 'Visión Nocturna / Infrarrojo',
    supported: Boolean(onvifProfile?.imagingSupported || detectedPorts.length > 0),
    status: onvifProfile?.imagingSupported ? 'ok' : 'warn',
    method: onvifProfile?.imagingSupported ? 'ONVIF Imaging IrCutFilter' : 'HTTP CGI / Filtro visual',
    reason: onvifProfile?.imagingSupported
      ? `ONVIF Imaging disponible (fuente ${onvifProfile.videoSourceToken || 'VideoSource_1'}).`
      : 'La cámara no anunció ONVIF Imaging; se probará CGI (ISAPI/Dahua/Hi3510) al cambiar modo IR.',
  });

  checks.push({
    feature: 'light',
    label: 'Luz / Linterna Integrada',
    supported: Boolean((onvifProfile?.relayTokens && onvifProfile.relayTokens.length > 0) || detectedPorts.length > 0),
    status: onvifProfile?.relayTokens && onvifProfile.relayTokens.length > 0 ? 'ok' : 'warn',
    method:
      onvifProfile?.relayTokens && onvifProfile.relayTokens.length > 0
        ? `ONVIF Relay (${onvifProfile.relayTokens.join(', ')})`
        : `HTTP Puertos (${detectedPorts.filter((p) => p !== 554).join(', ') || 'ninguno'})`,
    reason:
      onvifProfile?.relayTokens && onvifProfile.relayTokens.length > 0
        ? `Relé de luz ONVIF detectado (${onvifProfile.relayTokens.join(', ')}).`
        : 'Al pulsar Luz se probarán ONVIF Aux/WhiteLight e interfaces Hikvision/Dahua/Hi3510/Foscam.',
  });

  for (const c of checks) {
    diagnosticsManager.recordSample({
      ip,
      feature: c.feature,
      status: c.status,
      method: c.method,
      latencyMs: c.latencyMs,
      reason: c.reason,
      suggestion: c.suggestion,
    });
  }

  res.json({
    ok: true,
    openPorts: detectedPorts,
    checks,
    samples: diagnosticsManager.listSamples(ip),
  });
});

async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve('dist')));
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`VigíaLAN corriendo en http://0.0.0.0:${PORT}`);
  });
}

startServer();
