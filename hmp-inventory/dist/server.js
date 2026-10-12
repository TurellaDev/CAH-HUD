"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// server/config.ts
var require_config = __commonJS({
  "server/config.ts"(exports2, module2) {
    "use strict";
    function normalizeStartingItems(raw) {
      if (raw !== void 0 && raw !== null && !Array.isArray(raw)) throw new TypeError("hmp-inventory startingItems must be an array");
      const source = Array.isArray(raw) ? raw : [];
      const entries = [];
      for (const candidate of source) {
        const value = typeof candidate === "string" ? { name: candidate } : candidate && typeof candidate === "object" ? candidate : null;
        if (!value) continue;
        const name = String(value.name ?? value.item ?? "").trim().toLowerCase().slice(0, 64);
        if (!name) continue;
        const amount = Math.max(1, Math.min(1e5, Math.trunc(Number(value.amount ?? value.count ?? value.quantity)) || 1));
        const entry = { name, amount };
        if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) {
          entry.metadata = value.metadata;
        }
        entries.push(entry);
      }
      return entries;
    }
    function loadConfig2(Hmp2, options = {}) {
      const env = options.env || process.env;
      const cwd = options.cwd || process.cwd();
      const defaults = {
        slots: 36,
        maxWeight: 60,
        autoSaveMs: 3e4,
        allowInventoryCommand: true,
        items: [],
        startingItems: [],
        ui: {
          url: "fw://resources/hmp-inventory/dist/index.html"
        }
      };
      const config2 = Hmp2.config.load(env.HMP_INVENTORY_CONFIG || "data/hmp-inventory.json", { cwd, defaults });
      config2.slots = Math.max(1, Math.min(200, Math.trunc(Number(config2.slots)) || defaults.slots));
      config2.maxWeight = Math.max(0, Math.min(1e5, Number(config2.maxWeight) || defaults.maxWeight));
      config2.autoSaveMs = Math.max(0, Math.min(36e5, Math.trunc(Number(config2.autoSaveMs)) || 0));
      if (env.HMP_INVENTORY_COMMAND) config2.allowInventoryCommand = Hmp2.config.env.boolean(env.HMP_INVENTORY_COMMAND);
      if (!config2.ui || typeof config2.ui !== "object") config2.ui = { ...defaults.ui };
      if (env.HMP_INVENTORY_UI_URL) config2.ui.url = String(env.HMP_INVENTORY_UI_URL).trim();
      config2.ui.url = String(config2.ui.url || defaults.ui.url).trim();
      if (!config2.ui.url.startsWith("fw://resources/") && !config2.ui.url.startsWith("https://")) {
        throw new TypeError("hmp-inventory ui.url must be a resource URL or an HTTPS URL");
      }
      if (!Array.isArray(config2.items)) throw new TypeError("hmp-inventory items must be an array");
      config2.startingItems = normalizeStartingItems(config2.startingItems);
      return config2;
    }
    module2.exports = { loadConfig: loadConfig2, normalizeStartingItems };
  }
});

// server/schema.ts
var require_schema = __commonJS({
  "server/schema.ts"(exports2, module2) {
    "use strict";
    var migrations2 = [
      {
        version: 1,
        name: "create character inventories and native snapshots",
        statements: [
          `CREATE TABLE IF NOT EXISTS hmp_inventory_containers (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                container_key VARCHAR(191) NOT NULL,
                owner_character_id BIGINT UNSIGNED NULL,
                label VARCHAR(80) NOT NULL,
                slots SMALLINT UNSIGNED NOT NULL,
                max_weight DECIMAL(12,3) NOT NULL,
                metadata_json LONGTEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_hmp_inventory_container_key (container_key),
                KEY idx_hmp_inventory_character (owner_character_id),
                CONSTRAINT fk_hmp_inventory_character FOREIGN KEY (owner_character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_inventory_items (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                container_id BIGINT UNSIGNED NOT NULL,
                slot SMALLINT UNSIGNED NOT NULL,
                item_name VARCHAR(64) NOT NULL,
                amount INT UNSIGNED NOT NULL,
                metadata_json LONGTEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_hmp_inventory_slot (container_id, slot),
                KEY idx_hmp_inventory_item (container_id, item_name),
                CONSTRAINT fk_hmp_inventory_item_container FOREIGN KEY (container_id) REFERENCES hmp_inventory_containers (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
          `CREATE TABLE IF NOT EXISTS hmp_inventory_native (
                character_id BIGINT UNSIGNED NOT NULL,
                items_json LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id),
                CONSTRAINT fk_hmp_inventory_native_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
        ]
      }
    ];
    module2.exports = { migrations: migrations2 };
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
    function mapContainer(row, rows = []) {
      if (!row) return null;
      return {
        id: Number(row.id),
        key: row.container_key,
        characterId: row.owner_character_id === null ? null : Number(row.owner_character_id),
        label: row.label,
        slots: Number(row.slots),
        maxWeight: Number(row.max_weight),
        metadata: parseJson(row.metadata_json, {}),
        items: rows.map((item) => ({
          slot: Number(item.slot),
          name: item.item_name,
          amount: Number(item.amount),
          metadata: parseJson(item.metadata_json, {})
        }))
      };
    }
    function createRepository2(database2) {
      if (!database2 || typeof database2.transaction !== "function") throw new TypeError("database API is required");
      async function ensureContainer(spec) {
        await database2.update(
          `INSERT INTO hmp_inventory_containers
                (container_key, owner_character_id, label, slots, max_weight, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE container_key = VALUES(container_key)`,
          [spec.key, spec.characterId ?? null, spec.label, spec.slots, spec.maxWeight, JSON.stringify(spec.metadata || {})]
        );
        const container = await getContainer(spec.key);
        if (!container) throw new Error(`inventory container '${spec.key}' was not created`);
        return container;
      }
      async function getContainer(key) {
        const row = await database2.single("SELECT * FROM hmp_inventory_containers WHERE container_key = ?", [key]);
        if (!row) return null;
        const items = await database2.query("SELECT slot, item_name, amount, metadata_json FROM hmp_inventory_items WHERE container_id = ? ORDER BY slot", [row.id]);
        return mapContainer(row, items);
      }
      async function mutateContainer(key, work) {
        return database2.transaction(async (tx) => {
          const row = await tx.single("SELECT * FROM hmp_inventory_containers WHERE container_key = ? FOR UPDATE", [key]);
          if (!row) {
            const error = new Error(`inventory container '${key}' does not exist`);
            Object.assign(error, { code: "HMP_INVENTORY_CONTAINER_NOT_FOUND" });
            throw error;
          }
          const itemRows = await tx.query(
            "SELECT slot, item_name, amount, metadata_json FROM hmp_inventory_items WHERE container_id = ? ORDER BY slot FOR UPDATE",
            [row.id]
          );
          const container = mapContainer(row, itemRows);
          if (!container) throw new Error(`inventory container '${key}' could not be mapped`);
          const result = await work(container);
          await tx.update("DELETE FROM hmp_inventory_items WHERE container_id = ?", [container.id]);
          for (const item of container.items.sort((left, right) => left.slot - right.slot)) {
            await tx.insert(
              "INSERT INTO hmp_inventory_items (container_id, slot, item_name, amount, metadata_json) VALUES (?, ?, ?, ?, ?)",
              [container.id, item.slot, item.name, item.amount, JSON.stringify(item.metadata || {})]
            );
          }
          return { container, result };
        });
      }
      async function mutateContainers(keys, work) {
        const wanted = [...new Set(keys.map((key) => String(key)))].sort();
        if (wanted.length < 2) throw new TypeError("at least two different inventory containers are required");
        return database2.transaction(async (tx) => {
          const containers = /* @__PURE__ */ new Map();
          const rows = /* @__PURE__ */ new Map();
          for (const key of wanted) {
            const row = await tx.single("SELECT * FROM hmp_inventory_containers WHERE container_key = ? FOR UPDATE", [key]);
            if (!row) {
              const error = new Error(`inventory container '${key}' does not exist`);
              Object.assign(error, { code: "HMP_INVENTORY_CONTAINER_NOT_FOUND" });
              throw error;
            }
            rows.set(key, row);
          }
          for (const key of wanted) {
            const row = rows.get(key);
            const itemRows = await tx.query(
              "SELECT slot, item_name, amount, metadata_json FROM hmp_inventory_items WHERE container_id = ? ORDER BY slot FOR UPDATE",
              [row.id]
            );
            const container = mapContainer(row, itemRows);
            if (!container) throw new Error(`inventory container '${key}' could not be mapped`);
            containers.set(key, container);
          }
          const result = await work(containers);
          for (const key of wanted) {
            const container = containers.get(key);
            await tx.update("DELETE FROM hmp_inventory_items WHERE container_id = ?", [container.id]);
            for (const item of container.items.sort((left, right) => left.slot - right.slot)) {
              await tx.insert(
                "INSERT INTO hmp_inventory_items (container_id, slot, item_name, amount, metadata_json) VALUES (?, ?, ?, ?, ?)",
                [container.id, item.slot, item.name, item.amount, JSON.stringify(item.metadata || {})]
              );
            }
          }
          return { containers: wanted.map((key) => containers.get(key)), result };
        });
      }
      async function createNamedContainer(spec) {
        return ensureContainer({ ...spec, characterId: spec.characterId ?? null });
      }
      async function deleteContainer(key) {
        return await database2.update(
          "DELETE FROM hmp_inventory_containers WHERE container_key = ? AND owner_character_id IS NULL",
          [key]
        ) > 0;
      }
      async function loadNative(characterId) {
        const raw = await database2.scalar("SELECT items_json FROM hmp_inventory_native WHERE character_id = ?", [characterId]);
        return parseJson(raw, []);
      }
      async function saveNative(characterId, rows) {
        await database2.update(
          `INSERT INTO hmp_inventory_native (character_id, items_json) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE items_json = VALUES(items_json)`,
          [characterId, JSON.stringify(rows)]
        );
        return rows;
      }
      return Object.freeze({ ensureContainer, createNamedContainer, getContainer, mutateContainer, mutateContainers, deleteContainer, loadNative, saveNative });
    }
    module2.exports = { createRepository: createRepository2 };
  }
});

// server/registry.ts
var require_registry = __commonJS({
  "server/registry.ts"(exports2, module2) {
    "use strict";
    var ITEM_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
    function clean(value, length) {
      return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, length);
    }
    function prettify(value) {
      return String(value || "").replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/\s+/g, " ").trim();
    }
    function createItemRegistry2() {
      const definitions = /* @__PURE__ */ new Map();
      const nativeIds = /* @__PURE__ */ new Map();
      const aliases = /* @__PURE__ */ new Map();
      function normalize(raw) {
        if (!raw || typeof raw !== "object") throw new TypeError("item definition is required");
        const value = raw;
        const name = clean(value.name, 64).toLowerCase();
        if (!ITEM_NAME.test(name)) throw new TypeError("item name must match [a-z0-9:_-] and contain at most 64 characters");
        const itemAliases = [...new Set((Array.isArray(value.aliases) ? value.aliases : []).map((entry) => clean(entry, 64).toLowerCase()).filter((entry) => entry !== name))].slice(0, 16);
        if (itemAliases.some((entry) => !ITEM_NAME.test(entry))) throw new TypeError("item aliases must match [a-z0-9:_-] and contain at most 64 characters");
        const nativeId = clean(value.nativeId, 96) || null;
        const unique = value.unique === true;
        const maxStack = unique ? 1 : Math.max(1, Math.min(1e5, Math.trunc(Number(value.maxStack ?? value.stack)) || 1));
        const weight = Math.max(0, Math.min(1e5, Number(value.weight) || 0));
        const referenceValue = Math.trunc(Number(value.referenceValue));
        return Object.freeze({
          name,
          aliases: Object.freeze(itemAliases),
          label: clean(value.label ?? value.displayName ?? prettify(name), 80) || name,
          description: clean(value.description, 240),
          icon: clean(value.icon, 512),
          category: clean(value.category ?? value.itemType ?? "Miscellaneous", 48) || "Miscellaneous",
          kind: ["item", "gear", "tool", "mount"].includes(String(value.kind)) ? value.kind : "item",
          weight,
          maxStack,
          unique,
          usable: value.usable === true || typeof value.use === "function",
          consumable: value.consumable === true,
          use: typeof value.use === "function" ? value.use : null,
          referenceValue: Number.isFinite(referenceValue) && referenceValue > 0 ? Math.min(2147483647, referenceValue) : void 0,
          nativeId,
          holder: nativeId ? clean(value.holder, 64) || null : null,
          resource: clean(value.resource ?? "unknown", 64) || "unknown",
          native: Boolean(nativeId)
        });
      }
      function register(raw) {
        const definition = normalize(raw);
        const current = definitions.get(definition.name);
        if (current && current.resource !== definition.resource) throw new Error(`item '${definition.name}' is already owned by ${current.resource}`);
        const canonicalCollision = aliases.get(definition.name);
        if (canonicalCollision && canonicalCollision !== definition.name) throw new Error(`item '${definition.name}' is already an alias for ${canonicalCollision}`);
        if (definition.nativeId) {
          const mapped = nativeIds.get(definition.nativeId.toLowerCase());
          if (mapped && mapped !== definition.name) throw new Error(`native item '${definition.nativeId}' is already mapped to ${mapped}`);
        }
        for (const alias of definition.aliases) {
          const mapped = aliases.get(alias);
          if (definitions.has(alias) && alias !== definition.name) throw new Error(`item alias '${alias}' is already a canonical item`);
          if (mapped && mapped !== definition.name) throw new Error(`item alias '${alias}' is already mapped to ${mapped}`);
        }
        if (current?.nativeId) nativeIds.delete(current.nativeId.toLowerCase());
        for (const alias of current?.aliases || []) aliases.delete(alias);
        definitions.set(definition.name, definition);
        if (definition.nativeId) nativeIds.set(definition.nativeId.toLowerCase(), definition.name);
        for (const alias of definition.aliases) aliases.set(alias, definition.name);
        return definition;
      }
      function unregister(name, resource2) {
        const requested = String(name || "").toLowerCase();
        const key = definitions.has(requested) ? requested : aliases.get(requested) || requested;
        const current = definitions.get(key);
        if (!current || resource2 && current.resource !== resource2) return false;
        definitions.delete(key);
        if (current.nativeId) nativeIds.delete(current.nativeId.toLowerCase());
        for (const alias of current.aliases) aliases.delete(alias);
        return true;
      }
      function get(name) {
        const requested = String(name || "").toLowerCase();
        return definitions.get(requested) || definitions.get(aliases.get(requested) || "") || definitions.get(nativeIds.get(requested) || "") || null;
      }
      function fromNative(itemId) {
        const mapped = nativeIds.get(String(itemId || "").toLowerCase());
        return mapped ? definitions.get(mapped) || null : null;
      }
      function removeForResource(resource2) {
        let removed = 0;
        for (const definition of [...definitions.values()]) if (definition.resource === resource2 && unregister(definition.name, resource2)) removed++;
        return removed;
      }
      return Object.freeze({ register, unregister, get, fromNative, list: () => [...definitions.values()], removeForResource });
    }
    module2.exports = { createItemRegistry: createItemRegistry2, prettify };
  }
});

// server/native.ts
var require_native = __commonJS({
  "server/native.ts"(exports2, module2) {
    "use strict";
    function sanitizeRows(raw) {
      const rows = [];
      for (const row of Array.isArray(raw) ? raw : []) {
        if (!row || typeof row !== "object") continue;
        const value = row;
        const itemId = String(value.itemId || "").trim().slice(0, 96);
        const holder = String(value.holder || "").trim().slice(0, 64);
        const count = Math.trunc(Number(value.count));
        if (!itemId || !holder || !Number.isSafeInteger(count) || count <= 0) continue;
        const normalized = { itemId, holder, count };
        if (value.variation !== void 0 && value.variation !== null && String(value.variation)) normalized.variation = String(value.variation).slice(0, 96);
        if (value.identified === true) normalized.identified = true;
        if (value.equipped === true) normalized.equipped = true;
        if (value.hoodUp === true) normalized.hoodUp = true;
        if (["item", "gear", "tool", "mount"].includes(String(value.kind))) normalized.kind = value.kind;
        if (value.itemType) normalized.itemType = String(value.itemType).slice(0, 64);
        if (value.unique === true) normalized.unique = true;
        rows.push(normalized);
      }
      return rows;
    }
    function callbackCall(player, method, ...args) {
      return new Promise((resolve, reject) => {
        if (!player?.inventory || typeof player.inventory[method] !== "function") {
          const error = new Error(`native inventory method '${method}' is unavailable`);
          Object.assign(error, { code: "HMP_INVENTORY_NATIVE_UNAVAILABLE" });
          reject(error);
          return;
        }
        let settled = false;
        const done = (error, result) => {
          if (settled) return;
          settled = true;
          if (error) {
            const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
            reject(error instanceof Error ? error : Object.assign(new Error(message), typeof error === "object" ? error : {}));
          } else if (result) resolve(result);
          else reject(Object.assign(new Error(`native inventory method '${method}' returned no result`), { code: "HMP_INVENTORY_NATIVE_INVALID_RESULT" }));
        };
        try {
          const nativeMethod = player.inventory[method];
          const returned = nativeMethod.call(player.inventory, ...args, done);
          if (returned && typeof returned === "object" && "then" in returned && typeof returned.then === "function") {
            Promise.resolve(returned).then((result) => resolve(result), reject);
          }
        } catch (error) {
          reject(error);
        }
      });
    }
    async function waitForApplied(player, result) {
      const revision = Number(result?.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw Object.assign(new Error("native inventory mutation returned an invalid revision"), { code: "HMP_INVENTORY_NATIVE_INVALID_REVISION" });
      }
      const inventory2 = player?.inventory;
      if (!inventory2 || typeof inventory2.waitForRevision !== "function") {
        throw Object.assign(new Error("native inventory revision acknowledgement is unavailable"), { code: "HMP_INVENTORY_NATIVE_UNAVAILABLE" });
      }
      return inventory2.waitForRevision(revision);
    }
    function createNativeBridge2(options) {
      const { repository: repository2, core: core2, logger: logger2 } = options;
      const active = /* @__PURE__ */ new Map();
      const loading = /* @__PURE__ */ new Set();
      const writes = /* @__PURE__ */ new Map();
      function list(player) {
        try {
          return sanitizeRows(player?.inventory?.list?.() || []);
        } catch (_) {
          return [];
        }
      }
      function queueSave(characterId, rows) {
        const previous = writes.get(characterId) || Promise.resolve();
        const next = previous.catch(() => {
        }).then(() => repository2.saveNative(characterId, sanitizeRows(rows)));
        writes.set(characterId, next);
        next.then(
          () => {
            if (writes.get(characterId) === next) writes.delete(characterId);
          },
          () => {
            if (writes.get(characterId) === next) writes.delete(characterId);
          }
        );
        return next;
      }
      async function attach(player, character) {
        if (!player || !character) return false;
        loading.add(player.id);
        try {
          const rows = sanitizeRows(await repository2.loadNative(character.id));
          const replaced = await callbackCall(player, "replace", rows);
          await waitForApplied(player, replaced);
          active.set(player.id, Number(character.id));
          return true;
        } finally {
          loading.delete(player.id);
        }
      }
      async function save(player, character) {
        const characterId = Number(character?.id ?? active.get(player?.id));
        if (!player || !Number.isSafeInteger(characterId) || characterId <= 0) return false;
        if (player.inventory?.revision === 0) return false;
        await queueSave(characterId, list(player));
        return true;
      }
      async function onUpdated(player, rows) {
        if (!player || loading.has(player.id)) return false;
        const characterId = active.get(player.id) ?? core2.characters.active(player)?.id;
        if (!characterId) return false;
        await queueSave(Number(characterId), rows);
        return true;
      }
      function detach(player) {
        if (!player) return false;
        loading.delete(player.id);
        return active.delete(player.id);
      }
      async function give(player, definition, amount, options2 = {}) {
        if (!definition?.nativeId) throw new TypeError("a native-backed item definition is required");
        const nativeOptions = {};
        if (options2.variation) nativeOptions.variation = String(options2.variation).slice(0, 96);
        if (options2.identified === true) nativeOptions.identified = true;
        if (definition.unique) nativeOptions.unique = true;
        const result = await callbackCall(player, "give", definition.nativeId, amount, nativeOptions);
        await waitForApplied(player, result);
        return amount;
      }
      async function remove(player, definition, amount, options2 = {}) {
        if (!definition?.nativeId) throw new TypeError("a native-backed item definition is required");
        const nativeOptions = {};
        if (options2.variation) nativeOptions.variation = String(options2.variation).slice(0, 96);
        const result = await callbackCall(player, "remove", definition.nativeId, amount, nativeOptions);
        await waitForApplied(player, result);
        return amount;
      }
      async function use(player, definition, options2 = {}) {
        if (!definition?.nativeId) throw new TypeError("a native-backed item definition is required");
        const nativeOptions = {};
        if (options2.variation) nativeOptions.variation = String(options2.variation).slice(0, 96);
        const result = await callbackCall(player, "use", definition.nativeId, nativeOptions);
        await waitForApplied(player, result);
        return true;
      }
      async function flush() {
        await Promise.allSettled([...writes.values()]);
      }
      return Object.freeze({ list, attach, save, onUpdated, detach, give, remove, use, flush, sanitizeRows, status: () => ({ active: active.size, pendingWrites: writes.size }) });
    }
    module2.exports = { createNativeBridge: createNativeBridge2, sanitizeRows };
  }
});

// server/inventory.ts
var require_inventory = __commonJS({
  "server/inventory.ts"(exports2, module2) {
    "use strict";
    var { prettify } = require_registry();
    function stableJson(value) {
      if (!value || typeof value !== "object") return "{}";
      const sort = (entry) => Array.isArray(entry) ? entry.map(sort) : entry && typeof entry === "object" ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key])])) : entry;
      return JSON.stringify(sort(value));
    }
    function inventoryError(code, message) {
      const error = new Error(message);
      return Object.assign(error, { code });
    }
    function createInventory2(options) {
      const { repository: repository2, registry: registry2, native: native2, core: core2, events, config: config2 } = options;
      const characterKey = (id) => `character:${Number(id)}`;
      function characterFor(target) {
        if (target && typeof target === "object") {
          const character = core2.characters.active(target);
          if (!character) throw inventoryError("HMP_INVENTORY_NO_CHARACTER", "No character is active");
          return { character, player: target };
        }
        const id = Number(target);
        if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("a player or character id is required");
        return { character: { id }, player: null };
      }
      async function ensureCharacter(character) {
        return repository2.ensureContainer({
          key: characterKey(character.id),
          characterId: character.id,
          label: "Inventory",
          slots: config2.slots,
          maxWeight: config2.maxWeight,
          metadata: { kind: "character" }
        });
      }
      const weightOf = (container) => container.items.reduce((total, row) => total + (registry2.get(row.name)?.weight || 0) * row.amount, 0);
      function enrichCustom(row) {
        const definition = registry2.get(row.name);
        return {
          source: "custom",
          slot: row.slot,
          name: row.name,
          itemId: null,
          label: definition?.label || prettify(row.name) || "Unknown item",
          description: definition?.description || "This item definition is not currently registered.",
          icon: definition?.icon || "fw://resources/hmp-inventory/dist/icons/item.svg",
          category: definition?.category || "Unknown",
          kind: definition?.kind || "item",
          amount: row.amount,
          weight: (definition?.weight || 0) * row.amount,
          metadata: row.metadata || {},
          usable: definition?.usable === true
        };
      }
      function enrichNative(row) {
        const definition = registry2.fromNative(row.itemId);
        const kind = definition?.kind || row.kind || "item";
        return {
          source: "native",
          slot: null,
          name: definition?.name || `native:${String(row.itemId).toLowerCase()}`,
          itemId: row.itemId,
          label: definition?.label || prettify(row.itemId) || row.itemId,
          description: definition?.description || "Held by Hogwarts Legacy's native inventory.",
          icon: definition?.icon || `fw://resources/hmp-inventory/dist/icons/${["gear", "tool", "mount"].includes(kind) ? kind : "item"}.svg`,
          category: definition?.category || row.itemType || row.holder || "Native",
          kind,
          holder: row.holder,
          amount: row.count,
          weight: 0,
          variation: row.variation || "",
          identified: row.identified === true,
          equipped: row.equipped === true,
          metadata: {},
          usable: definition?.usable === true
        };
      }
      async function get(target) {
        const { character, player } = characterFor(target);
        const container = await ensureCharacter(character);
        const custom = [...container.items].sort((left, right) => left.slot - right.slot).map(enrichCustom);
        const nativeRows = player ? native2.list(player).map(enrichNative) : [];
        const items = [...custom, ...nativeRows];
        return {
          characterId: Number(character.id),
          container: { key: container.key, label: container.label, slots: container.slots, maxWeight: container.maxWeight },
          usedSlots: items.length,
          weight: items.reduce((total, row) => total + row.weight, 0),
          custom,
          native: nativeRows,
          items
        };
      }
      async function add(target, name, amount = 1, itemOptions = {}) {
        const definition = registry2.get(name);
        if (!definition) throw inventoryError("HMP_INVENTORY_ITEM_UNKNOWN", `Unknown item '${name}'`);
        const quantity = Math.trunc(Number(amount));
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
        const { character, player } = characterFor(target);
        if (definition.native) {
          if (!player) throw inventoryError("HMP_INVENTORY_NATIVE_OFFLINE", "Native items require an online player");
          await native2.give(player, definition, quantity, itemOptions);
          await events.emit("hmp:inventory:changed", { player, character, action: "add", item: definition, amount: quantity, source: "native" });
          return quantity;
        }
        const metadata = itemOptions.metadata && typeof itemOptions.metadata === "object" ? itemOptions.metadata : {};
        await ensureCharacter(character);
        const mutation = await repository2.mutateContainer(characterKey(character.id), (container) => {
          let left = quantity;
          const metadataKey = stableJson(metadata);
          if (!definition.unique) {
            for (const row of container.items) {
              if (row.name !== definition.name || stableJson(row.metadata) !== metadataKey || row.amount >= definition.maxStack) continue;
              const moved = Math.min(left, definition.maxStack - row.amount);
              row.amount += moved;
              left -= moved;
              if (!left) break;
            }
          }
          while (left > 0) {
            const occupied = new Set(container.items.map((row) => row.slot));
            let slot = 1;
            while (occupied.has(slot) && slot <= container.slots) slot++;
            if (slot > container.slots) throw inventoryError("HMP_INVENTORY_FULL", "There are not enough inventory slots");
            const moved = definition.unique ? 1 : Math.min(left, definition.maxStack);
            container.items.push({ slot, name: definition.name, amount: moved, metadata: { ...metadata } });
            left -= moved;
          }
          const weight = weightOf(container);
          if (container.maxWeight > 0 && weight > container.maxWeight + Number.EPSILON) throw inventoryError("HMP_INVENTORY_OVERWEIGHT", "The inventory cannot carry that much weight");
          return quantity;
        });
        await events.emit("hmp:inventory:changed", { player, character, action: "add", item: definition, amount: quantity, source: "custom", container: mutation.container });
        return quantity;
      }
      async function remove(target, name, amount = 1, itemOptions = {}) {
        const definition = registry2.get(name);
        if (!definition) throw inventoryError("HMP_INVENTORY_ITEM_UNKNOWN", `Unknown item '${name}'`);
        const quantity = Math.trunc(Number(amount));
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
        const { character, player } = characterFor(target);
        if (definition.native) {
          if (!player) throw inventoryError("HMP_INVENTORY_NATIVE_OFFLINE", "Native items require an online player");
          await native2.remove(player, definition, quantity, itemOptions);
          await events.emit("hmp:inventory:changed", { player, character, action: "remove", item: definition, amount: quantity, source: "native" });
          return quantity;
        }
        await ensureCharacter(character);
        const wantedMetadata = itemOptions.metadata && typeof itemOptions.metadata === "object" ? stableJson(itemOptions.metadata) : null;
        const mutation = await repository2.mutateContainer(characterKey(character.id), (container) => {
          const available = container.items.reduce((total, row) => total + (row.name === definition.name && (wantedMetadata === null || stableJson(row.metadata) === wantedMetadata) ? row.amount : 0), 0);
          if (available < quantity) throw inventoryError("HMP_INVENTORY_NOT_ENOUGH", `Not enough ${definition.label}`);
          let left = quantity;
          for (const row of [...container.items].sort((a, b) => b.slot - a.slot)) {
            if (row.name !== definition.name || wantedMetadata !== null && stableJson(row.metadata) !== wantedMetadata) continue;
            const moved = Math.min(left, row.amount);
            row.amount -= moved;
            left -= moved;
            if (row.amount <= 0) container.items.splice(container.items.indexOf(row), 1);
            if (!left) break;
          }
          return quantity;
        });
        await events.emit("hmp:inventory:changed", { player, character, action: "remove", item: definition, amount: quantity, source: "custom", container: mutation.container });
        return quantity;
      }
      async function count(target, name, itemOptions = {}) {
        const definition = registry2.get(name);
        if (!definition) return 0;
        const { character, player } = characterFor(target);
        if (definition.native) {
          if (!player) return 0;
          const variation = itemOptions.variation === void 0 ? null : String(itemOptions.variation);
          return native2.list(player).reduce((total, row) => total + (row.itemId === definition.nativeId && (variation === null || (row.variation || "") === variation) ? row.count : 0), 0);
        }
        const container = await ensureCharacter(character);
        const wantedMetadata = itemOptions.metadata && typeof itemOptions.metadata === "object" ? stableJson(itemOptions.metadata) : null;
        return container.items.reduce((total, row) => total + (row.name === definition.name && (wantedMetadata === null || stableJson(row.metadata) === wantedMetadata) ? row.amount : 0), 0);
      }
      async function move(target, fromSlot, toSlot) {
        const { character, player } = characterFor(target);
        const from = Math.trunc(Number(fromSlot));
        const to = Math.trunc(Number(toSlot));
        await ensureCharacter(character);
        const mutation = await repository2.mutateContainer(characterKey(character.id), (container) => {
          if (from < 1 || from > container.slots || to < 1 || to > container.slots) throw new RangeError("slot is outside this inventory");
          const source = container.items.find((row) => row.slot === from);
          if (!source) throw inventoryError("HMP_INVENTORY_SLOT_EMPTY", "The source slot is empty");
          const destination = container.items.find((row) => row.slot === to);
          if (!destination) source.slot = to;
          else {
            destination.slot = from;
            source.slot = to;
          }
          return true;
        });
        await events.emit("hmp:inventory:changed", { player, character, action: "move", source: "custom", container: mutation.container });
        return true;
      }
      async function use(player, target) {
        const { character } = characterFor(player);
        if (target && typeof target === "object" && target.source === "native") {
          const itemId = String(target.itemId || "").trim();
          const definition2 = registry2.fromNative(itemId);
          if (!definition2?.native || !definition2.usable) throw inventoryError("HMP_INVENTORY_NOT_USABLE", "That native item cannot be used");
          const context2 = {
            player,
            character,
            item: definition2,
            itemId: definition2.nativeId,
            variation: String(target.variation || ""),
            source: "native",
            cancelled: false
          };
          await events.emit("hmp:inventory:using", context2);
          if (context2.cancelled) return false;
          await native2.use(player, definition2, { variation: context2.variation });
          await events.emit("hmp:inventory:used", context2);
          return true;
        }
        const slot = typeof target === "number" ? target : target?.slot;
        const container = await ensureCharacter(character);
        const row = container.items.find((item) => item.slot === Math.trunc(Number(slot)));
        if (!row) throw inventoryError("HMP_INVENTORY_SLOT_EMPTY", "That slot is empty");
        const definition = registry2.get(row.name);
        if (!definition?.usable) throw inventoryError("HMP_INVENTORY_NOT_USABLE", "That item cannot be used");
        const context = {
          player,
          character,
          item: definition,
          slot: row.slot,
          metadata: { ...row.metadata },
          cancelled: false,
          consume: definition.consumable
        };
        if (definition.use) await definition.use(context);
        await events.emit("hmp:inventory:using", context);
        if (context.cancelled) return false;
        if (context.consume) await remove(player, definition.name, 1, { metadata: row.metadata });
        await events.emit("hmp:inventory:used", context);
        return true;
      }
      const api = Object.freeze({
        get,
        add,
        remove,
        count,
        has: async (target, name, amount = 1, opts) => await count(target, name, opts) >= amount,
        move,
        use
      });
      return { api, ensureCharacter, enrichNative, characterKey };
    }
    module2.exports = { createInventory: createInventory2, stableJson };
  }
});

// server/transfers.ts
var require_transfers = __commonJS({
  "server/transfers.ts"(exports2, module2) {
    "use strict";
    function transferError(code, message) {
      return Object.assign(new Error(message), { code });
    }
    function stableJson(value) {
      if (!value || typeof value !== "object") return "{}";
      const sort = (entry) => Array.isArray(entry) ? entry.map(sort) : entry && typeof entry === "object" ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key])])) : entry;
      return JSON.stringify(sort(value));
    }
    function createTransferService2(options) {
      const { repository: repository2, registry: registry2, core: core2, events, config: config2 } = options;
      const characterKey = (id) => `character:${Number(id)}`;
      async function resolve(target) {
        if (typeof target === "string") {
          const key = target.trim().toLowerCase();
          if (!key) throw new TypeError("a named inventory container key is required");
          if (!await repository2.getContainer(key)) throw transferError("HMP_INVENTORY_CONTAINER_NOT_FOUND", `Inventory container '${key}' does not exist`);
          return { key, player: null, character: null };
        }
        if (target && typeof target === "object") {
          const character2 = core2.characters.active(target);
          if (!character2) throw transferError("HMP_INVENTORY_NO_CHARACTER", "No character is active");
          await repository2.ensureContainer({
            key: characterKey(character2.id),
            characterId: character2.id,
            label: "Inventory",
            slots: config2.slots,
            maxWeight: config2.maxWeight,
            metadata: { kind: "character" }
          });
          return { key: characterKey(character2.id), player: target, character: character2 };
        }
        const characterId = Math.trunc(Number(target));
        if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new TypeError("a player, character id, or container key is required");
        const character = { id: characterId };
        await repository2.ensureContainer({
          key: characterKey(characterId),
          characterId,
          label: "Inventory",
          slots: config2.slots,
          maxWeight: config2.maxWeight,
          metadata: { kind: "character" }
        });
        return { key: characterKey(characterId), player: null, character };
      }
      function weightOf(container) {
        return container.items.reduce((total, row) => total + (registry2.get(row.name)?.weight || 0) * row.amount, 0);
      }
      function place(container, source, amount, preferredSlot) {
        const definition = registry2.get(source.name);
        if (!definition) throw transferError("HMP_INVENTORY_ITEM_UNKNOWN", `Unknown item '${source.name}'`);
        const metadataKey = stableJson(source.metadata);
        let left = amount;
        if (preferredSlot !== void 0) {
          if (preferredSlot < 1 || preferredSlot > container.slots) throw transferError("HMP_INVENTORY_SLOT_INVALID", "The destination slot is outside that container");
          const preferred = container.items.find((row) => row.slot === preferredSlot);
          if (preferred) {
            const compatible = !definition.unique && preferred.name === source.name && stableJson(preferred.metadata) === metadataKey && preferred.amount < definition.maxStack;
            if (!compatible) throw transferError("HMP_INVENTORY_SLOT_OCCUPIED", "The destination slot contains a different or full stack");
            const moved = Math.min(left, definition.maxStack - preferred.amount);
            preferred.amount += moved;
            left -= moved;
          } else {
            const moved = definition.unique ? 1 : Math.min(left, definition.maxStack);
            container.items.push({ slot: preferredSlot, name: source.name, amount: moved, metadata: { ...source.metadata } });
            left -= moved;
          }
          preferredSlot = void 0;
        }
        if (!definition.unique) {
          for (const row of [...container.items].sort((a, b) => a.slot - b.slot)) {
            if (!left) break;
            if (row.slot === preferredSlot || row.name !== source.name || stableJson(row.metadata) !== metadataKey || row.amount >= definition.maxStack) continue;
            const moved = Math.min(left, definition.maxStack - row.amount);
            row.amount += moved;
            left -= moved;
          }
        }
        while (left > 0) {
          const occupied = new Set(container.items.map((row) => row.slot));
          let slot = 1;
          while (occupied.has(slot) && slot <= container.slots) slot++;
          if (slot > container.slots) throw transferError("HMP_INVENTORY_FULL", "The destination does not have enough inventory slots");
          const moved = definition.unique ? 1 : Math.min(left, definition.maxStack);
          container.items.push({ slot, name: source.name, amount: moved, metadata: { ...source.metadata } });
          left -= moved;
        }
        if (container.maxWeight > 0 && weightOf(container) > container.maxWeight + Number.EPSILON) {
          throw transferError("HMP_INVENTORY_OVERWEIGHT", "The destination cannot carry that much weight");
        }
      }
      async function move(request) {
        if (!request || typeof request !== "object") throw new TypeError("an inventory transfer request is required");
        const [from, to] = await Promise.all([resolve(request.from), resolve(request.to)]);
        if (from.key === to.key) throw transferError("HMP_INVENTORY_SAME_CONTAINER", "Source and destination must be different containers");
        const fromSlot = Math.trunc(Number(request.fromSlot));
        if (!Number.isSafeInteger(fromSlot) || fromSlot < 1) throw new TypeError("fromSlot must be a positive integer");
        const requestedAmount = request.amount === void 0 ? null : Math.trunc(Number(request.amount));
        if (requestedAmount !== null && (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0)) throw new TypeError("amount must be a positive integer");
        const toSlot = request.toSlot === void 0 ? void 0 : Math.trunc(Number(request.toSlot));
        if (toSlot !== void 0 && (!Number.isSafeInteger(toSlot) || toSlot < 1)) throw new TypeError("toSlot must be a positive integer");
        const mutation = await repository2.mutateContainers([from.key, to.key], (containers) => {
          const sourceContainer2 = containers.get(from.key);
          const destinationContainer2 = containers.get(to.key);
          const source = sourceContainer2.items.find((row) => row.slot === fromSlot);
          if (!source) throw transferError("HMP_INVENTORY_SLOT_EMPTY", "The source slot is empty");
          const definition = registry2.get(source.name);
          if (!definition) throw transferError("HMP_INVENTORY_ITEM_UNKNOWN", `Unknown item '${source.name}'`);
          if (definition.native) {
            throw transferError("HMP_INVENTORY_NATIVE_TRANSFER_UNSUPPORTED", "Native game items cannot cross a database-container boundary without a recovery journal");
          }
          const amount = requestedAmount ?? source.amount;
          if (amount > source.amount) throw transferError("HMP_INVENTORY_NOT_ENOUGH", `The source stack contains only ${source.amount}`);
          place(destinationContainer2, source, amount, toSlot);
          source.amount -= amount;
          if (source.amount === 0) sourceContainer2.items.splice(sourceContainer2.items.indexOf(source), 1);
          return { item: source.name, amount, metadata: { ...source.metadata } };
        });
        const sourceContainer = mutation.containers.find((container) => container.key === from.key);
        const destinationContainer = mutation.containers.find((container) => container.key === to.key);
        const result = {
          ...mutation.result,
          from: sourceContainer,
          to: destinationContainer
        };
        const payload = { ...result, from: { ...from, container: sourceContainer }, to: { ...to, container: destinationContainer } };
        const notify = (name, value) => Promise.resolve().then(() => events.emit(name, value)).catch(() => void 0);
        const notifications = [];
        if (from.player) notifications.push(notify("hmp:inventory:changed", { player: from.player, character: from.character, action: "transfer-out", source: "custom", transfer: result, container: sourceContainer }));
        if (to.player) notifications.push(notify("hmp:inventory:changed", { player: to.player, character: to.character, action: "transfer-in", source: "custom", transfer: result, container: destinationContainer }));
        notifications.push(notify("hmp:inventory:transferred", payload));
        await Promise.allSettled(notifications);
        return result;
      }
      return Object.freeze({ move });
    }
    module2.exports = { createTransferService: createTransferService2 };
  }
});

// server/errors.ts
var require_errors = __commonJS({
  "server/errors.ts"(exports2, module2) {
    "use strict";
    function messageOf2(error) {
      if (error instanceof Error) return error.message;
      if (!error || typeof error !== "object") return String(error);
      const { code, message, applyErrors } = error;
      const text = [code, message].filter((part) => typeof part === "string" && part !== "").join(": ");
      if (!text) {
        try {
          return JSON.stringify(error);
        } catch (_) {
          return String(error);
        }
      }
      const rows = Array.isArray(applyErrors) ? applyErrors.map((row) => `${String(row?.itemId)}@${String(row?.holder)} ${String(row?.code)}`) : [];
      return rows.length ? `${text} (${rows.join(", ")})` : text;
    }
    module2.exports = { messageOf: messageOf2 };
  }
});

// server/resource.ts
var require_resource = __commonJS({
  "server/resource.ts"(exports2, module2) {
    "use strict";
    var CONTAINER_KEY = /^[a-z0-9][a-z0-9:_.-]{0,190}$/;
    var errorsModule2 = require_errors();
    var { messageOf: messageOf2 } = errorsModule2;
    function createInventoryResource2(options) {
      const { database: database2, repository: repository2, registry: registry2, inventory: inventory2, transfers: transfers2, native: native2, core: core2, events, config: config2, migrations: migrations2, logger: logger2, listPlayers } = options;
      const clients = /* @__PURE__ */ new Set();
      const open = /* @__PURE__ */ new Set();
      let state = "starting";
      let lastError = "";
      let startedAt = Date.now();
      const startPromise = Promise.resolve().then(async () => {
        if (typeof database2.ready === "function" && !await database2.ready()) throw new Error("hmp-mysql is not ready");
        return database2.migrate("hmp-inventory", migrations2);
      }).then(() => {
        state = "ready";
        return true;
      }).catch((error) => {
        state = "degraded";
        lastError = messageOf2(error);
        throw error;
      });
      function activeResourceName(input) {
        const value = input && typeof input === "object" ? input : {};
        return String(value.resource || value.resourceName || "unknown").trim().slice(0, 64) || "unknown";
      }
      const items = Object.freeze({
        register(definition) {
          return registry2.register({ ...definition, resource: activeResourceName(definition) });
        },
        unregister: (name, resource2) => registry2.unregister(name, resource2),
        get: (name) => registry2.get(name),
        fromNative: (itemId) => registry2.fromNative(itemId),
        list: () => registry2.list()
      });
      const containers = Object.freeze({
        async create(spec) {
          await startPromise;
          if (!spec || typeof spec !== "object") throw new TypeError("container definition is required");
          const key = String(spec.key || "").toLowerCase();
          if (!CONTAINER_KEY.test(key) || key.startsWith("character:")) throw new TypeError("container key is invalid or reserved");
          return repository2.createNamedContainer({
            key,
            label: String(spec.label || key).trim().slice(0, 80),
            slots: Math.max(1, Math.min(500, Math.trunc(Number(spec.slots)) || config2.slots)),
            maxWeight: Math.max(0, Math.min(1e6, Number(spec.maxWeight) || config2.maxWeight)),
            metadata: spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {}
          });
        },
        async get(key) {
          await startPromise;
          return repository2.getContainer(String(key || "").toLowerCase());
        },
        async remove(key) {
          await startPromise;
          return repository2.deleteContainer(String(key || "").toLowerCase());
        }
      });
      const transferApi = Object.freeze({
        async move(request) {
          await startPromise;
          return transfers2.move(request);
        }
      });
      async function model(player) {
        await startPromise;
        const data = await inventory2.api.get(player);
        return {
          title: core2.characters.active(player)?.name || "Inventory",
          ...data
        };
      }
      async function push(player) {
        if (!player || !clients.has(player.id)) return false;
        player.emit("hmp-inventory:model", JSON.stringify(await model(player)));
        return true;
      }
      const ui = Object.freeze({
        async open(player) {
          const payload = await model(player);
          open.add(player.id);
          player.emit("hmp-inventory:open", JSON.stringify(payload));
          return payload;
        },
        close(player) {
          if (!player) return false;
          open.delete(player.id);
          player.emit("hmp-inventory:close", "{}");
          return true;
        },
        refresh: push,
        isOpen: (player) => Boolean(player && open.has(player.id))
      });
      async function onCharacterLoading(payload) {
        await startPromise;
        await inventory2.ensureCharacter(payload.character);
        await native2.attach(payload.session.player, payload.character);
      }
      async function onCharacterUnloading(payload) {
        await native2.save(payload.session.player, payload.character);
        open.delete(payload.session.player.id);
        payload.session.player.emit("hmp-inventory:close", "{}");
        native2.detach(payload.session.player);
      }
      function disconnect(player) {
        clients.delete(player?.id);
        open.delete(player?.id);
        native2.detach(player);
      }
      function configureClient(player) {
        player.emit("hmp-inventory:configure", JSON.stringify({
          contract: "hmp.inventory.ui/v1",
          url: config2.ui.url
        }));
      }
      async function saveAll() {
        const players = listPlayers();
        await Promise.allSettled(players.map((player) => native2.save(player, core2.characters.active(player))));
        await native2.flush();
      }
      async function stop() {
        await saveAll();
        state = "stopped";
      }
      const status = () => ({
        state,
        lastError,
        itemDefinitions: registry2.list().length,
        openInventories: open.size,
        readyClients: clients.size,
        native: native2.status(),
        uptimeMs: Date.now() - startedAt
      });
      return Object.freeze({
        items,
        inventory: inventory2.api,
        containers,
        transfers: transferApi,
        native: Object.freeze({
          list: native2.list,
          save: native2.save,
          give: async (player, item, amount, opts) => native2.give(player, typeof item === "string" ? registry2.get(item) : item, amount, opts),
          remove: async (player, item, amount, opts) => native2.remove(player, typeof item === "string" ? registry2.get(item) : item, amount, opts),
          use: async (player, item, opts) => native2.use(player, typeof item === "string" ? registry2.get(item) : item, opts)
        }),
        ui,
        status,
        ready: () => startPromise,
        onClientReady(player) {
          clients.add(player.id);
          configureClient(player);
          return open.has(player.id) ? push(player) : Promise.resolve(true);
        },
        onCharacterLoading,
        onCharacterUnloading,
        onNativeUpdated: native2.onUpdated,
        disconnect,
        removeForResource: (resource2) => registry2.removeForResource(resource2),
        saveAll,
        stop
      });
    }
    module2.exports = { createInventoryResource: createInventoryResource2 };
  }
});

// server/native-catalog.ts
var require_native_catalog = __commonJS({
  "server/native-catalog.ts"(exports2, module2) {
    "use strict";
    var curated = [
      ["focus_potion", "Focus Potion", "AMFillPotion", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
      ["thunderbrew", "Thunderbrew", "AutoDamagePotion", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
      ["edurus_potion", "Edurus Potion", "Edurus", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
      ["felix_felicis", "Felix Felicis", "FelixFelicis", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
      ["invisibility_potion", "Invisibility Potion", "InvisibilityPotion", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
      ["maxima_potion", "Maxima Potion", "Maxima", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
      ["wiggenweld_potion", "Wiggenweld Potion", "WoundCleaning", "PotionUsable", "HealthPotionStorage", 25, "potion.svg"],
      ["chomping_cabbage", "Chinese Chomping Cabbage", "ChompingCabbage_Byproduct", "PlantUsable", "SanctuaryWheel", 12, "plant.svg"],
      ["mandrake", "Mandrake", "Mandrake_Byproduct", "PlantUsable", "SanctuaryWheel", 12, "plant.svg"],
      ["venomous_tentacula", "Venomous Tentacula", "VenomousTentacula_Byproduct", "PlantUsable", "SanctuaryWheel", 12, "plant.svg"],
      ["ashwinder_eggs", "Ashwinder Eggs", "AshwinderEggs", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
      ["horklump_juice", "Horklump Juice", "HorklumpJuice", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
      ["lacewing_flies", "Lacewing Flies", "LacewingFlies", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
      ["leech_juice", "Leech Juice", "LeechJuice", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
      ["moonstone", "Moonstone", "Moonstone", "Resource", "ResourceInventory", 999, "ingredient.svg"],
      ["fertiliser", "Fertiliser", "Fertiliser", "SanctuaryItem", "ResourceInventory", 999, "ingredient.svg"],
      ["galleons", "Galleons", "Knuts", "SPECIAL", "ResourceInventory", 999999, "coin.svg", ["native:knuts"]]
    ].map(([name, label, itemId, itemType, holder, maxStack, icon, aliases]) => ({ name, label, itemId, itemType, holder, maxStack, icon, aliases }));
    var curatedById = new Map(curated.map((item) => [item.itemId, item]));
    var iconUrl = (file) => `fw://resources/hmp-inventory/dist/icons/${file}`;
    function prettify(value) {
      return value.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/\s+/g, " ").trim();
    }
    function defaultIcon(definition) {
      const type = definition.itemType.toLowerCase();
      if (type.includes("potion")) return "potion.svg";
      if (type.includes("plant")) return "plant.svg";
      if (type.includes("forage") || type.includes("resource") || type.includes("ingredient")) return "ingredient.svg";
      if (["gear", "tool", "mount"].includes(definition.kind)) return `${definition.kind}.svg`;
      return "item.svg";
    }
    function fallbackDefinitions() {
      return curated.map((item) => ({
        itemId: item.itemId,
        itemType: item.itemType,
        holder: item.holder,
        maxStack: item.maxStack,
        kind: "item",
        inventoryable: true,
        persistent: true,
        consumable: item.itemType === "PotionUsable" || item.itemType === "PlantUsable",
        usableFromInventory: false
      }));
    }
    function createNativeItems2(catalog) {
      if (catalog) {
        const info = catalog.info();
        if (info.schemaVersion !== 1) throw new Error(`Unsupported InventoryCatalog schema version '${String(info.schemaVersion)}'`);
      }
      const definitions = catalog ? catalog.list({ inventoryable: true }) : fallbackDefinitions();
      return definitions.map((definition) => {
        const override = curatedById.get(definition.itemId);
        return {
          name: `native:${override?.name || definition.itemId.toLowerCase()}`,
          aliases: override?.aliases,
          label: override?.label || prettify(definition.itemId) || definition.itemId,
          nativeId: definition.itemId,
          category: prettify(definition.itemType) || "Native",
          holder: definition.holder,
          maxStack: Math.max(1, definition.maxStack),
          icon: iconUrl(override?.icon || defaultIcon(definition)),
          weight: 0,
          kind: definition.kind,
          unique: definition.kind === "gear",
          usable: definition.usableFromInventory,
          consumable: definition.consumable,
          referenceValue: Number.isFinite(definition.economyValue) && Number(definition.economyValue) > 0 ? Math.trunc(Number(definition.economyValue)) : void 0,
          resource: "hmp-inventory"
        };
      });
    }
    module2.exports = { createNativeItems: createNativeItems2 };
  }
});

// server/starting-items.ts
var require_starting_items = __commonJS({
  "server/starting-items.ts"(exports2, module2) {
    "use strict";
    var errorsModule2 = require_errors();
    var { messageOf: messageOf2 } = errorsModule2;
    function createStartingItemsGrant2(entries, deps) {
      const configured = entries.map((entry) => ({ ...entry }));
      const pending = /* @__PURE__ */ new Set();
      function created(payload) {
        const characterId = Number(payload?.character?.id);
        if (!configured.length || !Number.isSafeInteger(characterId) || characterId <= 0) return false;
        pending.add(characterId);
        return true;
      }
      async function loaded(payload) {
        const characterId = Number(payload?.character?.id);
        if (!pending.has(characterId)) return false;
        const player = payload?.session?.player;
        if (!player) return false;
        await deps.ready();
        pending.delete(characterId);
        for (const entry of configured) {
          try {
            await deps.inventory.api.add(player, entry.name, entry.amount, {
              identified: true,
              ...entry.metadata ? { metadata: entry.metadata } : {}
            });
          } catch (error) {
            deps.logger.warn(`Could not grant starting item '${entry.name}' to character #${characterId}: ${messageOf2(error)}`);
          }
        }
        return true;
      }
      function deleted(payload) {
        return pending.delete(Number(payload?.character?.id));
      }
      return Object.freeze({ created, loaded, deleted, pending: (characterId) => pending.has(Number(characterId)) });
    }
    module2.exports = { createStartingItemsGrant: createStartingItemsGrant2 };
  }
});

// server/main.ts
var configModule = require_config();
var schemaModule = require_schema();
var repositoryModule = require_repository();
var registryModule = require_registry();
var nativeModule = require_native();
var inventoryModule = require_inventory();
var transfersModule = require_transfers();
var resourceModule = require_resource();
var catalogModule = require_native_catalog();
var startingItemsModule = require_starting_items();
var errorsModule = require_errors();
var { loadConfig } = configModule;
var { migrations } = schemaModule;
var { createRepository } = repositoryModule;
var { createItemRegistry } = registryModule;
var { createNativeBridge } = nativeModule;
var { createInventory } = inventoryModule;
var { createTransferService } = transfersModule;
var { createInventoryResource } = resourceModule;
var { createNativeItems } = catalogModule;
var { createStartingItemsGrant } = startingItemsModule;
var { messageOf } = errorsModule;
var Hmp = Imports.get("hmp-lib");
var database = Imports.get("hmp-mysql");
var core = Imports.get("hmp-core");
var logger = Hmp.logger.create("hmp-inventory");
var config = loadConfig(Hmp);
var repository = createRepository(database);
var registry = createItemRegistry();
var configuredItems = config.items;
var nativeItems = createNativeItems(typeof InventoryCatalog === "object" ? InventoryCatalog : null);
for (const definition of [...nativeItems, ...configuredItems.map((item) => ({ ...item, resource: item.resource || "hmp-inventory" }))]) registry.register(definition);
var native = createNativeBridge({ repository, core, logger });
var inventory = createInventory({ repository, registry, native, core, events: Events, config });
var transfers = createTransferService({ repository, registry, core, events: Events, config });
var resource = createInventoryResource({
  database,
  repository,
  registry,
  inventory,
  transfers,
  native,
  core,
  events: Events,
  config,
  migrations,
  logger,
  listPlayers: () => PlayerManager.getAll()
});
var startingItems = createStartingItemsGrant(config.startingItems, { inventory, ready: resource.ready, logger });
var actions = Hmp.rateLimit.create({ limit: 6, windowMs: 2e3 });
for (const name of ["items", "inventory", "containers", "transfers", "native", "ui", "status"]) Exports.register(name, resource[name]);
Events.on("hmp:character:loading", (payload) => resource.onCharacterLoading(payload).catch((error) => logger.error(`Could not load inventory: ${messageOf(error)}`)));
Events.on("hmp:character:unloading", (payload) => resource.onCharacterUnloading(payload).catch((error) => logger.error(`Could not save inventory: ${messageOf(error)}`)));
Events.on("hmp:character:created", (payload) => startingItems.created(payload));
Events.on("hmp:character:loaded", (payload) => {
  const value = payload;
  startingItems.loaded(value).catch((error) => logger.error(`Could not grant starting items to character ${value?.character?.id}: ${messageOf(error)}`));
});
Events.on("hmp:character:deleted", (payload) => startingItems.deleted(payload));
Events.on("hmp:session:ended", (session) => resource.disconnect(session.player));
Events.on("playerInventoryUpdated", (player, rows) => resource.onNativeUpdated(player, rows).catch((error) => logger.warn(`Could not persist native inventory: ${messageOf(error)}`)));
Events.on("hmp:inventory:changed", (payload) => {
  const player = payload && typeof payload === "object" && "player" in payload ? payload.player : null;
  if (player && resource.ui.isOpen(player)) resource.ui.refresh(player).catch((error) => logger.warn(`Could not refresh inventory: ${messageOf(error)}`));
});
Events.onClient("hmp-inventory:ready", (player) => resource.onClientReady(player));
Events.onClient("hmp-inventory:close", (player) => resource.ui.close(player));
Events.onClient("hmp-inventory:refresh", (player) => {
  if (!actions.allow(player.id)) return;
  resource.ui.refresh(player).catch((error) => player.emit("hmp-inventory:error", JSON.stringify({ message: messageOf(error) })));
});
Events.onClient("hmp-inventory:use", (player, raw) => {
  if (!actions.allow(player.id)) return;
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch (_) {
  }
  const value = payload && typeof payload === "object" ? payload : {};
  const target = value.source === "native" ? { source: "native", itemId: String(value.itemId || ""), variation: String(value.variation || "") } : Number(value.slot);
  resource.inventory.use(player, target).then(() => resource.ui.refresh(player)).catch((error) => player.emit("hmp-inventory:error", JSON.stringify({ message: messageOf(error) })));
});
if (config.allowInventoryCommand) Events.on("chatCommand", (player, _message, command) => {
  const currentPlayer = player;
  if (!["inventory", "hmpinv"].includes(String(command || "").toLowerCase())) return;
  resource.ui.open(currentPlayer).catch((error) => {
    logger.warn(`Could not open inventory for #${currentPlayer.id}: ${messageOf(error)}`);
    if (typeof currentPlayer.sendChat === "function") currentPlayer.sendChat(`[inventory] ${messageOf(error)}`);
  });
});
var autoSaveTimer = config.autoSaveMs > 0 ? setInterval(() => resource.saveAll().catch((error) => logger.warn(`Inventory autosave failed: ${messageOf(error)}`)), config.autoSaveMs) : null;
if (autoSaveTimer && typeof autoSaveTimer.unref === "function") autoSaveTimer.unref();
Events.on("resourceStop", (name) => {
  if (name && name !== "hmp-inventory") {
    resource.removeForResource(name);
    return;
  }
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  resource.stop().catch((error) => logger.error(`Inventory shutdown failed: ${messageOf(error)}`));
});
Events.on("resourceStart", async (name) => {
  if (name && name !== "hmp-inventory") return;
  await resource.ready();
  logger.info(`Inventory ready with ${resource.status().itemDefinitions} item definition(s)`);
});
