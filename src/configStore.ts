import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Resolves where Roon pairing state (the `config.json` written by
 * node-roon-api) is stored.
 *
 * node-roon-api defaults to a `config.json` in the process's *current working
 * directory*. That is fine for a long-lived desktop app started from a fixed
 * place, but an MCP server is launched by arbitrary clients from unpredictable
 * (and often non-writable) working directories. Every launch from a different
 * CWD then fails to find the prior pairing token, so the extension presents as
 * unpaired and Roon registers a brand-new "Discovered" entry — the duplicate
 * `NO_CORE_PAIRED` flapping described in issue #4.
 *
 * Anchoring to a stable absolute path under the user's config directory keeps
 * a single pairing token across restarts. Resolution order (first match wins):
 *   1. `ROON_MCP_CONFIG` — explicit path. A value ending in `.json` is treated
 *      as the file itself; anything else as a directory to hold `config.json`.
 *   2. `XDG_CONFIG_HOME/roon-mcp/config.json`
 *   3. `~/.config/roon-mcp/config.json`
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ROON_MCP_CONFIG?.trim();
  if (explicit) {
    const abs = resolve(explicit);
    return abs.endsWith(".json") ? abs : join(abs, "config.json");
  }

  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "roon-mcp", "config.json");
}

/** Key/value persistence over a single JSON file, mirroring node-roon-api. */
export interface ConfigStore {
  load<T = unknown>(key: string): T | undefined;
  save(key: string, value: unknown): void;
}

/**
 * A file-backed {@link ConfigStore} compatible with node-roon-api's on-disk
 * format (one JSON object keyed by config key). The parent directory is
 * created on demand; read/write failures are swallowed (logged when a `log`
 * sink is given) so persistence problems never crash the server — exactly as
 * node-roon-api's own implementation behaves.
 */
export function createConfigStore(
  path: string,
  log?: (message: string) => void,
): ConfigStore {
  const readAll = (): Record<string, unknown> => {
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) || {};
    } catch {
      return {};
    }
  };

  return {
    load<T>(key: string): T | undefined {
      return readAll()[key] as T | undefined;
    },
    save(key: string, value: unknown): void {
      try {
        const config = readAll();
        if (value === undefined || value === null) delete config[key];
        else config[key] = value;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(config, null, "    "));
      } catch (e) {
        log?.(`failed to persist config to ${path}: ${String(e)}`);
      }
    },
  };
}
