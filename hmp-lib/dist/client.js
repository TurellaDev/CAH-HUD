"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // shared/text.ts
  var require_text = __commonJS({
    "shared/text.ts"(exports, module) {
      "use strict";
      var DEFAULT_MAX_LENGTH = 256;
      var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
      function maxLength(value, fallback = DEFAULT_MAX_LENGTH) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
      }
      function printable(character) {
        if (character === "\n") return "\n";
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
      }
      function clean(value, options = {}) {
        if (typeof options === "number") options = { maxLength: options };
        const limit = maxLength(options.maxLength);
        const multiline = options.multiline === true;
        const linesLimit = maxLength(options.maxLines, multiline ? 20 : 1);
        let output = Array.from(String(value ?? "").replace(/\r\n?/g, "\n"), printable).join("");
        if (!multiline) {
          output = output.replace(/\s+/g, " ").trim();
        } else {
          output = output.replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
          const lines = output.split("\n");
          if (lines.length > linesLimit) output = lines.slice(0, linesLimit).join("\n");
        }
        return output.slice(0, limit);
      }
      function slug(value, limit = 64) {
        return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength(limit, 64)).replace(/-+$/g, "");
      }
      function isId(value) {
        return typeof value === "string" && ID_PATTERN.test(value);
      }
      function truncate(value, limit = DEFAULT_MAX_LENGTH, suffix = "\u2026") {
        const text2 = String(value ?? "");
        const length = maxLength(limit);
        if (text2.length <= length) return text2;
        if (!length) return "";
        const ending = String(suffix ?? "").slice(0, length);
        return text2.slice(0, Math.max(0, length - ending.length)) + ending;
      }
      module.exports = Object.freeze({ clean, slug, isId, truncate });
    }
  });

  // shared/number.ts
  var require_number = __commonJS({
    "shared/number.ts"(exports, module) {
      "use strict";
      function finite(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      }
      function integer(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : fallback;
      }
      function clamp(value, minimum, maximum) {
        const min = finite(minimum);
        const max = finite(maximum);
        if (min > max) throw new RangeError("minimum cannot be greater than maximum");
        return Math.min(max, Math.max(min, finite(value, min)));
      }
      function between(value, minimum, maximum, inclusive = true) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return false;
        return inclusive ? parsed >= minimum && parsed <= maximum : parsed > minimum && parsed < maximum;
      }
      module.exports = Object.freeze({ finite, integer, clamp, between });
    }
  });

  // shared/position.ts
  var require_position = __commonJS({
    "shared/position.ts"(exports, module) {
      "use strict";
      function read(value) {
        try {
          const candidate = value && typeof value === "object" && "position" in value ? value.position : value;
          if (!candidate || typeof candidate !== "object") return null;
          const record = candidate;
          const x = Number(record.x);
          const y = Number(record.y);
          const z = Number(record.z);
          if (![x, y, z].every(Number.isFinite)) return null;
          return { x, y, z };
        } catch (_) {
          return null;
        }
      }
      function distanceSquared(left, right) {
        const a = read(left);
        const b = read(right);
        if (!a || !b) return Infinity;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return dx * dx + dy * dy + dz * dz;
      }
      function distance(left, right) {
        return Math.sqrt(distanceSquared(left, right));
      }
      function within(left, right, radius) {
        const range = Number(radius);
        return Number.isFinite(range) && range >= 0 && distanceSquared(left, right) <= range * range;
      }
      module.exports = Object.freeze({ read, distance, distanceSquared, within });
    }
  });

  // shared/validation.ts
  var require_validation = __commonJS({
    "shared/validation.ts"(exports, module) {
      "use strict";
      function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
      }
      function isPlainObject(value) {
        if (!isObject(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
      }
      function fail(name, message) {
        throw new TypeError(`${name || "value"} ${message}`);
      }
      function string(value, options = {}) {
        const name = options.name || "value";
        if (typeof value !== "string") fail(name, "must be a string");
        const output = options.trim === false ? value : value.trim();
        const minimum = options.minLength ?? 0;
        const maximum = options.maxLength ?? Infinity;
        if (output.length < minimum) fail(name, `must contain at least ${minimum} character(s)`);
        if (output.length > maximum) fail(name, `must contain at most ${maximum} character(s)`);
        if (options.pattern && !options.pattern.test(output)) fail(name, "has an invalid format");
        return output;
      }
      function number2(value, options = {}) {
        const name = options.name || "value";
        const parsed = options.coerce === true ? Number(value) : value;
        if (typeof parsed !== "number" || !Number.isFinite(parsed)) fail(name, "must be a finite number");
        if (options.integer === true && !Number.isSafeInteger(parsed)) fail(name, "must be a safe integer");
        if (options.min !== void 0 && parsed < options.min) fail(name, `must be at least ${options.min}`);
        if (options.max !== void 0 && parsed > options.max) fail(name, `must be at most ${options.max}`);
        return parsed;
      }
      function boolean(value, options = {}) {
        const name = options.name || "value";
        if (typeof value === "boolean") return value;
        if (options.coerce === true) {
          if (value === 1 || ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase())) return true;
          if (value === 0 || ["false", "0", "no", "off"].includes(String(value).trim().toLowerCase())) return false;
        }
        fail(name, "must be a boolean");
      }
      function array(value, options = {}) {
        const name = options.name || "value";
        if (!Array.isArray(value)) fail(name, "must be an array");
        const minimum = options.minLength ?? 0;
        const maximum = options.maxLength ?? Infinity;
        if (value.length < minimum) fail(name, `must contain at least ${minimum} item(s)`);
        if (value.length > maximum) fail(name, `must contain at most ${maximum} item(s)`);
        const itemParser = options.item;
        if (typeof itemParser !== "function") return value;
        return value.map((item, index) => itemParser(item, { name: `${name}[${index}]` }));
      }
      function object(value, options = {}) {
        const name = options.name || "value";
        const accepted = options.plain === false ? isObject(value) : isPlainObject(value);
        if (!accepted) fail(name, options.plain === false ? "must be an object" : "must be a plain object");
        return value;
      }
      function oneOf(value, allowed, options = {}) {
        const values = Array.from(allowed || []);
        if (!values.includes(value)) fail(options.name || "value", `must be one of: ${values.join(", ")}`);
        return value;
      }
      function optional(parser, defaultValue) {
        if (typeof parser !== "function") throw new TypeError("parser must be a function");
        return (value, options) => value === void 0 || value === null ? defaultValue : parser(value, options);
      }
      function assert(value, predicate, message = "failed validation") {
        if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
        if (!predicate(value)) fail("value", message);
        return value;
      }
      module.exports = Object.freeze({
        isObject,
        isPlainObject,
        string,
        number: number2,
        boolean,
        array,
        object,
        oneOf,
        optional,
        assert
      });
    }
  });

  // shared/rate-limit.ts
  var require_rate_limit = __commonJS({
    "shared/rate-limit.ts"(exports, module) {
      "use strict";
      function positiveInteger(value, name) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
        return value;
      }
      function create(options) {
        const limit = positiveInteger(options.limit, "limit");
        const windowMs = positiveInteger(options.windowMs, "windowMs");
        const now = typeof options.now === "function" ? options.now : Date.now;
        const onDrop = typeof options.onDrop === "function" ? options.onDrop : null;
        const buckets = /* @__PURE__ */ new Map();
        function bucketFor(key, time) {
          let bucket = buckets.get(key);
          if (!bucket || time >= bucket.resetAt) {
            bucket = { used: 0, dropped: 0, resetAt: time + windowMs, touchedAt: time };
            buckets.set(key, bucket);
          }
          bucket.touchedAt = time;
          return bucket;
        }
        function snapshot(key, bucket, allowed = true) {
          return {
            key,
            allowed,
            limit,
            used: bucket.used,
            remaining: Math.max(0, limit - bucket.used),
            dropped: bucket.dropped,
            resetAt: bucket.resetAt
          };
        }
        function take(key = "global", cost = 1) {
          positiveInteger(cost, "cost");
          const time = now();
          const bucket = bucketFor(key, time);
          if (bucket.used + cost <= limit) {
            bucket.used += cost;
            return snapshot(key, bucket, true);
          }
          bucket.dropped++;
          const result = snapshot(key, bucket, false);
          if (onDrop) onDrop(result);
          return result;
        }
        function allow(key = "global", cost = 1) {
          return take(key, cost).allowed;
        }
        function check(key = "global") {
          const time = now();
          const bucket = bucketFor(key, time);
          return snapshot(key, bucket, bucket.used < limit);
        }
        function reset(key = "global") {
          return buckets.delete(key);
        }
        function clear() {
          buckets.clear();
        }
        function sweep(maxIdleMs = windowMs * 2) {
          const time = now();
          let removed = 0;
          for (const [key, bucket] of buckets) {
            if (time - bucket.touchedAt >= maxIdleMs) {
              buckets.delete(key);
              removed++;
            }
          }
          return removed;
        }
        function status() {
          return { limit, windowMs, buckets: buckets.size };
        }
        return Object.freeze({ allow, take, check, reset, clear, sweep, status });
      }
      module.exports = Object.freeze({ create });
    }
  });

  // shared/locale.ts
  var require_locale = __commonJS({
    "shared/locale.ts"(exports, module) {
      "use strict";
      var MISSING = Symbol("missing");
      function lookup(root, key) {
        let value = root;
        for (const part of String(key).split(".")) {
          if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
          value = value[part];
        }
        return value;
      }
      function interpolate(value, params) {
        if (!params || typeof params !== "object") return String(value);
        return String(value).replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
      }
      function create(dictionaries = {}, options = {}) {
        const catalogs = new Map(Object.entries(dictionaries));
        let current = String(options.locale || "en");
        const fallback = String(options.fallback || "en");
        const missing = options.missing;
        function resolve(key, locale2) {
          const primary = lookup(catalogs.get(locale2), key);
          if (primary !== MISSING) return primary;
          if (locale2 !== fallback) {
            const secondary = lookup(catalogs.get(fallback), key);
            if (secondary !== MISSING) return secondary;
          }
          return MISSING;
        }
        function t(key, params, localeOverride) {
          const locale2 = String(localeOverride || current);
          const value = resolve(key, locale2);
          if (value !== MISSING) return interpolate(value, params);
          if (typeof missing === "function") return String(missing(key, locale2));
          if (missing !== void 0) return String(missing);
          return String(key);
        }
        function has(key, localeOverride) {
          return resolve(key, String(localeOverride || current)) !== MISSING;
        }
        function add(locale2, messages) {
          if (!locale2 || !messages || typeof messages !== "object") throw new TypeError("locale and messages are required");
          catalogs.set(String(locale2), messages);
        }
        function setLocale(locale2) {
          if (!locale2) throw new TypeError("locale must be a non-empty string");
          current = String(locale2);
          return current;
        }
        return Object.freeze({
          t,
          has,
          add,
          setLocale,
          getLocale: () => current,
          available: () => [...catalogs.keys()]
        });
      }
      module.exports = Object.freeze({ create });
    }
  });

  // shared/logger.ts
  var require_logger = __commonJS({
    "shared/logger.ts"(exports, module) {
      "use strict";
      var LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: Infinity });
      function create(name, options = {}) {
        const label = String(name || "hmp");
        const sink = options.sink || console;
        let threshold = options.level === void 0 ? LEVELS.info : LEVELS[options.level];
        const context = options.context && typeof options.context === "object" ? { ...options.context } : null;
        function write(level, args) {
          if (LEVELS[level] < threshold) return false;
          const method = typeof sink[level] === "function" ? sink[level] : sink.log;
          if (typeof method !== "function") return false;
          const prefix = `[${label}]`;
          if (context) method.call(sink, prefix, ...args, context);
          else method.call(sink, prefix, ...args);
          return true;
        }
        const api2 = {
          debug: (...args) => write("debug", args),
          info: (...args) => write("info", args),
          warn: (...args) => write("warn", args),
          error: (...args) => write("error", args),
          enabled: (level) => (LEVELS[level] ?? Infinity) >= threshold,
          setLevel: (level) => {
            if (!(level in LEVELS)) throw new TypeError(`unknown log level '${level}'`);
            threshold = LEVELS[level];
          },
          child: (child, childContext) => create(`${label}:${child}`, {
            sink,
            level: Object.keys(LEVELS).find((key) => LEVELS[key] === threshold) || "info",
            context: { ...context || {}, ...childContext || {} }
          })
        };
        return Object.freeze(api2);
      }
      module.exports = Object.freeze({ create, levels: LEVELS });
    }
  });

  // client/input.ts
  var require_input = __commonJS({
    "client/input.ts"(exports, module) {
      "use strict";
      var OWNER_PART = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
      function createInputApi2(options) {
        const { key, game } = options;
        const output = options.console || console;
        const controlOwners = /* @__PURE__ */ new Map();
        const shortcuts = /* @__PURE__ */ new Map();
        const buckets = /* @__PURE__ */ new Map();
        const warnedConflicts = /* @__PURE__ */ new Set();
        let sequence = 0;
        let conflicts = 0;
        let stopped = false;
        let nativeControlLock = false;
        function part(value, label) {
          const result = String(value || "").trim().toLowerCase();
          if (!OWNER_PART.test(result)) throw new TypeError(`${label} must be a namespaced identifier`);
          return result;
        }
        function owner(raw) {
          if (!raw || typeof raw !== "object") throw new TypeError("input owner is required");
          const resource = part(raw.resource, "resource");
          const id = part(raw.id, "owner id");
          return { resource, id, key: `${resource}:${id}` };
        }
        function normalizeKey(value) {
          const result = String(value || "").trim().toLowerCase();
          if (!result || result.length > 32) throw new TypeError("shortcut key is required");
          return result;
        }
        function normalizeState(value) {
          const state = String(value || "down").toLowerCase();
          if (state !== "down" && state !== "up" && state !== "both") throw new TypeError("shortcut state must be down, up, or both");
          return state;
        }
        function info(record) {
          return { id: record.id, resource: record.resource, key: record.key, state: record.state, priority: record.priority, enabled: record.enabled };
        }
        function eligible(record, state) {
          if (!record.enabled || record.state !== "both" && record.state !== state) return false;
          try {
            return record.when ? record.when() === true : true;
          } catch (error) {
            output.error(`[hmp-input] ${record.resource}:${record.id} eligibility failed`, error);
            return false;
          }
        }
        function dispatch(physicalKey, state) {
          const candidates = [...shortcuts.values()].filter((record) => record.key === physicalKey && eligible(record, state)).sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
          if (!candidates.length) return;
          if (candidates.length > 1 && candidates[0].priority === candidates[1].priority) {
            conflicts++;
            const tied = candidates.filter((record) => record.priority === candidates[0].priority);
            const signature = `${physicalKey}:${state}:${candidates[0].priority}:${tied.map((record) => `${record.resource}:${record.id}`).join(",")}`;
            if (!warnedConflicts.has(signature)) {
              warnedConflicts.add(signature);
              output.warn(`[hmp-input] refusing ambiguous ${physicalKey}/${state} shortcut at priority ${candidates[0].priority}: ${tied.map((record) => `${record.resource}:${record.id}`).join(", ")}`);
            }
            return;
          }
          const selected = candidates[0];
          try {
            selected.handler(physicalKey, state);
          } catch (error) {
            output.error(`[hmp-input] ${selected.resource}:${selected.id} handler failed`, error);
          }
        }
        function ensureBucket(physicalKey) {
          if (buckets.has(physicalKey)) return;
          const handler = (pressed, state) => dispatch(pressed, state);
          key.bind(physicalKey, "both", handler);
          buckets.set(physicalKey, handler);
        }
        function removeBucketIfEmpty(physicalKey) {
          if ([...shortcuts.values()].some((record) => record.key === physicalKey)) return;
          const handler = buckets.get(physicalKey);
          if (!handler) return;
          try {
            key.unbind(physicalKey, "both", handler);
          } catch (error) {
            output.error(`[hmp-input] could not unbind ${physicalKey}`, error);
          }
          buckets.delete(physicalKey);
        }
        function acquire(raw) {
          if (stopped) throw new Error("hmp-lib input manager is stopped");
          const value = owner(raw);
          if (controlOwners.has(value.key)) throw new Error(`control owner '${value.key}' already holds a lease`);
          if (!controlOwners.size) {
            game.lockControls(true);
            nativeControlLock = true;
          }
          controlOwners.set(value.key, { resource: value.resource, id: value.id });
          let released = false;
          return Object.freeze({
            resource: value.resource,
            id: value.id,
            release() {
              if (released) return false;
              released = true;
              return release(value);
            }
          });
        }
        function release(raw) {
          const value = owner(raw);
          if (!controlOwners.delete(value.key)) return false;
          if (!controlOwners.size && nativeControlLock) {
            game.lockControls(false);
            nativeControlLock = false;
          }
          return true;
        }
        function register(raw) {
          if (stopped) throw new Error("hmp-lib input manager is stopped");
          if (!raw || typeof raw !== "object" || typeof raw.handler !== "function") throw new TypeError("shortcut handler is required");
          const value = owner(raw);
          if (shortcuts.has(value.key)) throw new Error(`shortcut '${value.key}' is already registered`);
          const physicalKey = normalizeKey(raw.key);
          ensureBucket(physicalKey);
          shortcuts.set(value.key, {
            id: value.id,
            resource: value.resource,
            key: physicalKey,
            state: normalizeState(raw.state),
            priority: Math.max(-1e3, Math.min(1e3, Math.trunc(Number(raw.priority)) || 0)),
            enabled: raw.enabled !== false,
            when: raw.when,
            handler: raw.handler,
            sequence: ++sequence
          });
          let active = true;
          return () => {
            if (!active) return false;
            active = false;
            return unregister(value.id, value.resource);
          };
        }
        function unregister(id, resource) {
          const normalizedId = part(id, "shortcut id");
          const matches = [...shortcuts.entries()].filter(([, record2]) => record2.id === normalizedId && (!resource || record2.resource === part(resource, "resource")));
          if (matches.length !== 1) return false;
          const [recordKey, record] = matches[0];
          shortcuts.delete(recordKey);
          removeBucketIfEmpty(record.key);
          return true;
        }
        function setEnabled(id, enabled, resource) {
          const record = [...shortcuts.values()].find((entry) => entry.id === part(id, "shortcut id") && (!resource || entry.resource === part(resource, "resource")));
          if (!record) return false;
          record.enabled = enabled === true;
          return true;
        }
        function rebind(id, physicalKey, resource) {
          const record = [...shortcuts.values()].find((entry) => entry.id === part(id, "shortcut id") && (!resource || entry.resource === part(resource, "resource")));
          if (!record) return false;
          const next = normalizeKey(physicalKey);
          if (next === record.key) return true;
          ensureBucket(next);
          const previous = record.key;
          record.key = next;
          removeBucketIfEmpty(previous);
          return true;
        }
        function cleanup(resource) {
          const name = part(resource, "resource");
          let removed = 0;
          for (const [recordKey, record] of [...shortcuts]) {
            if (record.resource !== name) continue;
            shortcuts.delete(recordKey);
            removeBucketIfEmpty(record.key);
            removed++;
          }
          let controlRemoved = false;
          for (const [ownerKey, value] of [...controlOwners]) {
            if (value.resource !== name) continue;
            controlOwners.delete(ownerKey);
            controlRemoved = true;
            removed++;
          }
          if (controlRemoved && !controlOwners.size && nativeControlLock) {
            game.lockControls(false);
            nativeControlLock = false;
          }
          return removed;
        }
        function stop() {
          if (stopped) return;
          stopped = true;
          for (const [physicalKey, handler] of buckets) {
            try {
              key.unbind(physicalKey, "both", handler);
            } catch (_) {
            }
          }
          buckets.clear();
          shortcuts.clear();
          if (nativeControlLock) {
            game.lockControls(false);
            nativeControlLock = false;
          }
          controlOwners.clear();
        }
        return Object.freeze({
          controls: Object.freeze({
            acquire,
            release,
            held: (raw) => raw ? controlOwners.has(owner(raw).key) : controlOwners.size > 0,
            owners: () => [...controlOwners.values()].map((value) => ({ ...value }))
          }),
          shortcuts: Object.freeze({
            register,
            unregister,
            setEnabled,
            rebind,
            get(id, resource) {
              const normalizedId = part(id, "shortcut id");
              const matches = [...shortcuts.values()].filter((entry) => entry.id === normalizedId && (!resource || entry.resource === part(resource, "resource")));
              return matches.length === 1 ? info(matches[0]) : null;
            },
            list: (resource) => [...shortcuts.values()].filter((entry) => !resource || entry.resource === part(resource, "resource")).map(info),
            isDown: (physicalKey) => key.isDown(normalizeKey(physicalKey))
          }),
          cleanup,
          status: () => ({ controlOwners: controlOwners.size, shortcuts: shortcuts.size, physicalKeys: buckets.size, conflicts }),
          stop
        });
      }
      module.exports = { createInputApi: createInputApi2 };
    }
  });

  // client/main.ts
  var text = require_text();
  var number = require_number();
  var position = require_position();
  var validation = require_validation();
  var rateLimit = require_rate_limit();
  var locale = require_locale();
  var logger = require_logger();
  var { createInputApi } = require_input();
  var input = createInputApi({ key: Key, game: Game, console });
  var api = { text, number, position, validation, rateLimit, locale, logger, input };
  for (const [name, value] of Object.entries(api)) Exports.register(name, value);
  Events.on("resourceStop", (name) => {
    if (!name || name === "hmp-lib") input.stop();
    else input.cleanup(name);
  });
  console.info("[hmp-lib] client utilities ready");
})();
