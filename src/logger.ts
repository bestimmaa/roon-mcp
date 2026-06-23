// Structured, per-call logging for Roon API calls (Milestone 5 hardening).
//
// stdout is reserved for the MCP JSON-RPC stream, so every diagnostic line goes
// to stderr. Each Roon API call (browse / load / get_zones / change_settings)
// is wrapped in `call(...)`, which emits one compact JSON line on completion —
// success or failure — including the elapsed time. Retries therefore show up
// naturally as repeated lines for the same op.

export interface RoonCallLogger {
  /**
   * Time and log a single Roon API call. Emits one structured line when `fn`
   * settles (level `info` on success, `error` on rejection) and then
   * returns/rethrows `fn`'s result unchanged — so callers' error codes are
   * preserved for downstream retry/skip logic.
   *
   * @param op        Short operation name, e.g. "browse" or "get_zones".
   * @param params    Request parameters, logged as-is (Roon browse params hold
   *                  no secrets). Pass `{}` when there are none.
   * @param fn        The async call to time.
   * @param summarize Optional: derive a compact result summary to log instead
   *                  of the full (often large) response body.
   */
  call<T>(
    op: string,
    params: unknown,
    fn: () => Promise<T>,
    summarize?: (result: T) => unknown,
  ): Promise<T>;
}

/** A no-op logger: runs the call without emitting anything. Default in tests. */
export const silentLogger: RoonCallLogger = {
  call: (_op, _params, fn) => fn(),
};

/**
 * Logger that writes one `[roon-call] {json}` line per call to stderr (or any
 * injected sink, for tests). Undefined fields are dropped to keep lines compact.
 */
export function createStderrLogger(
  sink: (line: string) => void = (line) => void process.stderr.write(line),
): RoonCallLogger {
  return {
    async call(op, params, fn, summarize) {
      const started = Date.now();
      try {
        const result = await fn();
        sink(
          format({
            lvl: "info",
            op,
            ms: Date.now() - started,
            params,
            result: summarize ? summarize(result) : undefined,
          }),
        );
        return result;
      } catch (err) {
        const e = err as { code?: unknown; message?: unknown };
        sink(
          format({
            lvl: "error",
            op,
            ms: Date.now() - started,
            params,
            error: {
              code: typeof e?.code === "string" ? e.code : undefined,
              message: typeof e?.message === "string" ? e.message : String(err),
            },
          }),
        );
        throw err;
      }
    },
  };
}

function format(record: Record<string, unknown>): string {
  const clean: Record<string, unknown> = { t: new Date().toISOString() };
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) clean[key] = value;
  }
  return `[roon-call] ${JSON.stringify(clean)}\n`;
}

/**
 * Route every console output method (including `error`) to `sink` — stderr by
 * default. On a stdio MCP server stdout is reserved for the JSON-RPC stream, so
 * any library (node-roon-api) logging via `console.*` must not reach it.
 * `console.error` was previously left on its default, which happens to write to
 * stderr too, but routing it explicitly keeps a single chokepoint and uniform
 * formatting (issue #15). Returns a restore function so tests can reset it.
 */
export function redirectConsoleToStderr(
  sink: (line: string) => void = (line) => void process.stderr.write(line),
): () => void {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const write = (...args: unknown[]) => sink(`${args.map(String).join(" ")}\n`);
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
  console.error = write;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.warn = original.warn;
    console.error = original.error;
  };
}
