import type { EventEmitter } from "node:events";

/** How long `stop()` may take before the process exits anyway. */
export const SHUTDOWN_GRACE_MS = 3_000;

export interface ShutdownOptions {
  /** The MCP client's end of the stdio pipe (normally `process.stdin`). */
  stdin: EventEmitter;
  /** Where termination signals arrive (normally `process`). */
  signals: EventEmitter;
  /** Releases the Core pairing, the instance lock and the MCP transport. */
  stop: () => Promise<void>;
  /** Terminates the process (normally `process.exit`). */
  exit: (code: number) => void;
  log?: (message: string) => void;
  graceMs?: number;
}

/**
 * Shut the server down when its MCP client goes away, not only on a signal.
 *
 * The SDK's StdioServerTransport listens for stdin `data`/`error` only, so
 * when the client closes the pipe (session ended, client crashed, parent
 * reaped) nothing fires — and the open Roon websocket keeps the event loop
 * alive. The orphan then holds the single-owner pairing lock indefinitely,
 * and because its pid is still alive, other instances can't take the lock
 * over as stale. Treating stdin EOF as a shutdown request closes that gap.
 *
 * Returns the shutdown trigger. It is idempotent, and exits after
 * `graceMs` even if `stop()` hangs or rejects.
 */
export function installShutdown(opts: ShutdownOptions): (reason: string) => void {
  const { stdin, signals, stop, exit, log = () => {}, graceMs = SHUTDOWN_GRACE_MS } = opts;
  let shuttingDown = false;

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    const timer = setTimeout(() => {
      log(`shutdown did not finish within ${graceMs}ms; exiting anyway`);
      exit(0);
    }, graceMs);
    stop()
      .catch((err: unknown) => {
        log(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        clearTimeout(timer);
        exit(0);
      });
  };

  stdin.once("end", () => shutdown("MCP client closed stdin"));
  stdin.once("close", () => shutdown("MCP client closed stdin"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    signals.once(signal, () => shutdown(`received ${signal}`));
  }
  return shutdown;
}
