"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// server/config.ts
var require_config = __commonJS({
  "server/config.ts"(exports2, module2) {
    "use strict";
    function clean(value, label, maximum = 64) {
      const result = String(value || "").trim();
      if (!result || result.length > maximum) throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
      return result;
    }
    function bounded(value, fallback, minimum, maximum) {
      const result = Number(value);
      return Number.isSafeInteger(result) && result >= minimum && result <= maximum ? result : fallback;
    }
    function loadConfig2(Hmp2, options = {}) {
      const env = options.env || process.env;
      const defaults = {
        enableCommands: true,
        command: "progression",
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        maximumExperience: 1e8,
        maximumTalentPoints: 100,
        nativeRequestTimeoutMs: 8e3
      };
      const loaded = Hmp2.config.load(env.HMP_PROGRESSION_CONFIG || "data/hmp-progression.json", {
        cwd: options.cwd || process.cwd(),
        defaults
      });
      if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-progression adminGroups must be an array");
      return {
        enableCommands: env.HMP_PROGRESSION_COMMANDS === void 0 ? loaded.enableCommands !== false : Hmp2.config.env.boolean(env.HMP_PROGRESSION_COMMANDS, true),
        command: clean(env.HMP_PROGRESSION_COMMAND || loaded.command || "progression", "progression command").toLowerCase(),
        adminGroups: loaded.adminGroups.map((entry, index) => ({
          key: clean(entry?.key, `admin group ${index} key`).toLowerCase(),
          minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0
        })),
        maximumExperience: bounded(loaded.maximumExperience, defaults.maximumExperience, 1, Number.MAX_SAFE_INTEGER),
        maximumTalentPoints: bounded(loaded.maximumTalentPoints, defaults.maximumTalentPoints, 1, 1e4),
        nativeRequestTimeoutMs: bounded(loaded.nativeRequestTimeoutMs, defaults.nativeRequestTimeoutMs, 1e3, 6e4)
      };
    }
    module2.exports = { loadConfig: loadConfig2 };
  }
});

// server/repository.ts
var require_repository = __commonJS({
  "server/repository.ts"(exports2, module2) {
    "use strict";
    function integer(value, label) {
      const result = Number(value);
      if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the JavaScript safe integer range`);
      return result;
    }
    function parseMetadata(raw) {
      if (!raw) return {};
      try {
        const value = JSON.parse(raw);
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    }
    function mapProfile(row) {
      return {
        characterId: integer(row.character_id, "progression character id"),
        experiencePoints: integer(row.experience_points, "experience points"),
        level: integer(row.native_level, "native level"),
        talentPoints: integer(row.talent_points, "talent points"),
        revision: integer(row.revision, "progression revision"),
        appliedRevision: integer(row.applied_revision, "applied progression revision"),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
    function mapReward(row) {
      return {
        id: integer(row.id, "progression reward id"),
        reference: row.reference_id,
        characterId: integer(row.character_id, "progression reward character id"),
        operation: row.operation,
        amount: integer(row.amount, "progression reward amount"),
        balanceBefore: row.balance_before === null ? null : integer(row.balance_before, "progression balance before"),
        balanceAfter: row.balance_after === null ? null : integer(row.balance_after, "progression balance after"),
        actorCharacterId: row.actor_character_id === null ? null : integer(row.actor_character_id, "progression actor id"),
        resource: row.source_resource,
        reason: row.reason_text || "",
        metadata: parseMetadata(row.metadata_json),
        status: row.status,
        error: row.error_text || "",
        createdAt: row.created_at,
        completedAt: row.completed_at
      };
    }
    function mapTalent(row) {
      return {
        characterId: integer(row.character_id, "talent character id"),
        talentId: row.talent_id,
        level: integer(row.talent_level, "talent level"),
        status: row.status,
        acquisition: row.acquisition,
        actorCharacterId: row.actor_character_id === null ? null : integer(row.actor_character_id, "talent actor id"),
        resource: row.source_resource,
        reason: row.reason_text || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
    function createRepository2(database2) {
      if (!database2 || typeof database2.transaction !== "function") throw new TypeError("database API is required");
      async function ensureProfile(tx, characterId) {
        await tx.update("INSERT IGNORE INTO hmp_progression_profiles (character_id) VALUES (?)", [characterId]);
      }
      async function profile(characterId, tx = database2, lock = false) {
        await ensureProfile(tx, characterId);
        const row = await tx.single(`SELECT * FROM hmp_progression_profiles WHERE character_id = ?${lock ? " FOR UPDATE" : ""}`, [characterId]);
        if (!row) throw new Error(`progression profile for character ${characterId} could not be initialized`);
        return mapProfile(row);
      }
      async function reward(reference, tx = database2, lock = false) {
        const row = await tx.single(`SELECT * FROM hmp_progression_rewards WHERE reference_id = ?${lock ? " FOR UPDATE" : ""}`, [reference]);
        return row ? mapReward(row) : null;
      }
      async function beginReward(draft) {
        const created = await database2.update(
          `INSERT IGNORE INTO hmp_progression_rewards
                (reference_id, character_id, operation, amount, actor_character_id, source_resource, reason_text, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [draft.reference, draft.characterId, draft.operation, draft.amount, draft.actorCharacterId, draft.resource, draft.reason, JSON.stringify(draft.metadata)]
        ) > 0;
        const transaction = await reward(draft.reference);
        if (!transaction) throw new Error(`progression reward '${draft.reference}' was not found`);
        return { created, transaction };
      }
      async function applyReward(referenceId, maximumExperience) {
        return database2.transaction(async (tx) => {
          const transaction = await reward(referenceId, tx, true);
          if (!transaction) throw new Error(`progression reward '${referenceId}' was not found`);
          if (transaction.status === "completed") return transaction;
          if (transaction.status === "failed") throw new Error(`progression reward '${referenceId}' failed: ${transaction.error}`);
          const current = await profile(transaction.characterId, tx, true);
          const next = transaction.operation === "set" ? transaction.amount : current.experiencePoints + transaction.amount;
          if (!Number.isSafeInteger(next) || next < 0 || next > maximumExperience) throw new Error(`experience balance must remain between 0 and ${maximumExperience}`);
          await tx.update("UPDATE hmp_progression_profiles SET experience_points = ?, revision = revision + 1 WHERE character_id = ?", [next, transaction.characterId]);
          await tx.update("UPDATE hmp_progression_rewards SET status = 'completed', balance_before = ?, balance_after = ?, completed_at = CURRENT_TIMESTAMP WHERE reference_id = ?", [current.experiencePoints, next, referenceId]);
          return await reward(referenceId, tx, true);
        });
      }
      async function failReward(referenceId, error) {
        await database2.update("UPDATE hmp_progression_rewards SET status = 'failed', error_text = ?, completed_at = CURRENT_TIMESTAMP WHERE reference_id = ? AND status = 'pending'", [String(error || "unknown error").slice(0, 191), referenceId]);
        const transaction = await reward(referenceId);
        if (!transaction) throw new Error(`progression reward '${referenceId}' was not found`);
        return transaction;
      }
      async function rewardHistory(characterId, limit) {
        return (await database2.query(`SELECT * FROM hmp_progression_rewards WHERE character_id = ? ORDER BY id DESC LIMIT ${limit}`, [characterId])).map(mapReward);
      }
      async function pendingRewards(limit) {
        return (await database2.query(`SELECT * FROM hmp_progression_rewards WHERE status = 'pending' ORDER BY id LIMIT ${limit}`)).map(mapReward);
      }
      async function acknowledge(characterId, revision, level, talentPoints) {
        await database2.update(
          "UPDATE hmp_progression_profiles SET native_level = ?, talent_points = ?, applied_revision = ? WHERE character_id = ? AND revision = ? AND applied_revision <= ?",
          [level, talentPoints, revision, characterId, revision, revision]
        );
        return profile(characterId);
      }
      async function talents(characterId, includeRevoked) {
        const rows = await database2.query(`SELECT * FROM hmp_progression_talents WHERE character_id = ?${includeRevoked ? "" : " AND status = 'owned'"} ORDER BY talent_id`, [characterId]);
        return rows.map(mapTalent);
      }
      async function talent(characterId, talentId, tx = database2, lock = false) {
        const row = await tx.single(`SELECT * FROM hmp_progression_talents WHERE character_id = ? AND talent_id = ?${lock ? " FOR UPDATE" : ""}`, [characterId, talentId]);
        return row ? mapTalent(row) : null;
      }
      async function writeTalent(tx, mutation) {
        await tx.update(
          `INSERT INTO hmp_progression_talents
                (character_id, talent_id, talent_level, status, acquisition, actor_character_id, source_resource, reason_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE talent_level = VALUES(talent_level), status = VALUES(status), acquisition = VALUES(acquisition), actor_character_id = VALUES(actor_character_id), source_resource = VALUES(source_resource), reason_text = VALUES(reason_text)`,
          [mutation.characterId, mutation.talentId, mutation.level, mutation.status, mutation.acquisition, mutation.actorCharacterId, mutation.resource, mutation.reason]
        );
      }
      async function mutateTalent(mutation) {
        return database2.transaction(async (tx) => {
          await profile(mutation.characterId, tx, true);
          await writeTalent(tx, mutation);
          await tx.update("UPDATE hmp_progression_profiles SET revision = revision + 1 WHERE character_id = ?", [mutation.characterId]);
          return await talent(mutation.characterId, mutation.talentId, tx, true);
        });
      }
      async function purchaseTalent(mutation) {
        return database2.transaction(async (tx) => {
          const existing = await talent(mutation.characterId, mutation.talentId, tx, true);
          if (existing?.status === "owned") return existing;
          const current = await profile(mutation.characterId, tx, true);
          if (current.talentPoints < 1) throw new Error("No Foundations talent points are available");
          await writeTalent(tx, { ...mutation, status: "owned", acquisition: "purchase" });
          await tx.update("UPDATE hmp_progression_profiles SET talent_points = talent_points - 1, revision = revision + 1 WHERE character_id = ?", [mutation.characterId]);
          return await talent(mutation.characterId, mutation.talentId, tx, true);
        });
      }
      async function resetTalents(characterId, mutation) {
        return database2.transaction(async (tx) => {
          await profile(characterId, tx, true);
          const changed = await tx.update(
            "UPDATE hmp_progression_talents SET status = 'revoked', actor_character_id = ?, source_resource = ?, reason_text = ? WHERE character_id = ? AND status = 'owned'",
            [mutation.actorCharacterId, mutation.resource, mutation.reason, characterId]
          );
          if (changed > 0) await tx.update("UPDATE hmp_progression_profiles SET revision = revision + 1 WHERE character_id = ?", [characterId]);
          return changed;
        });
      }
      async function setTalentPoints(characterId, points) {
        return database2.transaction(async (tx) => {
          const current = await profile(characterId, tx, true);
          if (current.talentPoints !== points) await tx.update("UPDATE hmp_progression_profiles SET talent_points = ?, revision = revision + 1 WHERE character_id = ?", [points, characterId]);
          return profile(characterId, tx, true);
        });
      }
      return Object.freeze({
        migrate: (migrations2) => database2.migrate("hmp-progression", migrations2),
        profile,
        reward,
        beginReward,
        applyReward,
        failReward,
        rewardHistory,
        pendingRewards,
        acknowledge,
        talents,
        talent,
        mutateTalent,
        purchaseTalent,
        resetTalents,
        setTalentPoints
      });
    }
    module2.exports = { createRepository: createRepository2, mapProfile, mapReward, mapTalent };
  }
});

// server/schema.ts
var require_schema = __commonJS({
  "server/schema.ts"(exports2, module2) {
    "use strict";
    var migrations2 = [
      {
        version: 1,
        name: "create character progression, reward, and managed talent ledgers",
        statements: [
          `CREATE TABLE IF NOT EXISTS hmp_progression_profiles (
                character_id BIGINT UNSIGNED NOT NULL,
                experience_points BIGINT UNSIGNED NOT NULL DEFAULT 0,
                native_level SMALLINT UNSIGNED NOT NULL DEFAULT 1,
                talent_points INT UNSIGNED NOT NULL DEFAULT 0,
                revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                applied_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id),
                CONSTRAINT fk_hmp_progression_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_progression_rewards (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                reference_id VARCHAR(96) NOT NULL,
                character_id BIGINT UNSIGNED NOT NULL,
                operation VARCHAR(8) NOT NULL,
                amount BIGINT NOT NULL,
                balance_before BIGINT UNSIGNED NULL,
                balance_after BIGINT UNSIGNED NULL,
                actor_character_id BIGINT UNSIGNED NULL,
                source_resource VARCHAR(64) NOT NULL,
                reason_text VARCHAR(191) NOT NULL DEFAULT '',
                metadata_json LONGTEXT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'pending',
                error_text VARCHAR(191) NOT NULL DEFAULT '',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL DEFAULT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_hmp_progression_reward_reference (reference_id),
                KEY idx_hmp_progression_reward_character (character_id, id),
                KEY idx_hmp_progression_reward_status (status, id),
                CONSTRAINT fk_hmp_progression_reward_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE,
                CONSTRAINT fk_hmp_progression_reward_actor FOREIGN KEY (actor_character_id) REFERENCES hmp_characters (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_progression_talents (
                character_id BIGINT UNSIGNED NOT NULL,
                talent_id VARCHAR(128) NOT NULL,
                talent_level SMALLINT UNSIGNED NOT NULL DEFAULT 1,
                status VARCHAR(16) NOT NULL DEFAULT 'owned',
                acquisition VARCHAR(16) NOT NULL DEFAULT 'grant',
                actor_character_id BIGINT UNSIGNED NULL,
                source_resource VARCHAR(64) NOT NULL,
                reason_text VARCHAR(191) NOT NULL DEFAULT '',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id, talent_id),
                KEY idx_hmp_progression_talents_status (character_id, status),
                CONSTRAINT fk_hmp_progression_talent_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE,
                CONSTRAINT fk_hmp_progression_talent_actor FOREIGN KEY (actor_character_id) REFERENCES hmp_characters (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
        ]
      }
    ];
    module2.exports = { migrations: migrations2 };
  }
});

// shared/normalize.ts
var require_normalize = __commonJS({
  "shared/normalize.ts"(exports2, module2) {
    "use strict";
    function clean(value, label, maximum = 96) {
      const result = String(value || "").trim();
      if (!result || result.length > maximum) throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
      return result;
    }
    function positiveId(value, label) {
      const result = Number(value);
      if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive safe integer`);
      return result;
    }
    function nonNegative(value, label, maximum = Number.MAX_SAFE_INTEGER) {
      const result = Number(value);
      if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new TypeError(`${label} must be a non-negative safe integer no greater than ${maximum}`);
      return result;
    }
    function signed(value, label, maximum = Number.MAX_SAFE_INTEGER) {
      const result = Number(value);
      if (!Number.isSafeInteger(result) || result === 0 || Math.abs(result) > maximum) throw new TypeError(`${label} must be a non-zero safe integer between ${-maximum} and ${maximum}`);
      return result;
    }
    function limit(value, fallback = 50) {
      const result = Number(value);
      return Number.isSafeInteger(result) && result > 0 ? Math.min(result, 200) : fallback;
    }
    function reference(value) {
      const result = clean(value, "progression reference", 96);
      if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new TypeError("progression reference may contain only letters, numbers, dot, underscore, colon, and dash");
      return result;
    }
    function talentId(value) {
      const result = clean(value, "talent id", 128);
      if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new TypeError("talent id contains unsupported characters");
      return result;
    }
    function metadata(value) {
      if (value === void 0 || value === null) return {};
      if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("metadata must be an object");
      const encoded = JSON.stringify(value);
      if (encoded.length > 16384) throw new TypeError("metadata must serialize to at most 16384 characters");
      return JSON.parse(encoded);
    }
    module2.exports = { clean, positiveId, nonNegative, signed, limit, reference, talentId, metadata };
  }
});

// server/service.ts
var require_service = __commonJS({
  "server/service.ts"(exports2, module2) {
    "use strict";
    var normalizeModule = require_normalize();
    var { clean, positiveId, nonNegative, signed, limit, reference, talentId, metadata } = normalizeModule;
    var messageOf2 = (error) => error instanceof Error ? error.message : String(error);
    function payloadObject(payload) {
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return null;
        }
      }
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    }
    function createProgressionService2(dependencies) {
      const { repository: repository2, core: core2, events, logger: logger2, config: config2, migrations: migrations2 } = dependencies;
      const now = dependencies.now || Date.now;
      const setTimer = dependencies.setTimer || setTimeout;
      const clearTimer = dependencies.clearTimer || clearTimeout;
      const startedAt = now();
      const syncedPlayers = /* @__PURE__ */ new Set();
      const pendingNative = /* @__PURE__ */ new Map();
      let requestSequence = 0;
      let state = "starting";
      let lastError = "";
      let pendingTransactions = 0;
      let startPromise = null;
      function start() {
        if (state === "stopped") return Promise.reject(new Error("hmp-progression is stopped"));
        if (startPromise) return startPromise;
        state = "starting";
        startPromise = repository2.migrate(migrations2).then(async () => {
          pendingTransactions = (await repository2.pendingRewards(200)).length;
          state = "ready";
          lastError = "";
        }).catch((error) => {
          state = "degraded";
          lastError = messageOf2(error).slice(0, 191);
          throw error;
        });
        return startPromise;
      }
      function playerId(player) {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0 || typeof player.emit !== "function") throw new TypeError("a connected player is required");
        return id;
      }
      function activeCharacter(player) {
        playerId(player);
        const character = core2.characters.active(player);
        if (!character) throw new Error("Select a character before using progression");
        return character;
      }
      function characterId(target) {
        return typeof target === "number" ? positiveId(target, "character id") : activeCharacter(target).id;
      }
      function actorCharacterId(actor) {
        return actor === void 0 || actor === null ? null : characterId(actor);
      }
      function onlinePlayer(id) {
        return core2.sessions.all().find((session) => session.character?.id === id)?.player || null;
      }
      async function syncOnline(id) {
        const player = onlinePlayer(id);
        if (!player) return null;
        await sync(player);
        return onlinePlayer(id);
      }
      function emit(eventName, payload) {
        void Promise.resolve(events.emit(eventName, payload)).catch((error) => {
          const errors = error && typeof error === "object" && Array.isArray(error.errors) ? error.errors : [error];
          logger2.warn(`A ${eventName} listener failed: ${errors.map(messageOf2).join("; ")}`);
        });
      }
      function resource(value) {
        return clean(value, "source resource", 64);
      }
      function reason(value) {
        return String(value || "").trim().slice(0, 191);
      }
      async function sync(player) {
        await start();
        const character = activeCharacter(player);
        const profile = await repository2.profile(character.id);
        const talents = await repository2.talents(character.id, true);
        player.emit("hmp-progression:sync", JSON.stringify({
          characterId: character.id,
          revision: profile.revision,
          experiencePoints: profile.experiencePoints,
          talentPoints: profile.talentPoints,
          preserveTalentPoints: profile.appliedRevision >= profile.revision,
          talents: talents.map((entry) => ({ id: entry.talentId, level: entry.level, status: entry.status }))
        }));
        syncedPlayers.add(playerId(player));
        return profile;
      }
      function draft(target, operation, rawAmount, options) {
        if (!options) throw new TypeError("progression mutation options are required");
        const amount = operation === "add" ? signed(rawAmount, "experience adjustment", config2.maximumExperience) : nonNegative(rawAmount, "experience target", config2.maximumExperience);
        return {
          reference: reference(options.reference),
          characterId: characterId(target),
          operation,
          amount,
          actorCharacterId: actorCharacterId(options.actor),
          resource: resource(options.resource),
          reason: reason(options.reason),
          metadata: metadata(options.metadata)
        };
      }
      function assertReplay(transaction, expected) {
        if (transaction.characterId !== expected.characterId || transaction.operation !== expected.operation || transaction.amount !== expected.amount || transaction.actorCharacterId !== expected.actorCharacterId || transaction.resource !== expected.resource) {
          throw Object.assign(new Error(`Progression reference '${expected.reference}' was reused for a different operation`), { code: "HMP_PROGRESSION_REFERENCE" });
        }
      }
      async function mutate(target, operation, amount, options) {
        await start();
        const expected = draft(target, operation, amount, options);
        const begun = await repository2.beginReward(expected);
        assertReplay(begun.transaction, expected);
        if (begun.transaction.status === "failed") throw new Error(`Progression reward '${expected.reference}' failed: ${begun.transaction.error}`);
        const shouldEmit = begun.transaction.status !== "completed";
        let transaction;
        try {
          transaction = shouldEmit ? await repository2.applyReward(expected.reference, config2.maximumExperience) : begun.transaction;
        } catch (error) {
          if (begun.transaction.status === "pending") await repository2.failReward(expected.reference, messageOf2(error));
          pendingTransactions = (await repository2.pendingRewards(200)).length;
          throw error;
        }
        pendingTransactions = (await repository2.pendingRewards(200)).length;
        const synced = onlinePlayer(expected.characterId);
        const profile = synced ? await sync(synced) : await repository2.profile(expected.characterId);
        const player = synced && onlinePlayer(expected.characterId);
        if (shouldEmit) emit("hmp:progression:changed", { player, character: player ? core2.characters.active(player) : null, profile, transaction });
        return transaction;
      }
      function requestNative(player, operation, data) {
        const id = `${playerId(player).toString(36)}:${now().toString(36)}:${(++requestSequence).toString(36)}`;
        return new Promise((resolve, reject) => {
          const timer = setTimer(() => {
            pendingNative.delete(id);
            reject(new Error(`Native ${operation} request timed out`));
          }, config2.nativeRequestTimeoutMs);
          pendingNative.set(id, { playerId: playerId(player), operation, resolve, reject, timer });
          player.emit("hmp-progression:request", JSON.stringify({ requestId: id, operation, ...data }));
        });
      }
      async function nativeResult(player, rawPayload) {
        const payload = payloadObject(rawPayload);
        if (!payload) return;
        const requestId = String(payload.requestId || "");
        const pending = pendingNative.get(requestId);
        if (!pending || pending.playerId !== playerId(player) || pending.operation !== String(payload.operation || "")) return;
        pendingNative.delete(requestId);
        clearTimer(pending.timer);
        pending.resolve(payload);
      }
      async function nativeReport(player, rawPayload) {
        const payload = payloadObject(rawPayload);
        if (!payload) return;
        const character = activeCharacter(player);
        const id = playerId(player);
        if (Number(payload.characterId) !== character.id) return;
        const revision = nonNegative(payload.revision, "native revision");
        const points = nonNegative(payload.experiencePoints, "native experience", config2.maximumExperience);
        const level = nonNegative(payload.level, "native level", 40);
        const talentPoints = nonNegative(payload.talentPoints, "native talent points", config2.maximumTalentPoints);
        if (level < 1) return;
        const current = await repository2.profile(character.id);
        if (revision !== current.revision || points !== current.experiencePoints) return;
        const profile = await repository2.acknowledge(character.id, revision, level, talentPoints);
        const online = onlinePlayer(character.id);
        if (!online || Number(online.id) !== id) return;
        emit("hmp:progression:synchronized", { player: online, character, profile });
      }
      function talentMutation(target, rawTalentId, rawLevel, status, acquisition, options) {
        if (!options) throw new TypeError("talent mutation options are required");
        const level = rawLevel === void 0 ? 1 : nonNegative(rawLevel, "talent level", 255);
        if (level < 1) throw new TypeError("talent level must be at least 1");
        return {
          characterId: characterId(target),
          talentId: talentId(rawTalentId),
          level,
          status,
          acquisition,
          actorCharacterId: actorCharacterId(options.actor),
          resource: resource(options.resource),
          reason: reason(options.reason)
        };
      }
      async function setLevel(target, rawLevel, options) {
        const level = nonNegative(rawLevel, "level", 40);
        if (level < 1) throw new TypeError("level must be between 1 and 40");
        const result = await requestNative(target, "levelBounds", { level });
        if (result.ok !== true || !result.bounds || typeof result.bounds !== "object") throw new Error(String(result.detail || `The game could not resolve level ${level}`));
        const points = nonNegative(result.bounds.start, "level start", config2.maximumExperience);
        return mutate(target, "set", points, options);
      }
      async function grantTalent(target, rawTalentId, rawLevel, options) {
        await start();
        const mutation = talentMutation(target, rawTalentId, rawLevel, "owned", "grant", options);
        const result = await repository2.mutateTalent(mutation);
        const player = await syncOnline(mutation.characterId);
        emit("hmp:progression:talentChanged", { player, talent: result });
        return result;
      }
      async function purchaseTalent(player, rawTalentId, options) {
        await start();
        const mutation = talentMutation(player, rawTalentId, 1, "owned", "purchase", options);
        const existing = await repository2.talent(mutation.characterId, mutation.talentId);
        if (existing?.status === "owned") return existing;
        const current = await repository2.profile(mutation.characterId);
        if (current.talentPoints < 1) throw new Error("No Foundations talent points are available");
        const native = await requestNative(player, "purchase", { talentId: mutation.talentId });
        if (native.ok !== true) throw new Error(String(native.detail || "The game refused the talent purchase"));
        try {
          const result = await repository2.purchaseTalent(mutation);
          await sync(player);
          emit("hmp:progression:talentChanged", { player: onlinePlayer(mutation.characterId), talent: result, purchased: true });
          return result;
        } catch (error) {
          player.emit("hmp-progression:request", JSON.stringify({ requestId: "rollback", operation: "remove", talentId: mutation.talentId }));
          throw error;
        }
      }
      async function revokeTalent(target, rawTalentId, options) {
        await start();
        const mutation = talentMutation(target, rawTalentId, 1, "revoked", "grant", options);
        const result = await repository2.mutateTalent(mutation);
        const player = await syncOnline(mutation.characterId);
        emit("hmp:progression:talentChanged", { player, talent: result });
        return result;
      }
      async function resetTalents(target, options) {
        await start();
        if (!options) throw new TypeError("talent mutation options are required");
        const id = characterId(target);
        const changed = await repository2.resetTalents(id, { actorCharacterId: actorCharacterId(options.actor), resource: resource(options.resource), reason: reason(options.reason) });
        const player = await syncOnline(id);
        if (changed) emit("hmp:progression:talentsReset", { player, characterId: id, count: changed });
        return changed;
      }
      async function setTalentPoints(target, rawPoints, options) {
        await start();
        if (!options) throw new TypeError("talent mutation options are required");
        resource(options.resource);
        actorCharacterId(options.actor);
        const id = characterId(target);
        const profile = await repository2.setTalentPoints(id, nonNegative(rawPoints, "talent points", config2.maximumTalentPoints));
        const player = await syncOnline(id);
        emit("hmp:progression:changed", { player, character: player ? core2.characters.active(player) : null, profile });
        return profile;
      }
      async function recover(rawReference) {
        await start();
        const id = reference(rawReference);
        const existing = await repository2.reward(id);
        if (!existing) throw new Error(`Progression reward '${id}' does not exist`);
        if (existing.status === "failed") throw new Error(`Progression reward '${id}' failed: ${existing.error}`);
        const transaction = existing.status === "completed" ? existing : await repository2.applyReward(id, config2.maximumExperience);
        pendingTransactions = (await repository2.pendingRewards(200)).length;
        const player = onlinePlayer(transaction.characterId);
        if (player) await sync(player);
        return transaction;
      }
      async function characterLoaded(player) {
        try {
          await sync(player);
        } catch (error) {
          logger2.warn(`Could not synchronize #${player.id}: ${messageOf2(error)}`);
        }
      }
      async function worldReady(player) {
        await characterLoaded(player);
      }
      function disconnect(player) {
        const id = Number(player.id);
        syncedPlayers.delete(id);
        for (const [key, pending] of pendingNative) if (pending.playerId === id) {
          clearTimer(pending.timer);
          pendingNative.delete(key);
          pending.reject(new Error("Player disconnected"));
        }
        return true;
      }
      async function stop() {
        state = "stopped";
        syncedPlayers.clear();
        for (const [key, pending] of pendingNative) {
          clearTimer(pending.timer);
          pending.reject(new Error("hmp-progression stopped"));
          pendingNative.delete(key);
        }
      }
      return Object.freeze({
        progression: Object.freeze({
          get: async (target) => {
            await start();
            return repository2.profile(characterId(target));
          },
          add: (target, points, options) => mutate(target, "add", points, options),
          set: (target, points, options) => mutate(target, "set", points, options),
          setLevel,
          transaction: async (rawReference) => {
            await start();
            return repository2.reward(reference(rawReference));
          },
          history: async (id, rawLimit = 50) => {
            await start();
            return repository2.rewardHistory(positiveId(id, "character id"), limit(rawLimit));
          },
          pending: async (rawLimit = 50) => {
            await start();
            const rows = await repository2.pendingRewards(limit(rawLimit));
            pendingTransactions = rows.length;
            return rows;
          },
          recover,
          sync
        }),
        talents: Object.freeze({
          list: async (target, includeRevoked = false) => {
            await start();
            return repository2.talents(characterId(target), includeRevoked);
          },
          grant: grantTalent,
          purchase: purchaseTalent,
          revoke: revokeTalent,
          reset: resetTalents,
          setPoints: setTalentPoints
        }),
        status: () => ({ state, lastError, syncedPlayers: syncedPlayers.size, pendingTransactions, pendingNativeRequests: pendingNative.size, uptimeMs: Math.max(0, now() - startedAt) }),
        start,
        characterLoaded,
        worldReady,
        nativeReport,
        nativeResult,
        disconnect,
        stop
      });
    }
    module2.exports = { createProgressionService: createProgressionService2, payloadObject };
  }
});

// server/main.ts
var configModule = require_config();
var repositoryModule = require_repository();
var schemaModule = require_schema();
var serviceModule = require_service();
var { loadConfig } = configModule;
var { createRepository } = repositoryModule;
var { migrations } = schemaModule;
var { createProgressionService } = serviceModule;
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var Hmp = Imports.get("hmp-lib");
var database = Imports.get("hmp-mysql");
var core = Imports.get("hmp-core");
var logger = Hmp.logger.create("hmp-progression");
var config = loadConfig(Hmp);
var repository = createRepository(database);
var service = createProgressionService({ repository, core, events: Events, logger, config, migrations });
Exports.register("progression", service.progression);
Exports.register("talents", service.talents);
Exports.register("status", service.status);
function loadedPlayer(payload) {
  if (!payload || typeof payload !== "object" || !("session" in payload)) return null;
  const session = payload.session;
  return session && typeof session === "object" && "player" in session ? session.player : null;
}
Events.on("hmp:character:loaded", (payload) => {
  const player = loadedPlayer(payload);
  if (player) void service.characterLoaded(player);
});
Events.on("hmp:character:unloaded", (payload) => {
  const player = loadedPlayer(payload);
  if (player) service.disconnect(player);
});
Events.on("worldReady", (player) => {
  if (core.characters.active(player)) void service.worldReady(player);
});
Events.on("playerDisconnect", (player) => service.disconnect(player));
Events.onClient("hmp-progression:native-report", (player, payload) => {
  void service.nativeReport(player, payload).catch((error) => logger.warn(`Native report rejected: ${messageOf(error)}`));
});
Events.onClient("hmp-progression:native-result", (player, payload) => {
  void service.nativeResult(player, payload);
});
Events.on("resourceStop", (name) => {
  if (!name || name === "hmp-progression") void service.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`));
});
async function isAdmin(player) {
  if (!config.adminGroups.length) return false;
  return (await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade)))).some(Boolean);
}
var commandSequence = 0;
var commandReference = (suffix) => `progression:command:${suffix}:${Date.now().toString(36)}:${(++commandSequence).toString(36)}`;
if (config.enableCommands) Events.on("chatCommand", (player, _message, rawCommand, rawArgs) => {
  if (String(rawCommand || "").toLowerCase() !== config.command) return;
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  const reply = (message) => player.sendChat?.(`[progression] ${message}`);
  void (async () => {
    const subcommand = String(args.shift() || "status").toLowerCase();
    const target = (raw) => Hmp.player.find(raw || "me", player);
    if (subcommand === "status") {
      const selected2 = target(args[0]);
      if (!selected2) {
        reply(`Usage: /${config.command} status [me|nick|#id]`);
        return;
      }
      const profile = await service.progression.get(selected2);
      reply(`${selected2.nickname}: level ${profile.level}, ${profile.experiencePoints} XP, ${profile.talentPoints} talent point(s), revision ${profile.appliedRevision}/${profile.revision}`);
      return;
    }
    if (subcommand === "talents") {
      const selected2 = target(args[0]);
      if (!selected2) {
        reply(`Usage: /${config.command} talents [me|nick|#id]`);
        return;
      }
      const [profile, talents] = await Promise.all([service.progression.get(selected2), service.talents.list(selected2)]);
      reply(`${selected2.nickname}: ${profile.talentPoints} point(s); ${talents.length ? talents.map((entry) => `${entry.talentId}${entry.level > 1 ? `(${entry.level})` : ""}`).join(", ") : "no Foundations-managed talents"}`);
      return;
    }
    if (subcommand === "buy") {
      const id = args[0];
      if (!id) {
        reply(`Usage: /${config.command} buy <talentId>`);
        return;
      }
      const talent = await service.talents.purchase(player, id, { resource: "hmp-progression:command", actor: player, reason: "player purchase" });
      reply(`Purchased ${talent.talentId}.`);
      return;
    }
    if (!await isAdmin(player)) {
      reply("You do not have permission to administer progression.");
      return;
    }
    const context = { resource: "hmp-progression:command", actor: player, reason: "closed-testing command" };
    if (subcommand === "reset") {
      const resetTarget = target(args[0]);
      if (!resetTarget) {
        reply(`Usage: /${config.command} reset <me|nick|#id>`);
        return;
      }
      reply(`Revoked ${await service.talents.reset(resetTarget, context)} Foundations-managed talent(s) from ${resetTarget.nickname}.`);
      return;
    }
    const selected = target(args[1]);
    if (!selected) {
      reply(`Usage: /${config.command} <add|set|level|grant|revoke|points|reset> <value> [me|nick|#id]`);
      return;
    }
    if (subcommand === "add") {
      const amount = Number(args[0]);
      const transaction = await service.progression.add(selected, amount, { ...context, reference: commandReference("add") });
      reply(`${selected.nickname}: ${transaction.balanceBefore} -> ${transaction.balanceAfter} XP.`);
    } else if (subcommand === "set") {
      const amount = Number(args[0]);
      const transaction = await service.progression.set(selected, amount, { ...context, reference: commandReference("set") });
      reply(`${selected.nickname}: ${transaction.balanceBefore} -> ${transaction.balanceAfter} XP.`);
    } else if (subcommand === "level") {
      const transaction = await service.progression.setLevel(selected, Number(args[0]), { ...context, reference: commandReference("level") });
      reply(`${selected.nickname}: ${transaction.balanceAfter} XP (level ${args[0]} target).`);
    } else if (subcommand === "grant") {
      const talent = await service.talents.grant(selected, args[0], Number(args[2]) || 1, context);
      reply(`Granted ${talent.talentId} to ${selected.nickname}.`);
    } else if (subcommand === "revoke") {
      const talent = await service.talents.revoke(selected, args[0], context);
      reply(`Revoked ${talent.talentId} from ${selected.nickname}.`);
    } else if (subcommand === "points") {
      const profile = await service.talents.setPoints(selected, Number(args[0]), context);
      reply(`${selected.nickname}: ${profile.talentPoints} talent point(s).`);
    } else {
      reply(`Usage: /${config.command} status|talents|buy|add|set|level|grant|revoke|points|reset`);
    }
  })().catch((error) => {
    logger.warn(`Command failed: ${messageOf(error)}`);
    reply(messageOf(error));
  });
});
Events.on("resourceStart", async (name) => {
  if (name && name !== "hmp-progression") return;
  await service.start();
  logger.info("Character progression, replay-safe rewards, and managed talents ready");
});
