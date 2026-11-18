import type { ChildProcess } from 'node:child_process';
import type { ProcessOperationRecord, ProcessStatus } from '../src/utils/processLogic.ts';

interface ManagedEntry {
  record: ProcessOperationRecord;
  controller?: AbortController;
  child?: ChildProcess;
  killTimer?: ReturnType<typeof setTimeout>;
  manuallyCancelled?: boolean;
  timedOut?: boolean;
}

const MAX_HISTORY = 80;

export class ProcessManager {
  private entries = new Map<string, ManagedEntry>();
  private orderedIds: string[] = [];

  startOperation(
    kind: ProcessOperationRecord['kind'],
    target: string,
    options: {
      pid?: number;
      detail?: string;
      controller?: AbortController;
    } = {}
  ): string {
    const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    const record: ProcessOperationRecord = {
      id,
      kind,
      target,
      pid: options.pid,
      status: 'running',
      startedAt,
      detail: options.detail,
    };

    this.entries.set(id, {
      record,
      controller: options.controller,
    });
    this.orderedIds.unshift(id);
    this.trimHistory();
    return id;
  }

  updateDetail(id: string, detail: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.record.detail = detail;
  }

  attachChildProcess(id: string, child: ChildProcess, timeoutMs?: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.child = child;
    entry.record.pid = child.pid;

    if (timeoutMs && timeoutMs > 0) {
      entry.killTimer = setTimeout(() => {
        if (entry.record.status === 'running') {
          entry.timedOut = true;
          this.terminateChild(entry);
        }
      }, timeoutMs);
    }

    child.once('close', (code) => {
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = undefined;
      }
      if (entry.record.status === 'running') {
        const status: ProcessStatus = entry.manuallyCancelled
          ? 'cancelled'
          : entry.timedOut
            ? 'timeout'
            : code === 0
              ? 'completed'
              : 'error';
        this.completeOperation(id, status, entry.record.detail, code);
      }
    });

    child.once('error', (err) => {
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = undefined;
      }
      if (entry.record.status === 'running') {
        this.completeOperation(id, 'error', err.message, null);
      }
    });
  }

  completeOperation(
    id: string,
    status: ProcessStatus,
    detail?: string,
    exitCode?: number | null
  ): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = undefined;
    }
    const endedAt = Date.now();
    entry.record.status = status;
    entry.record.endedAt = endedAt;
    entry.record.durationMs = Math.max(0, endedAt - entry.record.startedAt);
    if (detail !== undefined) entry.record.detail = detail;
    if (exitCode !== undefined) entry.record.exitCode = exitCode;
  }

  cancelOperation(id: string, reason = 'Cancelado por el usuario'): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== 'running') return false;
    entry.manuallyCancelled = true;
    entry.record.detail = reason;

    if (entry.controller && !entry.controller.signal.aborted) {
      entry.controller.abort();
    }
    if (entry.child) {
      this.terminateChild(entry);
    } else {
      this.completeOperation(id, 'cancelled', reason, null);
    }
    return true;
  }

  cancelByKind(kind: ProcessOperationRecord['kind'], reason = 'Cancelado por el usuario'): number {
    let count = 0;
    for (const id of this.orderedIds) {
      const entry = this.entries.get(id);
      if (entry && entry.record.kind === kind && entry.record.status === 'running') {
        if (this.cancelOperation(id, reason)) {
          count++;
        }
      }
    }
    return count;
  }

  listOperations(): ProcessOperationRecord[] {
    const now = Date.now();
    return this.orderedIds
      .map((id) => this.entries.get(id)?.record)
      .filter((r): r is ProcessOperationRecord => Boolean(r))
      .map((r) =>
        r.status === 'running'
          ? { ...r, durationMs: Math.max(0, now - r.startedAt) }
          : { ...r }
      );
  }

  getActiveCount(): number {
    let active = 0;
    for (const entry of this.entries.values()) {
      if (entry.record.status === 'running') active++;
    }
    return active;
  }

  private terminateChild(entry: ManagedEntry): void {
    const child = entry.child;
    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already exited
    }
    const forceTimer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch {
        // Ignore
      }
    }, 450);
    child.once('close', () => clearTimeout(forceTimer));
  }

  private trimHistory(): void {
    while (this.orderedIds.length > MAX_HISTORY) {
      const oldestId = this.orderedIds[this.orderedIds.length - 1];
      const oldest = this.entries.get(oldestId);
      if (oldest && oldest.record.status === 'running') {
        break;
      }
      this.orderedIds.pop();
      this.entries.delete(oldestId);
    }
  }
}

export const processManager = new ProcessManager();
