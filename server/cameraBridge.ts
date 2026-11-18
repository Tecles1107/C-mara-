import crypto from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface OnvifDeviceProfile {
  ip: string;
  onvifPort: number;
  mediaUrl?: string;
  ptzUrl?: string;
  imagingUrl?: string;
  profileToken?: string;
  streamUri?: string;
  manufacturer?: string;
  model?: string;
  ptzSupported: boolean;
  imagingSupported: boolean;
}

const onvifCache = new Map<string, OnvifDeviceProfile>();

export function getAllLocalIPv4Addresses(): Array<{ address: string; subnet: string }> {
  const interfaces = os.networkInterfaces();
  const list: Array<{ address: string; subnet: string }> = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        const parts = info.address.split('.');
        if (parts.length === 4) {
          list.push({
            address: info.address,
            subnet: `${parts[0]}.${parts[1]}.${parts[2]}`,
          });
        }
      }
    }
  }
  return list;
}

function buildWsSecurityHeader(username?: string, password?: string): string {
  if (!username) return '';
  const nonceBytes = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonceBytes, Buffer.from(created, 'utf8'), Buffer.from(password || '', 'utf8')]))
    .digest('base64');

  return `<s:Header>
    <Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <UsernameToken>
        <Username>${escapeXml(username)}</Username>
        <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
        <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBytes.toString('base64')}</Nonce>
        <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>
      </UsernameToken>
    </Security>
  </s:Header>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseDigestChallenge(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /(\w+)=(?:"([^"]+)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(header)) !== null) {
    result[match[1]] = match[2] ?? match[3];
  }
  return result;
}

export async function fetchWithAuth(
  url: string,
  options: RequestInit & { username?: string; password?: string; timeoutMs?: number } = {}
): Promise<Response> {
  const { username, password, timeoutMs = 2000, ...fetchOpts } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    if (res.status !== 401 || !username) {
      return res;
    }

    const wwwAuth = res.headers.get('www-authenticate') || '';
    const method = (fetchOpts.method || 'GET').toUpperCase();
    const uri = new URL(url).pathname + new URL(url).search;

    if (wwwAuth.toLowerCase().startsWith('digest')) {
      const challenge = parseDigestChallenge(wwwAuth);
      const realm = challenge.realm || '';
      const nonce = challenge.nonce || '';
      const qop = challenge.qop ? challenge.qop.split(',')[0].trim() : '';
      const nc = '00000001';
      const cnonce = crypto.randomBytes(8).toString('hex');
      const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password || ''}`).digest('hex');
      const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
      const responseHash = qop
        ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
        : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');

      const authHeader =
        `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
        (qop ? `qop=${qop}, nc=${nc}, cnonce="${cnonce}", ` : '') +
        `response="${responseHash}"` +
        (challenge.opaque ? `, opaque="${challenge.opaque}"` : '');

      return await fetch(url, {
        ...fetchOpts,
        headers: {
          ...(fetchOpts.headers || {}),
          Authorization: authHeader,
        },
        signal: controller.signal,
      });
    }

    const basicToken = Buffer.from(`${username}:${password || ''}`).toString('base64');
    return await fetch(url, {
      ...fetchOpts,
      headers: {
        ...(fetchOpts.headers || {}),
        Authorization: `Basic ${basicToken}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function soapRequest(
  url: string,
  bodyXml: string,
  username?: string,
  password?: string,
  timeoutMs = 2000
): Promise<{ ok: boolean; status: number; text: string }> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  ${buildWsSecurityHeader(username, password)}
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;

  try {
    const res = await fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: envelope,
      username,
      password,
      timeoutMs,
    });
    const text = await res.text();
    return { ok: res.ok && !text.includes(':Fault>'), status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

export async function resolveOnvifProfile(
  ip: string,
  preferredPort?: number,
  username?: string,
  password?: string,
  forceRefresh = false
): Promise<OnvifDeviceProfile | null> {
  const cacheKey = `${ip}:${preferredPort || 'auto'}:${username || ''}`;
  if (!forceRefresh && onvifCache.has(cacheKey)) {
    return onvifCache.get(cacheKey)!;
  }

  const candidatePorts = Array.from(
    new Set([preferredPort, 80, 8899, 8000, 8080, 5000, 2020].filter((p): p is number => Boolean(p && p !== 554 && p !== 8554)))
  );

  for (const port of candidatePorts) {
    const deviceUrl = `http://${ip}:${port}/onvif/device_service`;
    const capRes = await soapRequest(
      deviceUrl,
      `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>`,
      username,
      password,
      1400
    );

    if (!capRes.ok) continue;

    const mediaMatch = capRes.text.match(/<[^:]*:?Media[^>]*>[\s\S]*?<[^:]*:?XAddr>([^<]+)<\/[^:]*:?XAddr>/i);
    const ptzMatch = capRes.text.match(/<[^:]*:?PTZ[^>]*>[\s\S]*?<[^:]*:?XAddr>([^<]+)<\/[^:]*:?XAddr>/i);
    const imagingMatch = capRes.text.match(/<[^:]*:?Imaging[^>]*>[\s\S]*?<[^:]*:?XAddr>([^<]+)<\/[^:]*:?XAddr>/i);

    const mediaUrl = mediaMatch?.[1] || `http://${ip}:${port}/onvif/media_service`;
    const ptzUrl = ptzMatch?.[1] || `http://${ip}:${port}/onvif/ptz_service`;
    const imagingUrl = imagingMatch?.[1] || `http://${ip}:${port}/onvif/imaging_service`;

    let manufacturer: string | undefined;
    let model: string | undefined;
    const infoRes = await soapRequest(
      deviceUrl,
      `<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>`,
      username,
      password,
      1200
    );
    if (infoRes.ok) {
      manufacturer = infoRes.text.match(/<[^:]*:?Manufacturer>([^<]+)<\/[^:]*:?Manufacturer>/i)?.[1];
      model = infoRes.text.match(/<[^:]*:?Model>([^<]+)<\/[^:]*:?Model>/i)?.[1];
    }

    let profileToken = 'Profile_1';
    const profilesRes = await soapRequest(
      mediaUrl,
      `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`,
      username,
      password,
      1400
    );
    if (profilesRes.ok) {
      const tokenMatch = profilesRes.text.match(/<[^:]*:?Profiles[^>]+token="([^"]+)"/i);
      if (tokenMatch) profileToken = tokenMatch[1];
    }

    let streamUri: string | undefined;
    const uriRes = await soapRequest(
      mediaUrl,
      `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">
        <StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream><Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup>
        <ProfileToken>${escapeXml(profileToken)}</ProfileToken>
      </GetStreamUri>`,
      username,
      password,
      1400
    );
    if (uriRes.ok) {
      const uriMatch = uriRes.text.match(/<[^:]*:?Uri>([^<]+)<\/[^:]*:?Uri>/i);
      if (uriMatch) streamUri = uriMatch[1].replace(/&amp;/g, '&');
    }

    const profile: OnvifDeviceProfile = {
      ip,
      onvifPort: port,
      mediaUrl,
      ptzUrl,
      imagingUrl,
      profileToken,
      streamUri,
      manufacturer,
      model,
      ptzSupported: Boolean(ptzMatch),
      imagingSupported: Boolean(imagingMatch),
    };
    onvifCache.set(cacheKey, profile);
    return profile;
  }

  return null;
}

export async function moveOnvifOrCgiPtz(params: {
  ip: string;
  port?: number;
  onvifPort?: number;
  profileToken?: string;
  username?: string;
  password?: string;
  direction: 'up' | 'down' | 'left' | 'right' | 'stop';
  speed?: number;
  stepMs?: number;
}): Promise<{ ok: boolean; method?: string; error?: string }> {
  const { ip, port = 80, onvifPort, profileToken, username, password, direction, speed = 0.25, stepMs = 260 } = params;
  const clampedSpeed = Math.min(1, Math.max(0.08, Number(speed) || 0.25));
  const x = direction === 'left' ? -clampedSpeed : direction === 'right' ? clampedSpeed : 0;
  const y = direction === 'up' ? clampedSpeed : direction === 'down' ? -clampedSpeed : 0;

  const profile = await resolveOnvifProfile(ip, onvifPort || (port !== 554 ? port : undefined), username, password);
  const ptzUrl = profile?.ptzUrl || `http://${ip}:${onvifPort || (port === 554 ? 80 : port)}/onvif/ptz_service`;
  const token = profileToken || profile?.profileToken || 'Profile_1';

  const stopSoap = `<tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
    <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
    <tptz:PanTilt>true</tptz:PanTilt>
    <tptz:Zoom>false</tptz:Zoom>
  </tptz:Stop>`;

  if (direction === 'stop') {
    const res = await soapRequest(ptzUrl, stopSoap, username, password, 1200);
    if (res.ok) return { ok: true, method: 'onvif-stop' };
  } else {
    // 1. Prefer RelativeMove so a single press NEVER causes continuous spinning!
    const relX = direction === 'left' ? -clampedSpeed * 0.28 : direction === 'right' ? clampedSpeed * 0.28 : 0;
    const relY = direction === 'up' ? clampedSpeed * 0.28 : direction === 'down' ? -clampedSpeed * 0.28 : 0;
    const relSoap = `<tptz:RelativeMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
      <tptz:Translation><tt:PanTilt x="${relX.toFixed(3)}" y="${relY.toFixed(3)}" xmlns:tt="http://www.onvif.org/ver10/schema"/></tptz:Translation>
    </tptz:RelativeMove>`;
    const relRes = await soapRequest(ptzUrl, relSoap, username, password, 1200);
    if (relRes.ok) {
      return { ok: true, method: 'onvif-relative' };
    }

    // 2. Fallback to ContinuousMove WITH explicit short SOAP Timeout + immediate Stop timer
    const timeoutSec = Math.max(0.2, Math.min(0.6, stepMs / 1000)).toFixed(2);
    const contSoap = `<tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
      <tptz:Velocity><tt:PanTilt x="${x.toFixed(3)}" y="${y.toFixed(3)}" xmlns:tt="http://www.onvif.org/ver10/schema"/></tptz:Velocity>
      <tptz:Timeout>PT${timeoutSec}S</tptz:Timeout>
    </tptz:ContinuousMove>`;
    const contRes = await soapRequest(ptzUrl, contSoap, username, password, 1200);
    if (contRes.ok) {
      setTimeout(() => {
        soapRequest(ptzUrl, stopSoap, username, password, 1000).catch(() => {});
      }, Math.min(450, stepMs));
      return { ok: true, method: 'onvif-continuous-timed' };
    }
  }

  // 3. Vendor HTTP CGI PTZ fallbacks (Hikvision ISAPI, Dahua, Foscam/VStarcam)
  const httpPort = onvifPort || (port === 554 ? 80 : port);
  const dahuaCode = direction === 'up' ? 'Up' : direction === 'down' ? 'Down' : direction === 'left' ? 'Left' : 'Right';
  const foscamCmd = direction === 'stop' ? 1 : direction === 'up' ? 0 : direction === 'down' ? 2 : direction === 'left' ? 4 : 6;
  const cgiCandidates: Array<{ url: string; method?: string; body?: string }> = [
    {
      url: `http://${ip}:${httpPort}/cgi-bin/ptz.cgi?action=${direction === 'stop' ? 'stop' : 'start'}&channel=1&code=${dahuaCode}&arg1=0&arg2=${Math.max(1, Math.round(clampedSpeed * 8))}&arg3=0`,
    },
    {
      url: `http://${ip}:${httpPort}/decoder_control.cgi?command=${foscamCmd}&onestep=1`,
    },
    {
      url: `http://${ip}:${httpPort}/ISAPI/PTZCtrl/channels/1/continuous`,
      method: 'PUT',
      body: `<PTZData><pan>${Math.round(x * 100)}</pan><tilt>${Math.round(y * 100)}</tilt></PTZData>`,
    },
  ];

  for (const c of cgiCandidates) {
    try {
      const r = await fetchWithAuth(c.url, {
        method: c.method || 'GET',
        body: c.body,
        username,
        password,
        timeoutMs: 1200,
      });
      if (r.ok) {
        if (direction !== 'stop' && c.url.includes('ptz.cgi')) {
          setTimeout(() => {
            fetchWithAuth(
              `http://${ip}:${httpPort}/cgi-bin/ptz.cgi?action=stop&channel=1&code=${dahuaCode}&arg1=0&arg2=0&arg3=0`,
              { username, password, timeoutMs: 1000 }
            ).catch(() => {});
          }, Math.min(400, stepMs));
        }
        return { ok: true, method: 'http-cgi' };
      }
    } catch {
      // Try next CGI endpoint
    }
  }

  return {
    ok: false,
    error: 'La cámara no respondió a PTZ (verifica el puerto ONVIF/HTTP o credenciales).',
  };
}

export async function toggleCameraLight(params: {
  ip: string;
  port?: number;
  onvifPort?: number;
  username?: string;
  password?: string;
  on: boolean;
}): Promise<{ ok: boolean; method?: string; error?: string }> {
  const { ip, port = 80, onvifPort, username, password, on } = params;
  const httpPort = onvifPort || (port === 554 ? 80 : port);

  // 1. Try ONVIF Auxiliary Command (Spotlight / WhiteLight / Relay) & Imaging IR/Light
  const profile = await resolveOnvifProfile(ip, httpPort, username, password);
  if (profile) {
    const devUrl = `http://${ip}:${profile.onvifPort}/onvif/device_service`;
    const auxCommands = [
      `tt:Spotlight|${on ? 'On' : 'Off'}`,
      `tt:Light|${on ? 'On' : 'Off'}`,
      `tt:IRLamp|${on ? 'On' : 'Off'}`,
    ];
    for (const cmd of auxCommands) {
      const auxRes = await soapRequest(
        devUrl,
        `<SendAuxiliaryCommand xmlns="http://www.onvif.org/ver10/device/wsdl"><AuxiliaryCommand>${cmd}</AuxiliaryCommand></SendAuxiliaryCommand>`,
        username,
        password,
        1000
      );
      if (auxRes.ok) return { ok: true, method: `onvif-aux:${cmd}` };
    }
  }

  // 2. Try standard HTTP CGI spotlight / LED / IR endpoints across brands
  const val = on ? 255 : 0;
  const candidates: Array<{ url: string; method?: string; body?: string }> = [
    { url: `http://${ip}:${httpPort}/control?var=led_intensity&val=${val}` },
    { url: `http://${ip}:${httpPort}/led?state=${on ? 1 : 0}` },
    { url: `http://${ip}:${httpPort}/cgi-bin/hi3510/param.cgi?cmd=setinfrared&-infraredstat=${on ? 'open' : 'close'}` },
    { url: `http://${ip}:${httpPort}/cgi-bin/configManager.cgi?action=setConfig&Lighting[0][0].Mode=${on ? 'Manual' : 'Off'}` },
    { url: `http://${ip}:${httpPort}/cgi-bin/configManager.cgi?action=setConfig&Lighting_V2[0][0][0].Mode=${on ? 'Manual' : 'Off'}` },
    {
      url: `http://${ip}:${httpPort}/ISAPI/System/Hardware`,
      method: 'PUT',
      body: `<Hardware><supplementLight><enabled>${on ? 'true' : 'false'}</enabled></supplementLight></Hardware>`,
    },
    { url: `http://${ip}:${httpPort}/set_misc.cgi?led_mode=${on ? 1 : 0}` },
  ];

  for (const c of candidates) {
    try {
      const r = await fetchWithAuth(c.url, {
        method: c.method || 'GET',
        body: c.body,
        username,
        password,
        timeoutMs: 1200,
      });
      if (r.ok) {
        return { ok: true, method: c.url };
      }
    } catch {
      // Try next endpoint
    }
  }

  return {
    ok: false,
    error: 'La cámara no expone control remoto de linterna/LED o requiere credenciales.',
  };
}

export async function probeMediaStream(
  rtspOrHttpUrl: string
): Promise<{ ok: boolean; resolution?: string; fps?: number; hasAudio?: boolean; authError?: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
        '-of', 'json',
        rtspOrHttpUrl,
      ],
      { timeout: 4500 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }> =
      parsed.streams || [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!video && streams.length === 0) {
      return { ok: false, authError: (stderr || '').includes('401') };
    }
    let fps = 25;
    if (video?.r_frame_rate && video.r_frame_rate.includes('/')) {
      const [num, den] = video.r_frame_rate.split('/').map(Number);
      if (num > 0 && den > 0) fps = Math.round(num / den);
    }
    return {
      ok: true,
      resolution: video?.width && video?.height ? `${video.width}x${video.height}` : 'Auto',
      fps,
      hasAudio: Boolean(audio),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, authError: msg.includes('401') || msg.toLowerCase().includes('unauthorized') };
  }
}

export function discoverSsdpDevices(timeoutMs = 1100): Promise<Array<{ ip: string; port: number; server?: string; location?: string }>> {
  return new Promise((resolve) => {
    const found: Array<{ ip: string; port: number; server?: string; location?: string }> = [];
    const seen = new Set<string>();
    const interfaces = getAllLocalIPv4Addresses();
    const sockets: dgram.Socket[] = [];
    const ssdpMsg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 1\r\n' +
        'ST: ssdp:all\r\n\r\n'
    );

    const bindTargets = interfaces.length > 0 ? interfaces.map((i) => i.address) : [undefined];
    for (const bindIp of bindTargets) {
      const sock = dgram.createSocket('udp4');
      sockets.push(sock);
      sock.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8');
        const lower = text.toLowerCase();
        if (
          !lower.includes('camera') &&
          !lower.includes('ipcam') &&
          !lower.includes('onvif') &&
          !lower.includes('rtsp') &&
          !lower.includes('nvr') &&
          !lower.includes('dvr') &&
          !lower.includes('hikvision') &&
          !lower.includes('dahua') &&
          !lower.includes('axis') &&
          !lower.includes('reolink')
        ) {
          return;
        }
        if (seen.has(rinfo.address)) return;
        seen.add(rinfo.address);
        const locMatch = text.match(/LOCATION:\s*([^\r\n]+)/i);
        const srvMatch = text.match(/SERVER:\s*([^\r\n]+)/i);
        let port = 80;
        if (locMatch) {
          const pm = locMatch[1].match(/:(\d+)/);
          if (pm) port = Number(pm[1]);
        }
        found.push({
          ip: rinfo.address,
          port,
          location: locMatch?.[1]?.trim(),
          server: srvMatch?.[1]?.trim(),
        });
      });
      sock.on('error', () => {});
      sock.bind(0, bindIp, () => {
        try {
          sock.setBroadcast(true);
          sock.send(ssdpMsg, 0, ssdpMsg.length, 1900, '239.255.255.250');
        } catch {
          // Ignore send errors
        }
      });
    }

    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          // Ignore
        }
      }
      resolve(found);
    }, timeoutMs);
  });
}
