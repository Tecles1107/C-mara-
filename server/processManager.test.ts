import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ProcessManager } from './processManager.ts';

test('ProcessManager tracks start, completion, timestamps, and duration', () => {
  const pm = new ProcessManager();
  const id = pm.startOperation('scan', '192.168.1.0/24', { detail: 'Perfil fast' });
  assert.equal(pm.getActiveCount(), 1);

  pm.completeOperation(id, 'completed', '2 cámaras', 0);
  assert.equal(pm.getActiveCount(), 0);

  const ops = pm.listOperations();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, 'completed');
  assert.equal(ops[0].exitCode, 0);
  assert.ok(ops[0].endedAt !== undefined && ops[0].endedAt >= ops[0].startedAt);
  assert.ok(ops[0].durationMs !== undefined && ops[0].durationMs >= 0);
});

test('ProcessManager cancels AbortController and terminates child process cleanly', async () => {
  const pm = new ProcessManager();
  const ac = new AbortController();
  const id = pm.startOperation('stream', 'rtsp://127.0.0.1:554/live', { controller: ac });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
  pm.attachChildProcess(id, child);

  assert.equal(pm.getActiveCount(), 1);
  assert.ok(pm.listOperations()[0].pid);

  const cancelled = pm.cancelOperation(id, 'Detenido en prueba');
  assert.equal(cancelled, true);
  assert.equal(ac.signal.aborted, true);

  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  const op = pm.listOperations()[0];
  assert.equal(op.status, 'cancelled');
  assert.equal(pm.getActiveCount(), 0);
});
