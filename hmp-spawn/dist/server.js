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
        showSelector: true,
        allowLastLocation: true,
        saveLastLocation: true,
        defaultLocation: "hogwarts",
        teleportTimeoutMs: 12e4,
        autoSaveMs: 6e4,
        locations: [
          {
            key: "hogwarts",
            label: "Hogwarts",
            description: "Return to the castle grounds.",
            areaId: "Overland",
            x: 366784,
            y: -461527,
            z: -82610,
            snapToGround: true
          }
        ]
      };
      const config2 = Hmp2.config.load(env.HMP_SPAWN_CONFIG || "data/hmp-spawn.json", { cwd, defaults });
      if (env.HMP_SPAWN_SELECTOR) config2.showSelector = Hmp2.config.env.boolean(env.HMP_SPAWN_SELECTOR);
      if (env.HMP_SPAWN_LAST_LOCATION) config2.allowLastLocation = Hmp2.config.env.boolean(env.HMP_SPAWN_LAST_LOCATION);
      if (env.HMP_SPAWN_SAVE_LOCATION) config2.saveLastLocation = Hmp2.config.env.boolean(env.HMP_SPAWN_SAVE_LOCATION);
      if (env.HMP_SPAWN_DEFAULT) config2.defaultLocation = String(env.HMP_SPAWN_DEFAULT).trim().toLowerCase();
      config2.teleportTimeoutMs = Math.max(5e3, Math.min(3e5, Math.trunc(Number(config2.teleportTimeoutMs)) || 12e4));
      config2.autoSaveMs = Math.max(0, Math.min(36e5, Math.trunc(Number(config2.autoSaveMs)) || 0));
      if (!Array.isArray(config2.locations) || !config2.locations.length) throw new TypeError("hmp-spawn requires at least one configured location");
      return config2;
    }
    module2.exports = { loadConfig: loadConfig2 };
  }
});

// server/spawn.ts
var require_spawn = __commonJS({
  "server/spawn.ts"(exports2, module2) {
    "use strict";
    var LAST_LOCATION_KEY = "hmp-spawn:last-location";
    var MAX_COORDINATE = 1e7;
    function spawnError(code, message) {
      const error = new Error(message);
      return Object.assign(error, { code });
    }
    function normalizeLocation(value, options = {}) {
      if (!value || typeof value !== "object") throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn location must be an object");
      const record = value;
      const key = String(record.key || options.key || "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key) || key === "last") {
        throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn key must be 1-32 lowercase letters, numbers, underscores or hyphens");
      }
      const coordinates = { x: Number(record.x), y: Number(record.y), z: Number(record.z) };
      for (const [axis, coordinate] of Object.entries(coordinates)) {
        if (!Number.isFinite(coordinate) || Math.abs(coordinate) > MAX_COORDINATE) {
          throw spawnError("HMP_SPAWN_INVALID_LOCATION", `Spawn ${axis} coordinate is invalid`);
        }
      }
      const yaw = record.yaw === void 0 || record.yaw === null ? void 0 : Number(record.yaw);
      if (yaw !== void 0 && !Number.isFinite(yaw)) throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn yaw is invalid");
      if (record.snapToGround !== void 0 && typeof record.snapToGround !== "boolean") {
        throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn snapToGround must be a boolean");
      }
      const groundSnapDistance = record.groundSnapDistance === void 0 ? 2e3 : Number(record.groundSnapDistance);
      if (!Number.isFinite(groundSnapDistance) || groundSnapDistance <= 0 || groundSnapDistance > 1e5) {
        throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn groundSnapDistance must be greater than 0 and at most 100000 cm");
      }
      const areaId = String(record.areaId || "").trim().slice(0, 128);
      const regionId = String(record.regionId || "").trim().slice(0, 128);
      const destinationId = record.destinationId === null ? null : String(record.destinationId || "").trim().slice(0, 128) || void 0;
      return Object.freeze({
        key,
        label: String(record.label || key).trim().slice(0, 64) || key,
        description: String(record.description || "").trim().slice(0, 160),
        ...coordinates,
        ...areaId ? { areaId } : {},
        ...regionId ? { regionId } : {},
        ...destinationId !== void 0 ? { destinationId } : {},
        ...yaw === void 0 ? {} : { yaw },
        snapToGround: record.snapToGround === true,
        groundSnapDistance,
        resource: String(record.resource || options.resource || "unknown")
      });
    }
    function storedLocation(value) {
      if (!value || typeof value !== "object") return null;
      try {
        return normalizeLocation({
          key: "saved-location",
          label: "Last Location",
          x: value.x,
          y: value.y,
          z: value.z,
          yaw: value.yaw,
          areaId: value.areaId,
          regionId: value.regionId,
          destinationId: value.destinationId,
          snapToGround: true,
          resource: "hmp-spawn"
        });
      } catch (_) {
        return null;
      }
    }
    function createSpawnFlow2(options) {
      const core2 = options.core;
      const events = options.events || null;
      const config2 = options.config || {};
      const logger2 = options.logger || console;
      const setTimer = options.setTimer || ((callback, milliseconds) => setTimeout(callback, milliseconds));
      const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
      if (!core2?.sessions || !core2?.characters || !core2?.metadata) throw new TypeError("hmp-core API is required");
      const locations = /* @__PURE__ */ new Map();
      const pendingByRequest = /* @__PURE__ */ new Map();
      const pendingByPlayer = /* @__PURE__ */ new Map();
      const spawnedCharacter = /* @__PURE__ */ new Map();
      const loadingDone = /* @__PURE__ */ new Set();
      const queuedSelection = /* @__PURE__ */ new Map();
      const selectorRequests = /* @__PURE__ */ new Map();
      for (const location of config2.locations || []) register({ ...location, resource: "hmp-spawn" });
      if (!locations.has(String(config2.defaultLocation || "").toLowerCase())) {
        throw new TypeError(`hmp-spawn default location '${config2.defaultLocation}' is not registered`);
      }
      function idOf(player) {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0) throw spawnError("HMP_SPAWN_INVALID_PLAYER", "A connected player is required");
        return id;
      }
      function send(player, event, payload = {}) {
        if (!player || typeof player.emit !== "function") return false;
        player.emit(event, JSON.stringify(payload));
        return true;
      }
      function playerLocation(player) {
        try {
          return typeof player.location === "function" ? player.location() : null;
        } catch (_) {
          return null;
        }
      }
      function matchesContext(player, location) {
        if (!location.areaId && !location.regionId) return true;
        const current = playerLocation(player);
        if (!current) return false;
        if (location.areaId && location.areaId.toLowerCase() !== current.areaId.toLowerCase()) return false;
        return !location.regionId || location.regionId.toLowerCase() === current.regionId.toLowerCase();
      }
      async function emit(name, payload) {
        if (!events || typeof events.emit !== "function") return;
        try {
          await events.emit(name, payload);
        } catch (error) {
          if (logger2 && typeof logger2.error === "function") logger2.error(`${name} handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      function register(definition) {
        const location = normalizeLocation(definition, { resource: definition?.resource });
        if (locations.has(location.key)) throw spawnError("HMP_SPAWN_LOCATION_EXISTS", `Spawn location '${location.key}' is already registered`);
        locations.set(location.key, location);
        return () => locations.delete(location.key);
      }
      function unregister(key) {
        const normalized = String(key || "").trim().toLowerCase();
        const location = locations.get(normalized);
        if (!location || location.resource === "hmp-spawn") return false;
        return locations.delete(normalized);
      }
      function removeForResource(resource) {
        let removed = 0;
        for (const [key, location] of locations) {
          if (location.resource === resource && location.resource !== "hmp-spawn") {
            locations.delete(key);
            removed += 1;
          }
        }
        return removed;
      }
      function publicLocation(location, kind = "configured") {
        return {
          key: location.key,
          label: location.label,
          description: location.description,
          kind,
          ...location.areaId ? { areaId: location.areaId } : {},
          ...location.regionId ? { regionId: location.regionId } : {}
        };
      }
      function sessionAndCharacter(player) {
        const session = core2.sessions.get(player);
        const character = core2.characters.active(player);
        if (!session || !character) throw spawnError("HMP_SPAWN_CHARACTER_MISSING", "Choose a character before selecting a spawn");
        return { session, character };
      }
      async function lastLocation(characterId) {
        if (!config2.allowLastLocation) return null;
        return storedLocation(await core2.metadata.getCharacter(characterId, LAST_LOCATION_KEY));
      }
      async function available(player) {
        const { character } = sessionAndCharacter(player);
        const result = [];
        const last = await lastLocation(character.id);
        if (last && matchesContext(player, last)) result.push(publicLocation({ ...last, key: "last" }, "last"));
        for (const location of locations.values()) if (matchesContext(player, location)) result.push(publicLocation(location));
        return result;
      }
      async function resolve(player, destination) {
        const { character } = sessionAndCharacter(player);
        if (typeof destination === "object" && destination) {
          const direct = destination;
          const resolved = normalizeLocation(destination, { key: String(direct.key || "direct"), resource: "direct" });
          if (!matchesContext(player, resolved)) throw spawnError("HMP_SPAWN_AREA_MISMATCH", "That destination is in a different game area.");
          return resolved;
        }
        const key = String(destination || "").trim().toLowerCase();
        if (key === "last") {
          const saved = await lastLocation(character.id);
          if (saved && matchesContext(player, saved)) return { ...saved, key: "last", label: "Last Location" };
          throw spawnError("HMP_SPAWN_LOCATION_MISSING", "No saved location is available for this character");
        }
        const configured = locations.get(key);
        if (!configured) throw spawnError("HMP_SPAWN_LOCATION_MISSING", "That spawn location is no longer available");
        if (!matchesContext(player, configured)) throw spawnError("HMP_SPAWN_AREA_MISMATCH", "That destination is in a different game area.");
        return configured;
      }
      async function open(player) {
        const { character } = sessionAndCharacter(player);
        const playerId = idOf(player);
        const request = Symbol();
        selectorRequests.set(playerId, request);
        const choices = await available(player);
        const current = playerLocation(player);
        const payload = {
          character: { id: character.id, name: character.name },
          locations: choices,
          defaultLocation: String(config2.defaultLocation),
          ...choices.length ? {} : {
            emptyMessage: current ? "No destinations are configured for your current area. Please contact the server administrator." : "Waiting for your current area to load. Destinations will appear automatically."
          }
        };
        if (selectorRequests.get(playerId) === request && core2.characters.active(player)?.id === character.id) {
          send(player, "hmp-spawn:open", payload);
        }
        return payload;
      }
      async function saveSnapshot(player, snapshot, characterOverride = null, force = false) {
        if (!config2.saveLastLocation) return false;
        const character = characterOverride || core2.characters.active(player);
        if (!character) return false;
        const id = idOf(player);
        if (!force && spawnedCharacter.get(id) !== character.id) return false;
        const saved = storedLocation(snapshot);
        if (!saved) return false;
        await core2.metadata.setCharacter(character.id, LAST_LOCATION_KEY, {
          x: saved.x,
          y: saved.y,
          z: saved.z,
          ...saved.yaw === void 0 ? {} : { yaw: saved.yaw },
          ...saved.areaId ? { areaId: saved.areaId } : {},
          ...saved.regionId ? { regionId: saved.regionId } : {},
          ...saved.destinationId !== void 0 ? { destinationId: saved.destinationId } : {}
        });
        return true;
      }
      async function save(player, characterOverride = null, force = false) {
        const location = playerLocation(player);
        if (location) return saveSnapshot(player, location, characterOverride, force);
        if (typeof player.location === "function") return false;
        let position;
        try {
          position = player.position;
        } catch (_) {
          return false;
        }
        return saveSnapshot(player, position, characterOverride, force);
      }
      async function locationChanged(player, current, previous) {
        const saved = await saveSnapshot(player, current || previous);
        if (selectorRequests.has(idOf(player))) await open(player);
        return saved;
      }
      function clearPending(context) {
        if (!context) return;
        if (context.timer) clearTimer(context.timer);
        pendingByRequest.delete(context.requestId);
        if (pendingByPlayer.get(context.playerId) === context) pendingByPlayer.delete(context.playerId);
      }
      async function failContext(context, status, message) {
        clearPending(context);
        send(context.player, "hmp-spawn:failed", { status, message });
        await emit("hmp:spawn:failed", { session: context.session, character: context.character, location: context.location, status, message });
        if (core2.sessions.get(context.player)) await open(context.player);
      }
      async function spawn(player, destination) {
        const playerId = idOf(player);
        if (pendingByPlayer.has(playerId)) throw spawnError("HMP_SPAWN_IN_PROGRESS", "A spawn is already in progress");
        const { session, character } = sessionAndCharacter(player);
        const location = await resolve(player, destination);
        selectorRequests.delete(playerId);
        send(player, "hmp-spawn:transition", { location: publicLocation(location, location.key === "last" ? "last" : "configured") });
        let requestId;
        try {
          requestId = Number(player.teleport(location.x, location.y, location.z, {
            ...location.yaw === void 0 ? {} : { yaw: location.yaw },
            snapToGround: location.snapToGround,
            groundSnapDistance: location.groundSnapDistance
          }));
        } catch (error) {
          send(player, "hmp-spawn:failed", { status: -1, message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        if (!Number.isSafeInteger(requestId) || requestId < 1) throw spawnError("HMP_SPAWN_TELEPORT_REJECTED", "The streamed teleport was not accepted");
        const context = { requestId, playerId, player, session, character, location, timer: null };
        context.timer = setTimer(() => {
          failContext(context, 6, "The destination took too long to load.").catch((error) => {
            if (logger2 && typeof logger2.error === "function") logger2.error(`Spawn timeout recovery failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, Number(config2.teleportTimeoutMs || 12e4));
        if (context.timer && typeof context.timer.unref === "function") context.timer.unref();
        pendingByRequest.set(requestId, context);
        pendingByPlayer.set(playerId, context);
        await emit("hmp:spawn:started", { session, character, location: publicLocation(location), requestId });
        return requestId;
      }
      async function complete(player, requestId, status, completion) {
        const context = pendingByRequest.get(Number(requestId));
        if (!context || context.playerId !== idOf(player)) return false;
        clearPending(context);
        if (Number(status) !== 0) {
          await failContext(context, Number(status), "The destination could not be loaded. Choose another location.");
          return false;
        }
        const detail = completion && typeof completion === "object" ? completion : null;
        const destination = detail?.destination;
        const validCompletion = Number(detail?.requestId) === context.requestId && Number(detail?.status) === 0 && destination && Number.isFinite(Number(destination.x)) && Number.isFinite(Number(destination.y)) && Number.isFinite(Number(destination.z)) && Number.isFinite(Number(destination.yaw));
        if (!validCompletion || !destination) {
          await failContext(context, 7, "The game did not confirm the final landing position. Choose another location.");
          return false;
        }
        const arrival = {
          ...context.location,
          x: Number(destination.x),
          y: Number(destination.y),
          z: Number(destination.z),
          yaw: Number(destination.yaw)
        };
        const observedLocation = playerLocation(player);
        if (observedLocation) {
          arrival.areaId = observedLocation.areaId;
          arrival.regionId = observedLocation.regionId;
          arrival.destinationId = observedLocation.destinationId;
        }
        spawnedCharacter.set(context.playerId, context.character.id);
        if (config2.saveLastLocation) {
          await saveSnapshot(player, arrival, context.character, true);
        }
        send(player, "hmp-spawn:complete", { location: publicLocation(arrival), destination, groundSnapped: detail.groundSnapped === true });
        await emit("hmp:spawn:complete", { session: context.session, character: context.character, location: arrival, completion: detail });
        return true;
      }
      async function select(player, key) {
        return spawn(player, String(key || ""));
      }
      async function onCharacterSelected(payload) {
        const player = payload?.session?.player;
        if (!player) return false;
        const id = idOf(player);
        spawnedCharacter.delete(id);
        selectorRequests.delete(id);
        if (!loadingDone.has(id)) {
          queuedSelection.set(id, payload);
          return false;
        }
        if (config2.showSelector === false) {
          const last = await lastLocation(payload.character.id);
          return spawn(player, last ? "last" : config2.defaultLocation);
        }
        await open(player);
        return true;
      }
      async function onLoadingFinished(player) {
        const id = idOf(player);
        loadingDone.add(id);
        const queued = queuedSelection.get(id);
        if (!queued) return false;
        queuedSelection.delete(id);
        return onCharacterSelected(queued);
      }
      async function saveAll(players) {
        let saved = 0;
        for (const player of Array.isArray(players) ? players : []) {
          try {
            if (await save(player)) saved += 1;
          } catch (error) {
            if (logger2 && typeof logger2.warn === "function") logger2.warn(`Could not save #${player?.id} location: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return saved;
      }
      function disconnect(player) {
        const id = idOf(player);
        const pending = pendingByPlayer.get(id);
        if (pending) clearPending(pending);
        loadingDone.delete(id);
        queuedSelection.delete(id);
        spawnedCharacter.delete(id);
        selectorRequests.delete(id);
      }
      const locationApi = Object.freeze({
        register,
        unregister,
        list: () => [...locations.values()].map((location) => publicLocation(location))
      });
      const ui = Object.freeze({ open });
      return Object.freeze({
        locations: locationApi,
        ui,
        spawn,
        select,
        complete,
        save,
        saveAll,
        onCharacterSelected,
        onLoadingFinished,
        locationChanged,
        removeForResource,
        disconnect,
        status: () => ({ locations: locations.size, pending: pendingByRequest.size, spawned: spawnedCharacter.size })
      });
    }
    module2.exports = { createSpawnFlow: createSpawnFlow2, normalizeLocation, LAST_LOCATION_KEY };
  }
});

// server/main.ts
var configModule = require_config();
var spawnModule = require_spawn();
var { loadConfig } = configModule;
var { createSpawnFlow } = spawnModule;
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var Hmp = Imports.get("hmp-lib");
var core = Imports.get("hmp-core");
var logger = Hmp.logger.create("hmp-spawn");
var config = loadConfig(Hmp);
var flow = createSpawnFlow({ core, events: Events, logger, config });
var actions = Hmp.rateLimit.create({ limit: 5, windowMs: 2e3 });
Exports.register("locations", flow.locations);
Exports.register("ui", flow.ui);
Exports.register("spawn", flow.spawn);
Exports.register("status", flow.status);
Events.on("hmp:character:selected", (payload) => flow.onCharacterSelected(payload).catch((error) => {
  logger.error(`Could not open spawn selection: ${messageOf(error)}`);
  const player = payload && typeof payload === "object" && "session" in payload && payload.session && typeof payload.session === "object" && "player" in payload.session ? payload.session.player : null;
  player?.emit("hmp-spawn:failed", JSON.stringify({ status: -1, message: messageOf(error) }));
}));
Events.on("hmp:character:unloading", (payload) => {
  const value = payload;
  return flow.save(value.session.player, value.character).catch((error) => logger.warn(`Could not save location: ${messageOf(error)}`));
});
Events.on("playerTeleportComplete", (player, requestId, status, completion) => flow.complete(player, requestId, status, completion).catch((error) => logger.error(`Spawn completion failed: ${messageOf(error)}`)));
Events.on("playerLocationChanged", (player, current, previous) => flow.locationChanged(player, current, previous).catch((error) => logger.warn(`Could not update spawn location context: ${messageOf(error)}`)));
Events.on("hmp:session:ended", (session) => flow.disconnect(session.player));
Events.on("resourceStop", (name) => {
  if (name && name !== "hmp-spawn") return flow.removeForResource(name);
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  return flow.saveAll(PlayerManager.getAll());
});
Events.on("loadingFinished", (player) => flow.onLoadingFinished(player).catch((error) => logger.error(`Client readiness failed: ${messageOf(error)}`)));
Events.onClient("hmp-spawn:select", (player, payload) => {
  if (!actions.allow(player.id)) return player.emit("hmp-spawn:failed", JSON.stringify({ status: -1, message: "Please slow down." }));
  const key = payload && typeof payload === "object" && "key" in payload ? payload.key : void 0;
  flow.select(player, key).catch((error) => {
    logger.warn(`Spawn selection for #${player.id} failed: ${messageOf(error)}`);
    player.emit("hmp-spawn:failed", JSON.stringify({ status: -1, message: messageOf(error) }));
  });
});
var autoSaveTimer = config.autoSaveMs > 0 ? setInterval(() => flow.saveAll(PlayerManager.getAll()), config.autoSaveMs) : null;
if (autoSaveTimer && typeof autoSaveTimer.unref === "function") autoSaveTimer.unref();
logger.info(`Spawn flow ready with ${flow.status().locations} location(s)`);
