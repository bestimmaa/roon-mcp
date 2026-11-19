import type { EventEmitter } from "node:events";

/** How long `stop()` may take before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 3_000;

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
 * over as stale. Treating the end of stdin as a shutdown request closes that
 * gap. (stdin only reports `end` once the transport has started reading it.)
 *
 * Shutdown runs once. It exits 0 when `stop()` succeeds, and 1 when `stop()`
 * rejects or is still pending after `graceMs`.
 */
export function installShutdown(opts: ShutdownOptions): void {
  const { stdin, signals, stop, exit, log = () => {}, graceMs = SHUTDOWN_GRACE_MS } = opts;
  let shuttingDown = false;

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    const timer = setTimeout(() => {
      log(`shutdown did not finish within ${graceMs}ms; exiting anyway`);
      exit(1);
    }, graceMs);
    stop().then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
        exit(1);
      },
    );
  };

  // `end` is a clean EOF; `close`/`error` cover a pipe that was destroyed or
  // broke without one.
  for (const event of ["end", "close", "error"]) {
    stdin.once(event, () => shutdown(`MCP client closed stdin (${event})`));
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    signals.once(signal, () => shutdown(`received ${signal}`));
  }
}
