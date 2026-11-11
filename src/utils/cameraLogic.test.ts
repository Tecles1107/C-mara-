import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_CAMERAS,
  DEFAULT_MOTION_CONFIG,
  filterCameras,
  clampZoomPan,
  calculateMotionScore,
  shouldTriggerMotionAlert,
  formatDuration,
  formatBytes,
  buildTermuxScript,
} from './cameraLogic';

test('filterCameras filters by query and online status', () => {
  const onlineOnly = filterCameras(INITIAL_CAMERAS, '', true);
  assert.equal(onlineOnly.every((c) => c.status === 'online'), true);
  assert.equal(onlineOnly.length, 4);

  const byIp = filterCameras(INITIAL_CAMERAS, '192.168.1.104', false);
  assert.equal(byIp.length, 1);
  assert.equal(byIp[0].id, 'cam-01');

  const byProtocol = filterCameras(INITIAL_CAMERAS, 'mjpeg', true);
  assert.equal(byProtocol.length, 1);
  assert.equal(byProtocol[0].id, 'cam-03');
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
  // threshold = 30
  assert.equal(shouldTriggerMotionAlert(25, cfg, 0, 20000), false);
  assert.equal(shouldTriggerMotionAlert(45, cfg, 0, 20000), true);
  // within cooldown
  assert.equal(shouldTriggerMotionAlert(45, cfg, 15000, 20000), false);
});

test('formatDuration and formatBytes format cleanly', () => {
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
});

test('buildTermuxScript includes subnet and port', () => {
  const script = buildTermuxScript('10.0.0.0/24', 8080);
  assert.ok(script.includes('10.0.0.0/24'));
  assert.ok(script.includes('--port=8080'));
});
