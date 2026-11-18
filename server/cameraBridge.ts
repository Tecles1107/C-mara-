import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodePcmToG711, extractPcm16Mono8k } from './rtspBackchannel.ts';

const execFileAsync = promisify(execFile);

export interface OnvifDeviceProfile {
  ip: string;
  onvifPort: number;
  mediaUrl?: string;
  ptzUrl?: string;
  imagingUrl?: string;
  profileToken?: string;
  videoSourceToken?: string;
  streamUri?: string;
  manufacturer?: string;
  model?: string;
  ptzSupported: boolean;
  imagingSupported: boolean;
  relayTokens?: string[];
}

export interface HardwareControlResult {
  ok: boolean;
  method?: string;
  attempts: string[];
  error?: string;
  authError?: boolean;
}

const onvifCache = new Map<string, OnvifDeviceProfile>();
const isapiTalkOpenCache = new Map<string, number>();

export function buildCandidateHttpPorts(
  port?: number,
  onvifPort?: number,
  openPorts?: number[]
): number[] {
  const rtspPorts = new Set([554, 8554, 10554, 34567, 37777]);
  const raw = [
    onvifPort,
    ...(openPorts || []),
    port && !rtspPorts.has(port) ? port : undefined,
    80,
    8000,
    8080,
    8899,
    81,
    5000,
  ];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const p of raw) {
    const num = Number(p);
    if (!Number.isInteger(num) || num <= 0 || num > 65535 || rtspPorts.has(num) || seen.has(num)) {
      continue;
    }
    seen.add(num);
    result.push(num);
  }
  return result;
}

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
    <Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-open-wss-wssecurity-secext-1.0.xsd">
      <UsernameToken>
        <Username>${escapeXml(username)}</Username>
        <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-open-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
        <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-open-wss-soap-message-security-1.0#Base64Binary">${nonceBytes.toString('base64')}</Nonce>
        <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-open-wss-wssecurity-utility-1.0.xsd">${created}</Created>
      </UsernameToken>
    </Security>
  </s:Header>`;
}

function buildWsSecurityStandardHeader(username?: string, password?: string): string {
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

function isValidCgiSuccessResponse(res: Response, bodyText: string): boolean {
  if (!res.ok) return false;
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const trimmed = bodyText.trim();
  const lower = trimmed.toLowerCase();

  // Reject HTML web pages / SPA fallbacks / router login pages served with HTTP 200
  if (
    contentType.includes('text/html') ||
    lower.startsWith('<!doctype') ||
    lower.startsWith('<html') ||
    lower.includes('<script') ||
    lower.includes('</head>')
  ) {
    return false;
  }

  // Reject explicit camera CGI / ISAPI failure payloads returned inside HTTP 200
  if (
    lower.includes('bad parameter') ||
    lower.includes('not support') ||
    lower.includes('unknown command') ||
    lower.includes('invalid operation') ||
    lower.includes('<statuscode>4</statuscode>') ||
    lower.includes('<statuscode>5</statuscode>') ||
    lower.includes('<statuscode>6</statuscode>') ||
    lower.startsWith('error')
  ) {
    return false;
  }

  return true;
}

async function soapRequest(
  url: string,
  bodyXml: string,
  username?: string,
  password?: string,
  timeoutMs = 1800
): Promise<{ ok: boolean; status: number; text: string }> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  ${buildWsSecurityStandardHeader(username, password)}
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
    const isFault = text.includes(':Fault>') || text.includes('<Fault>');
    const isSoapXml =
      text.includes(':Envelope') ||
      text.includes('<Envelope') ||
      text.includes(':Body') ||
      text.includes('<Body');
    const valid = res.ok && !isFault && isValidCgiSuccessResponse(res, text) && isSoapXml;
    return { ok: valid, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

// Unused alternate namespace retained only internally if needed
void buildWsSecurityHeader;

export async function resolveOnvifProfile(
  ip: string,
  preferredPort?: number,
  username?: string,
  password?: string,
  forceRefresh = false,
  extraPorts?: number[]
): Promise<OnvifDeviceProfile | null> {
  const cacheKey = `${ip}:${preferredPort || 'auto'}:${username || ''}`;
  if (!forceRefresh && onvifCache.has(cacheKey)) {
    return onvifCache.get(cacheKey)!;
  }

  const candidatePorts = buildCandidateHttpPorts(preferredPort, preferredPort, extraPorts).filter(
    (p) => p !== 81
  );
  if (!candidatePorts.includes(2020)) candidatePorts.push(2020);

  for (const port of candidatePorts.slice(0, 7)) {
    const deviceUrl = `http://${ip}:${port}/onvif/device_service`;
    const capRes = await soapRequest(
      deviceUrl,
      `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>`,
      username,
      password,
      1200
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
      1000
    );
    if (infoRes.ok) {
      manufacturer = infoRes.text.match(/<[^:]*:?Manufacturer>([^<]+)<\/[^:]*:?Manufacturer>/i)?.[1];
      model = infoRes.text.match(/<[^:]*:?Model>([^<]+)<\/[^:]*:?Model>/i)?.[1];
    }

    let profileToken = 'Profile_1';
    let videoSourceToken: string | undefined;
    const [profilesRes, videoSourcesRes, relayRes] = await Promise.all([
      soapRequest(mediaUrl, `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`, username, password, 1200),
      soapRequest(mediaUrl, `<GetVideoSources xmlns="http://www.onvif.org/ver10/media/wsdl"/>`, username, password, 1000),
      soapRequest(deviceUrl, `<GetRelayOutputs xmlns="http://www.onvif.org/ver10/device/wsdl"/>`, username, password, 1000),
    ]);

    if (profilesRes.ok) {
      const tokenMatch = profilesRes.text.match(/<[^:]*:?Profiles[^>]+token="([^"]+)"/i);
      if (tokenMatch) profileToken = tokenMatch[1];
      const srcTokenInProfile = profilesRes.text.match(/<[^:]*:?SourceToken>([^<]+)<\/[^:]*:?SourceToken>/i);
      if (srcTokenInProfile) videoSourceToken = srcTokenInProfile[1];
    }
    if (videoSourcesRes.ok && !videoSourceToken) {
      const vsMatch = videoSourcesRes.text.match(/<[^:]*:?VideoSources[^>]+token="([^"]+)"/i);
      if (vsMatch) videoSourceToken = vsMatch[1];
    }

    const relayTokens: string[] = [];
    if (relayRes.ok) {
      const matches = relayRes.text.matchAll(/<[^:]*:?RelayOutputs[^>]+token="([^"]+)"/gi);
      for (const m of matches) {
        if (m[1]) relayTokens.push(m[1]);
      }
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
      1200
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
      videoSourceToken: videoSourceToken || 'VideoSource_1',
      streamUri,
      manufacturer,
      model,
      ptzSupported: Boolean(ptzMatch),
      imagingSupported: Boolean(imagingMatch),
      relayTokens,
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
  openPorts?: number[];
  profileToken?: string;
  username?: string;
  password?: string;
  direction: 'up' | 'down' | 'left' | 'right' | 'stop';
  speed?: number;
  stepMs?: number;
}): Promise<{ ok: boolean; method?: string; error?: string; authError?: boolean }> {
  const { ip, port = 80, onvifPort, openPorts, profileToken, username, password, direction, speed = 0.25, stepMs = 260 } = params;
  const clampedSpeed = Math.min(1, Math.max(0.08, Number(speed) || 0.25));
  const x = direction === 'left' ? -clampedSpeed : direction === 'right' ? clampedSpeed : 0;
  const y = direction === 'up' ? clampedSpeed : direction === 'down' ? -clampedSpeed : 0;

  const profile = await resolveOnvifProfile(
    ip,
    onvifPort || (port !== 554 ? port : undefined),
    username,
    password,
    false,
    openPorts
  );
  const httpPorts = buildCandidateHttpPorts(port, profile?.onvifPort || onvifPort, openPorts);
  const ptzUrl = profile?.ptzUrl || `http://${ip}:${httpPorts[0] || 80}/onvif/ptz_service`;
  const token = profileToken || profile?.profileToken || 'Profile_1';

  const stopSoap = `<tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
    <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
    <tptz:PanTilt>true</tptz:PanTilt>
    <tptz:Zoom>false</tptz:Zoom>
  </tptz:Stop>`;

  let sawAuthError = false;

  if (direction === 'stop') {
    const res = await soapRequest(ptzUrl, stopSoap, username, password, 1200);
    if (res.status === 401) sawAuthError = true;
    if (res.ok) return { ok: true, method: 'onvif-stop' };
  } else {
    // 1. Prefer RelativeMove so a single press NEVER causes continuous spinning
    const relX = direction === 'left' ? -clampedSpeed * 0.28 : direction === 'right' ? clampedSpeed * 0.28 : 0;
    const relY = direction === 'up' ? clampedSpeed * 0.28 : direction === 'down' ? -clampedSpeed * 0.28 : 0;
    const relSoap = `<tptz:RelativeMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
      <tptz:Translation><tt:PanTilt x="${relX.toFixed(3)}" y="${relY.toFixed(3)}" xmlns:tt="http://www.onvif.org/ver10/schema"/></tptz:Translation>
    </tptz:RelativeMove>`;
    const relRes = await soapRequest(ptzUrl, relSoap, username, password, 1200);
    if (relRes.status === 401) sawAuthError = true;
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
    if (contRes.status === 401) sawAuthError = true;
    if (contRes.ok) {
      setTimeout(() => {
        soapRequest(ptzUrl, stopSoap, username, password, 1000).catch(() => {});
      }, Math.min(450, stepMs));
      return { ok: true, method: 'onvif-continuous-timed' };
    }
  }

  // 3. Vendor HTTP CGI PTZ fallbacks across candidate HTTP ports
  const dahuaCode = direction === 'up' ? 'Up' : direction === 'down' ? 'Down' : direction === 'left' ? 'Left' : 'Right';
  const foscamCmd = direction === 'stop' ? 1 : direction === 'up' ? 0 : direction === 'down' ? 2 : direction === 'left' ? 4 : 6;
  for (const httpPort of httpPorts.slice(0, 4)) {
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
          timeoutMs: 900,
        });
        if (r.status === 401) sawAuthError = true;
        const bodyText = r.ok ? await r.text().catch(() => '') : '';
        if (isValidCgiSuccessResponse(r, bodyText)) {
          if (direction !== 'stop' && c.url.includes('ptz.cgi')) {
            setTimeout(() => {
              fetchWithAuth(
                `http://${ip}:${httpPort}/cgi-bin/ptz.cgi?action=stop&channel=1&code=${dahuaCode}&arg1=0&arg2=0&arg3=0`,
                { username, password, timeoutMs: 900 }
              ).catch(() => {});
            }, Math.min(400, stepMs));
          }
          return { ok: true, method: `http-cgi:${httpPort}` };
        }
      } catch {
        // Try next
      }
    }
  }

  return {
    ok: false,
    authError: sawAuthError,
    error: sawAuthError
      ? 'La cámara rechazó las credenciales (HTTP 401) al mover PTZ.'
      : 'La cámara no respondió a PTZ (verifica puerto ONVIF/HTTP o soporte motorizado).',
  };
}

export async function toggleCameraLight(params: {
  ip: string;
  port?: number;
  onvifPort?: number;
  openPorts?: number[];
  username?: string;
  password?: string;
  on: boolean;
}): Promise<HardwareControlResult> {
  const { ip, port = 80, onvifPort, openPorts, username, password, on } = params;
  const httpPorts = buildCandidateHttpPorts(port, onvifPort, openPorts);
  const attempts: string[] = [];
  let sawAuthError = false;

  // 1. ONVIF: RelayOutputs, AuxiliaryCommand (WhiteLight/Spotlight/Light/FloodLight), Imaging WhiteLight
  const profile = await resolveOnvifProfile(ip, onvifPort || (port !== 554 ? port : undefined), username, password, false, openPorts);
  if (profile) {
    const devUrl = `http://${ip}:${profile.onvifPort}/onvif/device_service`;

    for (const relayToken of profile.relayTokens || []) {
      const relayRes = await soapRequest(
        devUrl,
        `<SetRelayOutputState xmlns="http://www.onvif.org/ver10/device/wsdl">
          <RelayOutputToken>${escapeXml(relayToken)}</RelayOutputToken>
          <LogicalState>${on ? 'active' : 'inactive'}</LogicalState>
        </SetRelayOutputState>`,
        username,
        password,
        1000
      );
      if (relayRes.status === 401) sawAuthError = true;
      attempts.push(`ONVIF Relay(${relayToken}):${relayRes.status || 'err'}`);
      if (relayRes.ok) {
        return { ok: true, method: `onvif-relay:${relayToken}`, attempts };
      }
    }

    const auxCommands = [
      `tt:WhiteLight|${on ? 'On' : 'Off'}`,
      `tt:Spotlight|${on ? 'On' : 'Off'}`,
      `tt:FloodLight|${on ? 'On' : 'Off'}`,
      `tt:Light|${on ? 'On' : 'Off'}`,
      `tt:IRLamp|${on ? 'On' : 'Off'}`,
    ];
    for (const cmd of auxCommands) {
      const auxRes = await soapRequest(
        devUrl,
        `<SendAuxiliaryCommand xmlns="http://www.onvif.org/ver10/device/wsdl"><AuxiliaryCommand>${cmd}</AuxiliaryCommand></SendAuxiliaryCommand>`,
        username,
        password,
        900
      );
      if (auxRes.status === 401) sawAuthError = true;
      attempts.push(`ONVIF Aux(${cmd}):${auxRes.status || 'err'}`);
      if (auxRes.ok) return { ok: true, method: `onvif-aux:${cmd}`, attempts };
    }

    if (profile.imagingUrl && profile.videoSourceToken) {
      const imgRes = await soapRequest(
        profile.imagingUrl,
        `<timg:SetImagingSettings xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl">
          <timg:VideoSourceToken>${escapeXml(profile.videoSourceToken)}</timg:VideoSourceToken>
          <timg:ImagingSettings>
            <tt:WhiteLight xmlns:tt="http://www.onvif.org/ver10/schema">${on ? 'ON' : 'OFF'}</tt:WhiteLight>
          </timg:ImagingSettings>
        </timg:SetImagingSettings>`,
        username,
        password,
        1000
      );
      if (imgRes.status === 401) sawAuthError = true;
      attempts.push(`ONVIF WhiteLight:${imgRes.status || 'err'}`);
      if (imgRes.ok) return { ok: true, method: 'onvif-imaging-whitelight', attempts };
    }
  } else {
    attempts.push(`ONVIF(sin respuesta en ${httpPorts.slice(0, 4).join(',')})`);
  }

  // 2. Multi-port vendor HTTP CGI spotlight / LED / Floodlight endpoints
  const val = on ? 255 : 0;
  for (const httpPort of httpPorts.slice(0, 5)) {
    const candidates: Array<{ label: string; url: string; method?: string; body?: string; headers?: Record<string, string> }> = [
      {
        label: 'ISAPI SupplementLight',
        url: `http://${ip}:${httpPort}/ISAPI/Image/channels/1/supplementLight`,
        method: 'PUT',
        headers: { 'Content-Type': 'application/xml' },
        body: `<SupplementLight><supplementLightMode>${on ? 'open' : 'close'}</supplementLightMode></SupplementLight>`,
      },
      {
        label: 'ISAPI Hardware Light',
        url: `http://${ip}:${httpPort}/ISAPI/System/Hardware`,
        method: 'PUT',
        headers: { 'Content-Type': 'application/xml' },
        body: `<Hardware><supplementLight><enabled>${on ? 'true' : 'false'}</enabled></supplementLight></Hardware>`,
      },
      {
        label: 'Dahua Lighting_V2',
        url: `http://${ip}:${httpPort}/cgi-bin/configManager.cgi?action=setConfig&Lighting_V2[0][0][0].Mode=${on ? 'Manual' : 'Off'}`,
      },
      {
        label: 'Dahua Lighting',
        url: `http://${ip}:${httpPort}/cgi-bin/configManager.cgi?action=setConfig&Lighting[0][0].Mode=${on ? 'Manual' : 'Off'}`,
      },
      {
        label: 'Hi3510 setlight',
        url: `http://${ip}:${httpPort}/cgi-bin/hi3510/param.cgi?cmd=setlight&-light=${on ? 1 : 0}`,
      },
      {
        label: 'Hi3510 setwhiteled',
        url: `http://${ip}:${httpPort}/cgi-bin/hi3510/param.cgi?cmd=setwhiteled&-state=${on ? 'open' : 'close'}`,
      },
      {
        label: 'Hi3510 setinfrared',
        url: `http://${ip}:${httpPort}/cgi-bin/hi3510/param.cgi?cmd=setinfrared&-infraredstat=${on ? 'open' : 'close'}`,
      },
      {
        label: 'Foscam WhiteLight',
        url: `http://${ip}:${httpPort}/cgi-bin/CGIProxy.fcgi?cmd=setWhiteLightState&state=${on ? 1 : 0}`,
      },
      {
        label: 'Generic set_misc LED',
        url: `http://${ip}:${httpPort}/set_misc.cgi?led_mode=${on ? 1 : 0}`,
      },
      {
        label: 'ESP32 LED PWM',
        url: `http://${ip}:${httpPort}/control?var=led_intensity&val=${val}`,
      },
      {
        label: 'HTTP LED',
        url: `http://${ip}:${httpPort}/led?state=${on ? 1 : 0}`,
      },
    ];

    const batchResults = await Promise.all(
      candidates.map(async (c) => {
        try {
          const r = await fetchWithAuth(c.url, {
            method: c.method || 'GET',
            headers: c.headers,
            body: c.body,
            username,
            password,
            timeoutMs: 850,
          });
          const txt = r.ok ? await r.text().catch(() => '') : '';
          const valid = isValidCgiSuccessResponse(r, txt);
          return { ...c, status: r.status, ok: valid, rejectedHtml: r.ok && !valid };
        } catch {
          return { ...c, status: 0, ok: false, rejectedHtml: false };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === 401) sawAuthError = true;
      if (r.status > 0) {
        attempts.push(
          `${r.label}(:${httpPort})->HTTP ${r.status}${r.rejectedHtml ? ' (HTML/no CGI)' : ''}`
        );
      }
      if (r.ok) {
        return { ok: true, method: `${r.label} (:${httpPort})`, attempts };
      }
    }
  }

  return {
    ok: false,
    attempts,
    authError: sawAuthError,
    error: sawAuthError
      ? `Credenciales rechazadas (HTTP 401) al intentar encender/apagar la luz en ${ip}.`
      : `La cámara (${ip}) no expuso interfaz compatible de luz/linterna en puertos ${httpPorts.slice(0, 5).join(', ')} (muchas cámaras Tuya/iCSee usan puerto propietario UDP/34567 sin CGI HTTP abierto).`,
  };
}

export async function setCameraIrMode(params: {
  ip: string;
  port?: number;
  onvifPort?: number;
  openPorts?: number[];
  username?: string;
  password?: string;
  mode: 'normal' | 'night' | 'auto';
}): Promise<HardwareControlResult & { mode: 'normal' | 'night' | 'auto' }> {
  const { ip, port = 80, onvifPort, openPorts, username, password, mode } = params;
  const httpPorts = buildCandidateHttpPorts(port, onvifPort, openPorts);
  const attempts: string[] = [];
  let sawAuthError = false;

  // ONVIF Spec: IrCutFilter ON = daylight (no IR night vision), OFF = night vision + IR LED, AUTO = automatic
  const onvifIrCut = mode === 'normal' ? 'ON' : mode === 'night' ? 'OFF' : 'AUTO';

  const profile = await resolveOnvifProfile(
    ip,
    onvifPort || (port !== 554 ? port : undefined),
    username,
    password,
    false,
    openPorts
  );

  if (profile) {
    if (profile.imagingUrl) {
      const srcToken = profile.videoSourceToken || 'VideoSource_1';
      const imgRes = await soapRequest(
        profile.imagingUrl,
        `<timg:SetImagingSettings xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl">
          <timg:VideoSourceToken>${escapeXml(srcToken)}</timg:VideoSourceToken>
          <timg:ImagingSettings>
            <tt:IrCutFilter xmlns:tt="http://www.onvif.org/ver10/schema">${onvifIrCut}</tt:IrCutFilter>
          </timg:ImagingSettings>
          <timg:ForcePersistence>true</timg:ForcePersistence>
        </timg:SetImagingSettings>`,
        username,
        password,
        1200
      );
      if (imgRes.status === 401) sawAuthError = true;
      attempts.push(`ONVIF IrCutFilter=${onvifIrCut}:${imgRes.status || 'err'}`);
      if (imgRes.ok) {
        return { ok: true, mode, method: `onvif-imaging:${onvifIrCut}`, attempts };
      }
    }

    const devUrl = `http://${ip}:${profile.onvifPort}/onvif/device_service`;
    const irAux = `tt:IRLamp|${mode === 'night' ? 'On' : mode === 'normal' ? 'Off' : 'Auto'}`;
    const auxRes = await soapRequest(
      devUrl,
      `<SendAuxiliaryCommand xmlns="http://www.onvif.org/ver10/device/wsdl"><AuxiliaryCommand>${irAux}</AuxiliaryCommand></SendAuxiliaryCommand>`,
      username,
      password,
      900
    );
    if (auxRes.status === 401) sawAuthError = true;
    attempts.push(`ONVIF Aux(${irAux}):${auxRes.status || 'err'}`);
    if (auxRes.ok) {
      return { ok: true, mode, method: `onvif-aux:${irAux}`, attempts };
    }
  } else {
    attempts.push(`ONVIF(sin respuesta en ${httpPorts.slice(0, 4).join(',')})`);
  }

  for (const httpPort of httpPorts.slice(0, 5)) {
    const candidates: Array<{ label: string; url: string; method?: string; body?: string; headers?: Record<string, string> }> = [
      {
        label: 'ISAPI IrcutFilter',
        url: `http://${ip}:${httpPort}/ISAPI/Image/channels/1/ircutFilter`,
        method: 'PUT',
        headers: { 'Content-Type': 'application/xml' },
        body: `<IrcutFilter><IrcutFilterType>${mode === 'normal' ? 'day' : mode === 'night' ? 'night' : 'auto'}</IrcutFilterType></IrcutFilter>`,
      },
      {
        label: 'Dahua VideoInDayNight',
        url: `http://${ip}:${httpPort}/cgi-bin/configManager.cgi?action=setConfig&VideoInDayNight[0][0].Mode=${mode === 'normal' ? 'Color' : mode === 'night' ? 'BlackWhite' : 'Brightness'}`,
      },
      {
        label: 'Dahua DayNightColor',
        url: `http://${ip}:${httpPort}/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[0].DayNightColor=${mode === 'normal' ? 1 : mode === 'night' ? 2 : 0}`,
      },
      {
        label: 'Hi3510 setinfrared',
        url: `http://${ip}:${httpPort}/cgi-bin/hi3510/param.cgi?cmd=setinfrared&-infraredstat=${mode === 'normal' ? 'close' : mode === 'night' ? 'open' : 'auto'}`,
      },
      {
        label: 'Foscam InfraLed',
        url: `http://${ip}:${httpPort}/cgi-bin/CGIProxy.fcgi?cmd=setInfraLedConfig&mode=${mode === 'auto' ? 0 : 1}`,
      },
    ];

    if (mode !== 'auto') {
      candidates.push({
        label: 'Generic Decoder IR',
        url: `http://${ip}:${httpPort}/decoder_control.cgi?command=${mode === 'night' ? 95 : 94}`,
      });
    }

    const batchResults = await Promise.all(
      candidates.map(async (c) => {
        try {
          const r = await fetchWithAuth(c.url, {
            method: c.method || 'GET',
            headers: c.headers,
            body: c.body,
            username,
            password,
            timeoutMs: 900,
          });
          const txt = r.ok ? await r.text().catch(() => '') : '';
          const valid = isValidCgiSuccessResponse(r, txt);
          return { ...c, status: r.status, ok: valid, rejectedHtml: r.ok && !valid };
        } catch {
          return { ...c, status: 0, ok: false, rejectedHtml: false };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === 401) sawAuthError = true;
      if (r.status > 0) {
        attempts.push(
          `${r.label}(:${httpPort})->HTTP ${r.status}${r.rejectedHtml ? ' (HTML/no CGI)' : ''}`
        );
      }
      if (r.ok) {
        return { ok: true, mode, method: `${r.label} (:${httpPort})`, attempts };
      }
    }
  }

  return {
    ok: false,
    mode,
    attempts,
    authError: sawAuthError,
    error: sawAuthError
      ? `Credenciales rechazadas (HTTP 401) al cambiar filtro IR / visión nocturna en ${ip}.`
      : `La cámara (${ip}) no confirmó el cambio de infrarrojo por ONVIF/CGI; se aplicó el modo visual en pantalla.`,
  };
}

export async function sendHttpTwoWayAudio(params: {
  ip: string;
  port?: number;
  onvifPort?: number;
  openPorts?: number[];
  username?: string;
  password?: string;
  audioBuffer: Buffer;
  mimeType?: string;
}): Promise<HardwareControlResult> {
  const { ip, port = 80, onvifPort, openPorts, username, password, audioBuffer, mimeType = 'audio/wav' } = params;
  const httpPorts = buildCandidateHttpPorts(port, onvifPort, openPorts);
  const attempts: string[] = [];
  let sawAuthError = false;

  const pcm8k = extractPcm16Mono8k(audioBuffer);
  const g711ulaw = pcm8k.length > 0 ? encodePcmToG711(pcm8k, 'PCMU') : audioBuffer;
  const g711alaw = pcm8k.length > 0 ? encodePcmToG711(pcm8k, 'PCMA') : audioBuffer;

  for (const httpPort of httpPorts.slice(0, 4)) {
    // 1. Hikvision ISAPI requires opening the TwoWayAudio channel BEFORE sending /audioData
    const openKey = `${ip}:${httpPort}`;
    const lastOpened = isapiTalkOpenCache.get(openKey) || 0;
    if (Date.now() - lastOpened > 12000) {
      try {
        const openRes = await fetchWithAuth(
          `http://${ip}:${httpPort}/ISAPI/System/TwoWayAudio/channels/1/open`,
          {
            method: 'PUT',
            username,
            password,
            timeoutMs: 900,
          }
        );
        if (openRes.status === 401) sawAuthError = true;
        const openTxt = openRes.ok ? await openRes.text().catch(() => '') : '';
        const openValid = isValidCgiSuccessResponse(openRes, openTxt);
        if (openRes.status > 0) attempts.push(`ISAPI open(:${httpPort})->HTTP ${openRes.status}${openRes.ok && !openValid ? ' (HTML)' : ''}`);
        if (openValid) {
          isapiTalkOpenCache.set(openKey, Date.now());
        }
      } catch {
        // Not ISAPI
      }
    }

    try {
      const dataRes = await fetchWithAuth(
        `http://${ip}:${httpPort}/ISAPI/System/TwoWayAudio/channels/1/audioData`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(g711ulaw),
          username,
          password,
          timeoutMs: 1200,
        }
      );
      if (dataRes.status === 401) sawAuthError = true;
      const dataTxt = dataRes.ok ? await dataRes.text().catch(() => '') : '';
      const dataValid = isValidCgiSuccessResponse(dataRes, dataTxt);
      if (dataRes.status > 0) attempts.push(`ISAPI audioData(:${httpPort})->HTTP ${dataRes.status}${dataRes.ok && !dataValid ? ' (HTML)' : ''}`);
      if (dataValid) {
        isapiTalkOpenCache.set(openKey, Date.now());
        return { ok: true, method: `isapi-twoway:${httpPort}`, attempts };
      }
    } catch {
      // Try next
    }

    // 2. Dahua HTTP Audio Post
    try {
      const dahuaRes = await fetchWithAuth(
        `http://${ip}:${httpPort}/cgi-bin/audio.cgi?action=postAudio&httptype=singlepart&channel=1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'Audio/G.711A' },
          body: new Uint8Array(g711alaw),
          username,
          password,
          timeoutMs: 1200,
        }
      );
      if (dahuaRes.status === 401) sawAuthError = true;
      const dahuaTxt = dahuaRes.ok ? await dahuaRes.text().catch(() => '') : '';
      const dahuaValid = isValidCgiSuccessResponse(dahuaRes, dahuaTxt);
      if (dahuaRes.status > 0) attempts.push(`Dahua audio.cgi(:${httpPort})->HTTP ${dahuaRes.status}${dahuaRes.ok && !dahuaValid ? ' (HTML)' : ''}`);
      if (dahuaValid) {
        return { ok: true, method: `dahua-audio:${httpPort}`, attempts };
      }
    } catch {
      // Try next
    }

    // 3. Hi3510 / CamHi HTTP talk.cgi
    try {
      const hiRes = await fetchWithAuth(`http://${ip}:${httpPort}/cgi-bin/hi3510/talk.cgi`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: new Uint8Array(g711ulaw),
        username,
        password,
        timeoutMs: 1100,
      });
      if (hiRes.status === 401) sawAuthError = true;
      const hiTxt = hiRes.ok ? await hiRes.text().catch(() => '') : '';
      const hiValid = isValidCgiSuccessResponse(hiRes, hiTxt);
      if (hiRes.status > 0) attempts.push(`Hi3510 talk.cgi(:${httpPort})->HTTP ${hiRes.status}${hiRes.ok && !hiValid ? ' (HTML)' : ''}`);
      if (hiValid) {
        return { ok: true, method: `hi3510-talk:${httpPort}`, attempts };
      }
    } catch {
      // Try next
    }
  }

  return {
    ok: false,
    attempts,
    authError: sawAuthError,
    error: sawAuthError
      ? 'Credenciales rechazadas (HTTP 401) para audio bidireccional HTTP.'
      : 'Ningún endpoint HTTP de audio bidireccional respondió en la cámara.',
  };
}

export async function probeMediaStream(
  rtspOrHttpUrl: string
): Promise<{ ok: boolean; resolution?: string; fps?: number; hasAudio?: boolean; audioCodec?: string; authError?: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate',
        '-of', 'json',
        rtspOrHttpUrl,
      ],
      { timeout: 4500 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }> =
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
      audioCodec: audio?.codec_name,
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
          // Ignore
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

export async function discoverArpNeighbors(): Promise<Array<{ ip: string; mac?: string }>> {
  const results: Array<{ ip: string; mac?: string }> = [];
  const seen = new Set<string>();
  const localIps = new Set(getAllLocalIPv4Addresses().map((i) => i.address));

  const addIfValid = (ip: string, mac?: string) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
    if (localIps.has(ip) || seen.has(ip)) return;
    const octets = ip.split('.').map(Number);
    if (
      octets[0] === 127 ||
      octets[0] >= 224 ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[3] === 0 ||
      octets[3] === 255
    ) {
      return;
    }
    seen.add(ip);
    results.push({ ip, mac });
  };

  try {
    const { stdout } = await execFileAsync('ip', ['neigh', 'show'], { timeout: 1000 });
    for (const line of stdout.split('\n')) {
      if (line.includes('FAILED') || line.includes('INCOMPLETE')) continue;
      const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+(?:\s+lladdr\s+([0-9a-f:]+))?/i);
      if (m) addIfValid(m[1], m[2]);
    }
  } catch {
    // Fallback to /proc/net/arp
  }

  try {
    const arpText = await fs.readFile('/proc/net/arp', 'utf8');
    for (const line of arpText.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 4 && cols[2] !== '0x0' && cols[3] !== '00:00:00:00:00:00') {
        addIfValid(cols[0], cols[3]);
      }
    }
  } catch {
    // Ignore on non-Linux
  }

  return results;
}

function encodeDnsName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from([buf.length]), buf);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function buildMdnsPtrQuery(service: string): Buffer {
  const header = Buffer.from([
    0x00, 0x00, // ID
    0x00, 0x00, // Flags (standard query)
    0x00, 0x01, // QDCOUNT = 1
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const qname = encodeDnsName(service);
  const qtypeClass = Buffer.from([0x00, 0x0c, 0x00, 0x01]); // PTR, IN
  return Buffer.concat([header, qname, qtypeClass]);
}

export function discoverMdnsCameras(timeoutMs = 1100): Promise<Array<{ ip: string; port: number; serviceName: string }>> {
  return new Promise((resolve) => {
    const found: Array<{ ip: string; port: number; serviceName: string }> = [];
    const seen = new Set<string>();
    const interfaces = getAllLocalIPv4Addresses();
    const sockets: dgram.Socket[] = [];
    const queries = [
      buildMdnsPtrQuery('_rtsp._tcp.local'),
      buildMdnsPtrQuery('_onvif._tcp.local'),
      buildMdnsPtrQuery('_http._tcp.local'),
    ];

    const bindTargets = interfaces.length > 0 ? interfaces.map((i) => i.address) : [undefined];
    for (const bindIp of bindTargets) {
      const sock = dgram.createSocket('udp4');
      sockets.push(sock);
      sock.on('message', (msg, rinfo) => {
        if (seen.has(rinfo.address)) return;
        const ascii = msg.toString('latin1').replace(/[^\x20-\x7e]/g, ' ').toLowerCase();
        const isCamLike =
          ascii.includes('rtsp') ||
          ascii.includes('onvif') ||
          ascii.includes('cam') ||
          ascii.includes('nvr') ||
          ascii.includes('hikvision') ||
          ascii.includes('dahua') ||
          ascii.includes('axis') ||
          ascii.includes('esp');
        if (!isCamLike) return;
        seen.add(rinfo.address);
        const port = ascii.includes('rtsp') ? 554 : 80;
        found.push({
          ip: rinfo.address,
          port,
          serviceName: ascii.includes('rtsp') ? 'mDNS RTSP' : ascii.includes('onvif') ? 'mDNS ONVIF' : 'mDNS HTTP Cam',
        });
      });
      sock.on('error', () => {});
      sock.bind(0, bindIp, () => {
        try {
          sock.setBroadcast(true);
          for (const q of queries) {
            sock.send(q, 0, q.length, 5353, '224.0.0.251');
          }
        } catch {
          // Ignore
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

export function discoverVendorUdpCameras(timeoutMs = 1100): Promise<Array<{ ip: string; port: number; vendor: string; protocol: 'RTSP' | 'ONVIF' }>> {
  return new Promise((resolve) => {
    const found: Array<{ ip: string; port: number; vendor: string; protocol: 'RTSP' | 'ONVIF' }> = [];
    const seen = new Set<string>();
    const interfaces = getAllLocalIPv4Addresses();
    const sockets: dgram.Socket[] = [];

    // 1. XMeye / iCSee / Xiongmai NetIP UDP 34569 search packet (20-byte header)
    const xmeyeProbe = Buffer.from([
      0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfa, 0x05,
      0x00, 0x00, 0x00, 0x00,
    ]);
    // 2. Dahua UDP 37810 discovery header
    const dahuaProbe = Buffer.from('DHDiscover\x00\x00\x00\x00\x00\x00', 'latin1');
    // 3. Hikvision SADP UDP 37020 inquiry XML
    const hikProbe = Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${crypto.randomUUID()}</Uuid><Types>inquiry</Types></Probe>`,
      'utf8'
    );

    const bindTargets = interfaces.length > 0 ? interfaces : [{ address: '0.0.0.0', subnet: '255.255.255' }];
    for (const iface of bindTargets) {
      const sock = dgram.createSocket('udp4');
      sockets.push(sock);
      sock.on('message', (msg, rinfo) => {
        if (seen.has(rinfo.address)) return;
        seen.add(rinfo.address);
        const txt = msg.toString('utf8');
        let vendor = 'Cámara IP';
        if (txt.includes('ProbeMatch') || txt.includes('DeviceType')) {
          vendor = 'Hikvision SADP';
        } else if (txt.includes('HostIP') || txt.includes('NetIP') || rinfo.port === 34569) {
          vendor = 'XMeye / iCSee';
        } else if (txt.includes('DH') || rinfo.port === 37810) {
          vendor = 'Dahua / Amcrest';
        }
        found.push({
          ip: rinfo.address,
          port: 554,
          vendor,
          protocol: 'ONVIF',
        });
      });
      sock.on('error', () => {});
      sock.bind(0, iface.address === '0.0.0.0' ? undefined : iface.address, () => {
        try {
          sock.setBroadcast(true);
          const bcast = iface.subnet === '255.255.255' ? '255.255.255.255' : `${iface.subnet}.255`;
          sock.send(xmeyeProbe, 0, xmeyeProbe.length, 34569, bcast);
          sock.send(xmeyeProbe, 0, xmeyeProbe.length, 34569, '255.255.255.255');
          sock.send(dahuaProbe, 0, dahuaProbe.length, 37810, bcast);
          sock.send(dahuaProbe, 0, dahuaProbe.length, 37810, '255.255.255.255');
          sock.send(hikProbe, 0, hikProbe.length, 37020, '239.255.255.250');
        } catch {
          // Ignore broadcast socket errors
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

export interface NearbyWifiNetwork {
  ssid: string;
  bssid?: string;
  signal?: number;
  frequency?: string;
  hidden: boolean;
  cameraLikely: boolean;
  source: string;
}

export interface RouteVpnDiscoveryResult {
  subnets: string[];
  vpnHosts: Array<{ ip: string; name?: string; source: 'tailscale' | 'route' }>;
  gateways: string[];
  routesSummary: string[];
}

export const COMMON_OUT_OF_NETWORK_CAMERA_IPS: string[] = [
  // Camera Wi-Fi AP & hotspot defaults (ESP32-CAM, V380, HDWiFiCam, Android/Wi-Fi Direct)
  '192.168.4.1',
  '192.168.4.2',
  '192.168.10.1',
  '192.168.42.1',
  '192.168.43.1',
  '192.168.49.1',
  '192.168.137.1',
  '192.168.169.1',
  '10.10.10.1',
  '10.10.0.1',
  '172.16.0.1',
  '172.20.10.1',
  // Common factory static defaults (Hikvision, Dahua, Reolink, Foscam, XMeye)
  '192.168.1.64',
  '192.168.1.108',
  '192.168.1.10',
  '192.168.1.100',
  '192.168.1.200',
  '192.168.0.64',
  '192.168.0.108',
  '192.168.0.100',
  '192.168.0.120',
];

export function isCameraLikeSsid(ssid: string): boolean {
  const lower = (ssid || '').toLowerCase();
  if (!lower) return false;
  return /(ipc|ipcam|cam|camera|v380|icsee|xmeye|tuya|smartlife|hik|dahua|reolink|esp|ezviz|tapo|imou|hdwifi|mv\d|yi_|ap_|wifi[-_]?cam)/i.test(
    lower
  );
}

export async function discoverNearbyWifiNetworks(): Promise<NearbyWifiNetwork[]> {
  const found: NearbyWifiNetwork[] = [];
  const seen = new Set<string>();

  const pushNet = (net: NearbyWifiNetwork) => {
    const key = net.bssid ? `${net.bssid}` : `${net.ssid}:${net.frequency || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(net);
  };

  // 1. Termux API (Android)
  try {
    const { stdout } = await execFileAsync('termux-wifi-scaninfo', [], { timeout: 2500 });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const ssid = typeof item.ssid === 'string' ? item.ssid.trim() : '';
        const hidden = !ssid || ssid === '<unknown ssid>';
        pushNet({
          ssid: hidden ? 'Red Wi-Fi Oculta' : ssid,
          bssid: typeof item.bssid === 'string' ? item.bssid : undefined,
          signal: typeof item.rssi === 'number' ? item.rssi : undefined,
          frequency: item.frequency_mhz ? `${item.frequency_mhz} MHz` : undefined,
          hidden,
          cameraLikely: hidden || isCameraLikeSsid(ssid),
          source: 'termux-wifi',
        });
      }
    }
  } catch {
    // termux-wifi-scaninfo unavailable
  }

  // 2. NetworkManager nmcli (Linux)
  if (found.length === 0) {
    try {
      const { stdout } = await execFileAsync(
        'nmcli',
        ['-t', '-f', 'SSID,BSSID,SIGNAL,FREQ', 'dev', 'wifi', 'list'],
        { timeout: 2500 }
      );
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        // nmcli -t escapes ':' inside BSSID as '\:'
        const parts = line.replace(/\\:/g, '|').split(':');
        if (parts.length < 2) continue;
        const rawSsid = (parts[0] || '').trim();
        const bssid = (parts[1] || '').replace(/\|/g, ':').trim() || undefined;
        const signal = parts[2] ? Number(parts[2]) : undefined;
        const freq = parts[3]?.trim() || undefined;
        const hidden = !rawSsid || rawSsid === '--';
        pushNet({
          ssid: hidden ? 'Red Wi-Fi Oculta' : rawSsid,
          bssid,
          signal: Number.isFinite(signal) ? signal : undefined,
          frequency: freq,
          hidden,
          cameraLikely: hidden || isCameraLikeSsid(rawSsid),
          source: 'nmcli',
        });
      }
    } catch {
      // nmcli unavailable
    }
  }

  // 3. Sort camera-like and hidden APs first, then strongest signal
  return found.sort((a, b) => {
    if (a.cameraLikely !== b.cameraLikely) return a.cameraLikely ? -1 : 1;
    if (a.hidden !== b.hidden) return a.hidden ? -1 : 1;
    return (b.signal ?? -100) - (a.signal ?? -100);
  });
}

export async function discoverRouteAndVpnTargets(): Promise<RouteVpnDiscoveryResult> {
  const localIps = new Set(getAllLocalIPv4Addresses().map((i) => i.address));
  const localSubnets = new Set(getAllLocalIPv4Addresses().map((i) => i.subnet));
  const externalSubnets = new Set<string>();
  const gateways = new Set<string>();
  const vpnHosts: Array<{ ip: string; name?: string; source: 'tailscale' | 'route' }> = [];
  const seenHosts = new Set<string>();
  const routesSummary: string[] = [];

  const addHost = (ip: string, source: 'tailscale' | 'route', name?: string) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || localIps.has(ip) || seenHosts.has(ip)) return;
    const octets = ip.split('.').map(Number);
    if (octets[0] === 127 || octets[0] >= 224 || octets[3] === 0 || octets[3] === 255) return;
    seenHosts.add(ip);
    vpnHosts.push({ ip, name, source });
  };

  // 1. Parse Linux / Android routing table (`ip route show`)
  try {
    const { stdout } = await execFileAsync('ip', ['route', 'show'], { timeout: 1500 });
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      routesSummary.push(trimmed);

      const viaMatch = trimmed.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
      if (viaMatch) {
        gateways.add(viaMatch[1]);
        addHost(viaMatch[1], 'route', 'Gateway / Router');
      }

      const cidrMatch = trimmed.match(/^(\d+\.\d+\.\d+)\.0\/(24|16|23|22|20|10)\b/);
      if (cidrMatch) {
        const subnet = cidrMatch[1];
        if (!subnet.startsWith('127.') && !subnet.startsWith('169.254.') && !localSubnets.has(subnet)) {
          externalSubnets.add(subnet);
        }
      }
    }
  } catch {
    // Fallback to /proc/net/route
    try {
      const routeText = await fs.readFile('/proc/net/route', 'utf8');
      for (const line of routeText.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 3) continue;
        const hexDest = cols[1];
        const hexGw = cols[2];
        if (hexGw && hexGw !== '00000000' && hexGw.length === 8) {
          const gw = [
            parseInt(hexGw.slice(6, 8), 16),
            parseInt(hexGw.slice(4, 6), 16),
            parseInt(hexGw.slice(2, 4), 16),
            parseInt(hexGw.slice(0, 2), 16),
          ].join('.');
          gateways.add(gw);
          addHost(gw, 'route', 'Gateway');
        }
        if (hexDest && hexDest !== '00000000' && hexDest.length === 8) {
          const b0 = parseInt(hexDest.slice(6, 8), 16);
          const b1 = parseInt(hexDest.slice(4, 6), 16);
          const b2 = parseInt(hexDest.slice(2, 4), 16);
          const subnet = `${b0}.${b1}.${b2}`;
          if (b0 !== 127 && b0 < 224 && !(b0 === 169 && b1 === 254) && !localSubnets.has(subnet)) {
            externalSubnets.add(subnet);
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // 2. Parse Tailscale Mesh VPN peers (`tailscale status --json`)
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 2000 });
    const parsed = JSON.parse(stdout);
    const peers = parsed?.Peer ? Object.values(parsed.Peer) : [];
    for (const peer of peers as Array<{ TailscaleIPs?: string[]; HostName?: string; Online?: boolean }>) {
      if (peer.Online === false) continue;
      for (const ip of peer.TailscaleIPs || []) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          addHost(ip, 'tailscale', peer.HostName || 'Tailscale Peer');
        }
      }
    }
  } catch {
    // Tailscale not installed or not running
  }

  return {
    subnets: Array.from(externalSubnets),
    vpnHosts,
    gateways: Array.from(gateways),
    routesSummary: routesSummary.slice(0, 10),
  };
}
