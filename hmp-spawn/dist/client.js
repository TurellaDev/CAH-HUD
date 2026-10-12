"use strict";
(() => {
  // client/main.ts
  var VIEW_URL = "fw://resources/hmp-spawn/dist/index.html";
  var Input = Imports.get("hmp-lib").input;
  var view = -1;
  var pageReady = false;
  var visible = false;
  var controlLease = null;
  var model = null;
  var transition = false;
  function lock(locked) {
    if (locked && !controlLease) controlLease = Input.controls.acquire({ resource: "hmp-spawn", id: "screen" });
    else if (!locked && controlLease) {
      controlLease.release();
      controlLease = null;
    }
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
        if (visible && model) Web.emit(view, "hmp-spawn:model", model);
      });
      Web.on(view, "select", (payload) => {
        const key = payload && typeof payload === "object" && "key" in payload ? payload.key : void 0;
        if (transition || !key) return;
        Events.emitServer("hmp-spawn:select", JSON.stringify({ key: String(key) }));
      });
    }
    return view;
  }
  function show(payload) {
    model = payload || model || {};
    transition = false;
    if (ensureView() < 0) {
      Game.notify("[spawn] The spawn screen is not ready yet.");
      return;
    }
    visible = true;
    Web.showView(view);
    Web.focusView(view);
    lock(true);
    if (pageReady) Web.emit(view, "hmp-spawn:model", model);
  }
  function startTransition() {
    transition = true;
    visible = false;
    if (view >= 0) Web.hideView(view);
    lock(true);
    try {
      Camera.fade({ from: 0, to: 1, duration: 0.45, hold: true, fadeAudio: true });
    } catch (_) {
    }
  }
  function finishTransition() {
    transition = false;
    visible = false;
    if (view >= 0) Web.hideView(view);
    try {
      Camera.stopFade();
      Camera.fade({ from: 1, to: 0, duration: 0.75, hold: false, fadeAudio: true });
    } catch (_) {
    }
    setTimeout(() => lock(false), 800);
  }
  function failTransition(payload) {
    transition = false;
    try {
      Camera.stopFade();
    } catch (_) {
    }
    const message = payload && typeof payload === "object" && "message" in payload ? payload.message : void 0;
    Game.notify(`[spawn] ${String(message || "The destination could not be loaded.")}`);
    if (model) show(model);
    else lock(false);
  }
  Events.on("hmp-spawn:open", (payload) => show(payload));
  Events.on("hmp-spawn:transition", () => startTransition());
  Events.on("hmp-spawn:complete", () => finishTransition());
  Events.on("hmp-spawn:failed", (payload) => failTransition(payload));
  ensureView();
})();
