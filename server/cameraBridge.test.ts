import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  COMMON_OUT_OF_NETWORK_CAMERA_IPS,
  buildCandidateHttpPorts,
  discoverRouteAndVpnTargets,
  isCameraLikeSsid,
  sendHttpTwoWayAudio,
  setCameraIrMode,
  toggleCameraLight,
} from './cameraBridge.ts';
import { DiagnosticsManager } from './diagnosticsManager.ts';

test('buildCandidateHttpPorts prioritizes onvifPort and openPorts while excluding RTSP ports', () => {
  const ports = buildCandidateHttpPorts(554, 8899, [554, 8080, 80, 8554, 34567]);
  assert.equal(ports[0], 8899);
  assert.ok(ports.includes(8080));
  assert.ok(ports.includes(80));
  assert.equal(ports.includes(554), false);
  assert.equal(ports.includes(8554), false);
  assert.equal(ports.includes(34567), false);
  assert.equal(new Set(ports).size, ports.length);
});

test('toggleCameraLight and setCameraIrMode succeed against real HTTP CGI server on openPorts', async () => {
  const seenUrls: string[] = [];
  const server = http.createServer((req, res) => {
    seenUrls.push(`${req.method} ${req.url}`);
    if (req.url?.includes('setlight') || req.url?.includes('setinfrared')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('[Success]');
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const lightRes = await toggleCameraLight({
      ip: '127.0.0.1',
      port: 554,
      openPorts: [554, port],
      on: true,
    });
    assert.equal(lightRes.ok, true);
    assert.ok(lightRes.method?.includes(String(port)));

    const irRes = await setCameraIrMode({
      ip: '127.0.0.1',
      port: 554,
      openPorts: [554, port],
      mode: 'night',
    });
    assert.equal(irRes.ok, true);
    assert.equal(irRes.mode, 'night');
    assert.ok(seenUrls.some((u) => u.includes('setinfrared&-infraredstat=open')));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('sendHttpTwoWayAudio opens Hikvision ISAPI channel before sending audioData', async () => {
  const callOrder: string[] = [];
  let receivedAudioBytes = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/ISAPI/System/TwoWayAudio/channels/1/open') {
        callOrder.push('open');
        res.writeHead(200);
        res.end('<ResponseStatus/>');
        return;
      }
      if (req.url === '/ISAPI/System/TwoWayAudio/channels/1/audioData') {
        callOrder.push('audioData');
        receivedAudioBytes = Buffer.concat(chunks).length;
        if (!callOrder.includes('open')) {
          res.writeHead(403);
          res.end('Channel not opened');
          return;
        }
        res.writeHead(200);
        res.end('<ResponseStatus/>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const pcm = Buffer.alloc(640);
    const result = await sendHttpTwoWayAudio({
      ip: '127.0.0.1',
      port: 554,
      openPorts: [port],
      audioBuffer: pcm,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(callOrder, ['open', 'audioData']);
    assert.equal(receivedAudioBytes, 160); // 640 bytes @16kHz PCM16 -> 320 samples -> 160 samples @8kHz G.711
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('DiagnosticsManager records, filters by IP, caps ring buffer, and clears samples', () => {
  const dm = new DiagnosticsManager();
  dm.recordSample({
    ip: '192.168.1.50',
    feature: 'talk',
    status: 'error',
    code: 401,
    reason: 'Unauthorized',
  });
  dm.recordSample({
    ip: '192.168.1.51',
    feature: 'light',
    status: 'ok',
    reason: 'Switched ON',
  });

  assert.equal(dm.listSamples().length, 2);
  assert.equal(dm.listSamples('192.168.1.50').length, 1);
  assert.equal(dm.listSamples('192.168.1.50')[0].code, 401);

  dm.clearSamples();
  assert.equal(dm.listSamples().length, 0);
});

test('toggleCameraLight and setCameraIrMode reject HTTP 200 HTML fallback pages', async () => {
  const htmlServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>Login Page</body></html>');
  });

  await new Promise<void>((resolve) => htmlServer.listen(0, '127.0.0.1', resolve));
  const port = (htmlServer.address() as AddressInfo).port;

  try {
    const lightRes = await toggleCameraLight({
      ip: '127.0.0.1',
      port: 554,
      openPorts: [port],
      on: true,
    });
    assert.equal(lightRes.ok, false);
    assert.ok(lightRes.attempts.some((a) => a.includes('(HTML/no CGI)')));

    const irRes = await setCameraIrMode({
      ip: '127.0.0.1',
      port: 554,
      openPorts: [port],
      mode: 'night',
    });
    assert.equal(irRes.ok, false);
    assert.ok(irRes.attempts.some((a) => a.includes('(HTML/no CGI)')));
  } finally {
    await new Promise<void>((resolve) => htmlServer.close(() => resolve()));
  }
});

test('isCameraLikeSsid detects common IP camera AP names and discoverRouteAndVpnTargets resolves cleanly', async () => {
  assert.equal(isCameraLikeSsid('V380_AP_9482'), true);
  assert.equal(isCameraLikeSsid('ESP32-CAM-AP'), true);
  assert.equal(isCameraLikeSsid('IPC_55312'), true);
  assert.equal(isCameraLikeSsid('Casa_WiFi_5G'), false);

  assert.ok(COMMON_OUT_OF_NETWORK_CAMERA_IPS.includes('192.168.4.1'));
  assert.ok(COMMON_OUT_OF_NETWORK_CAMERA_IPS.includes('192.168.1.64'));

  const routes = await discoverRouteAndVpnTargets();
  assert.ok(Array.isArray(routes.subnets));
  assert.ok(Array.isArray(routes.vpnHosts));
  assert.ok(Array.isArray(routes.gateways));
});

