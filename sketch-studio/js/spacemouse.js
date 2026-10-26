/* ============================================================
 * spacemouse.js — 3Dconnexion SpaceMouse support via WebHID.
 *
 * Mirrors the user's 3DxWare SketchUp profile:
 *   - Object Mode        (cap moves the MODEL; camera does the inverse)
 *   - Pan / Zoom + Rotation enabled, Dominant OFF (all axes at once)
 *   - Zoom Direction: Forward / Backward (push-pull cap = zoom)
 *   - Lock Horizon ON    (roll axis ignored; orbit = azimuth/elevation)
 *
 * Buttons: FIT → Zoom Extents, MENU → settings panel.
 * Works in Chrome/Edge (WebHID). Settings persist in localStorage.
 * ============================================================ */
"use strict";

const SpaceMouse = {
  device: null,
  ifaces: [],            // every opened HID interface of the device
  t: [0, 0, 0],          // raw translation counts (≈ ±350)
  r: [0, 0, 0],          // raw rotation counts
  buttons: 0,
  panel: null,
  _lastTime: 0,

  // user-tunable settings (mirrors the 3DxWare Advanced Settings panel)
  cfg: {
    enabled: true,
    panZoom: true,        // ☑ Pan / Zoom
    rotation: true,       // ☑ Rotation
    speed: 1.0,           // master speed
    invPanX: false,
    invPanY: false,
    invZoom: false,
    invYaw: false,
    invPitch: false
  },

  DEAD: 0.02,             // normalized deadzone
  FULL: 350,              // full cap deflection in HID counts

  /* ---------------- lifecycle ---------------- */
  init() {
    const btn = document.getElementById("btn-spacemouse");
    if (!btn) return;
    if (!navigator.hid) {
      btn.title = "WebHID not available — use Chrome or Edge";
      btn.disabled = true;
      return;
    }
    this.loadCfg();
    btn.addEventListener("click", () => this.device ? this.togglePanel() : this.connect(true));
    navigator.hid.addEventListener("connect", () => this.reconnect());
    navigator.hid.addEventListener("disconnect", e => {
      if (this.ifaces.some(d => d === e.device)) this.detach();
    });
    this.reconnect();                       // silent re-attach if permission was granted before
    requestAnimationFrame(ts => this.tick(ts));
  },

  isSpaceMouse(d) {
    return d.collections.some(c => c.usagePage === 0x01 && c.usage === 0x08) ||
           d.vendorId === 0x256f || d.vendorId === 0x046d;
  },

  async reconnect() {
    if (this.device) return;
    try {
      const devices = (await navigator.hid.getDevices()).filter(x => this.isSpaceMouse(x));
      if (devices.length) await this.attach(devices);
      else {
        // permission is per-website: a device granted on localhost is NOT
        // granted on the hosted copy (and vice versa) — prompt the user
        const btn = document.getElementById("btn-spacemouse");
        btn.title = "Click to connect your 3D mouse (browser permission is per-website)";
        btn.classList.add("attention");
      }
    } catch (err) { /* stay disconnected */ }
  },

  async connect(interactive) {
    try {
      const granted = await navigator.hid.requestDevice({
        filters: [{ usagePage: 0x01, usage: 0x08 }]   // multi-axis controller
      });
      if (!granted.length) {
        if (interactive) App.setHint("No 3D mouse selected.");
        return;
      }
      // granting one interface grants the whole physical device — re-query so
      // we pick up EVERY interface (wireless receivers expose several, and the
      // 6-axis data may come from a different one than the chooser returned)
      const all = (await navigator.hid.getDevices()).filter(x => this.isSpaceMouse(x));
      await this.attach(all.length ? all : granted);
    } catch (err) {
      App.setHint("3D mouse: " + err.message);
    }
  },

  /* open every matching HID interface and listen on all of them — receivers
   * like the 3Dconnexion Universal Receiver split axes/buttons across
   * interfaces, so attaching only the first one can yield zero motion data */
  async attach(devices) {
    const list = Array.isArray(devices) ? devices : [devices];
    this.ifaces = [];
    for (const device of list) {
      try {
        if (!device.opened) await device.open();
        device.addEventListener("inputreport", e => this.onReport(e));
        this.ifaces.push(device);
      } catch (err) { /* interface busy or protected — use the others */ }
    }
    if (!this.ifaces.length) {
      App.setHint("3D mouse: couldn't open " + (list[0] ? list[0].productName : "device") +
        " — another program may have it. Exit the 3Dconnexion tray app (3DxWare) and try again.");
      return;
    }
    this.device = this.ifaces[0];
    const btn = document.getElementById("btn-spacemouse");
    btn.classList.add("connected");
    btn.classList.remove("attention");
    btn.title = this.device.productName + " connected — click for settings";
    App.setHint("🖱 " + this.device.productName + " connected (" + this.ifaces.length +
      (this.ifaces.length > 1 ? " interfaces" : " interface") +
      "). FIT button = Zoom Extents, MENU button = settings.");
  },

  detach() {
    this.device = null;
    this.ifaces = [];
    this._lastReport = null;
    this.t = [0, 0, 0]; this.r = [0, 0, 0]; this.buttons = 0;
    const btn = document.getElementById("btn-spacemouse");
    btn.classList.remove("connected");
    btn.title = "Connect 3Dconnexion SpaceMouse (WebHID)";
    App.setHint("3D mouse disconnected.");
  },

  /* ---------------- HID input ---------------- */
  onReport(e) {
    const d = e.data;
    let hex = "";
    for (let i = 0; i < Math.min(d.byteLength, 12); i++) {
      hex += d.getUint8(i).toString(16).padStart(2, "0") + " ";
    }
    this._lastReport = "id " + e.reportId + " · " + d.byteLength + "B [" + hex.trim() + "]";
    if (e.reportId === 1) {
      if (d.byteLength >= 12) {           // combined 6-axis report
        this.t = [d.getInt16(0, true), d.getInt16(2, true), d.getInt16(4, true)];
        this.r = [d.getInt16(6, true), d.getInt16(8, true), d.getInt16(10, true)];
      } else if (d.byteLength >= 6) {
        this.t = [d.getInt16(0, true), d.getInt16(2, true), d.getInt16(4, true)];
      }
    } else if (e.reportId === 2 && d.byteLength >= 6) {
      this.r = [d.getInt16(0, true), d.getInt16(2, true), d.getInt16(4, true)];
    } else if (e.reportId === 3) {
      let bits = 0;
      for (let i = 0; i < Math.min(d.byteLength, 4); i++) bits |= d.getUint8(i) << (i * 8);
      this.onButtons(bits);
    }
  },

  onButtons(bits) {
    const pressed = bits & ~this.buttons;   // rising edges only
    this.buttons = bits;
    if (!App.viewport) return;
    if (pressed & 0b01) this.togglePanel();          // MENU (left)
    if (pressed & 0b10) App.viewport.zoomExtents();  // FIT (right)
  },

  /* normalized axis with deadzone + quadratic response for fine control */
  axis(raw) {
    let v = raw / this.FULL;
    if (Math.abs(v) < this.DEAD) return 0;
    return v * Math.abs(v);
  },

  /* ---------------- per-frame navigation ---------------- */
  tick(ts) {
    requestAnimationFrame(t2 => this.tick(t2));
    const dt = Math.min((ts - this._lastTime) / 1000, 0.1) || 0.016;
    this._lastTime = ts;
    if (this.panel) {
      const sig = this.panel.querySelector("#sm-signal");
      if (sig) {
        sig.textContent = this.device
          ? "T " + this.t.join(", ") + "  R " + this.r.join(", ") +
            (this._lastReport
              ? "  (" + this._lastReport + ")"
              : "  — no data on " + this.ifaces.length + " interface(s). If moving the cap " +
                "changes nothing here, the 3Dconnexion driver has the device: right-click its " +
                "tray icon, Exit, then unplug/replug the receiver and reload this page.")
          : "not connected — close this panel and click the 3D Mouse button";
      }
    }
    if (!this.device || !this.cfg.enabled || !window.App || !App.viewport) return;

    const vp = App.viewport, c = this.cfg;
    const k = dt * 60 * c.speed;            // normalize to 60 fps units

    if (c.panZoom) {
      /* Object Mode pan: cap right → model right, cap up → model up.
       * panBy() moves the scene WITH the given screen-pixel delta. */
      const px = this.axis(this.t[0]) * (c.invPanX ? -1 : 1);
      const py = this.axis(this.t[2]) * (c.invPanY ? -1 : 1);   // TZ: cap pressed down = +
      if (px || py) vp.panBy(px * 9 * k, py * 9 * k);

      /* Zoom Direction: Forward / Backward — matches SketchUp's object-mode
       * default: pull cap toward you = zoom in. Dolly toward the orbit target. */
      const vz = this.axis(this.t[1]) * (c.invZoom ? 1 : -1);
      if (vz) {
        const factor = Math.exp(vz * 0.025 * k);
        const dist = vp.camera.position.distanceTo(vp.target);
        if (!(factor < 1 && dist < 2)) {
          vp.camera.position.lerp(vp.target, 1 - factor);
          vp.camera.lookAt(vp.target);
        }
      }
    }

    if (c.rotation) {
      /* Lock Horizon: twist (RZ) = azimuth, tilt (RX) = elevation, roll ignored.
       * orbitBy() takes screen-pixel deltas (0.006 rad/px). */
      const yaw = this.axis(this.r[2]) * (c.invYaw ? -1 : 1);
      const pitch = this.axis(this.r[0]) * (c.invPitch ? -1 : 1);
      if (yaw || pitch) vp.orbitBy(yaw * 6 * k, pitch * 6 * k);
    }
  },

  /* ---------------- settings panel ---------------- */
  togglePanel() {
    if (this.panel) { this.panel.remove(); this.panel = null; return; }
    const p = document.createElement("div");
    p.className = "floating-panel";
    p.id = "spacemouse-panel";
    const chk = (id, label, val) =>
      `<label class="sm-row"><input type="checkbox" id="sm-${id}" ${val ? "checked" : ""}> ${label}</label>`;
    p.innerHTML = `
      <div class="panel-title">🖱 3D Mouse — ${this.device ? this.device.productName : "not connected"}</div>
      <div class="sm-body">
        <div class="sm-section">Navigation</div>
        ${chk("panZoom", "Pan / Zoom", this.cfg.panZoom)}
        ${chk("rotation", "Rotation", this.cfg.rotation)}
        <div class="sm-section">Speed</div>
        <input type="range" id="sm-speed" min="0.2" max="3" step="0.1" value="${this.cfg.speed}">
        <div class="sm-section">Invert</div>
        ${chk("invPanX", "Pan left / right", this.cfg.invPanX)}
        ${chk("invPanY", "Pan up / down", this.cfg.invPanY)}
        ${chk("invZoom", "Zoom (push / pull)", this.cfg.invZoom)}
        ${chk("invYaw", "Spin (twist cap)", this.cfg.invYaw)}
        ${chk("invPitch", "Tilt (lean cap)", this.cfg.invPitch)}
        <div class="sm-section">Signal (move the cap to test)</div>
        <div class="sm-note" id="sm-signal" style="font-family:monospace">waiting…</div>
        <div class="sm-note">Object Mode · Lock Horizon on · zoom = forward/backward.<br>
        Buttons: MENU = this panel, FIT = zoom extents.</div>
      </div>`;
    document.getElementById("viewport-container").appendChild(p);
    this.panel = p;
    for (const id of ["panZoom", "rotation", "invPanX", "invPanY", "invZoom", "invYaw", "invPitch"]) {
      p.querySelector("#sm-" + id).addEventListener("change", e => {
        this.cfg[id] = e.target.checked;
        this.saveCfg();
      });
    }
    p.querySelector("#sm-speed").addEventListener("input", e => {
      this.cfg.speed = parseFloat(e.target.value);
      this.saveCfg();
    });
  },

  loadCfg() {
    try {
      const saved = JSON.parse(localStorage.getItem("sketchstudio.spacemouse") || "{}");
      Object.assign(this.cfg, saved);
    } catch (err) { /* defaults */ }
  },
  saveCfg() {
    localStorage.setItem("sketchstudio.spacemouse", JSON.stringify(this.cfg));
  }
};

window.addEventListener("DOMContentLoaded", () => SpaceMouse.init());
window.SpaceMouse = SpaceMouse;
