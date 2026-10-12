"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// shared/text.ts
var require_text = __commonJS({
  "shared/text.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({ clean, slug, isId, truncate });
  }
});

// shared/number.ts
var require_number = __commonJS({
  "shared/number.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({ finite, integer, clamp, between });
  }
});

// shared/position.ts
var require_position = __commonJS({
  "shared/position.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({ read, distance, distanceSquared, within });
  }
});

// shared/validation.ts
var require_validation = __commonJS({
  "shared/validation.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({
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
  "shared/rate-limit.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({ create });
  }
});

// shared/locale.ts
var require_locale = __commonJS({
  "shared/locale.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({ create });
  }
});

// shared/logger.ts
var require_logger = __commonJS({
  "shared/logger.ts"(exports2, module2) {
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
    module2.exports = Object.freeze({ create, levels: LEVELS });
  }
});

// server/config.ts
var require_config = __commonJS({
  "server/config.ts"(exports2, module2) {
    "use strict";
    var fs = require("node:fs");
    var path = require("node:path");
    var BLOCKED_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
    function isPlainObject(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }
    function clone(value) {
      if (Array.isArray(value)) return value.map(clone);
      if (!isPlainObject(value)) return value;
      const output = {};
      for (const [key, child] of Object.entries(value)) {
        if (!BLOCKED_KEYS.has(key)) output[key] = clone(child);
      }
      return output;
    }
    function merge(...sources) {
      const output = {};
      for (const source of sources) {
        if (!isPlainObject(source)) continue;
        for (const [key, value] of Object.entries(source)) {
          if (BLOCKED_KEYS.has(key)) continue;
          if (isPlainObject(value) && isPlainObject(output[key])) output[key] = merge(output[key], value);
          else output[key] = clone(value);
        }
      }
      return output;
    }
    function load(candidates, options = {}) {
      const paths = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
      const cwd = options.cwd || process.cwd();
      let found = "";
      for (const candidate of paths) {
        const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
        if (fs.existsSync(resolved)) {
          found = resolved;
          break;
        }
      }
      if (!found) {
        if (options.required === true) {
          const error = new Error(`configuration not found; tried: ${paths.join(", ")}`);
          Object.assign(error, { code: "HMP_CONFIG_NOT_FOUND" });
          throw error;
        }
        return merge(options.defaults || {});
      }
      if (options.fresh === true) delete require.cache[require.resolve(found)];
      const loaded = require(found);
      const value = isPlainObject(loaded) && loaded.__esModule && loaded.default ? loaded.default : loaded;
      if (!isPlainObject(value)) throw new TypeError(`configuration '${found}' must export a plain object`);
      const config2 = merge(options.defaults || {}, value);
      if (typeof options.validate === "function") {
        const verdict = options.validate(config2, found);
        if (verdict === false) throw new TypeError(`configuration '${found}' failed validation`);
      }
      return config2;
    }
    function envBoolean(value, fallback = false) {
      if (value === void 0 || value === null || value === "") return fallback;
      const normalized = String(value).trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      throw new TypeError(`'${value}' is not a boolean`);
    }
    function envNumber(value, fallback, options = {}) {
      if (value === void 0 || value === null || value === "") return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new TypeError(`'${value}' is not a finite number`);
      if (options.integer === true && !Number.isSafeInteger(parsed)) throw new TypeError(`'${value}' is not a safe integer`);
      if (options.min !== void 0 && parsed < options.min) throw new RangeError(`'${value}' is below ${options.min}`);
      if (options.max !== void 0 && parsed > options.max) throw new RangeError(`'${value}' is above ${options.max}`);
      return parsed;
    }
    function envJson(value, fallback) {
      if (value === void 0 || value === null || value === "") return fallback;
      return JSON.parse(String(value));
    }
    module2.exports = Object.freeze({
      load,
      merge,
      env: Object.freeze({ boolean: envBoolean, number: envNumber, json: envJson })
    });
  }
});

// server/player.ts
var require_player = __commonJS({
  "server/player.ts"(exports2, module2) {
    "use strict";
    function createPlayerApi2(getPlayers) {
      if (typeof getPlayers !== "function") throw new TypeError("getPlayers must be a function");
      function all() {
        try {
          const players = getPlayers();
          return Array.isArray(players) ? players.filter(Boolean) : [];
        } catch (_) {
          return [];
        }
      }
      function byId(id) {
        const wanted = Number(id);
        if (!Number.isSafeInteger(wanted) || wanted < 0) return null;
        return all().find((player2) => Number(player2.id) === wanted) || null;
      }
      function result(player2, reason, candidates = []) {
        return { ok: Boolean(player2), player: player2 || null, reason, candidates };
      }
      function resolve(query, self = null, options = {}) {
        if (query && typeof query === "object" && query.id !== void 0) {
          const player2 = byId(query.id);
          return player2 ? result(player2, "found") : result(null, "not-found");
        }
        const input = typeof query === "number" ? `#${query}` : String(query ?? "").trim();
        if (!input) return result(null, "empty");
        if (options.allowSelf !== false && input.toLowerCase() === "me") {
          return self ? result(self, "found") : result(null, "self-unavailable");
        }
        if (input.startsWith("#")) {
          const player2 = byId(input.slice(1));
          return player2 ? result(player2, "found") : result(null, "not-found");
        }
        const normalize = options.caseSensitive === true ? (value) => String(value) : (value) => String(value).toLocaleLowerCase("en-US");
        const wanted = normalize(input);
        const candidates = all().filter((player2) => normalize(player2.nickname ?? "") === wanted);
        if (candidates.length === 1) return result(candidates[0] ?? null, "found", candidates);
        if (candidates.length > 1) return result(null, "ambiguous", candidates);
        return result(null, "not-found");
      }
      function find(query, self = null, options = {}) {
        return resolve(query, self, options).player;
      }
      function format(player2) {
        if (!player2) return "unknown player";
        return `${player2.nickname || "unnamed"} (#${player2.id})`;
      }
      return Object.freeze({ all, byId, resolve, find, format });
    }
    module2.exports = { createPlayerApi: createPlayerApi2 };
  }
});

// server/command.ts
var require_command = __commonJS({
  "server/command.ts"(exports2, module2) {
    "use strict";
    var COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
    function normalizeName(value) {
      const name = String(value || "").trim().toLowerCase();
      if (!COMMAND_PATTERN.test(name)) throw new TypeError(`invalid command name '${value}'`);
      return name;
    }
    function createCommandApi2(options) {
      const playerApi = options.player;
      if (!playerApi || typeof playerApi.resolve !== "function") throw new TypeError("command API requires the player API");
      const defaultLogger = options.logger || console;
      function createRouter(routerOptions = {}) {
        const commands = /* @__PURE__ */ new Map();
        const aliases = /* @__PURE__ */ new Map();
        const logger2 = routerOptions.logger || defaultLogger;
        const prefix = routerOptions.prefix ? String(routerOptions.prefix) : "";
        function replyTo(player2, message) {
          if (!player2 || typeof player2.sendChat !== "function") return false;
          player2.sendChat(prefix ? `${prefix} ${message}` : String(message));
          return true;
        }
        function register(name, specOrHandler, suppliedHandler) {
          const canonical = normalizeName(name);
          const spec = typeof specOrHandler === "function" ? {} : specOrHandler;
          const handler = typeof specOrHandler === "function" ? specOrHandler : suppliedHandler;
          if (typeof handler !== "function") throw new TypeError(`handler for '${canonical}' must be a function`);
          if (commands.has(canonical) || aliases.has(canonical)) throw new Error(`command '${canonical}' is already registered`);
          const names = Array.from(new Set((spec.aliases || []).map(normalizeName)));
          for (const alias of names) {
            if (alias === canonical || commands.has(alias) || aliases.has(alias)) {
              throw new Error(`command alias '${alias}' is already registered`);
            }
          }
          const errorMessage = spec.errorMessage === false ? false : String(spec.errorMessage || "The command could not be completed.");
          const entry = {
            name: canonical,
            aliases: names,
            description: String(spec.description || ""),
            usage: String(spec.usage || `/${canonical}`),
            guard: typeof spec.guard === "function" ? spec.guard : null,
            errorMessage,
            handler
          };
          commands.set(canonical, entry);
          for (const alias of names) aliases.set(alias, canonical);
          return () => unregister(canonical);
        }
        function unregister(name) {
          const requested = normalizeName(name);
          const canonical = aliases.get(requested) || requested;
          const entry = commands.get(canonical);
          if (!entry) return false;
          commands.delete(canonical);
          for (const alias of entry.aliases) aliases.delete(alias);
          return true;
        }
        function lookup(name) {
          const requested = String(name || "").toLowerCase();
          return commands.get(aliases.get(requested) || requested) || null;
        }
        function describe(entry) {
          if (!entry) return null;
          return {
            name: entry.name,
            aliases: [...entry.aliases],
            description: entry.description,
            usage: entry.usage
          };
        }
        function get(name) {
          return describe(lookup(name));
        }
        async function handle(player2, message, command2, args) {
          const entry = lookup(command2);
          if (!entry) return false;
          const values = Array.isArray(args) ? args.map(String) : [];
          const context = {
            player: player2,
            message: String(message || ""),
            command: entry.name,
            invokedAs: String(command2 || "").toLowerCase(),
            args: values,
            usage: entry.usage,
            reply: (text2) => replyTo(player2, text2),
            resolvePlayer: (query, resolveOptions) => playerApi.resolve(query, player2, resolveOptions),
            findPlayer: (query, resolveOptions) => playerApi.find(query, player2, resolveOptions)
          };
          try {
            if (entry.guard) {
              const verdict = await entry.guard(context);
              if (verdict !== true) {
                if (typeof verdict === "string" && verdict) context.reply(verdict);
                return true;
              }
            }
            await entry.handler(context);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            if (logger2 && typeof logger2.error === "function") logger2.error(`/${entry.name} failed: ${messageText}`);
            if (entry.errorMessage !== false) context.reply(entry.errorMessage);
          }
          return true;
        }
        function list() {
          return [...commands.values()].map((entry) => describe(entry));
        }
        return Object.freeze({ register, unregister, get, handle, list });
      }
      return Object.freeze({ createRouter });
    }
    module2.exports = { createCommandApi: createCommandApi2 };
  }
});

// server/main.ts
var text = require_text();
var number = require_number();
var position = require_position();
var validation = require_validation();
var rateLimit = require_rate_limit();
var locale = require_locale();
var logger = require_logger();
var config = require_config();
var { createPlayerApi } = require_player();
var { createCommandApi } = require_command();
var player = createPlayerApi(() => PlayerManager.getAll());
var command = createCommandApi({ player, logger: logger.create("hmp-command") });
var api = { text, number, position, validation, rateLimit, locale, logger, config, player, command };
for (const [name, value] of Object.entries(api)) Exports.register(name, value);
console.info("[hmp-lib] server utilities ready");
