/* ============================================================
 * bridge.js — lets other local apps (Dooley's Hub designer,
 * Feasibility module, etc.) open Sketch Studio and hand it work:
 *
 *   URL params:
 *     ?script=<url>            fetch a .rb and run it
 *     ?address=<addr>&size=660&spacing=10&autobuild=1
 *                              open the Site dialog prefilled (and build)
 *
 *   postMessage (from localhost or the hosted Hub only):
 *     { type: "sketch-studio:ping" }                → replies "ready"
 *     { type: "sketch-studio:run",  name, code }    → runs Ruby code
 *     { type: "sketch-studio:site", address, sizeFt, spacingFt, autobuild }
 *
 * On load, announces { type: "sketch-studio:ready" } to its opener.
 * ============================================================ */
"use strict";

const SSBridge = {
  isTrustedOrigin(origin) {
    // local dev servers, plus the deployed Hub (same GitHub Pages domain
    // this copy of Sketch Studio is served from)
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      origin === "https://dooleyswoodworksnv-sudo.github.io";
  },

  runScript(name, code) {
    App.toggleConsole(true);
    RubyConsole.append("── Bridge: received " + name + " (" + code.length + " chars) ──", "info");
    RubyEngine.run(code, { echo: false });
  },

  prefillSite(address, sizeFt, spacingFt, autobuild) {
    Site.showNewSiteDialog();
    const set = (id, v) => { if (v) document.getElementById(id).value = v; };
    set("site-addr", address);
    set("site-size", sizeFt);
    set("site-spacing", spacingFt);
    if (autobuild) Site.buildFromAddress();
  },

  init() {
    const q = new URLSearchParams(location.search);

    if (q.get("script")) {
      const url = q.get("script");
      setTimeout(() => {
        App.toggleConsole(true);
        RubyConsole.append("Bridge: downloading " + url + " …", "info");
        fetch(url)
          .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
          .then(code => this.runScript(url.split("/").pop() || "script.rb", code))
          .catch(err => RubyConsole.append("Bridge: download failed — " + err.message, "error"));
      }, 300);
    }

    if (q.get("address")) {
      setTimeout(() => this.prefillSite(
        q.get("address"), q.get("size"), q.get("spacing"), q.get("autobuild") === "1"), 300);
    }

    window.addEventListener("message", e => {
      if (!this.isTrustedOrigin(e.origin)) return;
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "sketch-studio:ping") {
        if (e.source) e.source.postMessage({ type: "sketch-studio:ready" }, e.origin);
      } else if (m.type === "sketch-studio:run" && typeof m.code === "string") {
        this.runScript(typeof m.name === "string" ? m.name : "bridge-script.rb", m.code);
        if (e.source) e.source.postMessage({ type: "sketch-studio:done" }, e.origin);
      } else if (m.type === "sketch-studio:site" && typeof m.address === "string") {
        this.prefillSite(m.address, m.sizeFt, m.spacingFt, !!m.autobuild);
        if (e.source) e.source.postMessage({ type: "sketch-studio:done" }, e.origin);
      }
    });

    // announce to whoever opened us
    if (window.opener) {
      try { window.opener.postMessage({ type: "sketch-studio:ready" }, "*"); } catch (err) { /* opener gone */ }
    }
  }
};

window.addEventListener("DOMContentLoaded", () => SSBridge.init());
