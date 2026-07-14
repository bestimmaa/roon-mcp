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

  export interface WsConnectOptions {
    host: string;
    port: number;
    onclose?: () => void;
    onerror?: (moo: unknown) => void;
  }

  export default class RoonApi {
    constructor(desc: RoonExtensionDescription);
    init_services(options: InitServicesOptions): void;
    start_discovery(): void;
    /** Connect straight to a known Core (registration/pairing included). */
    ws_connect(opts: WsConnectOptions): unknown;
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
    /** Populated for outputs that support volume control. Incremental outputs
     * (IR blasters and the like) omit `min`/`max`/`step`/`value` and report
     * `type: "incremental"`; only `is_muted` is meaningful for those. */
    volume?: {
      type?: "number" | "db" | "incremental" | string;
      min?: number;
      max?: number;
      value?: number;
      step?: number;
      is_muted?: boolean;
    };
  }

  export interface RoonNowPlaying {
    one_line?: { line1: string };
    two_line?: { line1: string; line2?: string };
    three_line?: { line1: string; line2?: string; line3?: string };
    /** Length of the current media in seconds, when applicable. */
    length?: number;
    /** Current seek position in seconds, when applicable. */
    seek_position?: number;
    /** Image key for the current media artwork. */
    image_key?: string;
  }

  export interface RoonApiZone {
    zone_id: string;
    display_name: string;
    state: RoonZoneState;
    outputs: RoonOutput[];
    now_playing?: RoonNowPlaying;
    /** Whether the Core currently allows the corresponding transport verb. */
    is_previous_allowed?: boolean;
    is_next_allowed?: boolean;
    is_pause_allowed?: boolean;
    is_play_allowed?: boolean;
    is_seek_allowed?: boolean;
    /** Current seek position in seconds, when applicable. */
    seek_position?: number;
  }

  export interface GetZonesBody {
    zones: RoonApiZone[];
  }

  export interface RoonZoneSettings {
    shuffle?: boolean;
    auto_radio?: boolean;
    loop?: "loop" | "loop_one" | "disabled";
  }

  /** Verb accepted by `RoonApiTransport#control`. */
  export type RoonControlVerb =
    | "play"
    | "pause"
    | "playpause"
    | "stop"
    | "previous"
    | "next";

  /** How to interpret the `value` argument of `RoonApiTransport#change_volume`. */
  export type RoonVolumeHow = "absolute" | "relative" | "relative_step";

  /** Body of a `subscribe_zones` `Subscribed` event — the full zone snapshot. */
  export interface SubscribeZonesSubscribed {
    zones: RoonApiZone[];
  }

  /** Body of a `subscribe_zones` `Changed` event — incremental updates. */
  export interface SubscribeZonesChanged {
    zones_added?: RoonApiZone[];
    zones_changed?: RoonApiZone[];
    zones_removed?: string[];
    /**
     * Per-zone seek-position ticks. Arrives frequently while a track is
     * playing; the snapshot's `now_playing.seek_position` is updated by
     * node-roon-api-transport's internal cache.
     */
    zones_seek_changed?: Array<{
      zone_id: string;
      seek_position?: number;
      queue_time_remaining?: number;
    }>;
  }

  /** Body of a `subscribe_zones` `Unsubscribed` event. */
  export interface SubscribeZonesUnsubscribed {
    zones?: never;
  }

  /** Lifecycle of a `subscribe_zones` subscription. */
  export type SubscribeZonesResponse =
    | "Subscribed"
    | "Changed"
    | "Unsubscribed";

  export class RoonApiTransport {
    get_zones(cb: (error: string | false, body: GetZonesBody) => void): void;
    /**
     * Subscribe to zone-state updates. The callback fires once with
     * `response: "Subscribed"` (carrying the full snapshot), then on every
     * `Changed` event with an incremental delta, and a final time with
     * `"Unsubscribed"` when the subscription is torn down.
     */
    subscribe_zones(
      cb: (
        response: SubscribeZonesResponse,
        body:
          | SubscribeZonesSubscribed
          | SubscribeZonesChanged
          | SubscribeZonesUnsubscribed,
      ) => void,
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
    /**
     * Run a transport verb (play/pause/stop/next/previous/playpause) against a
     * zone or output. Marked optional for the same reason as `change_settings`.
     */
    control?(
      zoneOrOutput: string,
      control: RoonControlVerb,
      cb?: (error: string | false) => void,
    ): void;
    /**
     * Seek within the current track. `how: "absolute"` seeks to `seconds` (0 =
     * start); `"relative"` moves by `seconds` (negative skips backward).
     */
    seek?(
      zoneOrOutput: string,
      how: "absolute" | "relative",
      seconds: number,
      cb?: (error: string | false) => void,
    ): void;
    /**
     * Change the volume of an output. Grouped zones may have outputs with
     * different volume systems, so callers should issue one call per output.
     */
    change_volume?(
      output: string | RoonOutput,
      how: RoonVolumeHow,
      value: number,
      cb?: (error: string | false) => void,
    ): void;
    /** Mute or unmute an output. */
    mute?(
      output: string | RoonOutput,
      how: "mute" | "unmute",
      cb?: (error: string | false) => void,
    ): void;
  }

  const _default: typeof RoonApiTransport;
  export default _default;
}
