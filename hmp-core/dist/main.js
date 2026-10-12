"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// server/config.ts
var require_config = __commonJS({
  "server/config.ts"(exports2, module2) {
    "use strict";
    function loadConfig2(Hmp2, options = {}) {
      const env = options.env || process.env;
      const cwd = options.cwd || process.cwd();
      const defaults = {
        maxCharacters: 4,
        autoSelectSingleCharacter: false,
        duplicateSession: "reject-new",
        duplicateSessionGroup: "admin",
        duplicateSessionMinimumGrade: 1,
        kickDuplicateSession: false,
        identityOrder: ["steamId", "discordId", "hardwareId"]
      };
      const config2 = Hmp2.config.load(env.HMP_CORE_CONFIG || "data/hmp-core.json", { cwd, defaults });
      if (env.HMP_CORE_MAX_CHARACTERS) {
        config2.maxCharacters = Hmp2.config.env.number(env.HMP_CORE_MAX_CHARACTERS, config2.maxCharacters, { integer: true, min: 1, max: 32 }) ?? config2.maxCharacters;
      }
      if (env.HMP_CORE_AUTO_SELECT_SINGLE) config2.autoSelectSingleCharacter = Hmp2.config.env.boolean(env.HMP_CORE_AUTO_SELECT_SINGLE);
      if (env.HMP_CORE_DUPLICATE_SESSION) config2.duplicateSession = env.HMP_CORE_DUPLICATE_SESSION.trim().toLowerCase();
      if (env.HMP_CORE_DUPLICATE_GROUP) config2.duplicateSessionGroup = env.HMP_CORE_DUPLICATE_GROUP.trim().toLowerCase();
      if (env.HMP_CORE_DUPLICATE_MIN_GRADE) {
        config2.duplicateSessionMinimumGrade = Hmp2.config.env.number(env.HMP_CORE_DUPLICATE_MIN_GRADE, config2.duplicateSessionMinimumGrade, { integer: true, min: 0, max: 1e3 }) ?? config2.duplicateSessionMinimumGrade;
      }
      if (env.HMP_CORE_KICK_DUPLICATE) config2.kickDuplicateSession = Hmp2.config.env.boolean(env.HMP_CORE_KICK_DUPLICATE);
      if (env.HMP_CORE_IDENTITY_ORDER) config2.identityOrder = env.HMP_CORE_IDENTITY_ORDER.split(",").map((value) => value.trim()).filter(Boolean);
      config2.duplicateSessionGroup = String(config2.duplicateSessionGroup || "").trim().toLowerCase();
      if (!Array.isArray(config2.identityOrder) || !config2.identityOrder.length) throw new TypeError("hmp-core identityOrder must not be empty");
      if (!["reject-new", "replace-old", "allow-group"].includes(config2.duplicateSession)) throw new TypeError("hmp-core duplicateSession must be reject-new, replace-old or allow-group");
      if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(config2.duplicateSessionGroup)) throw new TypeError("hmp-core duplicateSessionGroup must be a valid group key");
      if (!Number.isSafeInteger(config2.duplicateSessionMinimumGrade) || config2.duplicateSessionMinimumGrade < 0) throw new TypeError("hmp-core duplicateSessionMinimumGrade must be a non-negative integer");
      return config2;
    }
    module2.exports = { loadConfig: loadConfig2 };
  }
});

// server/repository.ts
var require_repository = __commonJS({
  "server/repository.ts"(exports2, module2) {
    "use strict";
    function parseJson(value, fallback) {
      if (value === null || value === void 0 || value === "") return fallback;
      try {
        return JSON.parse(String(value));
      } catch (_) {
        return fallback;
      }
    }
    function accountRow(row) {
      return row ? {
        id: Number(row.id),
        displayName: row.display_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at
      } : null;
    }
    function characterRow(row) {
      return row ? {
        id: Number(row.id),
        accountId: Number(row.account_id),
        slot: Number(row.slot),
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at
      } : null;
    }
    function groupRow(row, scope) {
      return {
        scope,
        key: row.group_key,
        grade: Number(row.grade),
        metadata: parseJson(row.metadata_json, {})
      };
    }
    function createRepository2(database2) {
      if (!database2 || typeof database2.query !== "function") throw new TypeError("database API is required");
      async function findIdentity(provider, subject) {
        const row = await database2.single(
          `SELECT a.id, a.display_name, a.created_at, a.last_seen_at,
                    i.provider, i.subject, i.trust_level
               FROM hmp_account_identities i
               JOIN hmp_accounts a ON a.id = i.account_id
              WHERE i.provider = ? AND i.subject = ?`,
          [provider, subject]
        );
        if (!row) return null;
        return {
          account: accountRow(row),
          principal: { provider: row.provider ?? provider, subject: row.subject ?? subject, trust: row.trust_level ?? "asserted" }
        };
      }
      async function findOrCreateAccount(principal, displayName) {
        const existing = await findIdentity(principal.provider, principal.subject);
        if (existing) {
          await database2.update(
            "UPDATE hmp_accounts SET display_name = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
            [displayName, existing.account.id]
          );
          await database2.update(
            "UPDATE hmp_account_identities SET last_seen_at = CURRENT_TIMESTAMP, trust_level = ? WHERE provider = ? AND subject = ?",
            [principal.trust, principal.provider, principal.subject]
          );
          return { ...existing.account, displayName };
        }
        try {
          return await database2.transaction(async (tx) => {
            const accountId = await tx.insert("INSERT INTO hmp_accounts (display_name) VALUES (?)", [displayName]);
            await tx.insert(
              "INSERT INTO hmp_account_identities (provider, subject, account_id, trust_level) VALUES (?, ?, ?, ?)",
              [principal.provider, principal.subject, accountId, principal.trust]
            );
            return accountRow(await tx.single(
              "SELECT id, display_name, created_at, last_seen_at FROM hmp_accounts WHERE id = ?",
              [accountId]
            ));
          });
        } catch (error) {
          const raced = await findIdentity(principal.provider, principal.subject);
          if (raced) return raced.account;
          throw error;
        }
      }
      async function linkIdentity(accountId, principal) {
        const existing = await findIdentity(principal.provider, principal.subject);
        if (existing && existing.account.id !== Number(accountId)) {
          const error = new Error(`Identity ${principal.provider}:${principal.subject} already belongs to another account`);
          Object.assign(error, { code: "HMP_CORE_IDENTITY_CONFLICT" });
          throw error;
        }
        if (existing) {
          await database2.update(
            "UPDATE hmp_account_identities SET trust_level = ?, last_seen_at = CURRENT_TIMESTAMP WHERE provider = ? AND subject = ?",
            [principal.trust, principal.provider, principal.subject]
          );
        } else {
          await database2.insert(
            "INSERT INTO hmp_account_identities (provider, subject, account_id, trust_level) VALUES (?, ?, ?, ?)",
            [principal.provider, principal.subject, accountId, principal.trust]
          );
        }
        return true;
      }
      const findAccountById = async (id) => accountRow(await database2.single(
        "SELECT id, display_name, created_at, last_seen_at FROM hmp_accounts WHERE id = ?",
        [id]
      ));
      const touchAccount = (id, displayName) => database2.update(
        "UPDATE hmp_accounts SET display_name = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
        [displayName, id]
      );
      async function listCharacters(accountId) {
        const rows = await database2.query(
          "SELECT * FROM hmp_characters WHERE account_id = ? AND status = 'active' ORDER BY slot",
          [accountId]
        );
        return rows.map((row) => characterRow(row));
      }
      const findCharacterById = async (id) => characterRow(await database2.single(
        "SELECT * FROM hmp_characters WHERE id = ?",
        [id]
      ));
      async function createCharacter(accountId, data) {
        const id = await database2.insert(
          "INSERT INTO hmp_characters (account_id, slot, name) VALUES (?, ?, ?)",
          [accountId, data.slot, data.name]
        );
        return await findCharacterById(Number(id));
      }
      async function deleteCharacter(id) {
        return await database2.update(
          "UPDATE hmp_characters SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
          [id]
        ) > 0;
      }
      async function listAccountGroups(accountId) {
        const rows = await database2.query("SELECT group_key, grade, metadata_json FROM hmp_account_groups WHERE account_id = ?", [accountId]);
        return rows.map((row) => groupRow(row, "account"));
      }
      async function listCharacterGroups(characterId) {
        const rows = await database2.query("SELECT group_key, grade, metadata_json FROM hmp_character_groups WHERE character_id = ?", [characterId]);
        return rows.map((row) => groupRow(row, "character"));
      }
      async function setGroup(scope, ownerId, key, grade, metadata) {
        const table = scope === "account" ? "hmp_account_groups" : "hmp_character_groups";
        const column = scope === "account" ? "account_id" : "character_id";
        await database2.update(
          `INSERT INTO ${table} (${column}, group_key, grade, metadata_json) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE grade = VALUES(grade), metadata_json = VALUES(metadata_json)`,
          [ownerId, key, grade, JSON.stringify(metadata || {})]
        );
        return { scope, key, grade, metadata: metadata || {} };
      }
      async function removeGroup(scope, ownerId, key) {
        const table = scope === "account" ? "hmp_account_groups" : "hmp_character_groups";
        const column = scope === "account" ? "account_id" : "character_id";
        return await database2.update(`DELETE FROM ${table} WHERE ${column} = ? AND group_key = ?`, [ownerId, key]) > 0;
      }
      async function getMetadata(scope, ownerId, key) {
        const table = scope === "account" ? "hmp_account_metadata" : "hmp_character_metadata";
        const column = scope === "account" ? "account_id" : "character_id";
        const value = await database2.scalar(`SELECT value_json FROM ${table} WHERE ${column} = ? AND meta_key = ?`, [ownerId, key]);
        return value === null ? void 0 : parseJson(value, null);
      }
      async function setMetadata(scope, ownerId, key, value) {
        const table = scope === "account" ? "hmp_account_metadata" : "hmp_character_metadata";
        const column = scope === "account" ? "account_id" : "character_id";
        await database2.update(
          `INSERT INTO ${table} (${column}, meta_key, value_json) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
          [ownerId, key, JSON.stringify(value)]
        );
        return value;
      }
      async function deleteMetadata(scope, ownerId, key) {
        const table = scope === "account" ? "hmp_account_metadata" : "hmp_character_metadata";
        const column = scope === "account" ? "account_id" : "character_id";
        return await database2.update(`DELETE FROM ${table} WHERE ${column} = ? AND meta_key = ?`, [ownerId, key]) > 0;
      }
      return Object.freeze({
        findIdentity,
        findOrCreateAccount,
        linkIdentity,
        findAccountById,
        touchAccount,
        listCharacters,
        findCharacterById,
        createCharacter,
        deleteCharacter,
        listAccountGroups,
        listCharacterGroups,
        setGroup,
        removeGroup,
        getMetadata,
        setMetadata,
        deleteMetadata
      });
    }
    module2.exports = { createRepository: createRepository2 };
  }
});

// server/core.ts
var require_core = __commonJS({
  "server/core.ts"(exports2, module2) {
    "use strict";
    var IDENTITY_FIELDS = Object.freeze({
      steamId: "client-steam",
      discordId: "client-discord",
      hardwareId: "client-hardware"
    });
    function fail(code, message) {
      const error = new Error(message);
      return Object.assign(error, { code });
    }
    function playerId(player) {
      const id = Number(player && typeof player === "object" ? player.id : player);
      if (!Number.isSafeInteger(id) || id < 0) throw fail("HMP_CORE_INVALID_PLAYER", "A connected player is required");
      return id;
    }
    function positiveId(value, label) {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id < 1) throw fail("HMP_CORE_INVALID_ID", `${label} must be a positive integer`);
      return id;
    }
    function normalizeKey(value, label = "key") {
      const key = String(value ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(key)) {
        throw fail("HMP_CORE_INVALID_KEY", `${label} must be 1-64 lowercase letters, numbers, dots, colons, underscores or hyphens`);
      }
      return key;
    }
    function normalizePrincipal(value, fallbackTrust = "asserted") {
      if (!value || typeof value !== "object") throw fail("HMP_CORE_INVALID_IDENTITY", "Identity provider returned an invalid principal");
      const record = value;
      const provider = normalizeKey(record.provider, "identity provider");
      const subject = String(record.subject ?? "").trim();
      if (!subject || subject.length > 191) throw fail("HMP_CORE_INVALID_IDENTITY", "Identity subject must be 1-191 characters");
      const trust = String(record.trust || fallbackTrust).trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,15}$/.test(trust)) throw fail("HMP_CORE_INVALID_IDENTITY", "Identity trust must be a short token");
      return Object.freeze({ provider, subject, trust });
    }
    function createCore2(options) {
      const repository2 = options.repository;
      const database2 = options.database;
      const migrations2 = options.migrations || [];
      const events = options.events || null;
      const listPlayers = options.listPlayers || (() => []);
      const logger2 = options.logger || console;
      const config2 = options.config || {};
      if (!repository2 || !database2) throw new TypeError("repository and database are required");
      let state = "starting";
      let lastError = "";
      let startedAt = Date.now();
      let startPromise = null;
      const sessionsByPlayer = /* @__PURE__ */ new Map();
      const characterClaims = /* @__PURE__ */ new Map();
      const attempts = /* @__PURE__ */ new Map();
      const providers = /* @__PURE__ */ new Map();
      function logError(message, error) {
        if (logger2 && typeof logger2.error === "function") logger2.error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
      }
      async function emit(name, payload) {
        if (!events || typeof events.emit !== "function") return;
        try {
          await events.emit(name, payload);
        } catch (error) {
          logError(`[hmp-core] ${name} handler failed`, error);
        }
      }
      function registerProvider(definition) {
        if (!definition || typeof definition.resolve !== "function") throw new TypeError("identity provider resolve must be a function");
        const name = normalizeKey(definition.name, "identity provider name");
        if (providers.has(name)) throw fail("HMP_CORE_PROVIDER_EXISTS", `Identity provider ${name} is already registered`);
        const entry = Object.freeze({
          name,
          resource: String(definition.resource || "unknown"),
          priority: Number.isFinite(Number(definition.priority)) ? Number(definition.priority) : 0,
          trust: String(definition.trust || "asserted"),
          resolve: definition.resolve
        });
        providers.set(name, entry);
        return () => providers.delete(name);
      }
      function unregisterProvider(name) {
        return providers.delete(normalizeKey(name, "identity provider name"));
      }
      function removeIdentityProvidersForResource(resource) {
        let removed = 0;
        for (const [name, provider] of providers) {
          if (provider.resource === resource && name !== "hmp-client-identity") {
            providers.delete(name);
            removed += 1;
          }
        }
        return removed;
      }
      async function resolveIdentity(player) {
        const ordered = [...providers.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
        for (const provider of ordered) {
          const result = await provider.resolve(player);
          if (result) return normalizePrincipal(result, provider.trust);
        }
        throw fail("HMP_CORE_IDENTITY_MISSING", "No usable identity was supplied for this player");
      }
      registerProvider({
        name: "hmp-client-identity",
        resource: "hmp-core",
        priority: -1e3,
        trust: "asserted",
        resolve(player) {
          for (const field of config2.identityOrder || Object.keys(IDENTITY_FIELDS)) {
            const provider = IDENTITY_FIELDS[field];
            const subject = String(player[field] ?? "").trim();
            if (provider && /^\d+$/.test(subject)) return { provider, subject, trust: "asserted" };
          }
          return null;
        }
      });
      function getSession(player) {
        try {
          return sessionsByPlayer.get(playerId(player)) || null;
        } catch (_) {
          return null;
        }
      }
      function requireSession(player) {
        const session = getSession(player);
        if (!session) throw fail("HMP_CORE_SESSION_MISSING", "Player does not have a ready hmp-core session");
        return session;
      }
      async function accountAllowsDuplicateSessions(accountId) {
        if (config2.duplicateSession !== "allow-group") return false;
        const key = String(config2.duplicateSessionGroup || "admin").trim().toLowerCase();
        const minimumGrade = Number(config2.duplicateSessionMinimumGrade ?? 1);
        return (await repository2.listAccountGroups(accountId)).some((group) => group.key === key && group.grade >= minimumGrade);
      }
      async function connect(player) {
        const id = playerId(player);
        if (startPromise) await startPromise;
        if (state !== "ready") throw fail("HMP_CORE_NOT_READY", `hmp-core is ${state}`);
        if (sessionsByPlayer.has(id)) return sessionsByPlayer.get(id) ?? null;
        const token = Symbol(`connect:${id}`);
        attempts.set(id, token);
        try {
          const principal = await resolveIdentity(player);
          const displayName = String(player.nickname || `Player ${id}`).trim().slice(0, 80) || `Player ${id}`;
          const account = await repository2.findOrCreateAccount(principal, displayName);
          if (attempts.get(id) !== token) return null;
          const existing = [...sessionsByPlayer.values()].filter((session2) => session2.account.id === account.id && session2.playerId !== id);
          if (existing.length) {
            if (config2.duplicateSession === "replace-old") {
              for (const session2 of existing) {
                await disconnect(session2.player);
                if (config2.kickDuplicateSession && typeof session2.player?.kick === "function") session2.player.kick("Your account connected from another session.");
              }
            } else if (!await accountAllowsDuplicateSessions(account.id)) {
              if (config2.kickDuplicateSession && typeof player.kick === "function") player.kick("This account is already connected.");
              throw fail("HMP_CORE_DUPLICATE_SESSION", "This account already has an active session");
            }
          }
          const session = {
            player,
            playerId: id,
            account,
            principal,
            character: null,
            connectedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          sessionsByPlayer.set(id, session);
          await emit("hmp:session:ready", session);
          if (config2.autoSelectSingleCharacter) {
            const available = await repository2.listCharacters(account.id);
            if (available.length === 1) await selectCharacter(player, available[0].id);
          }
          return session;
        } finally {
          if (attempts.get(id) === token) attempts.delete(id);
        }
      }
      async function unloadCharacter(player) {
        const session = requireSession(player);
        if (!session.character) return null;
        const character = session.character;
        await emit("hmp:character:unloading", { session, character });
        session.character = null;
        if (characterClaims.get(character.id) === session) characterClaims.delete(character.id);
        await emit("hmp:character:unloaded", { session, character });
        return character;
      }
      async function disconnect(player) {
        const id = playerId(player);
        attempts.delete(id);
        const session = sessionsByPlayer.get(id);
        if (!session) return false;
        const teardown = [];
        const character = session.character;
        if (character) {
          teardown.push(emit("hmp:character:unloading", { session, character }));
          session.character = null;
          if (characterClaims.get(character.id) === session) characterClaims.delete(character.id);
          teardown.push(emit("hmp:character:unloaded", { session, character }));
        }
        sessionsByPlayer.delete(id);
        teardown.push(emit("hmp:session:ended", session));
        const displayName = String(player.nickname || session.account.displayName).slice(0, 80);
        await Promise.all(teardown);
        try {
          await repository2.touchAccount(session.account.id, displayName);
        } catch (error) {
          logError("[hmp-core] could not update account activity", error);
        }
        return true;
      }
      async function listCharacters(player) {
        return repository2.listCharacters(requireSession(player).account.id);
      }
      async function createCharacter(player, input) {
        const session = requireSession(player);
        const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
        if (name.length < 2 || name.length > 80) throw fail("HMP_CORE_INVALID_CHARACTER", "Character name must be 2-80 characters");
        const existing = await repository2.listCharacters(session.account.id);
        if (existing.length >= Number(config2.maxCharacters || 4)) throw fail("HMP_CORE_CHARACTER_LIMIT", "Character limit reached");
        const requested = input?.slot === void 0 ? null : Number(input.slot);
        const occupied = new Set(existing.map((character2) => character2.slot));
        const slot = requested === null ? Array.from({ length: Number(config2.maxCharacters || 4) }, (_, index) => index + 1).find((value) => !occupied.has(value)) : requested;
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > Number(config2.maxCharacters || 4) || occupied.has(slot)) {
          throw fail("HMP_CORE_INVALID_CHARACTER_SLOT", "Character slot is unavailable");
        }
        const character = await repository2.createCharacter(session.account.id, { name, slot });
        await emit("hmp:character:created", { session, character });
        return character;
      }
      async function selectCharacter(player, characterId) {
        const session = requireSession(player);
        const character = await repository2.findCharacterById(positiveId(characterId, "characterId"));
        if (!character || character.accountId !== session.account.id || character.status !== "active") {
          throw fail("HMP_CORE_CHARACTER_NOT_FOUND", "Character does not belong to this account");
        }
        if (session.character?.id === character.id) return character;
        const claimed = characterClaims.get(character.id);
        if (claimed && claimed !== session) throw fail("HMP_CORE_CHARACTER_IN_USE", "Character is active in another session");
        if (session.character) await unloadCharacter(player);
        characterClaims.set(character.id, session);
        try {
          await emit("hmp:character:loading", { session, character });
        } catch (error) {
          if (characterClaims.get(character.id) === session) characterClaims.delete(character.id);
          throw error;
        }
        session.character = character;
        await emit("hmp:character:loaded", { session, character });
        await emit("hmp:character:selected", { session, character });
        return character;
      }
      async function deleteCharacter(player, characterId) {
        const session = requireSession(player);
        const character = await repository2.findCharacterById(positiveId(characterId, "characterId"));
        if (!character || character.accountId !== session.account.id || character.status !== "active") {
          throw fail("HMP_CORE_CHARACTER_NOT_FOUND", "Character does not belong to this account");
        }
        const claimed = characterClaims.get(character.id);
        if (claimed && claimed !== session) throw fail("HMP_CORE_CHARACTER_IN_USE", "Character is active in another session");
        if (session.character?.id === character.id) await unloadCharacter(player);
        const deleted = await repository2.deleteCharacter(character.id);
        if (deleted) await emit("hmp:character:deleted", { session, character });
        return deleted;
      }
      function normalizeGroup(grade, metadata2) {
        const value = Number(grade);
        if (!Number.isSafeInteger(value)) throw fail("HMP_CORE_INVALID_GRADE", "Group grade must be an integer");
        const details = metadata2 && typeof metadata2 === "object" ? metadata2 : {};
        try {
          JSON.stringify(details);
        } catch (_) {
          throw fail("HMP_CORE_INVALID_METADATA", "Group metadata must be JSON serializable");
        }
        return { grade: value, metadata: details };
      }
      async function effectiveGroups(player) {
        const session = requireSession(player);
        const accountGroups = await repository2.listAccountGroups(session.account.id);
        const characterGroups = session.character ? await repository2.listCharacterGroups(session.character.id) : [];
        const merged = new Map(accountGroups.map((group) => [group.key, group]));
        for (const group of characterGroups) {
          const current = merged.get(group.key);
          if (!current || group.grade >= current.grade) merged.set(group.key, group);
        }
        return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
      }
      async function setGroup(scope, ownerId, key, grade, metadata2) {
        const normalized = normalizeGroup(grade, metadata2);
        const group = await repository2.setGroup(scope, positiveId(ownerId, `${scope}Id`), normalizeKey(key, "group key"), normalized.grade, normalized.metadata);
        await emit("hmp:groups:changed", { action: "set", ownerId: Number(ownerId), group });
        return group;
      }
      async function removeGroup(scope, ownerId, key) {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "group key");
        const removed = await repository2.removeGroup(scope, id, normalized);
        if (removed) await emit("hmp:groups:changed", { action: "remove", scope, ownerId: id, key: normalized });
        return removed;
      }
      function serializable(value) {
        if (value === void 0) throw fail("HMP_CORE_INVALID_METADATA", "Metadata value cannot be undefined");
        try {
          const json = JSON.stringify(value);
          if (json === void 0) throw new Error("not serializable");
        } catch (_) {
          throw fail("HMP_CORE_INVALID_METADATA", "Metadata value must be JSON serializable");
        }
        return value;
      }
      async function setMetadata(scope, ownerId, key, value) {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "metadata key");
        const result = await repository2.setMetadata(scope, id, normalized, serializable(value));
        await emit("hmp:metadata:changed", { action: "set", scope, ownerId: id, key: normalized, value: result });
        return result;
      }
      async function deleteMetadata(scope, ownerId, key) {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "metadata key");
        const removed = await repository2.deleteMetadata(scope, id, normalized);
        if (removed) await emit("hmp:metadata:changed", { action: "delete", scope, ownerId: id, key: normalized });
        return removed;
      }
      async function start() {
        if (state === "ready") return true;
        if (startPromise) return startPromise;
        state = "starting";
        lastError = "";
        startedAt = Date.now();
        startPromise = (async () => {
          try {
            if (!await database2.ready()) throw fail("HMP_CORE_DATABASE_UNAVAILABLE", "hmp-mysql is not ready");
            await database2.migrate("hmp-core", migrations2);
            state = "ready";
            const players = listPlayers();
            for (const player of Array.isArray(players) ? players : []) connect(player).catch((error) => logError("[hmp-core] existing player setup failed", error));
            return true;
          } catch (error) {
            state = "degraded";
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            startPromise = null;
          }
        })();
        return startPromise;
      }
      async function stop() {
        state = "stopped";
        attempts.clear();
        for (const session of [...sessionsByPlayer.values()]) await disconnect(session.player);
      }
      const status = () => Object.freeze({ state, lastError, sessions: sessionsByPlayer.size, identityProviders: providers.size, uptimeMs: Date.now() - startedAt });
      const identity = Object.freeze({ register: registerProvider, unregister: unregisterProvider, list: () => [...providers.values()].map(({ resolve, ...entry }) => entry), resolve: resolveIdentity });
      const accounts = Object.freeze({
        getByPlayer: (player) => getSession(player)?.account || null,
        getById: (id) => repository2.findAccountById(positiveId(id, "accountId")),
        linkIdentity: (id, principal) => repository2.linkIdentity(positiveId(id, "accountId"), normalizePrincipal(principal))
      });
      const sessions = Object.freeze({ get: getSession, all: () => [...sessionsByPlayer.values()], isReady: (player) => Boolean(getSession(player)) });
      const characters = Object.freeze({
        list: listCharacters,
        create: createCharacter,
        select: selectCharacter,
        active: (player) => getSession(player)?.character || null,
        unload: unloadCharacter,
        delete: deleteCharacter,
        limit: () => Number(config2.maxCharacters || 4)
      });
      const groups = Object.freeze({
        listAccount: (id) => repository2.listAccountGroups(positiveId(id, "accountId")),
        listCharacter: (id) => repository2.listCharacterGroups(positiveId(id, "characterId")),
        effective: effectiveGroups,
        async has(player, key, minimumGrade = 0) {
          const grade = Number(minimumGrade);
          if (!Number.isSafeInteger(grade)) throw fail("HMP_CORE_INVALID_GRADE", "Minimum group grade must be an integer");
          return (await effectiveGroups(player)).some((group) => group.key === normalizeKey(key, "group key") && group.grade >= grade);
        },
        setAccount: (id, key, grade, metadata2) => setGroup("account", id, key, grade, metadata2),
        setCharacter: (id, key, grade, metadata2) => setGroup("character", id, key, grade, metadata2),
        removeAccount: (id, key) => removeGroup("account", id, key),
        removeCharacter: (id, key) => removeGroup("character", id, key)
      });
      const metadata = Object.freeze({
        getAccount: (id, key) => repository2.getMetadata("account", positiveId(id, "accountId"), normalizeKey(key, "metadata key")),
        getCharacter: (id, key) => repository2.getMetadata("character", positiveId(id, "characterId"), normalizeKey(key, "metadata key")),
        setAccount: (id, key, value) => setMetadata("account", id, key, value),
        setCharacter: (id, key, value) => setMetadata("character", id, key, value),
        deleteAccount: (id, key) => deleteMetadata("account", id, key),
        deleteCharacter: (id, key) => deleteMetadata("character", id, key)
      });
      return Object.freeze({ status, identity, accounts, sessions, characters, groups, metadata, start, stop, connect, disconnect, removeIdentityProvidersForResource });
    }
    module2.exports = { createCore: createCore2, normalizePrincipal };
  }
});

// server/schema.ts
var require_schema = __commonJS({
  "server/schema.ts"(exports2, module2) {
    "use strict";
    var migrations2 = [
      {
        version: 1,
        name: "create core accounts, identities, characters, groups and metadata",
        statements: [
          `CREATE TABLE IF NOT EXISTS hmp_accounts (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                display_name VARCHAR(80) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_account_identities (
                provider VARCHAR(64) NOT NULL,
                subject VARCHAR(191) NOT NULL,
                account_id BIGINT UNSIGNED NOT NULL,
                trust_level VARCHAR(16) NOT NULL DEFAULT 'asserted',
                first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (provider, subject),
                KEY idx_hmp_identities_account (account_id),
                CONSTRAINT fk_hmp_identities_account FOREIGN KEY (account_id) REFERENCES hmp_accounts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_characters (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                account_id BIGINT UNSIGNED NOT NULL,
                slot SMALLINT UNSIGNED NOT NULL,
                name VARCHAR(80) NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                active_slot SMALLINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN slot ELSE NULL END) STORED,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP NULL DEFAULT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_hmp_characters_active_slot (account_id, active_slot),
                KEY idx_hmp_characters_account_status (account_id, status),
                CONSTRAINT fk_hmp_characters_account FOREIGN KEY (account_id) REFERENCES hmp_accounts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_account_groups (
                account_id BIGINT UNSIGNED NOT NULL,
                group_key VARCHAR(64) NOT NULL,
                grade INT NOT NULL DEFAULT 0,
                metadata_json LONGTEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (account_id, group_key),
                CONSTRAINT fk_hmp_account_groups_account FOREIGN KEY (account_id) REFERENCES hmp_accounts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_character_groups (
                character_id BIGINT UNSIGNED NOT NULL,
                group_key VARCHAR(64) NOT NULL,
                grade INT NOT NULL DEFAULT 0,
                metadata_json LONGTEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id, group_key),
                CONSTRAINT fk_hmp_character_groups_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_account_metadata (
                account_id BIGINT UNSIGNED NOT NULL,
                meta_key VARCHAR(64) NOT NULL,
                value_json LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (account_id, meta_key),
                CONSTRAINT fk_hmp_account_metadata_account FOREIGN KEY (account_id) REFERENCES hmp_accounts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_character_metadata (
                character_id BIGINT UNSIGNED NOT NULL,
                meta_key VARCHAR(64) NOT NULL,
                value_json LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id, meta_key),
                CONSTRAINT fk_hmp_character_metadata_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
        ]
      }
    ];
    module2.exports = { migrations: migrations2 };
  }
});

// server/main.ts
var configModule = require_config();
var repositoryModule = require_repository();
var coreModule = require_core();
var schemaModule = require_schema();
var { loadConfig } = configModule;
var { createRepository } = repositoryModule;
var { createCore } = coreModule;
var { migrations } = schemaModule;
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var Hmp = Imports.get("hmp-lib");
var database = Imports.get("hmp-mysql");
var logger = Hmp.logger.create("hmp-core");
var config = loadConfig(Hmp);
var repository = createRepository(database);
var core = createCore({
  repository,
  database,
  migrations,
  events: Events,
  listPlayers: () => PlayerManager.getAll(),
  logger,
  config
});
for (const name of ["status", "identity", "accounts", "sessions", "characters", "groups", "metadata"]) {
  Exports.register(name, core[name]);
}
Events.on("playerConnect", (player) => {
  const currentPlayer = player;
  core.connect(currentPlayer).catch((error) => {
    logger.error(`Could not initialize ${Hmp.player.format(currentPlayer)}: ${messageOf(error)}`);
    if (typeof currentPlayer.kick === "function") currentPlayer.kick("Server services are temporarily unavailable. Please try again later.");
  });
});
Events.on("playerDisconnect", (player) => {
  const currentPlayer = player;
  core.disconnect(currentPlayer).catch((error) => logger.error(`Could not close ${Hmp.player.format(currentPlayer)}: ${messageOf(error)}`));
});
Events.on("resourceStop", (name) => {
  if (name === "hmp-core" || !name) {
    core.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`));
    return;
  }
  core.removeIdentityProvidersForResource(name);
});
Events.on("resourceStart", async (name) => {
  if (name && name !== "hmp-core") return;
  await core.start();
  logger.info("Accounts, characters, groups and metadata are ready");
});
