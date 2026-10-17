export interface HmpHudPlayer {
    id: number;
    nickname?: string;
    emit(eventName: string, payloadJson?: string): void;
}

export type HmpHudYearMode = "school" | "calendar" | "both";
export type HmpHudInventoryMetric = "slots" | "weight";

export interface HmpHudYearBand {
    maxLevel: number;
    year: number;
}

export interface HmpHudClassDefinition {
    key?: string;
    subject: string;
    teacher?: string;
    location?: string;
    /** In-game clock "HH:MM". */
    start: string;
    /** In-game clock "HH:MM", same day, after start. */
    end: string;
    /** Optional map blip position (centimetres, game coordinates). */
    x?: number;
    y?: number;
    z?: number;
    areaId?: string;
}

export interface HmpHudYearTestConfig {
    enabled?: boolean;
    /** Chat command that runs the test (default "teste"). */
    command?: string;
    /** Class levels are read from hmp-progression talents named "<talentPrefix><classKey>". */
    talentPrefix?: string;
    /**
     * Required level per class key for each target year. The wizard level is gated too:
     * five levels per school year by default (Ano 2 -> lvl 5, Ano 3 -> lvl 10, ...) unless the
     * entry sets minLevel explicitly.
     */
    requirements?: { targetYear: number; minLevel?: number; classes: Record<string, number> }[];
}

export interface HmpHudConfig {
    updateIntervalMs?: number;
    inventoryRefreshMs?: number;
    money?: { enabled?: boolean; source?: "native" | "bank" | "auto"; item?: string; currency?: string; label?: string };
    inventory?: { enabled?: boolean; metric?: HmpHudInventoryMetric };
    health?: { enabled?: boolean; max?: number };
    xp?: { enabled?: boolean };
    /**
     * The hold-hide key: holding it steps the HUD aside — the game's item-wheel
     * key (default "tab"). The inventory toggle itself belongs to hmp-inventory
     * (its ui.key, default "i") and is never bound here, so the two never race
     * on the same edge. An empty string disables the hold-hide.
     */
    keybinds?: { hudHoldKey?: string };
    /**
     * Chat rendered inside the HUD: the native chat overlay is hidden through
     * Chat.setUIVisible and messages are drawn by the HUD page. openKey focuses
     * the HUD input; submitting goes through Chat.send (commands still work).
     */
    chat?: { enabled?: boolean; openKey?: string };
    /**
     * Native game menus disabled while the resource runs (the HUD is the menu
     * layer instead).
     * - mode "pause" (default): holds the whole Field Guide shut, so ESC and
     *   every page hotkey (N/Y/U/I/map/...) do nothing.
     * - mode "pages": disables only the listed Field Guide pages (map excluded),
     *   leaving ESC and the map hotkey working.
     * toolWheel also shuts the Tab tool wheel, actionScreen the T spell-set editor.
     */
    gameMenus?: {
        enabled?: boolean;
        mode?: "pause" | "pages";
        pages?: Array<"gear" | "inventory" | "talents" | "quests" | "mail" | "collections" | "challenges" | "settings">;
        toolWheel?: boolean;
        actionScreen?: boolean;
    };
    /**
     * Native game HUD suppression. While the HUD is shown every HUD group reported by
     * Hud.groups() is hidden through Hud.hideGroup, except groups whose (lowercase) name
     * contains one of keepGroups - by default only the map/minimap is kept.
     */
    gameHud?: { enabled?: boolean; keepGroups?: string[] };
    /** The /menu layout editor. */
    menu?: { enabled?: boolean; command?: string };
    /**
     * The nametag overlay: the marker above every player's head (character
     * name, house crest, health bar, voice badge) drawn by a dedicated
     * transparent web view instead of the engine nametag layer, which only
     * supports engine-font text. While it runs the engine nametags are hidden
     * (Nametags.setVisible(false)); they are restored when the resource stops.
     */
    nametags?: {
        enabled?: boolean;
        /** Marker reach in world centimetres (floor 3000 = 30 m, default 12000 = 120 m). */
        range?: number;
        /** How often the client asks the server for the nearby roster (ms, default 150). */
        tickMs?: number;
        /** Draw this player's own marker (default true). */
        showSelf?: boolean;
        /** Hide markers behind walls via camera-channel line traces (default false: a wall must not delete the name). */
        occlusion?: boolean;
        /**
         * Card height above the GROUND, in centimetres (default 185). The card
         * is terrain-anchored per player through a cached downward line trace,
         * so the character origin's own height (pelvis vs feet, per build)
         * never pushes the card off the head. Airborne players (brooms) fall
         * back to an origin-relative offset until they land.
         */
        height?: number;
        /**
         * Height of this player's own card above the ground, in centimetres
         * (default 185, same as `height`). The own card is clamped on-screen
         * and only drawn while the camera is away from the body (third person).
         */
        selfHeight?: number;
        /** Maximum number of markers drawn, nearest first (default 32). */
        maxMarkers?: number;
        /** Card text scale for the Cinzel face (default 1). */
        fontScale?: number;
        /** Override the horizontal camera FOV used for projection (0 = engine lens). */
        fov?: number;
        /** Projection axis calibration, for engine builds with rotated cameras. */
        flipYaw?: boolean;
        flipPitch?: boolean;
    };
    year?: {
        mode?: HmpHudYearMode;
        metadataKey?: string;
        bands?: HmpHudYearBand[];
        /** End-of-year tests gating the green light for the next school year. */
        tests?: HmpHudYearTestConfig;
    };
    classes?: {
        enabled?: boolean;
        showBlip?: boolean;
        items?: HmpHudClassDefinition[];
    };
}

export type HmpHudWidgetKey =
    | "world"
    | "year"
    | "stats"
    | "vitals"
    | "progress"
    | "classes"
    | "spells"
    | "house"
    | "chat";

/** Widget anchor as a percentage of the screen (top-left corner). */
export interface HmpHudLayoutPosition {
    x: number;
    y: number;
    /** Keep the widget horizontally centred (dragging turns this off). */
    centerX?: boolean;
}

export interface HmpHudLayout {
    version: 1;
    widgets: Partial<Record<HmpHudWidgetKey, HmpHudLayoutPosition>>;
}

export interface HmpHudClassInfo {
    key: string;
    subject: string;
    teacher: string | null;
    location: string | null;
    start: string;
    end: string;
    hasMapMarker: boolean;
    endsInMin?: number;
    startsInMin?: number;
}

/** One quick-action spell slot, read client-side from the native Spells API. */
export interface HmpHudSpell {
    slot: number;
    /** Display name ("" when the slot is empty). */
    name: string;
}

/** One class requirement of the end-of-year test. */
export interface HmpHudTestRequirement {
    key: string;
    subject: string;
    /** The player's current class level (or wizard level on the "level" row). */
    have: number;
    /** The level required to pass to targetYear. */
    need: number;
}

export interface HmpHudTestState {
    /** The school year this test gates. */
    targetYear: number;
    /** True when every requirement is met (green light). */
    eligible: boolean;
    requirements: HmpHudTestRequirement[];
}

export interface HmpHudTestResult {
    ok: boolean;
    /** The year granted when ok. */
    year?: number;
    reason?: "hud-inactive" | "tests-disabled" | "tests-not-configured" | "requirements-not-met" | "core-unavailable";
    test?: HmpHudTestState;
}

export type HmpHudHouseId = "gryffindor" | "hufflepuff" | "ravenclaw" | "slytherin";

/** House crest state: null while the character is unsorted (the page shows the mystery orb). */
export interface HmpHudHouseState {
    house: HmpHudHouseId;
}

export interface HmpHudState {
    active: boolean;
    character: { id: number; name: string } | null;
    /** This client's own player id (used for the nametag overlay's self marker). */
    playerId: number | null;
    /** The player's saved widget layout (null until they save one in /menu). */
    layout: HmpHudLayout | null;
    money: { amount: number; label: string } | null;
    inventory: {
        used: number;
        slots: number;
        weight: number;
        maxWeight: number;
        metric: HmpHudInventoryMetric;
    } | null;
    health: number | null;
    healthMax: number;
    /** True only while a playerDied/playerDowned event holds the bar at zero. */
    healthForced: boolean;
    xp: { level: number; points: number; start?: number | null; end?: number | null; fraction?: number | null } | null;
    /** Four quick-action spells of the active loadout (client-side native read; null until ready). */
    spells: HmpHudSpell[] | null;
    /** Voice chat state of this client (local native read; kept for the /voz flow and diagnostics). */
    voice: { enabled: boolean; hasMic: boolean | null; talking: boolean } | null;
    year: {
        school?: number;
        schoolLabel?: string;
        schoolSource?: "level" | "metadata";
        calendar?: { day: number | null; month: number | null; year: number | null };
    } | null;
    /** End-of-year test status driving the qualification light (null when tests are off). */
    test: HmpHudTestState | null;
    world: {
        time: string;
        hour: number;
        minute: number;
        minuteOfDay: number;
        weather: string;
        date: { day: number | null; month: number | null; year: number | null };
        season: string | null;
        timeScale: number;
    } | null;
    classes: { current: HmpHudClassInfo | null; next: HmpHudClassInfo | null } | null;
    /** The character's house (hmp-houses membership); null while unsorted. */
    house: HmpHudHouseState | null;
}

export interface HmpHudStatus {
    tracked: number;
    yearOverrides: number;
    updateIntervalMs: number;
    world: boolean;
    blips: boolean;
    gameHud: {
        enabled: boolean;
        keepGroups: string[];
    };
    menu: {
        enabled: boolean;
        command: string;
    };
    layouts: number;
    classes: {
        enabled: boolean;
        showBlip: boolean;
        items: number;
        blipActive: boolean;
    };
}

export interface HmpHud {
    /** Show the HUD immediately for a player with an active session (bypasses the spawn gate). */
    show(player: HmpHudPlayer): Promise<void>;
    /** Hide the HUD until the next spawn completes. */
    hide(player: HmpHudPlayer): void;
    /** Force a snapshot push; optionally restrict the refreshed parts. */
    refresh(player: HmpHudPlayer, parts?: string[]): Promise<boolean>;
    /**
     * Override the school year for the player's active character (persisted in character metadata).
     * Pass null to remove the override and fall back to level derivation.
     */
    setYearOverride(player: HmpHudPlayer, year: number | null): Promise<number | null>;
    /** Open the /menu layout editor for the player (shows the HUD if it is not active yet). */
    menu(player: HmpHudPlayer): Promise<boolean>;
    /** Run the end-of-year test: checks every class level and advances the year on a pass. */
    test(player: HmpHudPlayer): Promise<HmpHudTestResult>;
    status(): HmpHudStatus;
}
