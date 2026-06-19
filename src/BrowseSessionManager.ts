import type {
  BrowseOptions,
  BrowseResultBody,
  LoadOptions,
  LoadResultBody,
} from "node-roon-api-browse";

import { RoonClient } from "./RoonClient.js";
import { silentLogger, type RoonCallLogger } from "./logger.js";
import { RoonMcpError } from "./types.js";

/**
 * Roon keeps browse state per session on the Core side, so concurrent browse
 * sequences would corrupt each other. This manager serializes whole browse
 * operations through a single lock (`runExclusive`) and exposes lock-free
 * `browse`/`load` primitives intended to be composed *inside* that lock.
 */
export class BrowseSessionManager {
  // Tail of the serialization chain; each exclusive op links onto it.
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly roon: RoonClient,
    private readonly logger: RoonCallLogger = silentLogger,
  ) {}

  /** Run a multi-step browse sequence with exclusive access to the session. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    // Keep the chain alive regardless of this op's outcome.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run an exclusive operation, retrying it once after resetting the search
   * hierarchy if it fails with a stale-session error (a popped/expired item
   * key surfaces as `INVALID_ITEM_KEY`).
   *
   * Only safe for operations whose item keys are produced *inside* `operation`
   * (e.g. a search that browses fresh group keys): the reset can recover them.
   * Do NOT use when `operation` drills a caller-supplied key — the reset would
   * invalidate the very key being used.
   */
  runExclusiveWithRetry<T>(
    operation: () => Promise<T>,
    isRetryable: (err: unknown) => boolean = isStaleSession,
  ): Promise<T> {
    return this.runExclusive(async () => {
      try {
        return await operation();
      } catch (err) {
        if (!isRetryable(err)) throw err;
        await this.resetSearchHierarchy();
        return operation();
      }
    });
  }

  /** Reset the search hierarchy to its root. Call inside `runExclusive`. */
  async resetSearchHierarchy(): Promise<void> {
    await this.browse({ hierarchy: "search", pop_all: true });
  }

  /** Lock-free browse primitive. Compose inside `runExclusive`. */
  async browse(options: BrowseOptions): Promise<BrowseResultBody> {
    await this.roon.waitForCore();
    const browse = this.roon.getBrowse();
    return this.logger.call(
      "browse",
      options,
      () =>
        new Promise<BrowseResultBody>((resolve, reject) => {
          browse.browse(options, (error, body) => {
            if (error) {
              reject(mapBrowseError(error, options));
              return;
            }
            resolve(body);
          });
        }),
      (body) => ({
        action: body.action,
        list: body.list?.title,
        count: body.list?.count,
        isError: body.is_error,
      }),
    );
  }

  /** Lock-free load primitive. Compose inside `runExclusive`. */
  async load(options: LoadOptions): Promise<LoadResultBody> {
    await this.roon.waitForCore();
    const browse = this.roon.getBrowse();
    return this.logger.call(
      "load",
      options,
      () =>
        new Promise<LoadResultBody>((resolve, reject) => {
          browse.load(options, (error, body) => {
            if (error) {
              reject(mapBrowseError(error, options));
              return;
            }
            resolve(body);
          });
        }),
      (body) => ({ items: body.items.length, count: body.list?.count }),
    );
  }
}

/** A stale browse session / popped item key surfaces as INVALID_ITEM_KEY. */
function isStaleSession(err: unknown): boolean {
  return err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY";
}

function mapBrowseError(error: string, context: unknown): RoonMcpError {
  // Roon returns the message name, e.g. "InvalidItemKey", "NetworkError".
  if (/invaliditemkey/i.test(error)) {
    return new RoonMcpError("INVALID_ITEM_KEY", `Browse rejected item key: ${error}`, context);
  }
  return new RoonMcpError("BROWSE_FAILED", `Browse failed: ${error}`, context);
}
