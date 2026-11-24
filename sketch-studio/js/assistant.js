/* ============================================================
 * assistant.js — ✨ AI Assistant: chat panel that turns plain
 * English into SketchUp-style Ruby and runs it in the workspace.
 *
 * The AI call goes through the same gemini-proxy Supabase Edge
 * Function the Hub uses — no API key in the browser. It reuses
 * the Hub's signed-in session (same origin on the deployed site),
 * so the user just needs to be signed in to Dooley's Hub.
 *
 * Flow: prompt → Gemini writes a Ruby script → script is shown
 * as a card → user clicks Run → if the script errors, the error
 * is sent back to the model and the corrected script re-runs
 * automatically (up to MAX_FIXES times).
 * ============================================================ */
"use strict";

const AIAssistant = {
  SUPABASE_URL: "https://mnwphkgrziboyudagzko.supabase.co",
  ANON_KEY: "sb_publishable_J8ezCizFeOFRcO6JKO9tdA_eAQF3_l9",
  MODEL: "gemini-2.5-pro",
  MAX_FIXES: 2,
  history: [],   // Gemini `contents` — {role:"user"|"model", parts:[{text}]}
  busy: false,

  /* ---------- auth: reuse the Hub's Supabase session ---------- */
  getToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!/^sb-.+-auth-token$/.test(k)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const v = JSON.parse(raw);
        const tok = (v && v.access_token) ||
          (v && v.currentSession && v.currentSession.access_token);
        if (tok) return tok;
      }
    } catch (err) { /* malformed entry — treat as signed out */ }
    return null;
  },

  /* ---------- what the model is told about this environment ---------- */
  systemPrompt() {
    return [
      "You are the AI modeling assistant inside Sketch Studio, a browser 3D workspace with a SketchUp-compatible Ruby API (ruby.wasm). You write Ruby scripts that build 3D geometry.",
      "",
      "RESPONSE FORMAT — always:",
      "1. One or two friendly sentences saying what the script builds (plain English, the user is a builder, not a programmer).",
      "2. Exactly ONE ```ruby code block with the complete, runnable script. No other code blocks.",
      "",
      "ENVIRONMENT RULES:",
      "- Units are INCHES. Z is up. Numeric helpers exist: 12.feet, 6.mm, 45.degrees.",
      "- Entry point: ents = Sketchup.active_model.entities",
      "- Supported: add_face(pts...), add_line(p1,p2), add_edges(pts...), add_circle(center,normal,radius,segs), add_ngon(center,normal,radius,sides), add_group, erase_entities, transform_entities, face.pushpull(dist), face.reverse!, face.normal / area / center, group.entities, group.name=, group.transform!, group.move!, Geom::Point3d, Geom::Vector3d, Geom::Transformation (.translation, .rotation(point,axis,angle), .scaling, .axes), Sketchup::Color, model.layers.add(name), entity.layer=.",
      "- Faces auto-orient; if a pushpull goes the wrong way, reverse! the face first or pushpull a negative distance.",
      "- Materials: face.material = [r,g,b] (0-255) or a Sketchup::Color. Paint faces, not groups.",
      "- NOT supported (never use): components UI, Face#followme, Face#to_ary, observers, UI dialogs (UI.messagebox is ok), file I/O, Sketchup.require of gems, add_text/dimensions (they no-op).",
      "- Scripts run with a watchdog — avoid loops over ~20,000 iterations; build with faces + pushpull rather than thousands of tiny boxes.",
      "- Wrap each distinct object in its own named group (grp = ents.add_group; grp.name = \"Gazebo Roof\"; ge = grp.entities; ...).",
      "- The model may already contain geometry. Only erase or modify existing geometry when the user asks; otherwise add new objects, placed at sensible coordinates.",
      "- Keep scripts self-contained and idempotent-ish: define your own variables, don't rely on prior runs.",
      "",
      "When the user reports a Ruby error, reply with the SAME format: a one-line explanation of the fix, then ONE corrected complete ```ruby script.",
    ].join("\n");
  },

  /* ---------- Gemini via the proxy ---------- */
  async callModel() {
    const token = this.getToken();
    if (!token) {
      throw new Error("SIGNIN");
    }
    const url = this.SUPABASE_URL + "/functions/v1/gemini-proxy/v1beta/models/" +
      this.MODEL + ":generateContent";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": this.ANON_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: this.systemPrompt() }] },
        contents: this.history,
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    });
    if (resp.status === 401) throw new Error("SIGNIN");
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data && (data.error && (data.error.message || data.error) || data.message);
      throw new Error(typeof msg === "string" ? msg : "AI request failed (HTTP " + resp.status + ")");
    }
    const parts = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).map(p => p.text || "").join("");
    if (!text) throw new Error("The AI returned an empty response — try rephrasing.");
    return text;
  },

  splitReply(text) {
    const m = text.match(/```ruby\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/);
    const code = m ? m[1].trim() : null;
    const prose = text.replace(/```(?:ruby)?\s*[\s\S]*?```/g, "").trim();
    return { prose, code };
  },

  /* ---------- run a script and capture its outcome ---------- */
  async runCaptured(code) {
    const outcome = { ran: false, error: null };
    const origErr = RubyBridge.evalError;
    const origRes = RubyBridge.evalResult;
    RubyBridge.evalError = (msg) => { outcome.ran = true; outcome.error = String(msg); origErr(msg); };
    RubyBridge.evalResult = (v) => { outcome.ran = true; origRes(v); };
    try {
      await RubyEngine.run(code, { echo: false });
    } finally {
      RubyBridge.evalError = origErr;
      RubyBridge.evalResult = origRes;
    }
    return outcome;
  },

  /* ---------- chat UI ---------- */
  el(id) { return document.getElementById(id); },

  esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  addBubble(cls, html) {
    const div = document.createElement("div");
    div.className = "ai-bubble " + cls;
    div.innerHTML = html;
    this.el("ai-messages").appendChild(div);
    this.el("ai-messages").scrollTop = this.el("ai-messages").scrollHeight;
    return div;
  },

  addScriptCard(code, { autorun = false, attempt = 0 } = {}) {
    const card = document.createElement("div");
    card.className = "ai-script-card";
    const title = attempt > 0 ? "Corrected script (fix " + attempt + ")" : "Generated script";
    card.innerHTML =
      '<div class="ai-script-head"><span>💎 ' + title + " — " + code.split("\n").length + ' lines</span>' +
      '<span><button class="ai-run">▶ Run</button><button class="ai-copy">Copy</button></span></div>' +
      '<pre class="ai-script-code">' + this.esc(code) + "</pre>";
    this.el("ai-messages").appendChild(card);
    this.el("ai-messages").scrollTop = this.el("ai-messages").scrollHeight;
    const runBtn = card.querySelector(".ai-run");
    card.querySelector(".ai-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(code).catch(() => {});
      this.setStatus("Script copied.");
    });
    runBtn.addEventListener("click", () => this.runWithAutoFix(code, card, attempt));
    if (autorun) this.runWithAutoFix(code, card, attempt);
    return card;
  },

  markCard(card, ok, note) {
    const head = card.querySelector(".ai-script-head span");
    head.textContent = (ok ? "✅ " : "⚠️ ") + head.textContent.replace(/^([✅⚠️💎]\s*)+/, "") +
      (note ? " — " + note : "");
  },

  setStatus(t) { this.el("ai-status").textContent = t || ""; },

  setBusy(b) {
    this.busy = b;
    this.el("btn-ai-send").disabled = b;
    this.el("ai-input").disabled = b;
  },

  /* ---------- run + auto-fix loop ---------- */
  async runWithAutoFix(code, card, attempt) {
    if (this.busy) return;
    this.setBusy(true);
    try {
      this.setStatus("Running script…");
      App.toggleConsole(true);
      const outcome = await this.runCaptured(code);
      if (!outcome.ran) {
        this.markCard(card, false, "Ruby engine failed to load");
        this.addBubble("ai", "The Ruby engine could not load (it needs an internet connection for a one-time download). Try again in a moment.");
        return;
      }
      if (!outcome.error) {
        this.markCard(card, true, "ran clean");
        this.setStatus("Done.");
        App.viewport.zoomExtents();
        return;
      }
      // errored — ask the model for a fix, up to MAX_FIXES times
      this.markCard(card, false, "errored");
      if (attempt >= this.MAX_FIXES) {
        this.addBubble("ai", "The script still errors after " + this.MAX_FIXES +
          " automatic fixes:<br><code>" + this.esc(outcome.error.split("\n")[0]) +
          "</code><br>Try describing the object differently, or simplify the request.");
        this.setStatus("");
        return;
      }
      this.setStatus("Script errored — asking the AI to fix it…");
      this.addBubble("ai muted", "That script hit an error (<code>" +
        this.esc(outcome.error.split("\n")[0]) + "</code>) — getting a corrected version…");
      this.history.push({
        role: "user",
        parts: [{ text: "Running that script raised this Ruby error:\n\n" + outcome.error + "\n\nPlease fix the script. Reply with a one-line explanation and ONE complete corrected ```ruby script." }],
      });
      const reply = await this.callModel();
      this.history.push({ role: "model", parts: [{ text: reply }] });
      const { prose, code: fixed } = this.splitReply(reply);
      if (prose) this.addBubble("ai", this.esc(prose));
      if (!fixed) {
        this.addBubble("ai", "The AI did not return a corrected script — try rephrasing the request.");
        this.setStatus("");
        return;
      }
      this.setBusy(false); // addScriptCard's autorun re-enters runWithAutoFix
      this.addScriptCard(fixed, { autorun: true, attempt: attempt + 1 });
      return;
    } catch (err) {
      this.handleError(err);
    } finally {
      if (this.busy) { this.setBusy(false); }
      if (this.el("ai-status").textContent.indexOf("…") >= 0) this.setStatus("");
    }
  },

  /* ---------- send a prompt ---------- */
  async send() {
    const input = this.el("ai-input");
    const text = input.value.trim();
    if (!text || this.busy) return;
    input.value = "";
    this.addBubble("user", this.esc(text));
    this.history.push({ role: "user", parts: [{ text }] });
    // keep the conversation from growing unbounded
    if (this.history.length > 24) this.history = this.history.slice(-24);
    this.setBusy(true);
    this.setStatus("Thinking…");
    try {
      const reply = await this.callModel();
      this.history.push({ role: "model", parts: [{ text: reply }] });
      const { prose, code } = this.splitReply(reply);
      if (prose) this.addBubble("ai", this.esc(prose));
      if (code) {
        this.addScriptCard(code);
        this.setStatus("Review the script, then press ▶ Run.");
      } else {
        this.setStatus("");
      }
    } catch (err) {
      this.handleError(err);
    } finally {
      this.setBusy(false);
    }
  },

  handleError(err) {
    const msg = err && err.message || String(err);
    if (msg === "SIGNIN") {
      this.addBubble("ai", "You need to be signed in to <b>Dooley's Hub</b> in this browser to use the AI assistant (that's what keeps the AI key off the internet). Open the Hub, sign in, then come back here and try again.");
    } else {
      this.addBubble("ai", "AI request failed: " + this.esc(msg));
    }
    this.setStatus("");
  },

  toggle(force) {
    const dock = this.el("ai-dock");
    const show = force !== undefined ? force : dock.classList.contains("hidden");
    dock.classList.toggle("hidden", !show);
    // the WebGL canvas must shrink to the new viewport width, or it keeps
    // covering (and stealing clicks from) the dock
    App.viewport.resize();
    if (show) this.el("ai-input").focus();
  },

  newChat() {
    this.history = [];
    this.el("ai-messages").innerHTML = "";
    this.greet();
  },

  greet() {
    this.addBubble("ai",
      "Describe what you want to build and I'll write a script for it — for example:<br>" +
      "<i>“a 12×16 ft gazebo with a hip roof”</i><br>" +
      "<i>“a workbench, 8 ft long, 36 inches tall, with a lower shelf”</i><br>" +
      "<i>“a set of 5 concrete steps, 48 inches wide, 7 inch rise”</i><br>" +
      "You'll see the script before anything runs, and if it errors I'll fix it automatically.");
  },

  init() {
    this.el("btn-ai-toggle").addEventListener("click", () => this.toggle());
    this.el("btn-ai-close").addEventListener("click", () => this.toggle(false));
    this.el("btn-ai-clear").addEventListener("click", () => this.newChat());
    this.el("btn-ai-send").addEventListener("click", () => this.send());
    this.el("ai-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.greet();
  },
};

window.addEventListener("DOMContentLoaded", () => AIAssistant.init());
