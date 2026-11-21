import assert from "node:assert/strict";
import { test } from "node:test";

import { ArtworkService } from "./ArtworkService.js";
import { silentLogger } from "./logger.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpError } from "./types.js";

const PIXELS = Buffer.from("not-really-a-jpeg");

function stubClient(endpoint?: { host: string; port: number }): RoonClient {
  return {
    waitForCore: async () => undefined,
    getCoreHttpEndpoint: () => endpoint,
  } as unknown as RoonClient;
}

function okResponse(contentType = "image/jpeg"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === "content-type" ? contentType : null) },
    arrayBuffer: async () => PIXELS.buffer.slice(PIXELS.byteOffset, PIXELS.byteOffset + PIXELS.byteLength),
  } as unknown as Response;
}

test("fetches the image over the Core's HTTP endpoint and returns base64", async () => {
  const urls: string[] = [];
  const service = new ArtworkService(
    stubClient({ host: "10.0.0.2", port: 9330 }),
    silentLogger,
    async (url) => {
      urls.push(String(url));
      return okResponse();
    },
  );

  const art = await service.getArtwork({ imageKey: "abc123" });
  assert.deepEqual(urls, ["http://10.0.0.2:9330/api/image/abc123?scale=fit&width=512&height=512"]);
  assert.equal(art.imageKey, "abc123");
  assert.equal(art.contentType, "image/jpeg");
  assert.equal(art.sizeBytes, PIXELS.length);
  assert.equal(Buffer.from(art.base64, "base64").toString(), PIXELS.toString());
});

test("explicit width/height override the default bounding box", async () => {
  const urls: string[] = [];
  const service = new ArtworkService(
    stubClient({ host: "core.local", port: 9100 }),
    silentLogger,
    async (url) => {
      urls.push(String(url));
      return okResponse("image/png");
    },
  );

  const art = await service.getArtwork({ imageKey: "k", width: 128, height: 256 });
  assert.deepEqual(urls, ["http://core.local:9100/api/image/k?scale=fit&width=128&height=256"]);
  assert.equal(art.contentType, "image/png");
});

test("a non-2xx response maps to IMAGE_FETCH_FAILED", async () => {
  const service = new ArtworkService(
    stubClient({ host: "10.0.0.2", port: 9330 }),
    silentLogger,
    async () => ({ ok: false, status: 404 }) as unknown as Response,
  );
  await assert.rejects(
    service.getArtwork({ imageKey: "stale" }),
    (err: unknown) => err instanceof RoonMcpError && err.code === "IMAGE_FETCH_FAILED",
  );
});

test("a network failure maps to IMAGE_FETCH_FAILED", async () => {
  const service = new ArtworkService(
    stubClient({ host: "10.0.0.2", port: 9330 }),
    silentLogger,
    async () => {
      throw new Error("connect ECONNREFUSED");
    },
  );
  await assert.rejects(
    service.getArtwork({ imageKey: "k" }),
    (err: unknown) => err instanceof RoonMcpError && err.code === "IMAGE_FETCH_FAILED",
  );
});

test("a connection without an exposed HTTP endpoint maps to CORE_HTTP_UNAVAILABLE", async () => {
  const service = new ArtworkService(stubClient(undefined), silentLogger, async () => okResponse());
  await assert.rejects(
    service.getArtwork({ imageKey: "k" }),
    (err: unknown) => err instanceof RoonMcpError && err.code === "CORE_HTTP_UNAVAILABLE",
  );
});
