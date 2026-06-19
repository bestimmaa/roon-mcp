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
      RoonApiBrowse: import("node-roon-api-browse").RoonApiBrowse;
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

declare module "node-roon-api-browse" {
  export type BrowseHierarchy =
    | "browse"
    | "playlists"
    | "settings"
    | "internet_radio"
    | "albums"
    | "artists"
    | "genres"
    | "composers"
    | "search";

  /** item hint = null | "action" | "action_list" | "list" | "header" */
  export type BrowseItemHint = "action" | "action_list" | "list" | "header" | null;

  export interface BrowseItem {
    title: string;
    subtitle?: string;
    image_key?: string;
    item_key?: string;
    hint?: BrowseItemHint;
    input_prompt?: {
      prompt: string;
      action: string;
      value?: string;
      is_password: boolean;
    };
  }

  export interface BrowseList {
    title: string;
    count: number;
    subtitle?: string;
    image_key?: string;
    level: number;
    display_offset?: number;
    hint?: "action_list" | null;
  }

  export interface BrowseOptions {
    hierarchy: BrowseHierarchy;
    multi_session_key?: string;
    item_key?: string;
    input?: string;
    zone_or_output_id?: string;
    pop_all?: boolean;
    pop_levels?: number;
    refresh_list?: boolean;
    set_display_offset?: number;
  }

  export interface BrowseResultBody {
    action: "message" | "none" | "list" | "replace_item" | "remove_item";
    item?: BrowseItem;
    list?: BrowseList;
    message?: string;
    is_error?: boolean;
  }

  export interface LoadOptions {
    hierarchy: BrowseHierarchy;
    multi_session_key?: string;
    level?: number;
    offset?: number;
    count?: number;
    set_display_offset?: number;
  }

  export interface LoadResultBody {
    items: BrowseItem[];
    offset: number;
    list: BrowseList;
  }

  export class RoonApiBrowse {
    browse(
      opts: BrowseOptions,
      cb: (error: string | false, body: BrowseResultBody) => void,
    ): void;
    load(
      opts: LoadOptions,
      cb: (error: string | false, body: LoadResultBody) => void,
    ): void;
  }

  const _default: typeof RoonApiBrowse;
  export default _default;
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

  export interface RoonZoneSettings {
    shuffle?: boolean;
    auto_radio?: boolean;
    loop?: "loop" | "loop_one" | "disabled";
  }

  export class RoonApiTransport {
    get_zones(cb: (error: string | false, body: GetZonesBody) => void): void;
    subscribe_zones(
      cb: (response: string, body: unknown) => void,
    ): void;
    /**
     * Change zone playback settings. Marked optional because availability
     * depends on the installed node-roon-api-transport version; callers must
     * feature-detect before use.
     */
    change_settings?(
      zoneOrOutputId: string,
      settings: RoonZoneSettings,
      cb?: (error: string | false) => void,
    ): void;
  }

  const _default: typeof RoonApiTransport;
  export default _default;
}
