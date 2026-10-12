"use strict";
// hmp-hud - server coordinator.
//
// The HUD is inactive until hmp-spawn reports a completed spawn (`hmp:spawn:complete`), which fires
// only after the player picked a destination and the streamed teleport was confirmed by the game.
// From then on this resource keeps a cached per-player snapshot and pushes diffs to the client:
//   money (native Galleons), inventory space, health, level + XP, school year,
//   in-game clock/weather/date (hmp-world) and the class timetable (daily schedule).
// The current-or-next class is additionally advertised as an owner-scoped hmp-blips marker so
// players can find the classroom on the map.
(() => {
  const Hmp = Imports.get("hmp-lib");
  if (!Hmp) {
    console.error("[hmp-hud] hmp-lib is required");
    return;
  }
  const logger = Hmp.logger.create("cah-hud");

  function optionalImport(name) {
    try {
      return Imports.get(name) || null;
    } catch (_) {
      return null;
    }
  }
  const core = optionalImport("hmp-core");
  const inventoryResource = optionalImport("hmp-inventory");
  const progressionResource = optionalImport("hmp-progression");
  const worldResource = optionalImport("hmp-world");
  const blipsResource = optionalImport("hmp-blips");

  if (!core) logger.warn("hmp-core is unavailable: sessions and character metadata are disabled");
  if (!inventoryResource) logger.warn("hmp-inventory is unavailable: money and inventory space are hidden");
  if (!progressionResource) logger.warn("hmp-progression is unavailable: level, XP and derived school year are hidden");
  if (!worldResource) logger.warn("hmp-world is unavailable: clock, weather, calendar and the class timetable are hidden");
  if (!blipsResource) logger.warn("hmp-blips is unavailable: the class map blip is disabled");

  const messageOf = (error) => (error instanceof Error ? error.message : String(error));

  // ---------------------------------------------------------------------------
  // Configuration (optional data/hmp-hud.json, environment override HMP_HUD_CONFIG)
  // ---------------------------------------------------------------------------
  const GAME_MENU_PAGES = ["map", "gear", "inventory", "talents", "quests", "mail", "collections", "challenges", "settings"];

  const DEFAULT_YEAR_BANDS = [    { maxLevel: 5, year: 1 },
    { maxLevel: 10, year: 2 },
    { maxLevel: 15, year: 3 },
    { maxLevel: 20, year: 4 },
    { maxLevel: 25, year: 5 },
    { maxLevel: 30, year: 6 },
    { maxLevel: 40, year: 7 },
  ];

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function parseClock(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const minutes = Math.trunc(value);
      return minutes >= 0 && minutes < 1440 ? minutes : null;
    }
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function clockLabel(minutes) {
    const safe = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
    const hour = Math.floor(safe / 60);
    const minute = safe % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function finiteOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeYearBands(raw) {
    const source = Array.isArray(raw) && raw.length ? raw : DEFAULT_YEAR_BANDS;
    const bands = [];
    for (const entry of source) {
      const maxLevel = Math.trunc(Number(entry && entry.maxLevel));
      const year = Math.trunc(Number(entry && entry.year));
      if (!Number.isFinite(maxLevel) || maxLevel < 1 || !Number.isFinite(year) || year < 1) {
        logger.warn("Ignoring invalid year band: every band needs maxLevel >= 1 and year >= 1");
        continue;
      }
      bands.push({ maxLevel, year });
    }
    if (!bands.length) return DEFAULT_YEAR_BANDS.map((band) => ({ ...band }));
    bands.sort((left, right) => left.maxLevel - right.maxLevel);
    return bands;
  }

  // End-of-year tests: per target year, the class level (hmp-progression talent
  // "<talentPrefix><classKey>") each class requires before the green light.
  function normalizeYearTests(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const requirements = [];
    const list = Array.isArray(source.requirements) ? source.requirements : [];
    for (const entry of list) {
      const targetYear = Math.trunc(Number(entry && entry.targetYear));
      const classes = entry && typeof entry.classes === "object" && !Array.isArray(entry.classes) ? entry.classes : null;
      if (!Number.isSafeInteger(targetYear) || targetYear < 2 || targetYear > 1000 || !classes) {
        logger.warn("Ignoring invalid year test: targetYear (2-1000) and a classes object are required");
        continue;
      }
      const mapped = {};
      for (const [key, need] of Object.entries(classes)) {
        const parsedNeed = Math.trunc(Number(need));
        const safeKey = String(key || "").trim().slice(0, 48);
        if (!safeKey || !Number.isFinite(parsedNeed) || parsedNeed < 0) continue;
        mapped[safeKey] = parsedNeed;
      }
      if (!Object.keys(mapped).length) continue;
      // Optional explicit wizard-level gate; defaults to five levels per school year.
      let minLevel = null;
      if (entry.minLevel !== undefined && entry.minLevel !== null) {
        const parsedMin = Math.trunc(Number(entry.minLevel));
        if (Number.isFinite(parsedMin) && parsedMin >= 0) minLevel = parsedMin;
      }
      requirements.push({ targetYear, minLevel, classes: mapped });
    }
    requirements.sort((left, right) => left.targetYear - right.targetYear);
    return {
      enabled: source.enabled !== false,
      command: String(source.command || "teste").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16) || "teste",
      talentPrefix: String(source.talentPrefix || "class-").slice(0, 32),
      requirements,
    };
  }

  function normalizeClassItems(rawItems) {
    const source = Array.isArray(rawItems) ? rawItems : [];
    const items = [];
    for (const entry of source) {
      try {
        const start = parseClock(entry && entry.start);
        const end = parseClock(entry && entry.end);
        if (start === null || end === null || end <= start) {
          throw new Error("start/end must be HH:MM values within one day and end after start");
        }
        const subject = String((entry && entry.subject) || "").trim().slice(0, 48);
        if (!subject) throw new Error("subject is required");
        const key = Hmp.text.slug((entry && entry.key) || subject, 48) || `class-${items.length + 1}`;
        const x = finiteOrNull(entry && entry.x);
        const y = finiteOrNull(entry && entry.y);
        const z = finiteOrNull(entry && entry.z);
        items.push({
          key,
          subject,
          teacher: String((entry && entry.teacher) || "").trim().slice(0, 64),
          location: String((entry && entry.location) || "").trim().slice(0, 64),
          start,
          end,
          startLabel: clockLabel(start),
          endLabel: clockLabel(end),
          position: x !== null && y !== null && z !== null ? { x, y, z } : null,
          areaId: String((entry && entry.areaId) || "").trim().slice(0, 128) || null,
        });
      } catch (error) {
        logger.warn(`Ignoring class entry: ${messageOf(error)}`);
      }
    }
    items.sort((left, right) => left.start - right.start || left.end - right.end);
    return items;
  }

  function loadConfig() {
    const defaults = {
      updateIntervalMs: 1000,
      inventoryRefreshMs: 10000,
      money: { enabled: true, item: "native:galleons", label: "Galeões" },
      inventory: { enabled: true, metric: "slots" },
      health: { enabled: true, max: 100 },
      xp: { enabled: true },
      nametag: { useCharacterName: true },
      keybinds: { inventoryToggle: true, inventoryKey: "tab" },
      chat: { enabled: true, openKey: "enter" },
      gameMenus: { enabled: true, mode: "pause", pages: ["spells"], toolWheel: false, actionScreen: false },
      gameHud: { enabled: true, keepGroups: ["map"] },
      menu: { enabled: true, command: "menu" },
      year: {
        mode: "school",
        metadataKey: "hmp-hud:year",
        bands: DEFAULT_YEAR_BANDS,
        tests: { enabled: true, command: "teste", talentPrefix: "class-", requirements: [] },
      },
      classes: { enabled: true, showBlip: true, items: [] },
      admins: { enabled: true, players: [] },
    };
    const loaded = Hmp.config.load(process.env.HMP_HUD_CONFIG || "data/hmp-hud.json", {
      cwd: process.cwd(),
      defaults,
      validate(config) {
        if (config.updateIntervalMs !== undefined && !Number.isFinite(Number(config.updateIntervalMs))) {
          throw new TypeError("updateIntervalMs must be a number");
        }
        if (config.year && config.year.mode && !["school", "calendar", "both"].includes(config.year.mode)) {
          throw new TypeError('year.mode must be "school", "calendar" or "both"');
        }
        return true;
      },
    });
    const money = loaded.money || {};
    const inventory = loaded.inventory || {};
    const health = loaded.health || {};
    const xp = loaded.xp || {};
    const nametag = loaded.nametag || {};
    const keybinds = loaded.keybinds || {};
    const chat = loaded.chat || {};
    const gameMenus = loaded.gameMenus || {};
    const gameHud = loaded.gameHud || {};
    const menu = loaded.menu || {};
    const year = loaded.year || {};
    const classes = loaded.classes || {};
    const admins = loaded.admins || {};
    const keepGroups = Array.isArray(gameHud.keepGroups)
      ? gameHud.keepGroups.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
      : ["map"];
    return {
      updateIntervalMs: clampNumber(loaded.updateIntervalMs, 250, 60000, 1000),
      inventoryRefreshMs: clampNumber(loaded.inventoryRefreshMs, 0, 3600000, 10000),
      money: {
        enabled: money.enabled !== false && !!inventoryResource,
        item: String(money.item || "native:galleons"),
        label: String(money.label || "Galeões").slice(0, 24),
      },
      inventory: {
        enabled: inventory.enabled !== false && !!inventoryResource,
        metric: inventory.metric === "weight" ? "weight" : "slots",
      },
      health: {
        enabled: health.enabled !== false,
        max: clampNumber(health.max, 1, 1000000, 100),
      },
      xp: { enabled: xp.enabled !== false && !!progressionResource },
      nametag: {
        useCharacterName: nametag.useCharacterName !== false,
      },
      keybinds: {
        inventoryToggle: keybinds.inventoryToggle !== false && !!inventoryResource,
        inventoryKey: String(keybinds.inventoryKey || "tab").trim().toLowerCase().slice(0, 16) || "tab",
      },
      chat: {
        enabled: chat.enabled !== false,
        openKey: String(chat.openKey || "t").trim().toLowerCase().slice(0, 16) || "t",
      },
      gameMenus: {
        enabled: gameMenus.enabled !== false,
        mode: gameMenus.mode === "pages" ? "pages" : "pause",
        pages: (Array.isArray(gameMenus.pages) ? gameMenus.pages : [])
          .map((page) => String(page).trim().toLowerCase())
          .filter((page) => GAME_MENU_PAGES.includes(page) && page !== "map"),
        toolWheel: gameMenus.toolWheel === true,
        actionScreen: gameMenus.actionScreen === true,
      },
      gameHud: {
        enabled: gameHud.enabled !== false,
        keepGroups,
      },
      menu: {
        enabled: menu.enabled !== false,
        command: String(menu.command || "menu").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16) || "menu",
      },
      year: {
        mode: ["school", "calendar", "both"].includes(year.mode) ? year.mode : "school",
        metadataKey: String(year.metadataKey || "hmp-hud:year").slice(0, 96),
        bands: normalizeYearBands(year.bands),
        tests: normalizeYearTests(year.tests),
      },
      classes: {
        enabled: classes.enabled !== false,
        showBlip: classes.showBlip !== false,
        items: normalizeClassItems(classes.items),
      },
      admins: {
        enabled: admins.enabled !== false,
        players: Array.isArray(admins.players)
          ? admins.players.map((name) => String(name).trim().toLowerCase()).filter(Boolean)
          : [],
      },
    };
  }

  const config = loadConfig();
  if (!config.classes.items.length) config.classes.enabled = false;
  if (config.classes.enabled && config.classes.items.length) {
    logger.info(`Class timetable loaded with ${config.classes.items.length} lesson(s)`);
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------
  const SEASONS = ["spring", "summer", "autumn", "winter"];

  function yearFromLevel(level) {
    for (const band of config.year.bands) {
      if (level <= band.maxLevel) return band.year;
    }
    return config.year.bands.length ? config.year.bands[config.year.bands.length - 1].year : null;
  }

  function normalizeYearValue(value) {
    if (value && typeof value === "object") value = value.year;
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : null;
  }

  function readHealth(player) {
    try {
      const raw = player.health;
      const value = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(value) && value >= 0) return Math.round(value * 10) / 10;
    } catch (_) {
      // The Framework build may not expose player health to scripts.
    }
    return null;
  }

  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function normalizeWorld(state) {
    if (!state || typeof state !== "object") return null;
    const hour = Math.trunc(Number(state.hour));
    const minute = Math.trunc(Number(state.minute));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const year = Math.trunc(Number(state.year));
    const seasonIndex = Math.trunc(Number(state.season));
    return {
      time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      hour,
      minute,
      minuteOfDay: hour * 60 + minute,
      weather: String(state.weather || "").trim().slice(0, 64),
      date: {
        day: Math.trunc(Number(state.day)) || null,
        month: Math.trunc(Number(state.month)) || null,
        year: Number.isFinite(year) && year > 0 ? year : null,
      },
      season: SEASONS[seasonIndex] || null,
      timeScale: round2(state.timeScale) || 1,
    };
  }

  // ---------------------------------------------------------------------------
  // Class timetable (daily schedule on the in-game clock)
  // ---------------------------------------------------------------------------
  function presentClass(item, extra) {
    return {
      key: item.key,
      subject: item.subject,
      teacher: item.teacher || null,
      location: item.location || null,
      start: item.startLabel,
      end: item.endLabel,
      hasMapMarker: !!item.position,
      ...extra,
    };
  }

  function computeClasses(entry) {
    if (!config.classes.enabled) return null;
    const world = entry.cache.world;
    if (!world || !Number.isFinite(world.minuteOfDay)) return null;
    const now = world.minuteOfDay;
    const items = config.classes.items;
    let current = null;
    for (const item of items) {
      if (now >= item.start && now < item.end) {
        current = item;
        break;
      }
    }
    let next = null;
    for (const item of items) {
      if (item.start > now) {
        next = item;
        break;
      }
    }
    if (!next) next = items[0] || null;
    return {
      current: current ? presentClass(current, { endsInMin: Math.max(0, current.end - now) }) : null,
      next: next ? presentClass(next, { startsInMin: (next.start - now + 1440) % 1440 }) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Class blip (hmp-blips marker on the current or next classroom)
  // ---------------------------------------------------------------------------
  const BLIP_ID = "class-focus";
  const blipState = { signature: "" };

  function clearClassBlip() {
    if (!blipState.signature) return;
    blipState.signature = "";
    try {
      if (blipsResource && blipsResource.markers) blipsResource.markers.remove(BLIP_ID, "cah-hud");
    } catch (_) {
    }
  }

  async function updateClassBlip(entry) {
    if (!blipsResource || !blipsResource.markers || !config.classes.enabled || !config.classes.showBlip) {
      clearClassBlip();
      return;
    }
    const classes = entry.cache.classes;
    const target = classes && (classes.current || classes.next);
    if (!target || !target.hasMapMarker) {
      clearClassBlip();
      return;
    }
    const item = config.classes.items.find((candidate) => candidate.key === target.key);
    if (!item || !item.position) {
      clearClassBlip();
      return;
    }
    const isCurrent = !!(classes.current && classes.current.key === target.key);
    const label = isCurrent
      ? `Agora: ${item.subject}${item.location ? ` - ${item.location}` : ""}`
      : `Próxima: ${item.subject} ${item.startLabel}${item.location ? ` - ${item.location}` : ""}`;
    const signature = `${target.key}|${label}|${item.position.x},${item.position.y},${item.position.z}`;
    if (signature === blipState.signature) return;

    let inGameMinutes = null;
    if (isCurrent) {
      inGameMinutes = target.endsInMin || 0;
    } else {
      const duration = item.end - item.start;
      inGameMinutes = (target.startsInMin || 0) + duration;
    }
    const scale = (entry.cache.world && Number(entry.cache.world.timeScale)) > 0 ? Number(entry.cache.world.timeScale) : 1;
    const ttl = Math.round(Math.min(86400, Math.max(120, (inGameMinutes * 60) / scale + 300)));

    blipState.signature = signature;
    try {
      await blipsResource.markers.upsert({
        resource: "cah-hud",
        id: BLIP_ID,
        kind: "marker",
        position: item.position,
        label,
        showOnHud: true,
        showDistance: true,
        ttl,
        ...(item.areaId ? { areaId: item.areaId } : {}),
      });
    } catch (error) {
      logger.warn(`Could not update the class blip: ${messageOf(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Widget layouts (/menu editor). Saved per account through hmp-core metadata
  // ("hmp-hud:layout"); the page also caches the latest layout in localStorage
  // so it re-appears instantly even before the server round-trip.
  // ---------------------------------------------------------------------------
  const LAYOUT_KEY = "hmp-hud:layout";
  const LAYOUT_WIDGETS = ["world", "year", "stats", "vitals", "progress", "classes", "spells", "chat"];
  const LAYOUT_MAX_JSON = 4096;
  const layouts = new Map(); // accountId -> normalized layout

  function clampPercent(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(Math.min(100, Math.max(0, parsed)) * 2) / 2;
  }

  function normalizeLayout(raw) {
    if (!raw || typeof raw !== "object" || !raw.widgets || typeof raw.widgets !== "object") return null;
    const widgets = {};
    for (const key of LAYOUT_WIDGETS) {
      const pos = raw.widgets[key];
      const x = pos ? clampPercent(pos.x) : null;
      const y = pos ? clampPercent(pos.y) : null;
      // Unknown/invalid widgets are dropped rather than rejected, so layouts saved by an older
      // page (e.g. before a new widget existed) still load; the page fills in its own defaults.
      if (x === null || y === null) continue;
      widgets[key] = { x, y, centerX: !!pos.centerX };
    }
    return { version: 1, widgets };
  }

  function accountOf(player) {
    try {
      return core && core.accounts ? core.accounts.getByPlayer(player) : null;
    } catch (_) {
      return null;
    }
  }

  function layoutFor(player) {
    const account = accountOf(player);
    const id = account && account.accountId;
    if (id === null || id === undefined) return null;
    return layouts.get(id) || null;
  }

  async function loadLayout(player) {
    const account = accountOf(player);
    if (!account || account.accountId === null || account.accountId === undefined) return;
    if (layouts.has(account.accountId)) return;
    if (!core || !core.metadata) return;
    try {
      const stored = await core.metadata.getAccount(account.accountId, LAYOUT_KEY);
      const normalized = stored ? normalizeLayout(stored) : null;
      if (normalized) layouts.set(account.accountId, normalized);
    } catch (_) {
      // Metadata unavailable or empty: the page falls back to its local copy.
    }
  }

  async function persistLayout(player, layout) {
    const account = accountOf(player);
    if (!account || account.accountId === null || account.accountId === undefined) return false;
    layouts.set(account.accountId, layout);
    if (!core || !core.metadata) return false;
    try {
      await core.metadata.setAccount(account.accountId, LAYOUT_KEY, layout);
      return true;
    } catch (error) {
      logger.warn(`Could not persist the HUD layout: ${messageOf(error)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-player snapshot
  // ---------------------------------------------------------------------------
  const tracked = new Map(); // playerId -> entry
  const yearOverrides = new Map(); // characterId -> number|null (metadata override cache)

  async function buildYear(player, entry) {
    const result = {};
    const mode = config.year.mode;
    if ((mode === "school" || mode === "both") && core && core.metadata && entry.cache.character) {
      const characterId = entry.cache.character.id;
      let override;
      if (yearOverrides.has(characterId)) {
        override = yearOverrides.get(characterId);
      } else {
        try {
          override = normalizeYearValue(await core.metadata.getCharacter(characterId, config.year.metadataKey));
        } catch (_) {
          override = null;
        }
        yearOverrides.set(characterId, override);
      }
      const xp = entry.cache.xp;
      if (Number.isSafeInteger(override)) {
        result.school = override;
        result.schoolSource = "metadata";
      } else if (xp && Number.isSafeInteger(xp.level)) {
        result.school = yearFromLevel(xp.level);
        result.schoolSource = "level";
      }
      if (Number.isSafeInteger(result.school)) result.schoolLabel = `Ano ${result.school}`;
    }
    if ((mode === "calendar" || mode === "both") && entry.cache.world && entry.cache.world.date) {
      result.calendar = { ...entry.cache.world.date };
    }
    return Object.keys(result).length ? result : null;
  }

  // ---------------------------------------------------------------------------
  // End-of-year test: checks every class level (hmp-progression talents named
  // "<talentPrefix><classKey>") against the requirement of the next school year.
  // Passing grants the green light (and the command advances the year itself).
  // ---------------------------------------------------------------------------
  async function computeTest(player, entry) {
    const tests = config.year.tests;
    const year = entry.cache.year;
    const currentYear = year && Number.isSafeInteger(year.school) ? year.school : null;
    if (!tests.enabled || !tests.requirements.length || !progressionResource ||
        !progressionResource.talents || currentYear === null) {
      entry.cache.test = null;
      return;
    }
    const requirement = tests.requirements.find((candidate) => candidate.targetYear === currentYear + 1) || null;
    if (!requirement) {
      // Nothing configured for the next year: no gate, free green light.
      entry.cache.test = { targetYear: currentYear + 1, eligible: true, requirements: [] };
      return;
    }
    // The hidden gate: five wizard levels per school year (Ano 2 -> lvl 5, Ano 3 -> lvl 10, ...),
    // overridable per requirement through "minLevel" in the config.
    const minLevel = Number.isSafeInteger(requirement.minLevel)
      ? requirement.minLevel
      : (requirement.targetYear - 1) * 5;
    const wizardLevel = entry.cache.xp && Number.isSafeInteger(entry.cache.xp.level) ? entry.cache.xp.level : 0;
    const levels = {};
    try {
      const owned = await progressionResource.talents.list(player);
      for (const talent of owned || []) {
        if (!talent || (talent.status && talent.status !== "owned")) continue;
        const id = String(talent.talentId || "");
        if (tests.talentPrefix && id.startsWith(tests.talentPrefix)) {
          const key = id.slice(tests.talentPrefix.length);
          const level = Math.max(0, Math.trunc(Number(talent.level)) || 0);
          levels[key] = Math.max(levels[key] || 0, level);
        }
      }
    } catch (_) {
      // Talent read failed: treat every class as level 0 (red light) until it works.
    }
    const classRows = Object.entries(requirement.classes).map(([key, need]) => {
      const item = config.classes.items.find((candidate) => candidate.key === key);
      return { key, subject: item ? item.subject : key, have: levels[key] || 0, need };
    });
    const levelRow = minLevel > 0
      ? [{ key: "level", subject: "N\u00edvel", have: wizardLevel, need: minLevel }]
      : [];
    entry.cache.test = {
      targetYear: requirement.targetYear,
      eligible: wizardLevel >= minLevel && classRows.every((row) => row.have >= row.need),
      requirements: [...levelRow, ...classRows],
    };
  }

  // parts: character -> world -> xp -> year -> classes -> money -> inventory -> health -> layout
  async function applyParts(player, entry, parts) {
    const wants = (name) => parts.has(name);
    if (wants("character") || wants("year")) {
      entry.cache.character = core && core.characters ? core.characters.active(player) : null;
      if (wants("year")) entry.cache.year = null;
    }
    if (wants("layout")) {
      entry.cache.layout = layoutFor(player);
    }
    if (wants("world") || wants("classes")) {
      entry.cache.world = null;
      if (worldResource && worldResource.environment) {
        try {
          entry.cache.world = normalizeWorld(worldResource.environment.state());
        } catch (_) {
          entry.cache.world = null;
        }
      }
    }
    if (wants("xp") && config.xp.enabled && progressionResource && progressionResource.progression) {
      try {
        const profile = await progressionResource.progression.get(player);
        entry.cache.xp = profile
          ? { level: Math.trunc(Number(profile.level)) || null, points: Math.trunc(Number(profile.experiencePoints)) || 0 }
          : null;
      } catch (_) {
        entry.cache.xp = null;
      }
    }
    if (wants("year") && (config.year.mode === "school" || config.year.mode === "both")) {
      entry.cache.year = await buildYear(player, entry);
    }
    if (wants("test")) {
      await computeTest(player, entry);
    }
    if (wants("classes")) {
      entry.cache.classes = computeClasses(entry);
    }
    if (wants("money") && config.money.enabled && inventoryResource && inventoryResource.inventory) {
      try {
        // Allow override via environment variable or config
        const itemOverride = process.env.HMP_HUD_MONEY_ITEM || config.money.item;
        const amount = await inventoryResource.inventory.count(player, itemOverride);
        if (Number.isFinite(amount)) {
          entry.cache.money = { amount, label: config.money.label };
          logger.debug(`[hmp-hud] Money: item=${itemOverride}, amount=${amount}`);
        } else {
          entry.cache.money = null;
          logger.warn(`[hmp-hud] Money count non-finite for item '${itemOverride}': ${amount}`);
        }
      } catch (_) {
        entry.cache.money = null;
        logger.warn(`[hmp-hud] Failed to get money count for item '${config.money.item}':`);
      }
    }
    if (wants("inventory") && config.inventory.enabled && inventoryResource && inventoryResource.inventory) {
      try {
        const view = await inventoryResource.inventory.get(player);
        entry.cache.inventory = view
          ? {
              used: Math.trunc(Number(view.usedSlots)) || 0,
              slots: Math.trunc(Number(view.container && view.container.slots)) || 0,
              weight: round2(view.weight) || 0,
              maxWeight: round2(view.container && view.container.maxWeight) || 0,
              metric: config.inventory.metric,
            }
          : null;
      } catch (_) {
        entry.cache.inventory = null;
      }
    }
    if (wants("health") && config.health.enabled) {
      if (entry.healthLocked && entry.healthLockedAt && Date.now() - entry.healthLockedAt > 90000) {
        // A death/downed hold that never got its playerDownedEnd (the event can fire while the
        // spawn is still streaming). Release it and re-probe; the client falls back to the
        // native LocalPlayer health meanwhile.
        entry.healthLocked = false;
        entry.cache.health = null;
      }
      if (entry.healthLocked) {
        const alive = readHealth(player);
        if (Number.isFinite(alive) && alive > 0) {
          // The game still reports living health, so the hold was spurious: release it instead
          // of sticking at zero.
          entry.healthLocked = false;
          entry.cache.health = alive;
        } else {
          // playerDied/playerDowned forced zero; it holds until playerDownedEnd or a new activation.
          entry.cache.health = 0;
        }
      } else {
        const value = readHealth(player);
        // A null read never clears a previously known value.
        if (value !== null || !Number.isFinite(entry.cache.health)) entry.cache.health = value;
      }
      entry.cache.healthMax = config.health.max;
    }
  }

  function buildState(entry) {
    const cache = entry.cache;
    return {
      active: true,
      character: cache.character || null,
      layout: cache.layout || null,
      money: cache.money || null,
      inventory: cache.inventory || null,
      health: Number.isFinite(cache.health) ? cache.health : null,
      healthMax: cache.healthMax || config.health.max,
      // True only while a playerDied/playerDowned event holds the bar at zero; the client uses
      // it to show that zero even though its native health reading is preferred otherwise.
      healthForced: !!entry.healthLocked,
      playerId: entry.playerId !== undefined ? entry.playerId : null,
      xp: cache.xp || null,
      year: cache.year || null,
      test: cache.test || null,
      world: cache.world || null,
      classes: cache.classes || null,
    };
  }

  function send(player, event, state) {
    try {
      player.emit(event, JSON.stringify(state));
    } catch (_) {
      // Player vanished mid-push; the next tick cleans the entry up.
    }
  }

  async function runRefresh(player, entry, parts, options = {}) {
    if (entry.pending) {
      for (const part of parts) if (!entry.dirtyParts.includes(part)) entry.dirtyParts.push(part);
      if (options.show) entry.pendingShow = true;
      return;
    }
    entry.pending = (async () => {
      try {
        const partSet = new Set(parts);
        if (partSet.has("classes")) partSet.add("world");
        if (partSet.has("year")) {
          partSet.add("character");
          partSet.add("xp");
        }
        if (partSet.has("test")) partSet.add("year");
        await applyParts(player, entry, partSet);
        const state = buildState(entry);
        const json = JSON.stringify(state);
        if (options.force || options.show || json !== entry.pushed) {
          entry.pushed = json;
          send(player, options.show ? "hmp-hud:show" : "hmp-hud:update", state);
        }
        await updateClassBlip(entry);
      } catch (error) {
        logger.warn(`HUD refresh failed for #${player && player.id}: ${messageOf(error)}`);
      } finally {
        entry.pending = null;
      }
    })();
    await entry.pending;
    if (entry.dirtyParts.length) {
      const queued = entry.dirtyParts.slice();
      entry.dirtyParts.length = 0;
      await runRefresh(player, entry, queued, { show: entry.pendingShow });
      entry.pendingShow = false;
    }
  }

  function entryFor(playerId) {
    return Number.isSafeInteger(playerId) ? tracked.get(playerId) || null : null;
  }

  function markDirty(player, parts) {
    const entry = entryFor(player && player.id);
    if (!entry) return;
    for (const part of parts) if (!entry.dirtyParts.includes(part)) entry.dirtyParts.push(part);
  }

  function forceHealthZero(player) {
    const entry = entryFor(player && player.id);
    if (!entry) return;
    entry.healthLocked = true;
    entry.healthLockedAt = Date.now();
    entry.cache.health = 0;
    void runRefresh(player, entry, new Set(["health"]), { force: true });
  }

  async function activate(payload) {
    const player = payload && payload.session ? payload.session.player : null;
    if (!player) return;
    const character = payload.character || (core && core.characters ? core.characters.active(player) : null);
    if (character && character.id) yearOverrides.delete(character.id);
    const entry = { cache: {}, pushed: "", pending: null, dirtyParts: [], pendingShow: false, playerId: player.id };
    tracked.set(player.id, entry);
    await loadLayout(player);
    await runRefresh(
      player,
      entry,
      new Set(["character", "world", "xp", "year", "test", "classes", "money", "inventory", "health", "layout"]),
      { show: true, force: true },
    );
    logger.debug(`HUD shown for #${player.id}`);
  }

  function hideFor(player) {
    if (!player) return;
    const id = player.id;
    if (!tracked.has(id)) return;
    send(player, "hmp-hud:hide", { active: false });
    tracked.delete(id);
    logger.debug(`HUD hidden for #${id}`);
  }

  // ---------------------------------------------------------------------------
  // Periodic tick: cheap live values (health, money) + clock/weather/timetable
  // ---------------------------------------------------------------------------
  let lastInventorySweep = 0;
  const tickTimer = setInterval(() => {
    const sweep = config.inventoryRefreshMs > 0 && Date.now() - lastInventorySweep >= config.inventoryRefreshMs;
    if (sweep) lastInventorySweep = Date.now();
    for (const [id, entry] of [...tracked]) {
      const session = core && core.sessions ? core.sessions.get(id) : null;
      if (!session || !session.player) {
        tracked.delete(id);
        continue;
      }
      const parts = new Set(["health", "money", "world", "classes"]);
      for (const part of entry.dirtyParts.splice(0)) parts.add(part);
      if (sweep) parts.add("inventory");
      void runRefresh(session.player, entry, parts, {});
    }
  }, config.updateIntervalMs);
  if (typeof tickTimer.unref === "function") tickTimer.unref();

  // ---------------------------------------------------------------------------
  // Lifecycle events
  // ---------------------------------------------------------------------------
  Events.on("hmp:spawn:complete", (payload) => {
    activate(payload).catch((error) => logger.error(`HUD activation failed: ${messageOf(error)}`));
  });
  Events.on("hmp:character:unloading", (payload) => {
    if (payload && payload.session) hideFor(payload.session.player);
  });
  Events.on("hmp:session:ended", (payload) => {
    if (!payload) return;
    hideFor(payload.player);
    if (payload.player && Number.isSafeInteger(payload.player.id)) tracked.delete(payload.player.id);
  });
  Events.on("hmp:inventory:changed", (payload) => markDirty(payload && payload.player, ["inventory", "money"]));
  Events.on("hmp:progression:changed", (payload) => markDirty(payload && payload.player, ["xp", "year", "test"]));
  Events.on("playerDied", (player) => forceHealthZero(player));
  Events.on("playerDowned", (player) => forceHealthZero(player));
  Events.on("playerDownedEnd", (player) => {
    const entry = entryFor(player && player.id);
    if (!entry) return;
    entry.healthLocked = false;
    void runRefresh(player, entry, new Set(["health"]), { force: true });
  });

  // ---------------------------------------------------------------------------
  // Chat handling: forward framework chat events to HUD clients, and handle
  // messages sent from the HUD input.
  // ---------------------------------------------------------------------------
  const chatHistory = new Map(); // playerId -> array of recent messages
  const MAX_HISTORY = 50;

  function addToHistory(playerId, message) {
    const history = chatHistory.get(playerId) || [];
    history.push(message);
    if (history.length > MAX_HISTORY) history.shift();
    chatHistory.set(playerId, history);
  }

  function getHistory(playerId) {
    return chatHistory.get(playerId) || [];
  }

  function sendChatToPlayer(player, message) {
    if (!player || typeof player.emit !== 'function') return;
    try {
      player.emit("hmp-hud:chat", JSON.stringify({ messages: [message] }));
    } catch (_) {}
  }

  function broadcastChat(message) {
    if (!core || !core.sessions) return;
    for (const [id, entry] of tracked) {
      const session = core.sessions.get(id);
      if (session && session.player) sendChatToPlayer(session.player, message);
    }
  }

  // Listen for framework chat events (player chat, system messages, etc.)
  Events.on("chatMessage", (payload) => {
    if (!payload) return;
    const message = {
      author: payload.author || payload.player?.nickname || 'System',
      text: payload.text || payload.message || '',
      channel: payload.channel || 'local',
      timestamp: Date.now(),
    };
    // Add to history for the sender if it's a player
    if (payload.player && payload.player.id) {
      addToHistory(payload.player.id, message);
    }
    // Broadcast to all tracked players
    broadcastChat(message);
  });

  // Also listen for common alternative chat event names
  Events.on("playerChat", (payload) => {
    if (!payload) return;
    const message = {
      author: payload.author || payload.player?.nickname || 'Player',
      text: payload.text || payload.message || '',
      channel: payload.channel || 'local',
      timestamp: Date.now(),
    };
    if (payload.player && payload.player.id) {
      addToHistory(payload.player.id, message);
    }
    broadcastChat(message);
  });

  // Listen for system messages (server announcements, etc.)
  Events.on("systemMessage", (payload) => {
    if (!payload) return;
    const message = {
      author: 'Sistema',
      text: payload.text || payload.message || '',
      channel: 'system',
      timestamp: Date.now(),
    };
    broadcastChat(message);
  });

  // Handle chat messages sent from the HUD input
  Events.onClient("hmp-hud:chat-send", (player, raw) => {
    if (!player || !config.chat.enabled) return;
    let data = null;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) {
      return;
    }
    const text = String(data?.text || "").trim().slice(0, 256);
    if (!text) return;
    // Forward to framework chat system (this will trigger chatMessage event)
    try {
      Events.emitServer("chat:send", JSON.stringify({ player: player.id, text: text }));
    } catch (_) {
      // Fallback: just broadcast locally
      const message = {
        author: player.nickname || 'Player',
        text: text,
        channel: 'local',
        timestamp: Date.now(),
      };
      broadcastChat(message);
    }
  });

  // Handle chat open/close from client
  Events.onClient("hmp-hud:chat-open", (player) => {
    // Send recent history when chat opens
    const history = getHistory(player && player.id);
    if (history.length) {
      try {
        player.emit("hmp-hud:chat", JSON.stringify({ messages: history }));
      } catch (_) {}
    }
  });

  // ---------------------------------------------------------------------------
  // Admin logging: capture server console/logs and forward to admin players
  // ---------------------------------------------------------------------------
  const adminLoggers = new Map(); // admin playerId -> { enabled: true, level: 'all'|'warn'|'error' }
  const adminLogBuffer = []; // circular buffer of recent admin logs
  const ADMIN_LOG_MAX = 200;

  function isAdmin(player) {
    if (!player) return false;
    // Check config.admins.players list first (nickname-based)
    if (config.admins && config.admins.enabled && config.admins.players) {
      const nickname = String(player.nickname || '').trim().toLowerCase();
      if (nickname && config.admins.players.includes(nickname)) return true;
    }
    // Fallback to group-based check
    if (!core || !core.groups) return false;
    try {
      return core.groups.has(player, 'admin', 1) || core.groups.has(player, 'admin', 2) || core.groups.has(player, 'admin', 3);
    } catch (_) {
      return false;
    }
  }

  function addAdminLog(entry) {
    const log = {
      author: entry.author || 'Console',
      text: entry.text || '',
      channel: entry.channel || 'console', // 'console' or 'admin'
      timestamp: Date.now(),
    };
    adminLogBuffer.push(log);
    if (adminLogBuffer.length > ADMIN_LOG_MAX) adminLogBuffer.shift();
    // Forward to all admin players
    if (core && core.sessions) {
      for (const [id, session] of core.sessions.all()) {
        if (session.player && isAdmin(session.player)) {
          sendAdminLogToPlayer(session.player, log);
        }
      }
    }
  }

  function sendAdminLogToPlayer(player, log) {
    if (!player || typeof player.emit !== 'function') return;
    try {
      player.emit("hmp-hud:admin-log", JSON.stringify({ entry: log }));
    } catch (_) {}
  }

  // Override console methods to capture logs
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  console.log = function (...args) {
    originalConsoleLog.apply(console, args);
    addAdminLog({ author: 'Console', text: args.map(a => String(a)).join(' '), channel: 'console' });
  };
  console.warn = function (...args) {
    originalConsoleWarn.apply(console, args);
    addAdminLog({ author: 'Console', text: args.map(a => String(a)).join(' '), channel: 'console' });
  };
  console.error = function (...args) {
    originalConsoleError.apply(console, args);
    addAdminLog({ author: 'Console', text: args.map(a => String(a)).join(' '), channel: 'console' });
  };

  // Admin log command: /hud adminlog on|off|level
  const adminLogCommands = Hmp.command.createRouter({ prefix: "[hud]", logger });
  adminLogCommands.register("adminlog", {
    description: "Toggle admin log capture or set level.",
    usage: "/hud adminlog on|off|level <all|warn|error>",
  }, (context) => {
    if (!isAdmin(context.player)) return context.reply("Apenas administradores.");
    const sub = String(context.args[0] || "").trim().toLowerCase();
    if (sub === "on") {
      adminLoggers.set(context.player.id, { enabled: true, level: 'all' });
      // Send recent buffer
      for (const log of adminLogBuffer.slice(-20)) {
        sendAdminLogToPlayer(context.player, log);
      }
      return context.reply("Admin log ativado. Últimas 20 entradas enviadas.");
    }
    if (sub === "off") {
      adminLoggers.delete(context.player.id);
      return context.reply("Admin log desativado.");
    }
    if (sub === "level") {
      const level = String(context.args[1] || "").trim().toLowerCase();
      if (!['all', 'warn', 'error'].includes(level)) {
        return context.reply("Nível inválido. Use: all, warn, error");
      }
      const current = adminLoggers.get(context.player.id) || { enabled: true, level: 'all' };
      current.level = level;
      adminLoggers.set(context.player.id, current);
      return context.reply(`Nível do admin log: ${level}`);
    }
    return context.reply("Uso: /hud adminlog on|off|level <all|warn|error>");
  });

  Events.on("chatCommand", adminLogCommands.handle);

  // Send admin log buffer to new admin players when they spawn
  Events.on("hmp:spawn:complete", (payload) => {
    const player = payload && payload.session ? payload.session.player : null;
    if (player && isAdmin(player)) {
      setTimeout(() => {
        for (const log of adminLogBuffer.slice(-30)) {
          sendAdminLogToPlayer(player, log);
        }
      }, 1000);
    }
  });

  // ---------------------------------------------------------------------------
  // Inventory toggle key (hmp-hud:inventory-toggle from the client TAB shortcut)
  // ---------------------------------------------------------------------------
  const toggleLimit = Hmp.rateLimit.create({ limit: 4, windowMs: 2000 });

  Events.onClient("hmp-hud:inventory-toggle", async (player) => {
    if (!config.keybinds.inventoryToggle || !inventoryResource || !inventoryResource.ui) return;
    if (!toggleLimit.allow(player && player.id)) return;
    const session = core && core.sessions ? core.sessions.get(player) : null;
    if (!session) return;
    if (!core.characters.active(player)) return; // no inventory without an active character
    try {
      if (inventoryResource.ui.isOpen(player)) {
        inventoryResource.ui.close(player);
      } else {
        await inventoryResource.ui.open(player);
      }
    } catch (error) {
      logger.warn(`Inventory toggle failed for #${player && player.id}: ${messageOf(error)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // /voz: inspect and change the local voice chat settings (they live
  // client-side, so the command asks the client and relays the answer).
  // ---------------------------------------------------------------------------
  Events.onClient("hmp-hud:voice-status", (player, raw) => {
    let data = null;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) {
      data = null;
    }
    if (!data || typeof data !== "object") return;
    const reply = (message) => {
      try {
        player.sendChat(`[hud] ${message}`);
      } catch (_) {
      }
    };
    if (data.kind === "status" && data.info) {
      const info = data.info;
      const mode = info.mode === "voiceActivity" ? "atividade de voz" : "push-to-talk";
      const mic = info.hasMic ? "detetado" : "AUSENTE";
      reply(
        `Voz: ${info.enabled ? "ativada" : "DESATIVADA"} · microfone: ${mic} · ` +
          `tecla: ${String(info.key || "?").toUpperCase()} · modo: ${mode} · nível do micro: ${info.level}` +
          (info.enabled && !info.hasMic ? " — sem microfone não transmites!" : ""),
      );
      return;
    }
    if (data.kind === "key") {
      return data.ok
        ? reply(`Tecla do voz alterada para ${String(data.key || "").toUpperCase()}. Segura-a para falar — o ícone acima do nome fica mais claro enquanto transmites.`)
        : reply(`Tecla desconhecida: "${data.key}". Usa nomes do Key.bind (ex.: v, b, f5).`);
    }
    if (data.kind === "enabled") {
      return reply(data.value ? "Voz ativada." : "Voz desativada.");
    }
    if (data.kind === "mode") {
      return data.ok
        ? reply(`Modo de transmissão: ${data.mode === "voiceActivity" ? "atividade de voz (micro aberto)" : "push-to-talk"}.`)
        : reply("Não foi possível alterar o modo de transmissão.");
    }
  });

  Events.onClient("hmp-hud:client-ready", (player) => {
    try {
      player.emit(
        "hmp-hud:keybinds",
        JSON.stringify({
          inventoryToggle: config.keybinds.inventoryToggle,
          inventoryKey: config.keybinds.inventoryKey,
        }),
      );
      player.emit(
        "hmp-hud:gamehud",
        JSON.stringify({
          enabled: config.gameHud.enabled,
          keepGroups: config.gameHud.keepGroups,
        }),
      );
      player.emit(
        "hmp-hud:chat",
        JSON.stringify({
          enabled: config.chat.enabled,
          openKey: config.chat.openKey,
        }),
      );
      player.emit(
        "hmp-hud:gamemenus",
        JSON.stringify({
          enabled: config.gameMenus.enabled,
          mode: config.gameMenus.mode,
          pages: config.gameMenus.pages,
          toolWheel: config.gameMenus.toolWheel,
          actionScreen: config.gameMenus.actionScreen,
        }),
      );
    } catch (_) {
    }
  });

  // ---------------------------------------------------------------------------
  // /menu layout saves (hmp-hud:layout-save relayed by the client from the page)
  // ---------------------------------------------------------------------------
  const layoutLimit = Hmp.rateLimit.create({ limit: 8, windowMs: 5000 });

  Events.onClient("hmp-hud:layout-save", async (player, raw) => {
    if (!config.menu.enabled) return;
    if (!layoutLimit.allow(player && player.id)) return;
    const entry = entryFor(player && player.id);
    if (!entry) return;
    let parsed = null;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) {
      parsed = null;
    }
    // The page sends the envelope { action: "save", layout }, but a bare layout is accepted too.
    const envelope = parsed && typeof parsed === "object" && parsed.layout ? parsed.layout : parsed;
    const layout = normalizeLayout(envelope);
    if (!layout) {
      try {
        player.emit("hmp-hud:layout-saved", JSON.stringify({ ok: false, error: "layout inválido" }));
      } catch (_) {
      }
      return;
    }
    if (JSON.stringify(layout).length > LAYOUT_MAX_JSON) {
      try {
        player.emit("hmp-hud:layout-saved", JSON.stringify({ ok: false, error: "layout demasiado grande" }));
      } catch (_) {
      }
      return;
    }
    entry.cache.layout = layout;
    await persistLayout(player, layout);
    try {
      player.emit("hmp-hud:layout-saved", JSON.stringify({ ok: true }));
    } catch (_) {
    }
    void runRefresh(player, entry, new Set(["layout"]), { force: true });
    logger.debug(`HUD layout saved for #${player && player.id}`);
  });

  Events.on("resourceStop", (name) => {
    if (name && name !== "cah-hud") return;
    clearInterval(tickTimer);
    tracked.clear();
    clearClassBlip();
    try {
      if (blipsResource && blipsResource.markers) blipsResource.markers.clear("cah-hud");
    } catch (_) {
    }
  });

  // ---------------------------------------------------------------------------
  // End-of-year test execution: shared by the /teste command and the "test" export.
  // Passing persists the year override (green light); failing reports the gaps.
  // ---------------------------------------------------------------------------
  async function applyYearOverride(player, year) {
    if (!core || !core.characters || !core.metadata) throw new Error("hmp-core is required for year overrides");
    const character = core.characters.active(player);
    if (!character) throw new Error("The player has no active character");
    const value = normalizeYearValue(year);
    if (value === null) {
      await core.metadata.deleteCharacter(character.id, config.year.metadataKey);
    } else {
      await core.metadata.setCharacter(character.id, config.year.metadataKey, { year: value });
    }
    yearOverrides.set(character.id, value);
    return value;
  }

  async function runYearTest(player, entry) {
    if (!config.year.tests.enabled) return { ok: false, reason: "tests-disabled" };
    if (!entry) return { ok: false, reason: "hud-inactive" };
    await runRefresh(player, entry, new Set(["year", "test"]), { force: true });
    const test = entry.cache.test;
    if (!test) return { ok: false, reason: "tests-not-configured" };
    if (!test.eligible) return { ok: false, reason: "requirements-not-met", test };
    let value = null;
    try {
      value = await applyYearOverride(player, test.targetYear);
    } catch (_) {
      value = null;
    }
    if (value === null) return { ok: false, reason: "core-unavailable", test };
    await runRefresh(player, entry, new Set(["year", "test"]), { force: true });
    return { ok: true, year: value, test: entry.cache.test };
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------
  Exports.register("show", async (player) => {
    const session = core && core.sessions ? core.sessions.get(player && player.id) : null;
    await activate({ session, character: null });
  });
  Exports.register("hide", (player) => hideFor(player));
  Exports.register("refresh", async (player, parts) => {
    const id = player && player.id;
    const entry = entryFor(id);
    if (!entry) {
      const session = core && core.sessions ? core.sessions.get(id) : null;
      if (!session) return false;
      await activate({ session, character: null });
      return true;
    }
    const requested = Array.isArray(parts) && parts.length ? parts : ["character", "world", "xp", "year", "test", "classes", "money", "inventory", "health", "layout"];
    await runRefresh(player, entry, new Set(requested), { force: true });
    return true;
  });
  Exports.register("setYearOverride", async (player, year) => {
    const value = await applyYearOverride(player, year);
    const entry = entryFor(player && player.id);
    if (entry) await runRefresh(player, entry, new Set(["year", "test"]), { force: true });
    return value;
  });
  Exports.register("status", () => ({
    tracked: tracked.size,
    yearOverrides: yearOverrides.size,
    updateIntervalMs: config.updateIntervalMs,
    world: !!worldResource,
    blips: !!blipsResource,
    keybinds: {
      inventoryToggle: config.keybinds.inventoryToggle,
      inventoryKey: config.keybinds.inventoryKey,
    },
    gameHud: {
      enabled: config.gameHud.enabled,
      keepGroups: config.gameHud.keepGroups.slice(),
    },
    gameMenus: {
      enabled: config.gameMenus.enabled,
      mode: config.gameMenus.mode,
      pages: config.gameMenus.pages.slice(),
      toolWheel: config.gameMenus.toolWheel,
      actionScreen: config.gameMenus.actionScreen,
    },
    menu: {
      enabled: config.menu.enabled,
      command: config.menu.command,
    },
    tests: {
      enabled: config.year.tests.enabled,
      command: config.year.tests.command,
      talentPrefix: config.year.tests.talentPrefix,
      requirements: config.year.tests.requirements.length,
    },
    layouts: layouts.size,
    classes: {
      enabled: config.classes.enabled,
      showBlip: config.classes.showBlip,
      items: config.classes.items.length,
      blipActive: blipState.signature !== "",
    },
  }));

  // ---------------------------------------------------------------------------
  // /hud on|off|refresh  and  /menu (layout editor)
  // ---------------------------------------------------------------------------
  const commands = Hmp.command.createRouter({ prefix: "[hud]", logger });
  commands.register("hud", (context) => {
    const sub = String(context.args[0] || "").trim().toLowerCase();
    if (sub === "off") {
      hideFor(context.player);
      return context.reply("HUD escondido até ao próximo spawn. Usa /hud on para o trazeres de volta.");
    }
    if (sub === "on") {
      const session = core && core.sessions ? core.sessions.get(context.player.id) : null;
      if (!session) return context.reply("Precisas primeiro de uma sessão ativa.");
      void activate({ session, character: null });
      return context.reply("HUD visível.");
    }
    if (sub === "refresh") {
      const entry = entryFor(context.player.id);
      if (!entry) return context.reply("O HUD não está ativo. Usa /hud on.");
      void runRefresh(
        context.player,
        entry,
        new Set(["character", "world", "xp", "year", "test", "classes", "money", "inventory", "health", "layout"]),
        { force: true },
      );
      return context.reply("HUD atualizado.");
    }
    if (sub === "menu") {
      return openMenuCommand(context);
    }
    return context.reply("Uso: /hud on|off|refresh|menu");
  });

  function openMenuCommand(context) {
    if (!config.menu.enabled) return context.reply("O editor de layout está desativado neste servidor.");
    const session = core && core.sessions ? core.sessions.get(context.player.id) : null;
    if (!session) return context.reply("Precisas primeiro de uma sessão ativa.");
    const entry = entryFor(context.player.id);
    const prepare = entry
      ? Promise.resolve(entry)
      : activate({ session, character: null }).then(() => entryFor(context.player.id));
    return Promise.resolve(prepare)
      .then(() => {
        try {
          context.player.emit(
            "hmp-hud:menu",
            JSON.stringify({ enabled: true, layout: layoutFor(context.player) }),
          );
        } catch (_) {
          return context.reply("Não foi possível abrir o editor do HUD.");
        }
        return context.reply("Editor do HUD aberto: arrasta os widgets e clica em Guardar.");
      })
      .catch(() => context.reply("Não foi possível abrir o editor do HUD."));
  }

  if (config.menu.command !== "hud") {
    commands.register(
      config.menu.command,
      { description: "Open the HUD layout editor (/menu).", usage: "/menu" },
      (context) => openMenuCommand(context),
    );
  }

  // End-of-year test: /teste checks every class level and advances the year on a pass.
  const testLimit = Hmp.rateLimit.create({ limit: 3, windowMs: 10000 });
  if (config.year.tests.command !== "hud" && config.year.tests.command !== config.menu.command) {
    commands.register(
      config.year.tests.command,
      { description: "Take the end-of-year test (checks every class level).", usage: `/${config.year.tests.command}` },
      async (context) => {
        if (!config.year.tests.enabled) return context.reply("Os testes de fim de ano estão desativados neste servidor.");
        if (!testLimit.allow(context.player && context.player.id)) {
          return context.reply("Acalma o ímpeto! Tenta daqui a uns segundos.");
        }
        const entry = entryFor(context.player.id);
        if (!entry) return context.reply("O HUD não está ativo. Usa /hud on.");
        const result = await runYearTest(context.player, entry);
        if (result.ok) return context.reply(`Aprovado! Luz verde para o Ano ${result.year}.`);
        if (result.reason === "requirements-not-met") {
          const missing = (result.test.requirements || [])
            .filter((row) => row.have < row.need)
            .map((row) => `${row.subject} ${row.have}/${row.need}`)
            .join(", ");
          return context.reply(`Sem luz verde para o Ano ${result.test.targetYear}.${missing ? " Falta: " + missing + "." : ""}`);
        }
        if (result.reason === "core-unavailable") {
          return context.reply("Aprovado no teste, mas não foi possível registar o ano (hmp-core indisponível).");
        }
        return context.reply("Os testes de fim de ano não estão configurados neste servidor.");
      },
    );
  }

  // /voz: the voice settings live client-side, so the command asks the client
  // to read or change them and relays the answer back to the chat.
  const voiceLimit = Hmp.rateLimit.create({ limit: 6, windowMs: 10000 });
  if (!["hud", config.menu.command, config.year.tests.command].includes("voz")) {
    commands.register(
      "voz",
      {
        aliases: ["voice"],
        description: "Voice chat: show the status or rebind the key (/voz <tecla> | on | off | modo).",
        usage: "/voz [tecla|on|off|modo]",
      },
      (context) => {
        if (!voiceLimit.allow(context.player && context.player.id)) {
          return context.reply("Devagar! Tenta daqui a uns segundos.");
        }
        const arg = String(context.args[0] || "").trim().toLowerCase();
        if (!arg) {
          try {
            context.player.emit("hmp-hud:voice", JSON.stringify({ action: "status" }));
          } catch (_) {
            return context.reply("Não foi possível ler o estado do voz.");
          }
          return context.reply("A ler o estado do voz...");
        }
        if (arg === "on" || arg === "ligar" || arg === "ativar") {
          try {
            context.player.emit("hmp-hud:voice", JSON.stringify({ action: "enabled", value: true }));
          } catch (_) {
          }
          return context.reply("A ativar o voz...");
        }
        if (arg === "off" || arg === "desligar" || arg === "mudo") {
          try {
            context.player.emit("hmp-hud:voice", JSON.stringify({ action: "enabled", value: false }));
          } catch (_) {
          }
          return context.reply("A desativar o voz...");
        }
        if (arg === "modo" || arg === "mode") {
          try {
            context.player.emit("hmp-hud:voice", JSON.stringify({ action: "mode-toggle" }));
          } catch (_) {
          }
          return context.reply("A alternar o modo de transmissão...");
        }
        if (!/^[a-z0-9]{1,12}$/.test(arg)) {
          return context.reply(`"${arg}" não parece um nome de tecla válido (ex.: v, b, f5).`);
        }
        try {
          context.player.emit("hmp-hud:voice", JSON.stringify({ action: "key", key: arg }));
        } catch (_) {
        }
        return context.reply(`A alterar a tecla do voz para ${arg.toUpperCase()}...`);
      },
    );
  }
  Events.on("chatCommand", commands.handle);

  Exports.register("menu", async (player) => {
    const session = core && core.sessions ? core.sessions.get(player && player.id) : null;
    if (!session) throw new Error("The player has no active session");
    if (!entryFor(player.id)) await activate({ session, character: null });
    player.emit("hmp-hud:menu", JSON.stringify({ enabled: true, layout: layoutFor(player) }));
    return true;
  });

  Exports.register("test", (player) => {
    const entry = entryFor(player && player.id);
    return runYearTest(player, entry);
  });

  logger.info(
    `HUD ready: ${config.classes.items.length} class(es), world ${worldResource ? "linked" : "missing"}, ` +
      `blips ${blipsResource ? "linked" : "missing"}, interval ${config.updateIntervalMs}ms, ` +
      `/${config.menu.command} ${config.menu.enabled ? "on" : "off"}, ` +
      `native HUD ${config.gameHud.enabled ? `suppressed (keeps: ${config.gameHud.keepGroups.join(", ")})` : "untouched"}`,
  );
})();

