import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireInstanceLock, resolveLockPath } from "./instanceLock.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roon-mcp-lock-"));
}

test("resolveLockPath sits next to the config file", () => {
  assert.equal(
    resolveLockPath("/home/me/.config/roon-mcp/config.json"),
    "/home/me/.config/roon-mcp/instance.lock",
  );
});

test("acquireInstanceLock succeeds when no lock file exists, and writes one", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "instance.lock");
    const result = acquireInstanceLock(path);
    assert.equal(result.acquired, true);
    const contents = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(contents.pid, process.pid);
    assert.equal(typeof contents.startedAt, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInstanceLock refuses when a live process already owns the lock", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "instance.lock");
    // pid 1 (init/launchd) is always alive on both Linux and macOS.
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }));
    const result = acquireInstanceLock(path);
    assert.equal(result.acquired, false);
    if (!result.acquired) {
      assert.equal(result.ownerPid, 1);
      assert.equal(result.ownerStartedAt, "2026-01-01T00:00:00.000Z");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInstanceLock takes over a stale lock from a dead pid", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "instance.lock");
    // A pid this large is essentially guaranteed not to exist.
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, startedAt: "2020-01-01T00:00:00.000Z" }));
    const result = acquireInstanceLock(path);
    assert.equal(result.acquired, true);
    const contents = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(contents.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInstanceLock tolerates a missing or corrupt lock file", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "bad.lock");
    writeFileSync(path, "{ not json");
    const result = acquireInstanceLock(path);
    assert.equal(result.acquired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() removes the lock file when it still names this process", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "instance.lock");
    const result = acquireInstanceLock(path);
    assert.equal(result.acquired, true);
    if (result.acquired) result.handle.release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() is a no-op when another process has since taken the lock", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "instance.lock");
    const result = acquireInstanceLock(path);
    assert.equal(result.acquired, true);
    // Simulate another process taking over after a stale takeover.
    writeFileSync(path, JSON.stringify({ pid: 999_999, startedAt: "2026-01-01T00:00:00.000Z" }));
    if (result.acquired) result.handle.release();
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
