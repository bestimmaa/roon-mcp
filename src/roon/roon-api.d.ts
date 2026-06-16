// Minimal ambient type declarations for the untyped RoonLabs packages.
// Covers only the surface this server uses.

declare module "node-roon-api" {
  export interface RoonExtensionDescription {
    extension_id: string;
    display_name: string;
    display_version: string;
    publisher: string;
    email: string;
    website?: string;
    log_level?: "all" | "none";
    core_paired?: (core: RoonCore) => void;
    core_unpaired?: (core: RoonCore) => void;
  }

  export interface RoonCore {
    core_id: string;
    display_name: string;
    display_version: string;
    services: {
      RoonApiTransport: import("node-roon-api-transport").RoonApiTransport;
      [service: string]: unknown;
    };
  }

  export interface InitServicesOptions {
    required_services?: unknown[];
    optional_services?: unknown[];
    provided_services?: unknown[];
  }

  export default class RoonApi {
    constructor(desc: RoonExtensionDescription);
    init_services(options: InitServicesOptions): void;
    start_discovery(): void;
    save_config(key: string, value: unknown): void;
    load_config<T = unknown>(key: string): T | undefined;
  }
}

declare module "node-roon-api-status" {
  import RoonApi from "node-roon-api";
  export default class RoonApiStatus {
    constructor(roon: RoonApi);
    set_status(message: string, is_error: boolean): void;
  }
}

declare module "node-roon-api-transport" {
  export type RoonZoneState = "playing" | "paused" | "loading" | "stopped";

  export interface RoonOutput {
    output_id: string;
    zone_id: string;
    display_name: string;
  }

  export interface RoonNowPlaying {
    one_line?: { line1: string };
    two_line?: { line1: string; line2?: string };
    three_line?: { line1: string; line2?: string; line3?: string };
  }

  export interface RoonApiZone {
    zone_id: string;
    display_name: string;
    state: RoonZoneState;
    outputs: RoonOutput[];
    now_playing?: RoonNowPlaying;
  }

  export interface GetZonesBody {
    zones: RoonApiZone[];
  }

  export class RoonApiTransport {
    get_zones(cb: (error: string | false, body: GetZonesBody) => void): void;
    subscribe_zones(
      cb: (response: string, body: unknown) => void,
    ): void;
  }

  const _default: typeof RoonApiTransport;
  export default _default;
}
