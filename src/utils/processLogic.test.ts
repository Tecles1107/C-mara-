import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getScanConfigForProfile,
  runWithConcurrency,
  formatLatency,
  formatProcessTime,
  getProcessStatusLabel,
} from './processLogic';

test('getScanConfigForProfile returns valid presets and clamps overrides', () => {
  const fast = getScanConfigForProfile('fast');
  assert.equal(fast.ports.length, 5);
  assert.equal(fast.connectTimeoutMs, 140);

  const deepCustom = getScanConfigForProfile('deep', 500, 32);
  assert.equal(deepCustom.connectTimeoutMs, 500);
  assert.equal(deepCustom.concurrency, 32);
  assert.ok(deepCustom.ports.includes(37777));
});

test('runWithConcurrency processes all items and supports AbortSignal', async () => {
  const items = [1, 2, 3, 4, 5, 6];
  const progressCounts: number[] = [];
  const res = await runWithConcurrency(
    items,
    2,
    async (n) => n * 10,
    undefined,
    (done) => progressCounts.push(done)
  );
  assert.deepEqual(res, [10, 20, 30, 40, 50, 60]);
  assert.equal(progressCounts[progressCounts.length - 1], 6);

  const ac = new AbortController();
  let executed = 0;
  await runWithConcurrency(
    [1, 2, 3, 4, 5, 6],
    1,
    async (n) => {
      executed++;
      if (n === 2) ac.abort();
      return n;
    },
    ac.signal
  );
  assert.equal(executed, 2);
});

test('formatLatency formats milliseconds and seconds cleanly', () => {
  assert.equal(formatLatency(undefined), '—');
  assert.equal(formatLatency(45), '45 ms');
  assert.equal(formatLatency(1520), '1.52 s');
});

test('formatProcessTime and getProcessStatusLabel format entry/exit metadata', () => {
  assert.equal(formatProcessTime(undefined), '—');
  assert.match(formatProcessTime(Date.now()), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(getProcessStatusLabel('running'), 'En ejecución');
  assert.equal(getProcessStatusLabel('completed'), 'Completado');
  assert.equal(getProcessStatusLabel('cancelled'), 'Cancelado');
  assert.equal(getProcessStatusLabel('timeout'), 'Tiempo agotado');
  assert.equal(getProcessStatusLabel('error'), 'Error');
});

