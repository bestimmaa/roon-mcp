import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConfigStore, resolveConfigPath } from "./configStore.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roon-mcp-cfg-"));
}

test("resolveConfigPath honours an explicit .json file path", () => {
  const p = resolveConfigPath({ ROON_MCP_CONFIG: "/var/lib/roon/state.json" });
  assert.equal(p, "/var/lib/roon/state.json");
});

test("resolveConfigPath treats a non-.json explicit path as a directory", () => {
  const p = resolveConfigPath({ ROON_MCP_CONFIG: "/var/lib/roon" });
  assert.equal(p, "/var/lib/roon/config.json");
});

test("resolveConfigPath falls back to XDG_CONFIG_HOME", () => {
  const p = resolveConfigPath({ XDG_CONFIG_HOME: "/home/me/.cfg" });
  assert.equal(p, "/home/me/.cfg/roon-mcp/config.json");
});

test("resolveConfigPath defaults to ~/.config/roon-mcp", () => {
  const p = resolveConfigPath({});
  assert.equal(p, join(homedir(), ".config", "roon-mcp", "config.json"));
});

test("save then load round-trips a value", () => {
  const dir = tempDir();
  try {
    const store = createConfigStore(join(dir, "config.json"));
    store.save("roonstate", { tokens: { core1: "abc" } });
    assert.deepEqual(store.load("roonstate"), { tokens: { core1: "abc" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save creates missing parent directories", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "nested", "deep", "config.json");
    const store = createConfigStore(path);
    store.save("roonstate", { paired: true });
    assert.deepEqual(
      JSON.parse(readFileSync(path, "utf8")),
      { roonstate: { paired: true } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save preserves other keys and deletes on null/undefined", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "config.json");
    const store = createConfigStore(path);
    store.save("roonstate", { paired: true });
    store.save("other", 1);
    store.save("roonstate", null);
    assert.equal(store.load("roonstate"), undefined);
    assert.equal(store.load("other"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load returns undefined for a missing or unreadable file", () => {
  const dir = tempDir();
  try {
    const store = createConfigStore(join(dir, "config.json"));
    assert.equal(store.load("roonstate"), undefined);

    // Corrupt JSON should be tolerated, not thrown.
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    assert.equal(createConfigStore(path).load("roonstate"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save reports failures through the log sink instead of throwing", () => {
  const logs: string[] = [];
  // A directory path is not a writable file; mkdir/write will fail.
  const dir = tempDir();
  try {
    const store = createConfigStore(dir, (m) => logs.push(m));
    assert.doesNotThrow(() => store.save("roonstate", { x: 1 }));
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /failed to persist config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
