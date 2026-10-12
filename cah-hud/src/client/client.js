"use strict";
// hmp-hud - client bridge.
//
// Owns the HUD web view (created hidden at startup, like hmp-spawn does). The server pushes full
// snapshots via hmp-hud:show / hmp-hud:update; the client merges in live client-side natives and
// forwards the final render state to the page through Web.emit(view, "hmp-hud:state", state):
//   - Progression (game-native XP/level/bounds) drives the level + XP bar so it updates instantly;
//   - LocalPlayer health is used only when the server could not read player.health.
// The HUD never grabs focus or input while playing: the view is shown without Web.focusView.
//
// The /menu layout editor is the one exception: the server asks for it through hmp-hud:menu, the
// client focuses the view (Web.focusView) and takes an hmp-lib input control lease so the game
// stops reacting while widgets are dragged; leaving the editor unfocuses and releases the lease.
//
// Native game HUD suppression: while the HUD is shown, every HUD group reported by Hud.groups()
// is hidden through Hud.hideGroup (provider-scoped, ignores the player's own Settings.getHud()
// choices and is released on hide/disconnect), except groups whose name matches a configured
// keep list (default: "map") so the minimap/map keeps working.
//
// Voice indicator: while the HUD is active, a glowing dot (Latin-1 middle dot, coloured) is drawn
// above the player's own name - green when voice is on and working, white while talking, red when
// voice is off or has no microphone. Fed by the Voice global every poll and on voiceStart/voiceStop.
(() => {
  const VIEW_URL = "fw://resources/hmp-hud/dist/hud.html";
  const POLL_MS = 500;

  let Hmp = null;
  try {
    Hmp = Imports.get("hmp-lib");
  } catch (_) {
  }
  const logger = Hmp && Hmp.logger ? Hmp.logger.create("hmp-hud") : console;

  let view = -1;
  let pageReady = false;
  let visible = false;
  let serverState = null;
  let lastPageJson = "";
  let healthGetter = null;
  let healthMaxGetter = null;
  let healthDeadGetter = null;

  function objectOf(payload) {
    if (payload && typeof payload === "object") return payload;
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function ensureView() {
    if (view >= 0) return view;
    try {
      view = Web.createView(VIEW_URL, { visible: false });
    } catch (_) {
      view = -1;
    }
    if (view >= 0) {
      Web.on(view, "ready", () => {
        pageReady = true;
        pushToPage();
        pushChatToPage();
      });
      // Page -> server: save the layout arranged in the /menu editor.
      Web.on(view, "hmp-hud:layout", (payload) => {
        try {
          Events.emitServer("hmp-hud:layout-save", typeof payload === "string" ? payload : JSON.stringify(payload || {}));
        } catch (_) {
        }
      });
      // Page -> client: the editor closed itself (Concluir button / ESC).
      Web.on(view, "hmp-hud:menu-exit", () => closeMenu());
      // Page -> client: the chat input submitted a line or was closed.
      Web.on(view, "hmp-hud:chat-send", (payload) => {
        let text = "";
        const detail = objectOf(payload);
        if (detail && typeof detail.text === "string") text = detail.text.trim().slice(0, 256);
        if (text && typeof Chat !== "undefined" && Chat && typeof Chat.send === "function") {
          try {
            Chat.send(text);
          } catch (_) {
          }
        }
        closeChatInput(true);
      });
      Web.on(view, "hmp-hud:chat-close", () => closeChatInput(false));
    }
    return view;
  }

  // ---------------------------------------------------------------------------
  // Native game HUD suppression (everything except the configured keep list).
  // ---------------------------------------------------------------------------
  const gameHud = { enabled: false, keepGroups: ["map"] };
  const heldGroups = new Set();

  function groupKept(name) {
    const lower = String(name || "").toLowerCase();
    return gameHud.keepGroups.some((needle) => lower.includes(needle));
  }

  function suppressGameHud(suppress) {
    if (typeof Hud === "undefined" || !Hud || typeof Hud.groups !== "function") return;
    if (!suppress) {
      for (const name of [...heldGroups]) {
        try {
          if (typeof Hud.showGroup === "function") Hud.showGroup(name);
        } catch (_) {
        }
        heldGroups.delete(name);
      }
      return;
    }
    if (!gameHud.enabled) return;
    let names = null;
    try {
      names = Hud.groups() || [];
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (heldGroups.has(name) || groupKept(name)) continue;
      try {
        const held = Hud.hideGroup(name);
        if (held !== false) heldGroups.add(name);
      } catch (_) {
      }
    }
    if (heldGroups.size) {
      logger.info(
        `Native HUD suppressed: ${heldGroups.size} group(s) hidden, kept: ${gameHud.keepGroups.join(", ") || "none"}`,
      );
    }
  }

  Events.on("hmp-hud:gamehud", (payload) => {
    const value = objectOf(payload);
    if (!value) return;
    gameHud.enabled = value.enabled !== false;
    // The server already normalized this list; an empty array intentionally hides even the map.
    gameHud.keepGroups = Array.isArray(value.keepGroups)
      ? value.keepGroups.map((entry) => String(entry).toLowerCase()).filter(Boolean)
      : ["map"];
    if (visible) suppressGameHud(true);
  });

  // ---------------------------------------------------------------------------
  // /menu layout editor mode (focused view + input control lease).
  // ---------------------------------------------------------------------------
  let menuLease = null;
  let menuActive = false;

  function openMenu(payload) {
    const detail = objectOf(payload) || {};
    if (ensureView() < 0) {
      logger.warn("The HUD web view is not available yet: /menu cannot open");
      return;
    }
    menuActive = true;
    visible = true;
    Web.showView(view);
    try {
      Web.focusView(view, true);
    } catch (_) {
    }
    if (!menuLease && Hmp && Hmp.input && Hmp.input.controls) {
      try {
        menuLease = Hmp.input.controls.acquire({ resource: "hmp-hud", id: "hud-menu" });
      } catch (_) {
        menuLease = null;
      }
    }
    try {
      Web.emit(view, "hmp-hud:edit", { enabled: true, layout: detail.layout || null });
    } catch (_) {
    }
    suppressGameHud(true);
  }

  function closeMenu() {
    menuActive = false;
    if (view >= 0) {
      try {
        Web.focusView(view, false);
      } catch (_) {
      }
      try {
        Web.emit(view, "hmp-hud:edit", { enabled: false });
      } catch (_) {
      }
      if (!visible) {
        try {
          Web.hideView(view);
        } catch (_) {
        }
      }
    }
    if (menuLease) {
      try {
        menuLease.release();
      } catch (_) {
      }
      menuLease = null;
    }
  }

  Events.on("hmp-hud:menu", openMenu);

  // Server acknowledges a saved layout so the page can toast the player.
  Events.on("hmp-hud:layout-saved", (payload) => {
    if (view < 0 || !pageReady) return;
    try {
      Web.emit(view, "hmp-hud:saved", objectOf(payload) || { ok: true });
    } catch (_) {
    }
  });

  function clamp01(value) {
    if (!Number.isFinite(value)) return null;
    return Math.min(1, Math.max(0, value));
  }

  // Native game progression: level, points and this level's XP bounds.
  function nativeProgression() {
    if (typeof Progression === "undefined" || !Progression) return null;
    let level = null;
    try {
      level = Number(Progression.getLevel());
    } catch (_) {
      return null;
    }
    if (!Number.isSafeInteger(level) || level < 1) return null;
    let points = null;
    try {
      points = Number(Progression.getPoints());
    } catch (_) {
    }
    let start = null;
    let end = null;
    if (typeof Progression.getLevelBounds === "function") {
      try {
        const bounds = Progression.getLevelBounds(level);
        if (bounds) {
          const parsedStart = Number(bounds.start);
          if (Number.isFinite(parsedStart)) start = parsedStart;
          const parsedEnd = Number(bounds.end);
          if (Number.isFinite(parsedEnd)) end = parsedEnd;
        }
      } catch (_) {
      }
      if (end === null) {
        try {
          const next = Progression.getLevelBounds(level + 1);
          if (next) {
            const parsedNext = Number(next.start);
            if (Number.isFinite(parsedNext)) end = parsedNext;
          }
        } catch (_) {
        }
      }
    }
    return {
      level,
      points: Number.isFinite(points) ? points : null,
      start,
      end,
    };
  }

  function resolveNativeHealth() {
    if (healthGetter) return;
    if (typeof LocalPlayer === "undefined" || !LocalPlayer) return;
    // Documented path (HogwartsMP 1.8+): the pawn's CharacterStateInfo component.
    const stateInfo = LocalPlayer.stateInfo;
    if (stateInfo && typeof stateInfo.getHealth === "function") {
      try {
        const value = Number(stateInfo.getHealth());
        if (Number.isFinite(value) && value >= 0) {
          healthGetter = () => stateInfo.getHealth();
          healthMaxGetter = typeof stateInfo.getMaxHealth === "function" ? () => stateInfo.getMaxHealth() : null;
          healthDeadGetter = typeof stateInfo.isDead === "function" ? () => stateInfo.isDead() : null;
          logger.info("Reading LocalPlayer.stateInfo health for the HUD");
          return;
        }
      } catch (_) {
      }
    }
    // Legacy candidates from older builds; kept harmless.
    const candidates = [
      () => LocalPlayer.getHealth(),
      () => LocalPlayer.health,
    ];
    for (const candidate of candidates) {
      try {
        const value = Number(candidate());
        if (Number.isFinite(value) && value >= 0) {
          healthGetter = candidate;
          logger.info("Reading native LocalPlayer health for the HUD");
          return;
        }
      } catch (_) {
      }
    }
    // Still unresolved (e.g. no pawn yet): retried on the next poll.
  }

  function nativeHealth() {
    resolveNativeHealth();
    if (!healthGetter) return null;
    try {
      const value = Number(healthGetter());
      if (!Number.isFinite(value) || value < 0) return null;
      let max = null;
      if (healthMaxGetter) {
        try {
          const parsed = Number(healthMaxGetter());
          if (Number.isFinite(parsed) && parsed > 0) max = parsed;
        } catch (_) {
        }
      }
      let dead = null;
      if (healthDeadGetter) {
        try {
          dead = healthDeadGetter() === true;
        } catch (_) {
        }
      }
      return { health: value, max, dead };
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Native spell loadout: the four quick-action slots of the active loadout,
  // read straight from the game (Spells.currentLoadout()/Spells.loadout()).
  // ---------------------------------------------------------------------------
  function prettifySpell(raw) {
    let name = String(raw || "").trim();
    if (!name) return "";
    const segment = name.split("/").filter(Boolean).pop();
    if (segment) name = segment;
    name = name.replace(/\.(u?asset|uexp)$/i, "").replace(/[_-]+/g, " ").trim();
    return name;
  }

  function nativeSpells() {
    if (typeof Spells === "undefined" || !Spells || typeof Spells.loadout !== "function") return null;
    try {
      // Spells.loadout() defaults to the currently selected loadout and reads the live
      // QuickActionManager spell diamonds (the quick bar this HUD replaces).
      const state = Spells.loadout();
      const slots = state && Array.isArray(state.slots) ? state.slots : null;
      if (!slots) return null;
      const out = [];
      for (let slot = 0; slot < 4; slot++) {
        out.push({ slot, name: prettifySpell(slots[slot]) });
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  // The game fires spellAssignment whenever a diamond slot changes; refresh immediately.
  Events.on("spellAssignment", () => {
    if (visible && serverState) pushToPage();
  });

  // Voice state changes should move the above-name icon instantly, not half a second later.
  Events.on("voiceStart", () => {
    if (visible && serverState) pushToPage();
  });
  Events.on("voiceStop", () => {
    if (visible && serverState) pushToPage();
  });

  // ---------------------------------------------------------------------------
  // Voice indicator: a glowing dot attached to the player's own nametag (it
  // hangs above the name and follows the body). Green while voice chat is on,
  // brighter while talking, red when it is off/muted. The glyph is a Latin-1
  // middle dot, which the nametag font renders reliably (geometric shapes like
  // the black circle showed up as "?").
  // ---------------------------------------------------------------------------
  const VOICE_DOT = "\u00B7";
  const VOICE_COLOR_ON = 0xFF53FF7A;   // green: voice is on and working
  const VOICE_COLOR_TALKING = 0xFFFFFFFF; // white: actually talking
  const VOICE_COLOR_OFF = 0xFFFF5A4D;  // red: voice is off or otherwise not working

  let voiceEntityId = null;
  let voiceLabelState = null;

  function clearVoiceLabel() {
    if (voiceLabelState && voiceEntityId !== null && typeof Nametags !== "undefined" && Nametags &&
        typeof Nametags.clearLabel === "function") {
      try {
        Nametags.clearLabel(voiceEntityId);
      } catch (_) {
      }
    }
    voiceLabelState = null;
    voiceEntityId = null;
  }

  function hideVoiceIndicator() {
    clearVoiceLabel();
    if (typeof Nametags !== "undefined" && Nametags && typeof Nametags.setSelfVisible === "function") {
      try {
        Nametags.setSelfVisible(false);
      } catch (_) {
      }
    }
  }

  function updateVoiceIndicator(state) {
    if (typeof Nametags === "undefined" || !Nametags || typeof Nametags.setLabel !== "function") return;
    const voice = state && state.voice;
    const entityId = state && Number.isSafeInteger(state.playerId) ? state.playerId : null;
    if (!voice || entityId === null) {
      clearVoiceLabel();
      return;
    }
    if (voiceLabelState !== null && entityId !== voiceEntityId) clearVoiceLabel();
    voiceEntityId = entityId;
    // Voice "working" means enabled AND a microphone actually captured; anything else is red.
    const working = voice.enabled === true && voice.hasMic !== false;
    const want = working ? (voice.talking ? "talking" : "on") : "off";
    if (want === voiceLabelState) return;
    voiceLabelState = want;
    try {
      if (typeof Nametags.setSelfVisible === "function") Nametags.setSelfVisible(true);
      const color = want === "off" ? VOICE_COLOR_OFF
        : (want === "talking" ? VOICE_COLOR_TALKING : VOICE_COLOR_ON);
      Nametags.setLabel(entityId, VOICE_DOT, 0, color);
    } catch (_) {
      voiceLabelState = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat: the native chat overlay is hidden (Chat.setUIVisible, the Framework's
  // documented replacement hook) and messages are rendered inside the HUD page
  // instead. The configurable open key (default T) focuses the HUD input;
  // submitting goes through Chat.send, so slash commands and server relays
  // work exactly as before. Incoming lines arrive via the reserved chatMessage
  // event as { author, text, color }.
  // ---------------------------------------------------------------------------
  let chatConfig = { enabled: true, openKey: "t" };
  let chatHidden = false;
  let chatBuffer = [];
  let chatInputOpen = false;
  let chatLease = null;
  let chatShortcutDisposer = null;

  function applyChatConfig(value) {
    chatConfig.enabled = value.enabled !== false;
    chatConfig.openKey = String(value.openKey || "t").trim().toLowerCase().slice(0, 16) || "t";
    if (typeof Chat !== "undefined" && Chat && typeof Chat.setUIVisible === "function") {
      try {
        if (chatConfig.enabled && !chatHidden) {
          Chat.setUIVisible(false);
          chatHidden = true;
        } else if (!chatConfig.enabled && chatHidden) {
          Chat.setUIVisible(true);
          chatHidden = false;
        }
      } catch (_) {
      }
    }
    registerChatShortcut();
  }

  function registerChatShortcut() {
    if (chatShortcutDisposer) {
      try {
        chatShortcutDisposer();
      } catch (_) {
      }
      chatShortcutDisposer = null;
    }
    if (!chatConfig.enabled || !Hmp || !Hmp.input || !Hmp.input.shortcuts) return;
    try {
      chatShortcutDisposer = Hmp.input.shortcuts.register({
        resource: "hmp-hud",
        id: "open-chat",
        key: chatConfig.openKey,
        state: "down",
        priority: 10,
        handler: () => openChatInput(),
      });
      logger.info(`Chat input bound to '${chatConfig.openKey}' (native overlay hidden)`);
    } catch (error) {
      chatShortcutDisposer = null;
      logger.warn(`Could not bind the chat open key '${chatConfig.openKey}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function pushChatToPage() {
    if (view < 0 || !pageReady) return;
    try {
      Web.emit(view, "hmp-hud:chat", { messages: chatBuffer.slice(-14) });
    } catch (_) {
    }
  }

  Events.on("chatMessage", (message) => {
    let entry = null;
    if (typeof message === "string") {
      entry = { author: "", text: message.slice(0, 300) };
    } else if (message && typeof message === "object") {
      const text = String(message.text || message.message || "").trim();
      if (text) entry = { author: String(message.author || ""), text: text.slice(0, 300) };
    }
    if (!entry) return;
    chatBuffer.push(entry);
    if (chatBuffer.length > 40) chatBuffer.splice(0, chatBuffer.length - 40);
    if (chatConfig.enabled) pushChatToPage();
  });

  function openChatInput() {
    if (!chatConfig.enabled || chatInputOpen || menuActive || !visible) return;
    if (ensureView() < 0) return;
    chatInputOpen = true;
    try {
      Web.showView(view);
    } catch (_) {
    }
    try {
      Web.focusView(view, true);
    } catch (_) {
    }
    if (!chatLease && Hmp && Hmp.input && Hmp.input.controls) {
      try {
        chatLease = Hmp.input.controls.acquire({ resource: "hmp-hud", id: "chat-input" });
      } catch (_) {
        chatLease = null;
      }
    }
    pushChatToPage();
    try {
      Web.emit(view, "hmp-hud:chat-open", {});
    } catch (_) {
    }
  }

  function closeChatInput(notifyPage) {
    chatInputOpen = false;
    if (view >= 0) {
      try {
        Web.focusView(view, false);
      } catch (_) {
      }
      if (notifyPage !== false) {
        try {
          Web.emit(view, "hmp-hud:chat-close", {});
        } catch (_) {
        }
      }
      if (!visible) {
        try {
          Web.hideView(view);
        } catch (_) {
        }
      }
    }
    if (chatLease) {
      try {
        chatLease.release();
      } catch (_) {
      }
      chatLease = null;
    }
  }

  Events.on("hmp-hud:chat", (payload) => {
    const value = objectOf(payload);
    if (value) applyChatConfig(value);
  });

  // ---------------------------------------------------------------------------
  // Native game menus: disable the game's Field Guide (ESC plus every page
  // hotkey such as N/Y/U/I) so the HUD is the only menu layer, optionally the
  // tool wheel (Tab) and the action screen (T) too. Game holds are idempotent,
  // resource-scoped and dropped automatically on stop/reload/disconnect.
  // ---------------------------------------------------------------------------
  const MENU_PAGES = ["map", "gear", "inventory", "talents", "quests", "mail", "collections", "challenges", "settings"];

  function releaseGameMenuHolds() {
    if (typeof Game === "undefined" || !Game) return;
    try {
      if (typeof Game.setPauseMenuEnabled === "function") Game.setPauseMenuEnabled(true);
      if (typeof Game.setToolWheelEnabled === "function") Game.setToolWheelEnabled(true);
      if (typeof Game.setActionScreenEnabled === "function") Game.setActionScreenEnabled(true);
      if (typeof Game.setMenuPageEnabled === "function") {
        for (const page of MENU_PAGES) {
          try {
            Game.setMenuPageEnabled(page, true);
          } catch (_) {
          }
        }
      }
    } catch (_) {
    }
  }

  function applyGameMenus(value) {
    if (typeof Game === "undefined" || !Game) return;
    releaseGameMenuHolds();
    if (value.enabled === false) return;
    const applied = [];
    try {
      if (value.mode === "pages") {
        for (const page of Array.isArray(value.pages) ? value.pages : []) {
          if (typeof Game.setMenuPageEnabled !== "function") break;
          try {
            Game.setMenuPageEnabled(page, false);
            applied.push(page);
          } catch (_) {
          }
        }
      } else if (typeof Game.setPauseMenuEnabled === "function") {
        Game.setPauseMenuEnabled(false);
        applied.push("field-guide (ESC + page keys)");
      }
      if (value.toolWheel === true && typeof Game.setToolWheelEnabled === "function") {
        Game.setToolWheelEnabled(false);
        applied.push("tool-wheel");
      }
      if (value.actionScreen === true && typeof Game.setActionScreenEnabled === "function") {
        Game.setActionScreenEnabled(false);
        applied.push("action-screen");
      }
    } catch (_) {
    }
    if (applied.length) logger.info(`Native game menus disabled: ${applied.join(", ")}`);
  }

  Events.on("hmp-hud:gamemenus", (payload) => {
    const value = objectOf(payload);
    if (value) applyGameMenus(value);
  });

  // ---------------------------------------------------------------------------
  // /voz bridge: the server asks, we read the local Voice state and either
  // report it back or apply a change (rebind the key, enable/disable, toggle
  // the transmit mode). The voice settings live client-side, so this is the
  // only way a chat command can reach them.
  // ---------------------------------------------------------------------------
  function voiceInfo() {
    const read = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
    return {
      enabled: read(() => Voice.isEnabled() === true, false),
      hasMic: read(() => Voice.hasMicrophone() === true, false),
      key: read(() => String(Voice.getPushToTalkKey() || ""), "?"),
      mode: read(() => String(Voice.getTransmitMode() || ""), "?"),
      talking: read(() => Voice.isTalking() === true, false),
      level: Math.round(read(() => Number(Voice.getInputLevel()) || 0, 0) * 100) / 100,
      tier: read(() => Number(Voice.getTier()) || 0, 0),
    };
  }

  Events.on("hmp-hud:voice", (payload) => {
    if (typeof Voice === "undefined" || !Voice) return;
    const detail = objectOf(payload);
    if (!detail) return;
    const action = String(detail.action || "");
    if (action === "status") {
      try {
        Events.emitServer("hmp-hud:voice-status", JSON.stringify({ kind: "status", info: voiceInfo() }));
      } catch (_) {
      }
      return;
    }
    if (action === "key") {
      const key = String(detail.key || "").trim().toLowerCase();
      let ok = false;
      try {
        Voice.setPushToTalkKey(key);
        ok = true;
      } catch (_) {
        ok = false;
      }
      try {
        Events.emitServer("hmp-hud:voice-status", JSON.stringify({ kind: "key", ok, key }));
      } catch (_) {
      }
      return;
    }
    if (action === "enabled") {
      const value = detail.value === true;
      try {
        Voice.setEnabled(value);
      } catch (_) {
      }
      try {
        Events.emitServer("hmp-hud:voice-status", JSON.stringify({ kind: "enabled", ok: true, value }));
      } catch (_) {
      }
      return;
    }
    if (action === "mode-toggle") {
      let current = "pushToTalk";
      try {
        current = String(Voice.getTransmitMode() || "pushToTalk");
      } catch (_) {
      }
      const next = current === "pushToTalk" ? "voiceActivity" : "pushToTalk";
      let ok = false;
      try {
        Voice.setTransmitMode(next);
        ok = true;
      } catch (_) {
        ok = false;
      }
      try {
        Events.emitServer("hmp-hud:voice-status", JSON.stringify({ kind: "mode", ok, mode: next }));
      } catch (_) {
      }
    }
  });

  function mergedState() {
    const state = Object.assign({}, serverState);
    const native = nativeProgression();
    if (native) {
      const serverXp = state.xp && typeof state.xp === "object" ? state.xp : {};
      const points = native.points !== null ? native.points : Number(serverXp.points) || 0;
      let fraction = null;
      if (native.start !== null && native.end !== null && native.end > native.start) {
        fraction = clamp01((points - native.start) / (native.end - native.start));
      } else if (native.start !== null && native.end === null) {
        fraction = points >= native.start ? 1 : 0; // top of the ladder: bar stays full
      }
      state.xp = {
        level: native.level,
        points,
        start: native.start,
        end: native.end,
        fraction,
        source: "native",
      };
    } else if (state.xp) {
      state.xp = { ...state.xp, start: null, end: null, fraction: null, source: "server" };
    }
    const spells = nativeSpells();
    if (spells) state.spells = spells;
    // Health: the game's own CharacterStateInfo read (LocalPlayer.stateInfo) is the authority.
    // A death read forces zero; a living reading wins over everything the server cached (which
    // is where a stale death hold or a broken zero used to leak into the bar). The server's
    // event-driven zero (healthForced) only applies when the game read is unavailable.
    const vitals = nativeHealth();
    if (vitals) {
      if (vitals.dead === true) {
        state.health = 0;
      } else if (vitals.health !== null) {
        state.health = vitals.health;
        if (vitals.max) state.healthMax = vitals.max;
      } else if (state.healthForced === true) {
        state.health = 0;
      }
    } else if (state.healthForced === true) {
      state.health = 0;
    }
    // Voice state: read from the Voice global (client-side) and mirrored onto the
    // player's own nametag as the dot above the name.
    let voice = null;
    if (typeof Voice !== "undefined" && Voice && typeof Voice.isEnabled === "function") {
      let enabled = false;
      try {
        enabled = Voice.isEnabled() === true;
      } catch (_) {
        enabled = false;
      }
      let hasMic = null;
      if (typeof Voice.hasMicrophone === "function") {
        try {
          hasMic = Voice.hasMicrophone() === true;
        } catch (_) {
          hasMic = null;
        }
      }
      let talking = false;
      if (enabled) {
        try {
          talking = Voice.isTalking() === true;
        } catch (_) {
          talking = false;
        }
      }
      voice = { enabled, hasMic, talking };
    }
    if (voice) state.voice = voice;
    updateVoiceIndicator(state);
    return state;
  }

  function pushToPage() {
    if (view < 0 || !pageReady || !visible || !serverState) return;
    const state = mergedState();
    const json = JSON.stringify(state);
    if (json === lastPageJson) return;
    lastPageJson = json;
    try {
      Web.emit(view, "hmp-hud:state", state);
    } catch (error) {
      logger.warn(`Could not push HUD state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  Events.on("hmp-hud:show", (payload) => {
    const state = objectOf(payload);
    if (!state) return;
    serverState = state;
    lastPageJson = "";
    if (ensureView() < 0) {
      logger.warn("The HUD web view is not available yet");
      return;
    }
    visible = true;
    Web.showView(view);
    suppressGameHud(true);
    pushToPage();
    pushChatToPage();
  });

  Events.on("hmp-hud:update", (payload) => {
    if (!visible) return;
    if (view < 0) ensureView();
    const state = objectOf(payload);
    if (!state) return;
    serverState = state;
    pushToPage();
  });

  Events.on("hmp-hud:hide", () => {
    visible = false;
    serverState = null;
    lastPageJson = "";
    closeMenu();
    hideVoiceIndicator();
    if (view >= 0) {
      try {
        Web.hideView(view);
      } catch (_) {
      }
    }
    suppressGameHud(false);
  });

  // ---------------------------------------------------------------------------
  // TAB -> inventory toggle.
  // The server owns the configured key; while the inventory page is focused the
  // Framework swallows key edges, so the forked inventory page (inventory.html)
  // handles TAB itself and closes via its normal close bridge.
  // ---------------------------------------------------------------------------
  let shortcutDisposer = null;
  let registeredKey = "";

  function registerInventoryShortcut(key) {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized || normalized === registeredKey) return;
    if (shortcutDisposer) {
      try {
        shortcutDisposer();
      } catch (_) {
      }
      shortcutDisposer = null;
      registeredKey = "";
    }
    if (!Hmp || !Hmp.input || !Hmp.input.shortcuts) {
      logger.warn("hmp-lib input shortcuts unavailable: TAB inventory toggle is disabled");
      return;
    }
    try {
      shortcutDisposer = Hmp.input.shortcuts.register({
        resource: "hmp-hud",
        id: "toggle-inventory",
        key: normalized,
        state: "down",
        priority: 10,
        handler: () => {
          try {
            Events.emitServer("hmp-hud:inventory-toggle", "{}");
          } catch (_) {
          }
        },
      });
      registeredKey = normalized;
      logger.info(`Inventory toggle bound to '${normalized}'`);
    } catch (error) {
      logger.warn(`Could not bind the inventory toggle to '${normalized}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  Events.on("hmp-hud:keybinds", (payload) => {
    const value = objectOf(payload);
    if (!value) return;
    if (value.inventoryToggle === false) {
      if (shortcutDisposer) {
        try {
          shortcutDisposer();
        } catch (_) {
        }
        shortcutDisposer = null;
        registeredKey = "";
      }
      return;
    }
    registerInventoryShortcut(value.inventoryKey);
  });

  function announceReady() {
    try {
      Events.emitServer("hmp-hud:client-ready", "{}");
    } catch (_) {
    }
  }

  Events.on("resourceStop", (name) => {
    if (name && name !== "hmp-hud") return;
    if (shortcutDisposer) {
      try {
        shortcutDisposer();
      } catch (_) {
      }
      shortcutDisposer = null;
      registeredKey = "";
    }
    visible = false;
    serverState = null;
    closeMenu();
    hideVoiceIndicator();
    suppressGameHud(false);
    closeChatInput(false);
    if (chatShortcutDisposer) {
      try {
        chatShortcutDisposer();
      } catch (_) {
      }
      chatShortcutDisposer = null;
    }
    if (chatHidden && typeof Chat !== "undefined" && Chat && typeof Chat.setUIVisible === "function") {
      try {
        Chat.setUIVisible(true);
      } catch (_) {
      }
      chatHidden = false;
    }
    if (view >= 0) {
      try {
        Web.hideView(view);
        Web.destroyView(view);
      } catch (_) {
      }
      view = -1;
      pageReady = false;
    }
  });

  // Live poll: keeps the XP bar and (fallback) health smooth between server pushes.
  const pollTimer = setInterval(() => {
    if (visible && serverState) pushToPage();
  }, POLL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  ensureView();
  announceReady();
  setTimeout(announceReady, 1500); // retry once in case the server resource loaded after us
  logger.info("HUD client ready (view created hidden until spawn completes)");
})();
