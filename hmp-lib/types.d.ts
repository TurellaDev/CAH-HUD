export interface HmpVector3Like {
    x: number;
    y: number;
    z: number;
}

export interface HmpPositionHolder {
    position: HmpVector3Like;
}

export interface HmpInputOwner {
    /** Owning resource; used for automatic cleanup when it stops. */
    resource: string;
    /** Unique lease or shortcut id within that resource. */
    id: string;
}

export interface HmpControlLease extends HmpInputOwner { release(): boolean }
export type HmpShortcutState = "down" | "up" | "both";

export interface HmpShortcutDefinition extends HmpInputOwner {
    key: string;
    state?: HmpShortcutState;
    /** Higher eligible priority owns the physical edge. Equal top priorities are rejected as ambiguous. */
    priority?: number;
    enabled?: boolean;
    /** Evaluated at the key edge; return true only while this shortcut is contextually available. */
    when?: () => boolean;
    handler(key: string, state: "down" | "up"): unknown;
}

export interface HmpShortcutInfo extends HmpInputOwner {
    key: string;
    state: HmpShortcutState;
    priority: number;
    enabled: boolean;
}

export interface HmpInputApi {
    controls: {
        acquire(owner: HmpInputOwner): HmpControlLease;
        release(owner: HmpInputOwner): boolean;
        held(owner?: HmpInputOwner): boolean;
        owners(): HmpInputOwner[];
    };
    shortcuts: {
        register(definition: HmpShortcutDefinition): () => boolean;
        unregister(id: string, resource?: string): boolean;
        setEnabled(id: string, enabled: boolean, resource?: string): boolean;
        rebind(id: string, key: string, resource?: string): boolean;
        get(id: string, resource?: string): HmpShortcutInfo | null;
        list(resource?: string): HmpShortcutInfo[];
        isDown(key: string): boolean;
    };
    /** Remove every lease and shortcut belonging to a resource. */
    cleanup(resource: string): number;
    status(): { controlOwners: number; shortcuts: number; physicalKeys: number; conflicts: number };
}

export interface HmpTextCleanOptions {
    maxLength?: number;
    multiline?: boolean;
    maxLines?: number;
}

export interface HmpTextApi {
    clean(value: unknown, options?: number | HmpTextCleanOptions): string;
    slug(value: unknown, maxLength?: number): string;
    isId(value: unknown): value is string;
    truncate(value: unknown, maxLength?: number, suffix?: string): string;
}

export interface HmpNumberApi {
    finite(value: unknown, fallback?: number): number;
    integer(value: unknown, fallback?: number): number;
    clamp(value: unknown, minimum: number, maximum: number): number;
    between(value: unknown, minimum: number, maximum: number, inclusive?: boolean): boolean;
}

export interface HmpPositionApi {
    read(value: HmpVector3Like | HmpPositionHolder | unknown): HmpVector3Like | null;
    distance(left: HmpVector3Like | HmpPositionHolder, right: HmpVector3Like | HmpPositionHolder): number;
    distanceSquared(left: HmpVector3Like | HmpPositionHolder, right: HmpVector3Like | HmpPositionHolder): number;
    within(left: HmpVector3Like | HmpPositionHolder, right: HmpVector3Like | HmpPositionHolder, radius: number): boolean;
}

export interface HmpStringValidationOptions {
    name?: string;
    trim?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
}

export interface HmpNumberValidationOptions {
    name?: string;
    coerce?: boolean;
    integer?: boolean;
    min?: number;
    max?: number;
}

export interface HmpBooleanValidationOptions {
    name?: string;
    coerce?: boolean;
}

export interface HmpArrayValidationOptions<T> {
    name?: string;
    minLength?: number;
    maxLength?: number;
    item?: (value: unknown, options: { name: string }) => T;
}

export interface HmpValidationApi {
    isObject(value: unknown): value is Record<string, unknown>;
    isPlainObject(value: unknown): value is Record<string, unknown>;
    string(value: unknown, options?: HmpStringValidationOptions): string;
    number(value: unknown, options?: HmpNumberValidationOptions): number;
    boolean(value: unknown, options?: HmpBooleanValidationOptions): boolean;
    array<T = unknown>(value: unknown, options?: HmpArrayValidationOptions<T>): T[];
    object<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown, options?: { name?: string; plain?: boolean }): T;
    oneOf<T>(value: T, allowed: Iterable<T>, options?: { name?: string }): T;
    optional<T>(parser: (value: unknown, options?: unknown) => T, defaultValue: T): (value: unknown, options?: unknown) => T;
    assert<T>(value: T, predicate: (value: T) => boolean, message?: string): T;
}

export interface HmpRateLimitResult<K = unknown> {
    key: K;
    allowed: boolean;
    limit: number;
    used: number;
    remaining: number;
    dropped: number;
    resetAt: number;
}

export interface HmpRateLimiter<K = unknown> {
    allow(key?: K, cost?: number): boolean;
    take(key?: K, cost?: number): HmpRateLimitResult<K>;
    check(key?: K): HmpRateLimitResult<K>;
    reset(key?: K): boolean;
    clear(): void;
    sweep(maxIdleMs?: number): number;
    status(): { limit: number; windowMs: number; buckets: number };
}

export interface HmpRateLimitApi {
    create<K = string>(options: {
        limit: number;
        windowMs: number;
        now?: () => number;
        onDrop?: (result: HmpRateLimitResult<K>) => void;
    }): HmpRateLimiter<K>;
}

export interface HmpLocale {
    t(key: string, params?: Record<string, unknown>, localeOverride?: string): string;
    has(key: string, localeOverride?: string): boolean;
    add(locale: string, messages: Record<string, unknown>): void;
    setLocale(locale: string): string;
    getLocale(): string;
    available(): string[];
}

export interface HmpLocaleApi {
    create(dictionaries?: Record<string, Record<string, unknown>>, options?: {
        locale?: string;
        fallback?: string;
        missing?: string | ((key: string, locale: string) => string);
    }): HmpLocale;
}

export type HmpLogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface HmpLogger {
    debug(...args: unknown[]): boolean;
    info(...args: unknown[]): boolean;
    warn(...args: unknown[]): boolean;
    error(...args: unknown[]): boolean;
    enabled(level: HmpLogLevel): boolean;
    setLevel(level: HmpLogLevel): void;
    child(name: string, context?: Record<string, unknown>): HmpLogger;
}

export interface HmpLoggerApi {
    readonly levels: Readonly<Record<HmpLogLevel, number>>;
    create(name: string, options?: {
        level?: HmpLogLevel;
        sink?: Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
        context?: Record<string, unknown>;
    }): HmpLogger;
}

export interface HmpConfigApi {
    load<T extends Record<string, unknown>>(candidates: string | string[], options?: {
        cwd?: string;
        defaults?: Partial<T>;
        required?: boolean;
        fresh?: boolean;
        validate?: (config: T, source: string) => boolean | void;
    }): T;
    merge<T extends Record<string, unknown>>(...sources: Array<Partial<T> | null | undefined>): T;
    env: {
        boolean(value: unknown, fallback?: boolean): boolean;
        number(value: unknown, fallback?: number, options?: { integer?: boolean; min?: number; max?: number }): number | undefined;
        json<T = unknown>(value: unknown, fallback?: T): T;
    };
}

export interface HmpPlayerLike {
    id: number;
    nickname: string;
    connected?: boolean;
    position?: HmpVector3Like;
    sendChat?(message: string): void;
}

export type HmpPlayerResolutionReason = "found" | "empty" | "not-found" | "ambiguous" | "self-unavailable";

export interface HmpPlayerResolution<P extends HmpPlayerLike = HmpPlayerLike> {
    ok: boolean;
    player: P | null;
    reason: HmpPlayerResolutionReason;
    candidates: P[];
}

export interface HmpPlayerApi<P extends HmpPlayerLike = HmpPlayerLike> {
    all(): P[];
    byId(id: number | string): P | null;
    resolve(query: string | number | P, self?: P | null, options?: { allowSelf?: boolean; caseSensitive?: boolean }): HmpPlayerResolution<P>;
    find(query: string | number | P, self?: P | null, options?: { allowSelf?: boolean; caseSensitive?: boolean }): P | null;
    format(player: P | null): string;
}

export interface HmpCommandContext<P extends HmpPlayerLike = HmpPlayerLike> {
    player: P;
    message: string;
    command: string;
    invokedAs: string;
    args: string[];
    usage: string;
    reply(message: unknown): boolean;
    resolvePlayer(query: string | number | P, options?: { allowSelf?: boolean; caseSensitive?: boolean }): HmpPlayerResolution<P>;
    findPlayer(query: string | number | P, options?: { allowSelf?: boolean; caseSensitive?: boolean }): P | null;
}

export interface HmpCommandDescription {
    name: string;
    aliases: string[];
    description: string;
    usage: string;
}

export interface HmpCommandRouter<P extends HmpPlayerLike = HmpPlayerLike> {
    register(name: string, handler: (context: HmpCommandContext<P>) => unknown): () => boolean;
    register(name: string, options: {
        aliases?: string[];
        description?: string;
        usage?: string;
        guard?: (context: HmpCommandContext<P>) => true | false | string | Promise<true | false | string>;
        errorMessage?: string | false;
    }, handler: (context: HmpCommandContext<P>) => unknown): () => boolean;
    unregister(name: string): boolean;
    get(name: string): HmpCommandDescription | null;
    handle(player: P, message: string, command: string, args: string[]): Promise<boolean>;
    list(): HmpCommandDescription[];
}

export interface HmpCommandApi<P extends HmpPlayerLike = HmpPlayerLike> {
    createRouter(options?: { prefix?: string; logger?: Pick<HmpLogger, "error"> }): HmpCommandRouter<P>;
}

export interface HmpLibClient {
    text: HmpTextApi;
    number: HmpNumberApi;
    position: HmpPositionApi;
    validation: HmpValidationApi;
    rateLimit: HmpRateLimitApi;
    locale: HmpLocaleApi;
    logger: HmpLoggerApi;
    input: HmpInputApi;
}

export interface HmpLibServer<P extends HmpPlayerLike = HmpPlayerLike> extends Omit<HmpLibClient, "input"> {
    config: HmpConfigApi;
    player: HmpPlayerApi<P>;
    command: HmpCommandApi<P>;
}
