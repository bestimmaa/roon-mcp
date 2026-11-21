import { silentLogger, type RoonCallLogger } from "./logger.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpError, type ArtworkResult, type GetArtworkInput } from "./types.js";

/** Default bounding box for fetched artwork, in pixels. */
const DEFAULT_SIZE = 512;

/**
 * Resolves an `image_key` into image bytes via the Core's HTTP endpoint
 * (`GET http://{core}:{http_port}/api/image/{key}?scale=fit&…`), documented in
 * node-roon-api-image's JSDoc. The HTTP route is deliberate: registering the
 * `com.roonlabs.image:1` WS service makes the Core drop the socket whenever a
 * second connection with the same extension_id is live with a smaller service
 * set — exactly the scripts/integration.mjs-beside-a-client scenario — and
 * the HTTP endpoint needs no registration or dependency at all (issue #39).
 */
export class ArtworkService {
  constructor(
    private readonly roon: RoonClient,
    private readonly logger: RoonCallLogger = silentLogger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getArtwork(input: GetArtworkInput): Promise<ArtworkResult> {
    await this.roon.waitForCore();
    const endpoint = this.roon.getCoreHttpEndpoint();
    if (!endpoint) {
      throw new RoonMcpError(
        "CORE_HTTP_UNAVAILABLE",
        "The paired connection did not expose the Core's HTTP host/port, so artwork cannot be fetched.",
      );
    }

    const width = input.width ?? DEFAULT_SIZE;
    const height = input.height ?? DEFAULT_SIZE;
    const url =
      `http://${endpoint.host}:${endpoint.port}/api/image/` +
      `${encodeURIComponent(input.imageKey)}?scale=fit&width=${width}&height=${height}`;

    return this.logger.call(
      "get_image",
      { imageKey: input.imageKey, width, height },
      async () => {
        let res: Response;
        try {
          res = await this.fetchFn(url);
        } catch (err) {
          throw new RoonMcpError(
            "IMAGE_FETCH_FAILED",
            `Could not reach the Core's image endpoint at ${endpoint.host}:${endpoint.port}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!res.ok) {
          throw new RoonMcpError(
            "IMAGE_FETCH_FAILED",
            `The Core returned HTTP ${res.status} for image key "${input.imageKey}" — ` +
              "the key may be stale; re-read it from now_playing or get_item_info.",
          );
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        return {
          imageKey: input.imageKey,
          contentType: res.headers.get("content-type") ?? "image/jpeg",
          sizeBytes: bytes.length,
          base64: bytes.toString("base64"),
        };
      },
      (result) => ({ contentType: result.contentType, sizeBytes: result.sizeBytes }),
    );
  }
}
