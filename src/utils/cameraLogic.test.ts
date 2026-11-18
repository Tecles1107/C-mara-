import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOTION_CONFIG,
  buildStreamUrl,
  resolveEffectiveEndpoint,
  mergeCameraLists,
  parseSubnetInputs,
  parseExternalScanTargets,
  classifyStreamFailure,
  filterCameras,
  clampZoomPan,
  calculateMotionScore,
  shouldTriggerMotionAlert,
  formatDuration,
  formatBytes,
  buildTermuxScript,
} from './cameraLogic';

const TEST_CAMERAS = [
  {
    id: 'cam-01',
    name: 'Acceso',
    ip: '192.168.1.104',
    port: 554,
    protocol: 'RTSP' as const,
    streamPath: '/live',
    status: 'online' as const,
    resolution: '1080p',
    fps: 30,
    hasAudio: true,
    location: 'Norte',
    nightVision: false,
    manufacturer: 'Hikvision',
    capabilities: { ptz: true, audio: true, light: false, twoWayAudio: false },
  },
  {
    id: 'cam-02',
    name: 'Jardín',
    ip: '192.168.1.115',
    port: 8080,
    protocol: 'MJPEG' as const,
    streamPath: '/video',
    status: 'online' as const,
    resolution: '720p',
    fps: 20,
    hasAudio: false,
    location: 'Patio',
    nightVision: true,
    manufacturer: 'ESP32',
    capabilities: { ptz: false, audio: false, light: true, twoWayAudio: false },
  },
  {
    id: 'cam-03',
    name: 'Taller',
    ip: '192.168.1.140',
    port: 81,
    protocol: 'MJPEG' as const,
    streamPath: '/stream',
    status: 'offline' as const,
    resolution: '600p',
    fps: 15,
    hasAudio: false,
    location: 'Taller',
    nightVision: false,
  },
];

test('buildStreamUrl embeds credentials and resolves remote endpoints when active', () => {
  assert.equal(buildStreamUrl(TEST_CAMERAS[0]), 'rtsp://192.168.1.104:554/live');
  assert.equal(
    buildStreamUrl({ ...TEST_CAMERAS[0], username: 'admin', password: 'p@ss' }),
    'rtsp://admin:p%40ss@192.168.1.104:554/live'
  );

  const remoteCam = {
    ...TEST_CAMERAS[0],
    remoteHost: 'mi-casa.duckdns.org',
    remotePort: 8554,
    connectionMode: 'remote' as const,
  };
  const endpoint = resolveEffectiveEndpoint(remoteCam);
  assert.equal(endpoint.isRemote, true);
  assert.equal(endpoint.host, 'mi-casa.duckdns.org');
  assert.equal(endpoint.port, 8554);
  assert.equal(buildStreamUrl(remoteCam), 'rtsp://mi-casa.duckdns.org:8554/live');
});

test('mergeCameraLists preserves saved names, credentials, and remote configs', () => {
  const saved = [
    {
      ...TEST_CAMERAS[0],
      name: 'Portón Principal',
      remoteHost: 'casa.duckdns.org',
      isSaved: true,
    },
  ];
  const discovered = [
    { ...TEST_CAMERAS[0], name: 'Cámara 192.168.1.104', status: 'online' as const, latencyMs: 12 },
    TEST_CAMERAS[1],
  ];
  const merged = mergeCameraLists(saved, discovered);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'Portón Principal');
  assert.equal(merged[0].remoteHost, 'casa.duckdns.org');
  assert.equal(merged[0].latencyMs, 12);
});

test('parseSubnetInputs normalizes multi-subnet and CIDR strings', () => {
  assert.deepEqual(parseSubnetInputs('', ['192.168.1']), ['192.168.1']);
  assert.deepEqual(
    parseSubnetInputs('192.168.1.0/24, 10.0.0.55', ['192.168.1']),
    ['192.168.1', '10.0.0']
  );
});

test('filterCameras filters by query, protocol, and capabilities', () => {
  const onlineOnly = filterCameras(TEST_CAMERAS, '', true);
  assert.equal(onlineOnly.every((c) => c.status === 'online'), true);
  assert.equal(onlineOnly.length, 2);

  const byBrand = filterCameras(TEST_CAMERAS, 'hikvision', false);
  assert.equal(byBrand.length, 1);
  assert.equal(byBrand[0].id, 'cam-01');

  const byProtoAndAudio = filterCameras(TEST_CAMERAS, '', {
    onlyOnline: true,
    protocol: 'RTSP',
    onlyAudio: true,
  });
  assert.equal(byProtoAndAudio.length, 1);
  assert.equal(byProtoAndAudio[0].id, 'cam-01');
});

test('clampZoomPan resets pan at 1x and clamps at higher zoom', () => {
  assert.deepEqual(clampZoomPan(1, 25, -25), { zoom: 1, panX: 0, panY: 0 });
  const zoomed = clampZoomPan(2, 100, -100);
  assert.equal(zoomed.zoom, 2);
  assert.equal(zoomed.panX, 25);
  assert.equal(zoomed.panY, -25);
});

test('calculateMotionScore detects frame differences', () => {
  const a = new Uint8ClampedArray(64 * 4).fill(10);
  const b = new Uint8ClampedArray(64 * 4).fill(10);
  assert.equal(calculateMotionScore(a, b, 1), 0);

  for (let i = 0; i < b.length; i += 4) {
    b[i] = 200;
    b[i + 1] = 200;
    b[i + 2] = 200;
  }
  assert.ok(calculateMotionScore(a, b, 1) > 50);
});

test('shouldTriggerMotionAlert respects threshold and cooldown', () => {
  const cfg = { ...DEFAULT_MOTION_CONFIG, sensitivity: 70, cooldownSeconds: 10 };
  assert.equal(shouldTriggerMotionAlert(25, cfg, 0, 20000), false);
  assert.equal(shouldTriggerMotionAlert(45, cfg, 0, 20000), true);
  assert.equal(shouldTriggerMotionAlert(45, cfg, 15000, 20000), false);
});

test('formatDuration and formatBytes format cleanly', () => {
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
});

test('buildTermuxScript includes subnet, port, and remote tunnel option', () => {
  const script = buildTermuxScript('10.0.0.0/24', 8080, 'cloudflared');
  assert.ok(script.includes('10.0.0.0/24'));
  assert.ok(script.includes('PORT=8080'));
  assert.ok(script.includes('cloudflared tunnel'));
});

test('parseExternalScanTargets parses external IPs, ranges, DDNS hosts, URLs, and subnets', () => {
  const parsed = parseExternalScanTargets(
    '192.168.4.1-3, 10.0.0.10-10.0.0.11, cam.duckdns.org:8554, rtsp://admin:pass@172.20.10.4:554/live, 10.8.0.0/24'
  );
  assert.deepEqual(parsed.subnets, ['10.8.0']);
  assert.ok(parsed.hosts.some((h) => h.host === '192.168.4.1' && h.source === 'range'));
  assert.ok(parsed.hosts.some((h) => h.host === '192.168.4.3' && h.source === 'range'));
  assert.ok(parsed.hosts.some((h) => h.host === '10.0.0.10' && h.source === 'range'));
  assert.ok(parsed.hosts.some((h) => h.host === '10.0.0.11' && h.source === 'range'));
  assert.ok(parsed.hosts.some((h) => h.host === 'cam.duckdns.org' && h.port === 8554 && h.source === 'ddns'));
  assert.ok(parsed.hosts.some((h) => h.host === '172.20.10.4' && h.port === 554 && h.source === 'external-ip'));
});

test('classifyStreamFailure detects 401, 404, ECONNREFUSED, ENETUNREACH, ETIMEDOUT, and missing ffmpeg', () => {
  assert.equal(classifyStreamFailure('HTTP error 401 Unauthorized', { host: '192.168.1.50', port: 554 }).code, '401');
  assert.equal(classifyStreamFailure('Server returned 404 Stream Not Found', { host: '192.168.1.50', port: 554 }).code, '404');
  assert.equal(classifyStreamFailure('connect ECONNREFUSED 127.0.0.1:554').code, 'ECONNREFUSED');
  assert.equal(classifyStreamFailure('No route to host').code, 'ENETUNREACH');
  assert.equal(classifyStreamFailure('Connection timed out').code, 'ETIMEDOUT');
  assert.equal(classifyStreamFailure('spawn ffmpeg ENOENT').code, 'FFMPEG_MISSING');
});


