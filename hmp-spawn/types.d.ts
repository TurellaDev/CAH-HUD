export interface HmpSpawnPlayer {
    id: number;
    position: { x: number; y: number; z: number };
    emit(eventName: string, payloadJson?: string): void;
    teleport(x: number, y: number, z: number, options?: HogwartsMpTeleportOptions): number;
    location?(): HogwartsMpPlayerLocation | null;
}

export interface HmpSpawnLocationDefinition {
    key: string;
    label: string;
    description?: string;
    x: number;
    y: number;
    z: number;
    /** Game coordinate space. Scoped destinations are hidden and rejected in other areas. */
    areaId?: string;
    /** Optional game-authored region scope within areaId. */
    regionId?: string;
    /** Last confirmed named fast-travel destination, when supplied by the Framework. */
    destinationId?: string | null;
    /** Final heading in degrees. Omit to preserve the player's current heading. */
    yaw?: number;
    /** Run capsule-aware downward placement after arrival. */
    snapToGround?: boolean;
    /** Downward ground search distance in centimetres; defaults to 2000. */
    groundSnapDistance?: number;
    /** Resource owner used for automatic cleanup when that resource stops. */
    resource?: string;
}

export interface HmpSpawnLocationInfo {
    key: string;
    label: string;
    description: string;
    kind: "configured" | "last" | string;
    areaId?: string;
    regionId?: string;
}

export interface HmpSpawnLocationsApi {
    register(location: HmpSpawnLocationDefinition): () => boolean;
    /** Built-in configuration locations cannot be unregistered at runtime. */
    unregister(key: string): boolean;
    list(): HmpSpawnLocationInfo[];
}

export interface HmpSpawnUiModel {
    character: { id: number; name: string };
    locations: HmpSpawnLocationInfo[];
    defaultLocation: string;
    /** Explanation shown when no destinations are currently available. */
    emptyMessage?: string;
}

export interface HmpSpawnUiApi<P extends HmpSpawnPlayer = HmpSpawnPlayer> {
    open(player: P): Promise<HmpSpawnUiModel>;
}

export interface HmpSpawnStatus {
    locations: number;
    pending: number;
    spawned: number;
}

export interface HmpSpawn<P extends HmpSpawnPlayer = HmpSpawnPlayer> {
    locations: HmpSpawnLocationsApi;
    ui: HmpSpawnUiApi<P>;
    spawn(player: P, destination: string | HmpSpawnLocationDefinition): Promise<number>;
    status(): HmpSpawnStatus;
}
