import type {
  BrowseOptions,
  BrowseResultBody,
  LoadOptions,
  LoadResultBody,
} from "node-roon-api-browse";

import { RoonClient } from "./RoonClient.js";
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

  constructor(private readonly roon: RoonClient) {}

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

  /** Reset the search hierarchy to its root. Call inside `runExclusive`. */
  async resetSearchHierarchy(): Promise<void> {
    await this.browse({ hierarchy: "search", pop_all: true });
  }

  /** Lock-free browse primitive. Compose inside `runExclusive`. */
  async browse(options: BrowseOptions): Promise<BrowseResultBody> {
    await this.roon.waitForCore();
    const browse = this.roon.getBrowse();
    return new Promise<BrowseResultBody>((resolve, reject) => {
      browse.browse(options, (error, body) => {
        if (error) {
          reject(mapBrowseError(error, options));
          return;
        }
        resolve(body);
      });
    });
  }

  /** Lock-free load primitive. Compose inside `runExclusive`. */
  async load(options: LoadOptions): Promise<LoadResultBody> {
    await this.roon.waitForCore();
    const browse = this.roon.getBrowse();
    return new Promise<LoadResultBody>((resolve, reject) => {
      browse.load(options, (error, body) => {
        if (error) {
          reject(mapBrowseError(error, options));
          return;
        }
        resolve(body);
      });
    });
  }
}

function mapBrowseError(error: string, context: unknown): RoonMcpError {
  // Roon returns the message name, e.g. "InvalidItemKey", "NetworkError".
  if (/invaliditemkey/i.test(error)) {
    return new RoonMcpError("INVALID_ITEM_KEY", `Browse rejected item key: ${error}`, context);
  }
  return new RoonMcpError("BROWSE_FAILED", `Browse failed: ${error}`, context);
}
