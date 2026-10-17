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
// Nametag overlay: the marker above every player's head (name, health, voice) is drawn by a
// dedicated transparent web view (dist/nametags.html), not by the engine nametag layer. The engine
// nametag only renders engine-font text, so it can never show images (house crests), a custom font
// (Cinzel) or a redesigned health bar - and it labels players by their platform (Steam/Discord)
// nickname instead of the roleplay name. The overlay replaces all of it: character names streamed
// by the server, a house-tinted health bar, a voice badge (own state read locally, others relayed)
// and per-viewer marks (curfew breakers). The engine nametags are hidden while it runs.
(() => {
  const VIEW_URL = "fw://resources/cah-hud/dist/hud.html";
  const POLL_MS = 500;

  let Hmp = null;
  try {
    Hmp = Imports.get("hmp-lib");
  } catch (_) {
  }
  const logger = Hmp && Hmp.logger ? Hmp.logger.create("cah-hud") : console;

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

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
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
      // Page -> client: ESC menu card interactions.
      Web.on(view, "hmp-hud:esc-close", () => {
        // Ignore the echo of the opening keypress (see the page-side guard).
        if (escOpenedAt && Date.now() - escOpenedAt < 250) return;
        closeEscMenu();
      });
      Web.on(view, "hmp-hud:esc-editor", () => {
        closeEscMenu();
        openMenu({});
      });
      Web.on(view, "hmp-hud:esc-settings", () => {
        closeEscMenu();
        openNativeSettings();
      });
      Web.on(view, "hmp-hud:esc-schedule", () => {
        closeEscMenu();
        try {
          Events.emitServer("hmp-hud:esc-schedule", "{}");
        } catch (_) {
        }
      });
    }
    return view;
  }

  // ---------------------------------------------------------------------------
  // Native game HUD suppression (everything except the configured keep list).
  // ---------------------------------------------------------------------------
  const gameHud = { enabled: false, keepGroups: ["map"] };
  const heldGroups = new Set();
  let loggedGroupNames = false;

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
      if (!loggedGroupNames) {
        loggedGroupNames = true;
        logger.info(`Native HUD group names: hidden=[${[...heldGroups].join(", ")}] kept=[${gameHud.keepGroups.join(", ")}]`);
      }
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
        menuLease = Hmp.input.controls.acquire({ resource: "cah-hud", id: "hud-menu" });
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

  // ---------------------------------------------------------------------------
  // ESC menu card: the game's own ESC field guide stays disabled, so ESC opens
  // our own card menu instead (DefiniÃ§Ãµes / HorÃ¡rio / Editor do HUD). The card
  // owns the physical ESC edge with priority 600 - above hmp-schedule's guide
  // (500) - and closes itself on ESC while the focused view handles the key.
  // ---------------------------------------------------------------------------
  let escLease = null;
  let escMenuOpen = false;
  let escOpenedAt = 0;
  let escClosedAt = 0;

  function openEscMenu() {
    if (escMenuOpen || menuActive) {
      logger.info(`ESC card open refused: card=${escMenuOpen} editor=${menuActive}`);
      return;
    }
    // Ignore the echo of the keypress that closed the card: the game layer can
    // re-deliver that edge after the view released focus.
    if (escClosedAt && Date.now() - escClosedAt < 200) {
      logger.info("ESC card open ignored (echo of the closing press)");
      return;
    }
    if (ensureView() < 0) {
      logger.warn("ESC card open refused: the HUD web view is unavailable");
      return;
    }
    escMenuOpen = true;
    escOpenedAt = Date.now();
    visible = true;
    Web.showView(view);
    try {
      Web.focusView(view);
    } catch (_) {
      try {
        Web.focusView(view, true);
      } catch (__) {
        logger.warn("ESC card: focusView failed (ESC may not close the card)");
      }
    }
    if (!escLease && Hmp && Hmp.input && Hmp.input.controls) {
      try {
        escLease = Hmp.input.controls.acquire({ resource: "cah-hud", id: "esc-menu" });
      } catch (_) {
        escLease = null;
      }
    }
    try {
      Web.emit(view, "hmp-hud:escmenu", { open: true });
    } catch (_) {
    }
  }

  function closeEscMenu() {
    if (!escMenuOpen) return;
    escMenuOpen = false;
    escClosedAt = Date.now();
    logger.info("ESC card closed");
    try {
      Web.focusView(view, false);
    } catch (_) {
    }
    try {
      Web.emit(view, "hmp-hud:escmenu", { open: false });
    } catch (_) {
    }
    if (escLease) {
      try {
        escLease.release();
      } catch (_) {
      }
      escLease = null;
    }
  }

  // The game hides its natives for driving the Field Guide behind DEV/QA names,
  // but they are real and exposed to resources: _menuPageHotkey(page) fires the
  // page's hotkey handler "as the key would" and _fieldGuideClose() closes the
  // guide through its own back path. DefiniÃ§Ãµes therefore: gives back the Field
  // Guide hold (clears the pause-lock that blocks opening), opens the guide
  // straight at the settings page, and keeps guideOpenState true until the
  // player presses ESC again - our shortcut then closes the settings and
  // re-takes the hold, so ESC returns to this card.
  let guideOpenState = false;
  let guideWatch = null;

  function openNativeSettings() {
    if (typeof Game === "undefined" || !Game) return;
    try {
      if (typeof Game.setPauseMenuEnabled === "function") Game.setPauseMenuEnabled(true);
      if (typeof Game.setMenuPageEnabled === "function") {
        for (const page of MENU_PAGES) {
          try {
            Game.setMenuPageEnabled(page, page === "settings");
          } catch (_) {
          }
        }
      }
      try {
        if (typeof Game._menuPageHotkey === "function") Game._menuPageHotkey("settings");
        else if (typeof Game._fieldGuideOpen === "function") Game._fieldGuideOpen();
      } catch (_) {
      }
      guideOpenState = true;
      logger.info("Opening the native settings page from the ESC menu");
    } catch (_) {
    }
    // One delayed pass: if the hotkey only landed on the guide's index page,
    // click the settings entry "as a click would".
    if (guideWatch) clearTimeout(guideWatch);
    guideWatch = setTimeout(() => {
      guideWatch = null;
      if (!guideOpenState) return;
      try {
        if (typeof Game !== "undefined" && Game && typeof Game._menuPagesState === "function") {
          const state = Game._menuPagesState();
          if (state && state.open && state.tabIndex === 0 && state.activeMenu !== "settings" && typeof Game._menuPageIndexSelect === "function") {
            Game._menuPageIndexSelect("settings");
            logger.info("Clicked the settings entry on the Field Guide index");
          }
          logger.info(`Field guide state: ${JSON.stringify(state)}`);
        } else {
          logger.info("Field guide QA state native unavailable; ESC still closes the settings");
        }
      } catch (error) {
        logger.warn(`Field guide state read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 600);
  }

  function closeNativeSettings() {
    guideOpenState = false;
    if (guideWatch) { clearTimeout(guideWatch); guideWatch = null; }
    try {
      if (typeof Game !== "undefined" && Game) {
        if (typeof Game._fieldGuideClose === "function") Game._fieldGuideClose();
        if (typeof Game.setPauseMenuEnabled === "function") Game.setPauseMenuEnabled(false);
      }
    } catch (_) {
    }
    logger.info("Native settings closed; ESC returns to the HUD menu card");
  }

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
    ntMarkSelfVoiceDirty();
  });
  Events.on("voiceStop", () => {
    if (visible && serverState) pushToPage();
    ntMarkSelfVoiceDirty();
  });

  // ---------------------------------------------------------------------------
  // Nametag overlay: the marker above every player's head, drawn by a dedicated
  // transparent web view (nametags.html) instead of the engine nametag layer.
  // Why: the engine nametag only draws engine-font text, so it can never show
  // images (house crests), a custom font (Cinzel) or a redesigned health bar,
  // and it labels players by their platform nickname rather than the character
  // name. The overlay replaces all of that:
  //   - identity: hmp-core character names, streamed by the server;
  //   - health:   a house-tinted bar under the name (server-authoritative);
  //   - voice:    a mic badge - own state read locally every frame, other
  //               players relayed by the server (playerVoiceStart/Stop);
  //   - marks:    per-viewer glyphs other resources pin through the server
  //               export setNametagMark (hmp-schedule curfew breakers).
  // The engine nametag layer is switched off while the overlay runs and is
  // restored when the resource stops, so nothing is left hidden behind us.
  // ---------------------------------------------------------------------------
  const NT_VIEW_URL = "fw://resources/cah-hud/dist/nametags.html";
  const NT_RAD = Math.PI / 180;
  const NT_OCCLUSION_BUDGET = 6;   // line traces per frame (round-robin)
  const NT_OCCLUSION_TTL = 250;    // ms an occlusion answer stays valid
  const NT_DATA_PUSH_MS = 120;     // throttle for identity pushes to the page
  const NT_EYE_HEIGHT = 165;       // camera-fallback origin: eye height above the player origin
  const NT_GROUND_TTL = 3000;      // ms a ground anchor stays fresh
  const NT_GROUND_MOVE = 60;       // cm of horizontal drift that forces a re-trace
  const NT_GROUND_BUDGET = 4;      // ground traces per frame at most
  const NT_GROUND_MAX_ABOVE = 400; // cm above the anchor before a player counts as airborne
  const NT_AIR_FALLBACK = 90;      // origin-relative offset while airborne/uncalibrated
  const NT_SELF_CAM_DIST = 100;    // camera farther than this (XY) from the body = third person
  const NT_MIN_RANGE = 3000;       // markers must reach at least 30 m, whatever the config says

  const nt = {
    view: -1,
    config: {
      enabled: true, range: 12000, showSelf: true, occlusion: false,
      height: 185, selfHeight: 185, tickMs: 150, maxMarkers: 32, fontScale: 1,
      fov: 0, flipYaw: false, flipPitch: false,
    },
    roster: new Map(),   // targetId -> entry (server-streamed players)
    marks: new Map(),    // targetId -> Set(mark) for THIS viewer
    dirty: new Set(),    // ids whose page data needs a re-push
    removed: [],         // ids the page still draws but should drop
    occ: new Map(),      // targetId -> { blocked, at }
    ground: new Map(),   // targetId -> { gz, at, x, y } terrain anchor
    occCursor: 0,
    lastRosterReq: 0,
    lastDataPush: 0,
    lastScreen: { w: 0, h: 0, at: 0 },
    selfVoiceSig: "",
  };

  function ntSupported() {
    return typeof Nametags !== "undefined" && !!Nametags &&
      typeof Web !== "undefined" && !!Web && typeof Web.createView === "function";
  }

  function ntEnsureView() {
    if (nt.view >= 0) return nt.view;
    if (!ntSupported()) return -1;
    try {
      nt.view = Web.createView(NT_VIEW_URL, { visible: false, focus: false, zIndex: 400 });
    } catch (_) {
      nt.view = -1;
    }
    if (nt.view >= 0) {
      Web.on(nt.view, "ready", () => {
        ntPushConfig();
        ntDirtyAll();
        ntPushData(true);
      });
    }
    return nt.view;
  }

  function ntApplyConfig(value) {
    if (!value || typeof value !== "object") return;
    const c = nt.config;
    c.enabled = value.enabled !== false;
    // 30 m floor: a nametag must be readable across a classroom wing, whatever
    // a half-tuned config file says.
    c.range = clampNumber(value.range, NT_MIN_RANGE, 20000, 12000);
    c.tickMs = clampNumber(value.tickMs, 60, 2000, 150);
    // Height above the GROUND (terrain-anchored): the card rides this far above
    // the floor under the player, so the character origin's own height (pelvis
    // or feet, depending on the build) never moves the card off the head.
    c.height = clampNumber(value.height, 50, 500, 185);
    // Own card override; falls back to height when unset. From the third-person
    // camera behind the head a taller anchor can still leave the frame.
    c.selfHeight = clampNumber(value.selfHeight, 50, 500, 185);
    c.maxMarkers = clampNumber(value.maxMarkers, 1, 64, 32);
    c.fontScale = clampNumber(value.fontScale, 0.5, 2.5, 1);
    c.showSelf = value.showSelf !== false;
    // Off by default: a wall must not delete the name off a player's head.
    c.occlusion = value.occlusion === true;
    c.fov = clampNumber(value.fov, 0, 179, 0);
    c.flipYaw = value.flipYaw === true;
    c.flipPitch = value.flipPitch === true;
  }

  function ntPushConfig() {
    if (nt.view < 0) return;
    try {
      Web.emit(nt.view, "hmp-hud:nametags-config", {
        fontScale: nt.config.fontScale,
        showSelf: nt.config.showSelf,
      });
    } catch (_) {
    }
  }

  function ntHideEngineNametags() {
    if (typeof Nametags === "undefined" || !Nametags || typeof Nametags.setVisible !== "function") return;
    try {
      Nametags.setVisible(false);
    } catch (_) {
    }
  }

  function ntRestoreEngineNametags() {
    if (typeof Nametags === "undefined" || !Nametags || typeof Nametags.setVisible !== "function") return;
    try {
      Nametags.setVisible(true);
    } catch (_) {
    }
  }

  function ntMarksOf(targetId) {
    let set = nt.marks.get(targetId);
    if (!set) {
      set = new Set();
      nt.marks.set(targetId, set);
    }
    return set;
  }

  // Server roster: identity, health, voice and positions for players near us.
  // Positions are the two most recent samples; the render loop interpolates.
  function ntApplyRoster(payload) {
    const upserts = Array.isArray(payload && payload.upserts) ? payload.upserts : [];
    const removed = Array.isArray(payload && payload.removed) ? payload.removed : [];
    const now = Date.now();
    for (const up of upserts) {
      if (!up || !Number.isSafeInteger(up.i)) continue;
      const id = up.i;
      const prev = nt.roster.get(id);
      const entry = prev || { px: up.x, py: up.y, pz: up.z, pt: now, t: now };
      if (prev && (prev.x !== up.x || prev.y !== up.y || prev.z !== up.z)) {
        entry.px = prev.x; entry.py = prev.y; entry.pz = prev.z; entry.pt = prev.t;
        entry.x = up.x; entry.y = up.y; entry.z = up.z; entry.t = now;
      } else if (!prev) {
        entry.x = up.x; entry.y = up.y; entry.z = up.z; entry.t = now;
      } else {
        entry.x = up.x; entry.y = up.y; entry.z = up.z; entry.t = now;
      }
      entry.name = String(up.n || "");
      entry.house = up.h || null;
      entry.hp = Number.isFinite(Number(up.hp)) ? Number(up.hp) : null;
      entry.hm = Number.isFinite(Number(up.hm)) ? Number(up.hm) : null;
      entry.voice = up.v === 0 ? false : (up.v === 1 ? true : null);
      entry.talking = up.t === 1;
      entry.marks = [...(nt.marks.get(id) || [])];
      nt.roster.set(id, entry);
      nt.dirty.add(id);
    }
    for (const id of removed) {
      if (Number.isSafeInteger(id) && nt.roster.delete(id)) nt.removed.push(id);
    }
  }

  function ntApplyMark(payload) {
    if (!payload || !Number.isSafeInteger(payload.playerId)) return;
    const id = payload.playerId;
    const mark = String(payload.mark || "").slice(0, 16);
    if (!mark) return;
    const set = ntMarksOf(id);
    if (payload.on === false) set.delete(mark); else set.add(mark);
    const entry = nt.roster.get(id);
    if (entry) {
      entry.marks = [...set];
      nt.dirty.add(id);
    } else if (serverState && serverState.playerId === id) {
      nt.dirty.add(id);
    }
  }

  // Own voice state lives client-side: enabled + microphone, talking right now.
  function ntSelfVoice() {
    if (typeof Voice === "undefined" || !Voice || typeof Voice.isEnabled !== "function") return null;
    try {
      const enabled = Voice.isEnabled() === true;
      let hasMic = true;
      if (typeof Voice.hasMicrophone === "function") hasMic = Voice.hasMicrophone() !== false;
      const talking = typeof Voice.isTalking === "function" ? Voice.isTalking() === true : false;
      return { enabled, hasMic, talking };
    } catch (_) {
      return null;
    }
  }

  function ntSelfVoiceSig() {
    const v = ntSelfVoice();
    return v ? `${v.enabled ? 1 : 0}${v.hasMic ? 1 : 0}${v.talking ? 1 : 0}` : "";
  }

  function ntMarkSelfVoiceDirty() {
    nt.selfVoiceSig = ""; // force the next self-data check to re-push
  }

  function ntSelfData() {
    const state = serverState;
    if (!state || !Number.isSafeInteger(state.playerId)) return null;
    const voice = ntSelfVoice();
    const character = state.character || null;
    const house = state.house && state.house.house ? String(state.house.house).toLowerCase() : null;
    const marks = [...(nt.marks.get(state.playerId) || [])];
    // Health: the game's own read (LocalPlayer.stateInfo) is the authority for
    // the own marker too — the server value comes from `player.health`, which
    // this build may not expose, and it left the own health bar stuck hidden.
    let hp = Number.isFinite(Number(state.health)) ? Number(state.health) : null;
    let hm = Number.isFinite(Number(state.healthMax)) ? Number(state.healthMax) : null;
    const vitals = nativeHealth();
    if (vitals) {
      if (vitals.dead === true) {
        hp = 0;
      } else if (vitals.health !== null) {
        hp = vitals.health;
        if (vitals.max) hm = vitals.max;
      }
    }
    return {
      id: state.playerId,
      name: character && character.name ? String(character.name) : "",
      house,
      hp,
      hm,
      voice: voice ? (voice.enabled && voice.hasMic ? true : false) : null,
      talking: voice ? voice.talking : false,
      marks,
    };
  }

  function ntDirtyAll() {
    for (const id of nt.roster.keys()) nt.dirty.add(id);
    if (serverState && Number.isSafeInteger(serverState.playerId)) nt.dirty.add(serverState.playerId);
  }

  // Throttled identity push: only rows whose signature changed leave the client.
  function ntPushData(force) {
    if (nt.view < 0) return;
    const now = Date.now();
    if (!force && now - nt.lastDataPush < NT_DATA_PUSH_MS) return;
    const upserts = [];
    const seen = new Set();
    const self = ntSelfData();
    if (self) {
      seen.add(self.id);
      const sig = `${self.name}|${self.house || ""}|${self.hp}|${self.hm}|${self.voice === null ? "" : (self.voice ? 1 : 0)}|${self.talking ? 1 : 0}|${self.marks.join(",")}`;
      if (force || sig !== nt.selfVoiceSig) {
        nt.selfVoiceSig = sig;
        upserts.push(self);
      }
    }
    for (const id of nt.dirty) {
      if (seen.has(id)) continue;
      const entry = nt.roster.get(id);
      if (!entry) continue;
      seen.add(id);
      upserts.push({
        id,
        name: entry.name,
        house: entry.house,
        hp: entry.hp,
        hm: entry.hm,
        voice: entry.voice,
        talking: entry.talking,
        marks: entry.marks || [],
      });
    }
    nt.dirty.clear();
    const removed = nt.removed.splice(0, nt.removed.length);
    if (!upserts.length && !removed.length) return;
    nt.lastDataPush = now;
    try {
      Web.emit(nt.view, "hmp-hud:nametags-data", { upserts, removed });
    } catch (_) {
    }
  }

  function ntScreenSize() {
    const now = Date.now();
    if (now - nt.lastScreen.at < 500) return nt.lastScreen;
    try {
      const size = Web.getScreenSize();
      if (size && Number(size.width) > 0 && Number(size.height) > 0) {
        nt.lastScreen = { w: Number(size.width), h: Number(size.height), at: now };
      }
    } catch (_) {
    }
    return nt.lastScreen;
  }

  // Linear extrapolation between the last two server samples keeps markers
  // glued to heads between roster ticks without per-frame server chatter.
  function ntInterpolated(entry, now) {
    const span = Math.max(50, entry.t - entry.pt);
    let a = (now - entry.t) / span;
    if (a > 1.3) a = 1.3;
    if (a < 0) a = 0;
    return {
      x: entry.x + (entry.x - entry.px) * a,
      y: entry.y + (entry.y - entry.py) * a,
      z: entry.z + (entry.z - entry.pz) * a,
    };
  }

  function ntOccluded(id, from, head) {
    if (typeof World === "undefined" || !World || typeof World.lineTrace !== "function") return false;
    const now = Date.now();
    const cached = nt.occ.get(id);
    if (cached && now - cached.at < NT_OCCLUSION_TTL) return cached.blocked;
    if (nt.occCursor >= NT_OCCLUSION_BUDGET) return cached ? cached.blocked : false;
    nt.occCursor++;
    let blocked = false;
    try {
      const hit = World.lineTrace(
        { x: from.x, y: from.y, z: from.z },
        { x: head.x, y: head.y, z: head.z },
        { channel: "camera", ignore: [id] },
      );
      blocked = hit !== null && hit !== undefined;
    } catch (_) {
      blocked = false;
    }
    nt.occ.set(id, { blocked, at: now });
    return blocked;
  }

  function ntVisibleAlpha(dist) {
    const range = nt.config.range;
    if (dist >= range) return 0;
    // Hold full opacity almost to the edge of the range: the marker belongs
    // above the player it names, not in a fade band a few metres out.
    const edge = range * 0.9;
    if (dist <= edge) return 1;
    return Math.max(0, 1 - (dist - edge) / (range - edge));
  }

  // Ground anchoring. The character origin sits an unknown height above the
  // floor (some builds report the pelvis, others the feet), so a flat origin
  // offset floats the card metres above the head. Instead the card is pinned
  // to the terrain under the player: a cheap downward trace, cached per player
  // and refreshed on movement, yields the floor, and the card rides
  // config.height above it. The answer only counts while the player stands
  // roughly on it — flyers (brooms) fail the band and fall back to an
  // origin-relative offset until they land.
  function ntGroundZ(id, pos, now, budget) {
    const cached = nt.ground.get(id) || null;
    const moved = !!cached && Math.hypot(pos.x - cached.x, pos.y - cached.y) > NT_GROUND_MOVE;
    const stale = !cached || now - cached.at > NT_GROUND_TTL;
    if (cached && !stale && !moved) return cached.gz;
    if (budget.used >= NT_GROUND_BUDGET) return cached ? cached.gz : null;
    budget.used++;
    let gz = null;
    try {
      if (typeof World !== "undefined" && World && typeof World.lineTrace === "function") {
        const hit = World.lineTrace(
          { x: pos.x, y: pos.y, z: pos.z + 180 },
          { x: pos.x, y: pos.y, z: pos.z - 300 },
          { objectTypes: ["worldStatic", "shallowWater", "deepWater"] },
        );
        if (hit && !hit.startPenetrating && hit.location && Number.isFinite(hit.location.z)) {
          const above = pos.z - hit.location.z;
          if (above >= -50 && above <= NT_GROUND_MAX_ABOVE) gz = hit.location.z;
        }
      }
    } catch (_) {
      gz = null;
    }
    nt.ground.set(id, { gz, at: now, x: pos.x, y: pos.y });
    return gz;
  }

  // Marker anchor: the ground under the player plus the configured card
  // height, with an origin-relative fallback while uncalibrated or airborne.
  function ntAnchorZ(id, pos, now, budget) {
    const gz = ntGroundZ(id, pos, now, budget);
    return gz !== null ? gz + nt.config.height : pos.z + NT_AIR_FALLBACK;
  }

  function ntScaleFor(dist) {
    const t = Math.min(1, dist / nt.config.range);
    return Math.max(0.55, Math.min(1.2, 1.15 - 0.65 * t));
  }

  function ntPlayerPosition() {
    try {
      if (typeof LocalPlayer !== "undefined" && LocalPlayer && typeof LocalPlayer.getPosition === "function") {
        return LocalPlayer.getPosition();
      }
    } catch (_) {
    }
    return null;
  }

  // Camera pose with a fallback. Camera.capture() is not guaranteed to answer
  // on every build/context (hmp-admin and hmp-quidditch already work around it
  // through getControlRotation); without a pose this loop would emit empty
  // frames forever — the overlay would simply never draw. The fallback
  // synthesizes an eye-level origin from the player transform, which keeps the
  // remote markers placed sensibly.
  function ntCameraPose() {
    let cam = null;
    try {
      cam = typeof Camera !== "undefined" && Camera && typeof Camera.capture === "function" ? Camera.capture() : null;
    } catch (_) {
      cam = null;
    }
    if (cam && cam.position && cam.rotation) return cam;
    let rot = null;
    try {
      if (typeof LocalPlayer !== "undefined" && LocalPlayer && typeof LocalPlayer.getControlRotation === "function") {
        rot = LocalPlayer.getControlRotation();
      }
    } catch (_) {
      rot = null;
    }
    const own = ntPlayerPosition();
    if (rot && own && Number.isFinite(own.x) && Number.isFinite(Number(rot.yaw))) {
      return {
        position: { x: own.x, y: own.y, z: (Number(own.z) || 0) + NT_EYE_HEIGHT },
        rotation: { yaw: Number(rot.yaw) || 0, pitch: Number(rot.pitch) || 0 },
        lens: null,
      };
    }
    return null;
  }

  // The lens fov must be horizontal degrees. Builds that report radians (~1.5
  // for a 90-degree lens) would project every marker tens of screen-widths
  // off-screen — all of them culled, nothing ever drawn. A value below 10
  // cannot be sane degrees, so treat it as radians and convert.
  function ntFovDegrees(cam) {
    const lens = cam && cam.lens ? Number(cam.lens.fov) : 0;
    let fov = lens > 0 ? lens : 90;
    if (fov < 10) fov = (fov * 180) / Math.PI;
    return Math.min(170, Math.max(20, fov));
  }

  // The render loop: project every tracked player to screen space and hand the
  // page a compact geometry frame. Runs ~60x per second; identity data moves on
  // the throttled data push, geometry on this one.
  function ntRenderFrame() {
    if (nt.view < 0 || !nt.config.enabled) return;
    const now = Date.now();
    const screen = ntScreenSize();
    const rows = [];

    const cam = ntCameraPose();
    if (!cam || !cam.position || !cam.rotation || screen.w <= 0 || screen.h <= 0) {
      try {
        Web.emit(nt.view, "hmp-hud:nametags-frame", { rows });
      } catch (_) {
      }
      return;
    }

    let yaw = Number(cam.rotation.yaw) || 0;
    let pitch = Number(cam.rotation.pitch) || 0;
    if (nt.config.flipYaw) yaw = -yaw;
    if (nt.config.flipPitch) pitch = -pitch;
    const cy = Math.cos(yaw * NT_RAD), sy = Math.sin(yaw * NT_RAD);
    const cp = Math.cos(pitch * NT_RAD), sp = Math.sin(pitch * NT_RAD);
    // Unreal-style basis: X forward, Y right, Z up, rotations in degrees.
    const fwd = { x: cp * cy, y: cp * sy, z: sp };
    const right = { x: -sy, y: cy, z: 0 };
    const up = { x: -sp * cy, y: -sp * sy, z: cp };
    const origin = cam.position;
    const fov = nt.config.fov > 0 ? nt.config.fov : ntFovDegrees(cam);
    const tanH = Math.tan((fov * 0.5) * NT_RAD);
    const tanV = (tanH * screen.h) / screen.w;

    const project = (wx, wy, wz) => {
      const dx = wx - origin.x, dy = wy - origin.y, dz = wz - origin.z;
      const zc = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      if (zc < 30) return null;
      const xc = dx * right.x + dy * right.y + dz * right.z;
      const yc = dx * up.x + dy * up.y + dz * up.z;
      const sx = (xc / (zc * tanH) * 0.5 + 0.5) * screen.w;
      const syp = (0.5 - (yc / (zc * tanV)) * 0.5) * screen.h;
      return { sx, sy: syp, dist: Math.sqrt(dx * dx + dy * dy + dz * dz) };
    };

    const marginX = 90, marginY = 140;
    nt.occCursor = 0;
    const groundBudget = { used: 0 };

    // Remote players first (interpolated server samples, occlusion-checked).
    for (const [id, entry] of nt.roster) {
      const pos = ntInterpolated(entry, now);
      const head = { x: pos.x, y: pos.y, z: ntAnchorZ(id, pos, now, groundBudget) };
      const p = project(head.x, head.y, head.z);
      if (!p || p.sx < -marginX || p.sx > screen.w + marginX || p.sy < -marginY || p.sy > screen.h + marginY) continue;
      let alpha = ntVisibleAlpha(p.dist);
      if (alpha > 0 && nt.config.occlusion && ntOccluded(id, origin, head)) alpha = 0;
      if (alpha <= 0) continue;
      rows.push([id, p.sx, p.sy, ntScaleFor(p.dist), alpha]);
    }

    // Own marker: live LocalPlayer position, server identity + health.
    // The own tag anchors a bit lower than everyone else's (`selfHeight`):
    // with the third-person camera close behind the head, the full-height
    // anchor projects above the top of the frame where the cull deleted it —
    // the own marker never showed in the game's normal view. It is clamped
    // into the visible frame instead of culled, so it stays readable; in
    // first person (camera on the body) it is skipped — it would only sit
    // mid-screen over the crosshair.
    if (nt.config.showSelf && serverState && Number.isSafeInteger(serverState.playerId)) {
      const own = ntPlayerPosition();
      if (own && Number.isFinite(own.x)) {
        const dxc = own.x - origin.x, dyc = own.y - origin.y;
        const camDistXy = Math.sqrt(dxc * dxc + dyc * dyc);
        if (camDistXy > NT_SELF_CAM_DIST) {
          // The own card may sit lower than everyone else's (selfHeight); the
          // anchor is still terrain-based, so the origin convention is moot.
          const baseZ = ntAnchorZ(serverState.playerId, own, now, groundBudget);
          const anchorZ = Number.isFinite(nt.config.selfHeight) && nt.config.selfHeight > 0
            ? baseZ - nt.config.height + nt.config.selfHeight
            : baseZ;
          const head = { x: own.x, y: own.y, z: anchorZ };
          const p = project(head.x, head.y, head.z);
          if (p) {
            const alpha = ntVisibleAlpha(p.dist);
            if (alpha > 0) {
              // Clamp into the visible frame: the own tag must stay readable
              // even when its anchor leaves the frustum at close zoom.
              const sx = Math.min(screen.w - 80, Math.max(80, p.sx));
              const sy = Math.min(screen.h - 180, Math.max(90, p.sy));
              rows.push([serverState.playerId, sx, sy, ntScaleFor(p.dist), alpha]);
            }
          }
        }
      }
    }

    try {
      Web.emit(nt.view, "hmp-hud:nametags-frame", { rows });
    } catch (_) {
    }
  }

  // Client-driven roster tick: the host has no reliable server timers, so the
  // client asks for the nearby-player snapshot at the configured rate.
  function ntTick() {
    if (!nt.config.enabled) return;
    const now = Date.now();
    if (now - nt.lastRosterReq >= nt.config.tickMs) {
      nt.lastRosterReq = now;
      try {
        Events.emitServer("hmp-hud:nametags-tick", "{}");
      } catch (_) {
      }
    }
    ntPushData(false);
    ntRenderFrame();
  }

  function ntShow() {
    if (!nt.config.enabled || !ntSupported()) return;
    if (ntEnsureView() < 0) return;
    ntHideEngineNametags();
    try {
      Web.showView(nt.view);
    } catch (_) {
    }
    ntPushConfig();
    ntDirtyAll();
    ntPushData(true);
  }

  function ntHide() {
    if (nt.view >= 0) {
      try {
        Web.emit(nt.view, "hmp-hud:nametags-clear", {});
        Web.hideView(nt.view);
      } catch (_) {
      }
    }
    nt.roster.clear();
    nt.occ.clear();
    nt.ground.clear();
    nt.dirty.clear();
    nt.removed.length = 0;
  }

  function ntStop() {
    ntHide();
    ntRestoreEngineNametags();
    if (nt.view >= 0) {
      try {
        Web.destroyView(nt.view);
      } catch (_) {
      }
      nt.view = -1;
    }
  }

  Events.on("hmp-hud:nametags-config", (payload) => {
    ntApplyConfig(objectOf(payload));
    ntPushConfig();
  });

  Events.on("hmp-hud:nametags-roster", (payload) => {
    ntApplyRoster(objectOf(payload));
  });

  Events.on("hmp-hud:nametags-mark", (payload) => {
    ntApplyMark(objectOf(payload));
  });

  // ~60 Hz overlay loop; each iteration throttles the server roster request to
  // the configured tick rate and pushes at most one geometry + data frame.
  const ntTimer = setInterval(() => {
    if (!visible || isSuspended()) return;
    ntTick();
  }, 16);
  if (typeof ntTimer.unref === "function") ntTimer.unref();

  // ---------------------------------------------------------------------------
  // Chat: the native chat overlay is hidden (Chat.setUIVisible, the Framework's
  // documented replacement hook) and messages are rendered inside the HUD page
  // instead. The configurable open key (default Enter) focuses the HUD input;
  // submitting goes through Chat.send, so slash commands and server relays
  // work exactly as before. Incoming lines arrive via the reserved chatMessage
  // event as { author, text, color }.
  // ---------------------------------------------------------------------------
  let chatConfig = { enabled: true, openKey: "enter" };
  let chatHidden = false;
  let chatBuffer = [];
  let chatInputOpen = false;
  let chatLease = null;
  let chatShortcutDisposer = null;

  function applyChatConfig(value) {
    chatConfig.enabled = value.enabled !== false;
    chatConfig.openKey = String(value.openKey || "enter").trim().toLowerCase().slice(0, 16) || "enter";
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
        resource: "cah-hud",
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
        chatLease = Hmp.input.controls.acquire({ resource: "cah-hud", id: "chat-input" });
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
    // The above-name voice dot is gone: the nametag overlay (nt* functions)
    // reads Voice directly every frame. state.voice stays for the HUD page.
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
    // While another screen owns the display (Floo map, hold key, inventory screen),
    // only buffer the state; resume renders it the moment the screen is back.
    if (isSuspended()) return;
    if (ensureView() < 0) {
      logger.warn("The HUD web view is not available yet");
      return;
    }
    visible = true;
    Web.showView(view);
    ntShow();
    suppressGameHud(true);
    // Entering the world: only NOW are the native menu holds + ESC bind applied,
    // so the loading/character/spawn phases run completely untouched.
    if (!inWorld) {
      inWorld = true;
      applyGameMenus(menusConfig);
      registerMenuShortcut();
    }
    pushToPage();
    pushChatToPage();
  });

  Events.on("hmp-hud:update", (payload) => {
    if (isSuspended()) {
      // Keep the snapshot fresh so resume is instant; render waits for resume.
      const buffered = objectOf(payload);
      if (buffered) {
        serverState = buffered;
        lastPageJson = "";
      }
      return;
    }
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
    ntHide();
    if (view >= 0) {
      try {
        Web.hideView(view);
      } catch (_) {
      }
    }
    suppressGameHud(false);
  });

  // ---------------------------------------------------------------------------
  // Suspend/resume: a focused full-screen resource (the Floo Flames map) asks
  // the HUD to step aside without dropping its state, and to come back after.
  // Unlike hmp-hud:hide, the server snapshot survives, so resume is instant and
  // the native game HUD suppression is untouched (no flicker behind overlays).
  // A show/update arriving while suspended only buffers state until resume.
  // Reasons stack: the map's suspend and the inventory key's hold can be out
  // at once, and the view returns only when the last reason lets go.
  // ---------------------------------------------------------------------------
  const suspendReasons = new Set();
  let suspendedWasVisible = false;

  function isSuspended() {
    return suspendReasons.size > 0;
  }

  function setSuspended(reason, on) {
    let changed = false;
    if (on) {
      if (suspendReasons.has(reason)) return false;
      const first = suspendReasons.size === 0;
      suspendReasons.add(reason);
      if (first) suspendedWasVisible = visible;
      changed = true;
    } else {
      if (!suspendReasons.delete(reason)) return false;
      changed = true;
    }
    if (suspendReasons.size > 0) {
      if (visible) {
        visible = false;
        if (view >= 0) {
          try {
            Web.hideView(view);
          } catch (_) {
          }
        }
        ntHide();
      }
      return changed;
    }
    if (suspendedWasVisible && serverState) {
      visible = true;
      if (view >= 0) {
        try {
          Web.showView(view);
        } catch (_) {
        }
      }
      ntShow();
      lastPageJson = "";
      pushToPage();
      pushChatToPage();
    }
    suspendedWasVisible = false;
    return changed;
  }

  Events.on("hmp-hud:suspend", () => setSuspended("floo", true));
  Events.on("hmp-hud:resume", () => setSuspended("floo", false));

  // ---------------------------------------------------------------------------
  // The inventory screen belongs to hmp-inventory: it owns the page and the
  // toggle key (its ui.key, default I) and reports open/close, while this
  // resource only steps the HUD aside while the screen is up — whatever opened
  // it (/inventory, another resource calling ui.open, or its bound key).
  Events.on("hmp-inventory:open", () => {
    setSuspended("inventory", true);
  });
  Events.on("hmp-inventory:close", () => {
    setSuspended("inventory", false);
  });

  // ---------------------------------------------------------------------------
  // Hold-hide (the item-wheel key). Holding the configured key (default TAB,
  // the game's own item wheel) steps the HUD aside for exactly as long as it is
  // held — the release brings the HUD back. The inventory toggle itself is NOT
  // bound here: hmp-inventory owns it (ui.key, default I), so the two never
  // race on the same edge. A focused page swallows key edges, so the release
  // is caught three ways: the key's up edge whenever the game layer sees it, a
  // poll of the physical key state while the hold is out, and a deadline that
  // can never leave the HUD hidden on its own.
  // ---------------------------------------------------------------------------
  let holdDownDisposer = null;
  let holdUpDisposer = null;
  let holdTimer = null;
  let holdKey = "";

  function holdEnd() {
    if (holdTimer) {
      clearInterval(holdTimer);
      holdTimer = null;
    }
    if (setSuspended("key-hold", false)) logger.info("HUD back — hold key released");
  }

  function holdStart() {
    const key = holdKey || "tab";
    if (setSuspended("key-hold", true)) logger.info(`HUD hidden while '${key}' is held`);
    if (holdTimer) return;
    const deadline = Date.now() + 8000;
    holdTimer = setInterval(() => {
      let down = true;
      try {
        down = !!Hmp.input.shortcuts.isDown(key);
      } catch (_) {
        down = true;
      }
      if (!down || Date.now() >= deadline) holdEnd();
    }, 80);
    if (typeof holdTimer.unref === "function") holdTimer.unref();
  }

  function disposeHold() {
    for (const disposer of [holdDownDisposer, holdUpDisposer]) {
      if (disposer) {
        try {
          disposer();
        } catch (_) {
        }
      }
    }
    holdDownDisposer = null;
    holdUpDisposer = null;
    if (holdTimer) {
      clearInterval(holdTimer);
      holdTimer = null;
    }
    setSuspended("key-hold", false);
  }

  function applyHoldKey(key) {
    const normalized = String(key === undefined || key === null ? "tab" : key).trim().toLowerCase().slice(0, 16);
    if (normalized === holdKey) return;
    disposeHold();
    holdKey = normalized;
    if (!normalized) {
      logger.info("Hold-hide disabled (empty hudHoldKey)");
      return;
    }
    if (!Hmp || !Hmp.input || !Hmp.input.shortcuts) {
      logger.warn("hmp-lib input shortcuts unavailable: the HUD hold-hide is disabled");
      return;
    }
    try {
      holdDownDisposer = Hmp.input.shortcuts.register({
        resource: "cah-hud",
        id: "hud-hold-start",
        key: normalized,
        state: "down",
        priority: 10,
        handler: () => holdStart(),
      });
      // One registration per physical edge, so this can never tie with the
      // start above. A lower priority means another resource's up edge wins
      // arbitration; the poll still catches the release either way.
      holdUpDisposer = Hmp.input.shortcuts.register({
        resource: "cah-hud",
        id: "hud-hold-end",
        key: normalized,
        state: "up",
        priority: 9,
        handler: () => holdEnd(),
      });
      logger.info(`Hold-hide bound to '${normalized}' (holding it hides the HUD for the item wheel)`);
    } catch (error) {
      logger.warn(`Could not bind the HUD hold-hide to '${normalized}': ${error instanceof Error ? error.message : String(error)}`);
      holdDownDisposer = null;
      holdUpDisposer = null;
      holdKey = "";
    }
  }

  Events.on("hmp-hud:keybinds", (payload) => {
    const value = objectOf(payload);
    if (!value) return;
    applyHoldKey(value.hudHoldKey);
  });

  function announceReady() {
    try {
      Events.emitServer("hmp-hud:client-ready", "{}");
    } catch (_) {
    }
  }

  Events.on("resourceStop", (name) => {
    if (name && name !== "cah-hud") return;
    visible = false;
    serverState = null;
    // After the state is gone the hold's release path cannot re-show anything.
    disposeHold();
    closeMenu();
    ntStop();
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

  // Live poll: re-render locally + ask the server for fresh state every ~1s.
  // Server-side timers are unreliable in this host, so the client drives the
  // periodic refresh (clock/money/health) itself.
  let lastTickRequest = 0;
  const pollTimer = setInterval(() => {
    if (!visible) return;
    if (serverState) pushToPage();
    if (Date.now() - lastTickRequest >= 1000) {
      lastTickRequest = Date.now();
      try {
        Events.emitServer("hmp-hud:tick", "{}");
      } catch (_) {
      }
    }
  }, POLL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  // ESC opens the HUD menu card (DefiniÃ§Ãµes / HorÃ¡rio / Editor do HUD).
  function registerEscShortcut() {
    if (!Hmp || !Hmp.input || !Hmp.input.shortcuts) {
      logger.warn("hmp-lib input shortcuts unavailable: the ESC menu card is disabled");
      return;
    }
    try {
      Hmp.input.shortcuts.register({
        resource: "cah-hud",
        id: "toggle-esc-menu",
        key: "escape",
        state: "down",
        priority: 600,
        when: () => visible && !escMenuOpen && !menuActive,
        handler: () => {
          logger.info(`ESC edge: guide=${guideOpenState} vis=${visible} menu=${menuActive} card=${escMenuOpen}`);
          if (guideOpenState) {
            // The native settings page is up: this ESC closes it and hands the
            // key back to the card, instead of stacking the card on top.
            closeNativeSettings();
            return;
          }
          openEscMenu();
        },
      });
      logger.info("ESC menu card bound (priority 600)");
    } catch (error) {
      logger.warn(`Could not bind the ESC menu card: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  registerEscShortcut();

  ensureView();
  announceReady();
  setTimeout(announceReady, 1500); // retry once in case the server resource loaded after us
  logger.info("HUD client ready (view created hidden until spawn completes)");
})();
