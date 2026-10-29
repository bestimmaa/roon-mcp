import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

type LockRead =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "owned"; contents: LockFileContents };

/** Distinguishes a missing lock file from one that exists but holds junk. */
function readLock(path: string): LockRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "missing" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockFileContents>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return { state: "owned", contents: parsed as LockFileContents };
    }
  } catch {
    // fall through
  }
  return { state: "unreadable" };
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
 * the holder exits (issue #48). Concurrent takeovers are race-free: a stale
 * file is removed via atomic rename (one winner) and the new lock is created
 * exclusively (`wx`), so two processes probing a free or stale slot at the
 * same time cannot both believe they won — the loser re-reads the winner's
 * file and reports it as the holder.
 */
export function acquireInstanceLock(
  path: string,
  log?: (message: string) => void,
): LockAcquired | LockHeldByOther {
  for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt++) {
    // Probe by reading first: a blocked instance re-probes on every call, and
    // a live owner must short-circuit here, before any write is attempted —
    // the fail-open branch below must never run while someone else validly
    // holds the slot.
    const read = readLock(path);
    if (read.state === "owned" && isProcessAlive(read.contents.pid)) {
      return {
        acquired: false,
        ownerPid: read.contents.pid,
        ownerStartedAt: read.contents.startedAt,
      };
    }

    if (read.state !== "missing") {
      // A leftover from a dead owner, or an unreadable file. Remove it via an
      // atomic rename to a per-pid tombstone: of several processes contending
      // for the same leftover, exactly one rename succeeds — and unlike a
      // bare unlink, a rename can never remove a lock another contender just
      // created, because that creation was itself preceded by a rename that
      // moved `path` away (making this one fail with ENOENT).
      log?.(
        read.state === "owned"
          ? `found a stale instance lock from pid ${read.contents.pid} at ${path}; taking over`
          : `found an unreadable instance lock at ${path}; taking over`,
      );
      try {
        renameSync(path, `${path}.stale-${process.pid}`);
      } catch {
        // Lost the removal race — another process is mid-takeover. Re-read
        // and re-evaluate the new owner.
        continue;
      }
      try {
        unlinkSync(`${path}.stale-${process.pid}`);
      } catch {
        // A lingering tombstone is harmless.
      }
    }

    const contents: LockFileContents = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      // mkdir sits here, not before the loop, so the common blocked re-probe
      // (which returns from the read above) does no filesystem writes at all.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(contents, null, "    "), { flag: "wx" });
      return { acquired: true, handle: makeHandle(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; // lost the create race; re-evaluate the winner
      // Persistence problems shouldn't crash the server (matches configStore's
      // own fail-open behaviour) — just proceed without the safety net. Safe
      // only because the read above found no live owner this probe.
      log?.(`failed to write instance lock at ${path}: ${String(e)}; proceeding without it`);
      return { acquired: true, handle: makeHandle(path) };
    }
  }

  // Lost every takeover race: each retry means another process got there
  // first, so by now the file names a (very recent, presumed live) winner.
  const owner = readLock(path);
  return owner.state === "owned"
    ? { acquired: false, ownerPid: owner.contents.pid, ownerStartedAt: owner.contents.startedAt }
    : { acquired: false, ownerPid: -1, ownerStartedAt: "unknown" };
}

function makeHandle(path: string): InstanceLockHandle {
  return {
    release() {
      const current = readLock(path);
      if (current.state !== "owned" || current.contents.pid !== process.pid) return;
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    },
  };
}
