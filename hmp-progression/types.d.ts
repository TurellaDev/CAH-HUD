import type { HmpCoreCharacter } from "../hmp-core/types";

export interface HmpProgressionPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    sendChat?(message: string): void;
    emit?(eventName: string, payload?: string): void;
}

export interface HmpProgressionProfile {
    characterId: number;
    experiencePoints: number;
    level: number;
    talentPoints: number;
    revision: number;
    appliedRevision: number;
    createdAt: string | Date;
    updatedAt: string | Date;
}

export type HmpProgressionOperation = "add" | "set";

export interface HmpProgressionRewardTransaction {
    id: number;
    reference: string;
    characterId: number;
    operation: HmpProgressionOperation;
    amount: number;
    balanceBefore: number | null;
    balanceAfter: number | null;
    actorCharacterId: number | null;
    resource: string;
    reason: string;
    metadata: Record<string, unknown>;
    status: "pending" | "completed" | "failed";
    error: string;
    createdAt: string | Date;
    completedAt: string | Date | null;
}

export interface HmpProgressionMutationOptions<P = HmpProgressionPlayer> {
    reference: string;
    resource: string;
    actor?: P | number | null;
    reason?: string;
    metadata?: Record<string, unknown>;
}

export interface HmpProgressionApi<P = HmpProgressionPlayer> {
    get(target: P | number): Promise<HmpProgressionProfile>;
    add(target: P | number, points: number, options: HmpProgressionMutationOptions<P>): Promise<HmpProgressionRewardTransaction>;
    set(target: P | number, points: number, options: HmpProgressionMutationOptions<P>): Promise<HmpProgressionRewardTransaction>;
    setLevel(target: P, level: number, options: HmpProgressionMutationOptions<P>): Promise<HmpProgressionRewardTransaction>;
    transaction(reference: string): Promise<HmpProgressionRewardTransaction | null>;
    history(characterId: number, limit?: number): Promise<HmpProgressionRewardTransaction[]>;
    pending(limit?: number): Promise<HmpProgressionRewardTransaction[]>;
    recover(reference: string): Promise<HmpProgressionRewardTransaction>;
    sync(player: P): Promise<HmpProgressionProfile>;
}

export type HmpTalentStatus = "owned" | "revoked";
export type HmpTalentAcquisition = "grant" | "purchase";

export interface HmpManagedTalent {
    characterId: number;
    talentId: string;
    level: number;
    status: HmpTalentStatus;
    acquisition: HmpTalentAcquisition;
    actorCharacterId: number | null;
    resource: string;
    reason: string;
    createdAt: string | Date;
    updatedAt: string | Date;
}

export interface HmpTalentMutationOptions<P = HmpProgressionPlayer> {
    resource: string;
    actor?: P | number | null;
    reason?: string;
}

export interface HmpTalentsApi<P = HmpProgressionPlayer> {
    list(target: P | number, includeRevoked?: boolean): Promise<HmpManagedTalent[]>;
    grant(target: P | number, talentId: string, level: number | undefined, options: HmpTalentMutationOptions<P>): Promise<HmpManagedTalent>;
    purchase(player: P, talentId: string, options: HmpTalentMutationOptions<P>): Promise<HmpManagedTalent>;
    revoke(target: P | number, talentId: string, options: HmpTalentMutationOptions<P>): Promise<HmpManagedTalent>;
    reset(target: P | number, options: HmpTalentMutationOptions<P>): Promise<number>;
    setPoints(target: P | number, points: number, options: HmpTalentMutationOptions<P>): Promise<HmpProgressionProfile>;
}

export interface HmpProgressionStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    syncedPlayers: number;
    pendingTransactions: number;
    pendingNativeRequests: number;
    uptimeMs: number;
}

export interface HmpProgression<P = HmpProgressionPlayer> {
    progression: HmpProgressionApi<P>;
    talents: HmpTalentsApi<P>;
    status(): HmpProgressionStatus;
}

export interface HmpProgressionChangedEvent<P = HmpProgressionPlayer> {
    player: P | null;
    character: HmpCoreCharacter | null;
    profile: HmpProgressionProfile;
    transaction?: HmpProgressionRewardTransaction;
}
