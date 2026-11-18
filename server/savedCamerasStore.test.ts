import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SavedCamerasStore } from './savedCamerasStore.ts';
import type { CameraChannel } from '../src/utils/cameraLogic.ts';

test('SavedCamerasStore upserts, renames, updates remoteHost, and deletes cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigialan-store-'));
  const filePath = path.join(tmpDir, 'saved-cameras.json');
  const store = new SavedCamerasStore(filePath);

  assert.deepEqual(store.list(), []);

  const cam: CameraChannel = {
    id: 'cam-1',
    name: 'Patio',
    ip: '192.168.1.50',
    port: 554,
    protocol: 'RTSP',
    streamPath: '/live/ch00_0',
    status: 'online',
    resolution: '1080p',
    fps: 25,
    hasAudio: true,
    location: 'Casa',
    nightVision: false,
  };

  store.upsert(cam);
  let list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].isSaved, true);
  assert.ok(list[0].lastSeenAt);

  // Rename and add remoteHost
  store.upsert({
    ...cam,
    name: 'Patio Principal',
    remoteHost: 'mi-casa.duckdns.org',
    remotePort: 8554,
    connectionMode: 'auto',
  });
  list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Patio Principal');
  assert.equal(list[0].remoteHost, 'mi-casa.duckdns.org');
  assert.equal(list[0].remotePort, 8554);

  const delRes = store.remove('cam-1');
  assert.equal(delRes.removed, true);
  assert.equal(store.list().length, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
