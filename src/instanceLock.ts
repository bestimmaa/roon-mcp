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
 * Bound on takeover attempts when the exclusive create keeps losing races.
 * Hitting it means the lock file is churning pathologically; report whoever
 * holds it at that point rather than looping.
 */
const MAX_TAKEOVER_ATTEMPTS = 3;

/**
 * Ensures only one `roon-mcp` process at a time drives discovery/pairing for
 * a given identity. Roon keeps a single pairing slot per `extension_id`;
 * concurrent instances sharing the persisted token (issue #4) otherwise
 * repeatedly steal the pairing from one another (issue #40). A process that
 * loses the race gets a clear `LockHeldByOther` result naming the owning pid
 * instead of silently flapping between paired/unpaired.
 *
 * A lock from a pid that is no longer alive (crash, kill -9, forgotten
 * cleanup) is treated as stale and taken over. Safe to call repeatedly: a
 * blocked process re-probes it on each incoming call so it can recover once
 * the holder exits (issue #48). The lock file is created exclusively
 * (`wx`), so two processes probing a free or stale slot at the same time
 * cannot both believe they won — the loser's create fails with `EEXIST` and
 * it re-reads the winner's file.
 */
export function acquireInstanceLock(
  path: string,
  log?: (message: string) => void,
): LockAcquired | LockHeldByOther {
  const contents: LockFileContents = { pid: process.pid, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt++) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(contents, null, "    "), { flag: "wx" });
      return { acquired: true, handle: makeHandle(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // Persistence problems shouldn't crash the server (matches configStore's
        // own fail-open behaviour) — just proceed without the safety net.
        log?.(`failed to write instance lock at ${path}: ${String(e)}; proceeding without it`);
        return { acquired: true, handle: makeHandle(path) };
      }
    }

    // The exclusive create hit an existing file: either a live owner, or a
    // leftover from a process that never released it.
    const existing = readLockFile(path);
    if (existing && isProcessAlive(existing.pid)) {
      return { acquired: false, ownerPid: existing.pid, ownerStartedAt: existing.startedAt };
    }
    log?.(
      existing
        ? `found a stale instance lock from pid ${existing.pid} at ${path}; taking over`
        : `found an unreadable instance lock at ${path}; taking over`,
    );
    try {
      unlinkSync(path);
    } catch {
      // best-effort; if someone else just unlinked-and-recreated it, the next
      // iteration's exclusive create re-evaluates the new owner.
    }
  }

  const owner = readLockFile(path);
  return {
    acquired: false,
    ownerPid: owner?.pid ?? -1,
    ownerStartedAt: owner?.startedAt ?? "unknown",
  };
}

function makeHandle(path: string): InstanceLockHandle {
  return {
    release() {
      const current = readLockFile(path);
      if (current?.pid !== process.pid) return;
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    },
  };
}
