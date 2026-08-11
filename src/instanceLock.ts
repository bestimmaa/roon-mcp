import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where a `RoonClient`'s single-owner lock lives, given its config path. */
export function resolveLockPath(configPath: string): string {
  return join(dirname(configPath), "instance.lock");
}

export interface InstanceLockHandle {
  /** Removes the lock file, but only if it still names this process. */
  release(): void;
}

export interface LockAcquired {
  acquired: true;
  handle: InstanceLockHandle;
}

export interface LockHeldByOther {
  acquired: false;
  ownerPid: number;
  ownerStartedAt: string;
}

interface LockFileContents {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 does no actual signaling; it just probes whether the pid exists.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive. Any other error (notably ESRCH) means it is gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockFile(path: string): LockFileContents | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockFileContents>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return parsed as LockFileContents;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensures only one `roon-mcp` process at a time drives discovery/pairing for
 * a given identity. Roon keeps a single pairing slot per `extension_id`;
 * concurrent instances sharing the persisted token (issue #4) otherwise
 * repeatedly steal the pairing from one another (issue #40). A process that
 * loses the race gets a clear `LockHeldByOther` result naming the owning pid
 * instead of silently flapping between paired/unpaired.
 *
 * A lock from a pid that is no longer alive (crash, kill -9, forgotten
 * cleanup) is treated as stale and taken over.
 */
export function acquireInstanceLock(
  path: string,
  log?: (message: string) => void,
): LockAcquired | LockHeldByOther {
  const existing = readLockFile(path);
  if (existing && isProcessAlive(existing.pid)) {
    return { acquired: false, ownerPid: existing.pid, ownerStartedAt: existing.startedAt };
  }
  if (existing) {
    log?.(`found a stale instance lock from pid ${existing.pid} at ${path}; taking over`);
  }

  const contents: LockFileContents = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(contents, null, "    "));
  } catch (e) {
    // Persistence problems shouldn't crash the server (matches configStore's
    // own fail-open behaviour) — just proceed without the safety net.
    log?.(`failed to write instance lock at ${path}: ${String(e)}; proceeding without it`);
  }

  return {
    acquired: true,
    handle: {
      release() {
        const current = readLockFile(path);
        if (current?.pid !== process.pid) return;
        try {
          unlinkSync(path);
        } catch {
          // best-effort
        }
      },
    },
  };
}
