import fs from 'node:fs';
import path from 'node:path';
import type { CameraChannel } from '../src/utils/cameraLogic.ts';

export class SavedCamerasStore {
  private filePath: string;

  constructor(filePath = path.resolve('data/saved-cameras.json')) {
    this.filePath = filePath;
  }

  list(): CameraChannel[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((cam) => ({ ...cam, isSaved: true }));
    } catch {
      return [];
    }
  }

  upsert(camera: CameraChannel): CameraChannel[] {
    const existing = this.list();
    const now = Date.now();
    const normalized: CameraChannel = {
      ...camera,
      isSaved: true,
      lastSeenAt: camera.lastSeenAt || now,
    };

    const idx = existing.findIndex(
      (c) => c.id === normalized.id || (c.ip === normalized.ip && c.port === normalized.port)
    );

    if (idx >= 0) {
      existing[idx] = {
        ...existing[idx],
        ...normalized,
        id: existing[idx].id,
        isSaved: true,
        lastSeenAt: normalized.lastSeenAt || existing[idx].lastSeenAt || now,
      };
    } else {
      existing.unshift(normalized);
    }

    this.writeAll(existing);
    return existing;
  }

  remove(id: string): { cameras: CameraChannel[]; removed: boolean } {
    const existing = this.list();
    const filtered = existing.filter((c) => c.id !== id);
    const removed = filtered.length !== existing.length;
    if (removed) {
      this.writeAll(filtered);
    }
    return { cameras: filtered, removed };
  }

  private writeAll(cameras: CameraChannel[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(cameras, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

export const savedCamerasStore = new SavedCamerasStore();
