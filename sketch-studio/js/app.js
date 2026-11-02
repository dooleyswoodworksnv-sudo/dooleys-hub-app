/* ============================================================
 * app.js — application shell: menus, toolbar, keyboard
 * shortcuts, undo/redo, VCB (measurements box), file I/O,
 * paint palette, drag & drop of .rb scripts and models.
 * ============================================================ */
"use strict";

const App = {
  model: null,
  viewport: null,
  tools: null,
  undoStack: [],
  redoStack: [],
  activeContext: 0,      // container id of the group open for editing (0 = model)
  currentColor: "#cc4444",
  pluginMenuItems: [],   // { id, title }
  _menuId: 1,

  /* ================= init ================= */
  init() {
    if (typeof THREE === "undefined") {
      document.body.innerHTML = "<div style='padding:40px;font-family:sans-serif'><h2>Three.js failed to load</h2>" +
        "<p>Sketch Studio needs an internet connection the first time (Three.js and ruby.wasm load from a CDN).</p></div>";
      return;
    }
    this.model = new SUModel();
    this.viewport = new Viewport(document.getElementById("viewport"), this.model);
    this.tools = new ToolManager({ model: this.model, viewport: this.viewport, app: this });
    RubyConsole.init();

    this.buildMenus();
    this.buildToolbar();
    this.buildPalette();
    this.outliner.init();
    this.layers.init();
    // keep the outliner and layers panel in sync with model changes (debounced),
    // and drop the edit context if its group vanished (undo, clear, script rebuild)
    let outlinerTimer = null;
    let layersTimer = null;
    this.model.onChange(() => {
      if (this.activeContext && !this.model.containers.has(this.activeContext)) {
        this.activeContext = 0;
        this.viewport.setEditContext(0);
        this.updateContextHint();
      }
      if (!document.getElementById("layers-dock").classList.contains("hidden")) {
        clearTimeout(layersTimer);
        layersTimer = setTimeout(() => this.layers.render(), 250);
      }
      if (document.getElementById("outliner-dock").classList.contains("hidden")) return;
      clearTimeout(outlinerTimer);
      outlinerTimer = setTimeout(() => this.outliner.updateFromModel(), 250);
    });
    this.bindKeyboard();
    this.bindVCB();
    this.bindFileInputs();
    this.bindDragDrop();

    this.tools.activate("select");
    this.setHint("Ready. Draw with Line/Rectangle, extrude with Push/Pull, script it with the Ruby Console (💎).");

    // a starter slab so the space doesn't feel empty (8' x 6')
    this.model.addFace([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(96, 0, 0),
      new THREE.Vector3(96, 72, 0), new THREE.Vector3(0, 72, 0)
    ]);
    this.undoStack = [];
  },

  /* ================= status bar / VCB ================= */
  setHint(text) { document.getElementById("status-hint").textContent = text; },
  setVCB(label, value) {
    document.getElementById("vcb-label").textContent = label;
    const input = document.getElementById("vcb-input");
    if (document.activeElement !== input) input.value = value;
  },

  bindVCB() {
    const input = document.getElementById("vcb-input");
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        this.tools.vcbSubmit(input.value);
        input.value = "";
        input.blur();
      }
      if (e.key === "Escape") { input.value = ""; input.blur(); }
    });
  },

  /* ================= undo / redo ================= */
  pushUndo() { this.pushUndoSnapshot(this.model.toJSON()); },
  pushUndoSnapshot(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  },
  undo() {
    if (!this.undoStack.length) { this.setHint("Nothing to undo."); return; }
    this.redoStack.push(this.model.toJSON());
    this.model.loadJSON(this.undoStack.pop());
    this.viewport.setSelection([]);
  },
  redo() {
    if (!this.redoStack.length) { this.setHint("Nothing to redo."); return; }
    this.undoStack.push(this.model.toJSON());
    this.model.loadJSON(this.redoStack.pop());
    this.viewport.setSelection([]);
  },

  /* ================= selection rectangle overlay ================= */
  showSelectRect(x1, y1, x2, y2) {
    const el = document.getElementById("select-rect");
    const r = document.getElementById("viewport").getBoundingClientRect();
    el.classList.remove("hidden");
    el.style.left = (Math.min(x1, x2) - r.left) + "px";
    el.style.top = (Math.min(y1, y2) - r.top) + "px";
    el.style.width = Math.abs(x2 - x1) + "px";
    el.style.height = Math.abs(y2 - y1) + "px";
  },
  hideSelectRect() { document.getElementById("select-rect").classList.add("hidden"); },

  /* ================= toolbar ================= */
  buildToolbar() {
    document.querySelectorAll(".tool-btn").forEach(btn => {
      btn.addEventListener("click", () => this.tools.activate(btn.dataset.tool));
    });
    document.getElementById("btn-undo").addEventListener("click", () => this.undo());
    document.getElementById("btn-redo").addEventListener("click", () => this.redo());
    document.getElementById("btn-zoom-extents").addEventListener("click", () => this.viewport.zoomExtents());
    document.getElementById("btn-console-toggle").addEventListener("click", () => this.toggleConsole());
    document.getElementById("btn-outliner-toggle").addEventListener("click", () => this.toggleOutliner());
    document.getElementById("btn-layers-toggle").addEventListener("click", () => this.toggleLayers());
  },

  markActiveTool(name) {
    document.querySelectorAll(".tool-btn").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.tool === name));
  },

  /* ================= paint palette ================= */
  buildPalette() {
    const colors = [
      "#f6f6ef", "#d9d9d9", "#9e9e9e", "#5c5c5c", "#3a3a3a", "#1c1c1c",
      "#cc4444", "#e07b39", "#e8c547", "#7ba05b", "#4a8bbf", "#7d5ba6",
      "#8b5a2b", "#c49a6c", "#e8d5b7", "#b0c4b1", "#a3c6e8", "#e8b7c8",
      "#7f1d1d", "#9a3412", "#a16207", "#166534", "#1e3a8a", "#581c87"
    ];
    const wrap = document.getElementById("palette-swatches");
    colors.forEach(c => {
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener("click", () => {
        this.currentColor = c;
        wrap.querySelectorAll(".swatch").forEach(s => s.classList.remove("active"));
        sw.classList.add("active");
      });
      wrap.appendChild(sw);
    });
    wrap.firstChild && wrap.children[6].classList.add("active");
    document.getElementById("palette-color-input").addEventListener("input", e => {
      this.currentColor = e.target.value;
      wrap.querySelectorAll(".swatch").forEach(s => s.classList.remove("active"));
    });
  },
  showPalette(show) {
    document.getElementById("paint-palette").classList.toggle("hidden", !show);
  },

  /* ================= Ruby console dock ================= */
  toggleConsole(force) {
    const dock = document.getElementById("ruby-dock");
    const show = force !== undefined ? force : dock.classList.contains("hidden");
    dock.classList.toggle("hidden", !show);
    this.viewport.resize();
  },

  /* ================= make / explode groups ================= */
  makeGroup() {
    const sel = [...this.viewport.selection];
    if (!sel.length) {
      this.setHint("Nothing selected — select faces or groups first, then press G.");
      return;
    }
    const ctx = this.activeContext || 0;
    // loose entities at this level, and child groups covered by the selection
    const loose = sel.filter(id => { const e = this.model.getEntity(id); return e && e.cid === ctx; });
    const childCids = new Set();
    for (const id of sel) {
      const e = this.model.getEntity(id);
      if (!e || e.cid === ctx || !e.cid) continue;
      const res = this.model.resolveInContext(id, ctx);
      if (res && res.kind === "group") childCids.add(res.cid);
    }
    if (!loose.length && !childCids.size) {
      this.setHint("Selection has nothing groupable at this level.");
      return;
    }
    this.pushUndo();
    const cid = this.model.createContainer("Group", ctx);
    if (loose.length) this.model.groupEntitiesInto(cid, loose);
    for (const ccid of childCids) {
      const c = this.model.containers.get(ccid);
      if (c) c.parent = cid;   // nesting: grouping groups
    }
    this.model.changed();
    this.viewport.setSelection(this.model.entitiesInContainer(cid, true).map(e => e.id));
    this.outliner.updateFromModel();
    const parts = [loose.length && (loose.length + " entities"), childCids.size && (childCids.size + " groups")]
      .filter(Boolean).join(" + ");
    this.setHint("Group created from " + parts + " — double-click to edit it, or rename it in the Outliner.");
  },

  explodeSelection() {
    const sel = [...this.viewport.selection];
    if (!sel.length) { this.setHint("Select a group to explode."); return; }
    const res = this.model.resolveInContext(sel[0], this.activeContext || 0);
    if (!res || res.kind !== "group") { this.setHint("Selection is not a group."); return; }
    this.pushUndo();
    this.model.explodeContainer(res.cid);
    this.viewport.setSelection([]);
    this.outliner.updateFromModel();
    this.setHint("Group exploded — its contents now live one level up.");
  },

  /* ================= group edit context ================= */
  enterContext(cid) {
    if (!cid || !this.model.containers.has(cid)) return;
    this.activeContext = cid;
    this.viewport.setSelection([]);
    this.viewport.setEditContext(cid);
    this.updateContextHint();
    this.outliner.render();
  },

  exitContext() {
    if (!this.activeContext) return;
    const c = this.model.containers.get(this.activeContext);
    this.activeContext = c && c.parent && this.model.containers.has(c.parent) ? c.parent : 0;
    this.viewport.setSelection([]);
    this.viewport.setEditContext(this.activeContext);
    this.updateContextHint();
    this.outliner.render();
  },

  updateContextHint() {
    if (!this.activeContext) {
      this.setHint("Select: click selects a group, double-click opens it for editing.");
      return;
    }
    const names = [];
    let c = this.model.containers.get(this.activeContext);
    while (c) { names.unshift(c.name); c = this.model.containers.get(c.parent); }
    this.setHint("✏ Editing " + names.join(" ▸ ") +
      " — double-click deeper groups to drill in, Esc / double-click empty space to exit.");
  },

  /* ================= Outliner dock ================= */
  toggleOutliner(force) {
    const dock = document.getElementById("outliner-dock");
    const show = force !== undefined ? force : dock.classList.contains("hidden");
    dock.classList.toggle("hidden", !show);
    this.viewport.resize();
    if (show) this.outliner.refresh();
  },

  /* ================= Layers dock ================= */
  toggleLayers(force) {
    const dock = document.getElementById("layers-dock");
    const show = force !== undefined ? force : dock.classList.contains("hidden");
    dock.classList.toggle("hidden", !show);
    this.viewport.resize();
    if (show) this.layers.render();
  },

  layers: {
    hidden: new Set(),        // container names currently hidden

    init() {
      document.getElementById("btn-layers-close").addEventListener("click", () => App.toggleLayers(false));
      document.getElementById("btn-layers-all").addEventListener("click", () => {
        this.hidden.clear();
        this.apply();
        this.render();
      });
      try {
        JSON.parse(localStorage.getItem("sketchstudio.hiddenLayers") || "[]").forEach(n => this.hidden.add(n));
      } catch (e) { /* corrupt storage — start fresh */ }
      if (this.hidden.size) App.viewport.setHiddenLayerNames(this.hidden);
    },

    /* Distinct container names in the model, with counts */
    names() {
      const counts = new Map();
      for (const c of App.model.containers.values()) {
        const n = String(c.name || "Group");
        if (n.startsWith("<definition>")) continue;
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    },

    apply() {
      App.viewport.setHiddenLayerNames(this.hidden);
      try { localStorage.setItem("sketchstudio.hiddenLayers", JSON.stringify([...this.hidden])); } catch (e) { /* private mode */ }
    },

    render() {
      const list = document.getElementById("layers-list");
      list.innerHTML = "";
      const entries = this.names();
      if (!entries.length) {
        list.innerHTML = "<div class='layers-empty'>No groups yet — build something first (e.g. send a design from Dooley's Hub).</div>";
        return;
      }
      for (const [name, count] of entries) {
        const row = document.createElement("label");
        row.className = "layers-row" + (this.hidden.has(name) ? " layers-off" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !this.hidden.has(name);
        cb.addEventListener("change", () => {
          if (cb.checked) this.hidden.delete(name); else this.hidden.add(name);
          this.apply();
          row.classList.toggle("layers-off", !cb.checked);
        });
        const text = document.createElement("span");
        text.className = "layers-name";
        text.textContent = name;
        text.title = name;
        const badge = document.createElement("span");
        badge.className = "layers-count";
        badge.textContent = count;
        row.append(cb, text, badge);
        list.appendChild(row);
      }
    }
  },

  outliner: {
    data: [],                 // [{oid, name, parent, ids}] from the Ruby VM
    hiddenOids: new Set(),
    collapsed: new Set(),
    filter: "",

    init() {
      document.getElementById("btn-outliner-close").addEventListener("click", () => App.toggleOutliner(false));
      document.getElementById("btn-outliner-refresh").addEventListener("click", () => this.refresh());
      const filter = document.getElementById("outliner-filter");
      filter.addEventListener("input", () => { this.filter = filter.value.trim().toLowerCase(); this.render(); });
      filter.addEventListener("keydown", e => e.stopPropagation());
    },

    refresh() { this.updateFromModel(); },

    /* Build the tree from the model's containers (groups & component instances) */
    updateFromModel() {
      const m = App.model;
      const nodes = [];
      const byId = new Map();
      for (const c of m.containers.values()) {
        if (String(c.name).startsWith("<definition>")) continue;   // blueprints aren't placed geometry
        const parent = c.parent && m.containers.has(c.parent) ? c.parent : null;
        const n = { oid: c.id, name: c.name || "Group", parent, ids: [] };
        nodes.push(n);
        byId.set(c.id, n);
      }
      const push = (cid, id) => {
        let c = m.containers.get(cid);
        while (c) {
          const n = byId.get(c.id);
          if (n) n.ids.push(id);
          c = m.containers.get(c.parent);
        }
      };
      for (const e of m.edges.values()) if (e.cid) push(e.cid, e.id);
      for (const f of m.faces.values()) if (f.cid) push(f.cid, f.id);
      this.update(nodes);
    },

    update(nodes) {
      this.data = nodes;
      this.render();
    },

    liveIds(node) { return node.ids.filter(id => App.model.getEntity(id)); },
    children(oid) { return this.data.filter(n => n.parent === oid); },
    hasContent(node) {
      if (this.liveIds(node).length) return true;
      return this.children(node.oid).some(c => this.hasContent(c));
    },

    applyHidden() {
      const hidden = new Set();
      for (const n of this.data)
        if (this.hiddenOids.has(n.oid))
          for (const id of n.ids) hidden.add(id);
      App.viewport.hiddenIds = hidden;
      App.viewport.rebuild();
    },

    render() {
      const tree = document.getElementById("outliner-tree");
      tree.innerHTML = "";
      const matches = node =>
        !this.filter ||
        node.name.toLowerCase().includes(this.filter) ||
        this.children(node.oid).some(matches);

      const renderNode = (node, depth) => {
        if (!this.hasContent(node) || !matches(node)) return;
        const kids = this.children(node.oid).filter(k => this.hasContent(k) && matches(k));

        const row = document.createElement("div");
        row.className = "outliner-row" + (this.hiddenOids.has(node.oid) ? " o-hidden" : "");
        row.style.paddingLeft = (6 + depth * 14) + "px";

        const arrow = document.createElement("span");
        arrow.className = "o-arrow";
        arrow.textContent = kids.length ? (this.collapsed.has(node.oid) ? "▸" : "▾") : "▪";
        if (kids.length) arrow.addEventListener("click", e => {
          e.stopPropagation();
          this.collapsed.has(node.oid) ? this.collapsed.delete(node.oid) : this.collapsed.add(node.oid);
          this.render();
        });

        const eye = document.createElement("span");
        eye.className = "o-eye";
        eye.textContent = "👁";
        eye.title = "Show / hide";
        eye.addEventListener("click", e => {
          e.stopPropagation();
          this.hiddenOids.has(node.oid) ? this.hiddenOids.delete(node.oid) : this.hiddenOids.add(node.oid);
          this.applyHidden();
          this.render();
        });

        const label = document.createElement("span");
        label.className = "o-label";
        label.textContent = node.name;
        label.title = node.name + " (" + this.liveIds(node).length + " entities)";

        if (node.oid === App.activeContext) row.classList.add("ctx");
        row.append(arrow, eye, label);
        row.addEventListener("click", () => {
          App.viewport.setSelection(this.liveIds(node));
          tree.querySelectorAll(".outliner-row.sel").forEach(r => r.classList.remove("sel"));
          row.classList.add("sel");
        });
        row.addEventListener("dblclick", () => App.enterContext(node.oid));
        row.addEventListener("contextmenu", e => {
          e.preventDefault();
          const name = window.prompt("Group name:", node.name);
          if (name) {
            const c = App.model.containers.get(node.oid);
            if (c) { c.name = name; this.updateFromModel(); }
          }
        });
        tree.appendChild(row);
        if (!this.collapsed.has(node.oid)) kids.forEach(k => renderNode(k, depth + 1));
      };

      this.data.filter(n => !n.parent).forEach(n => renderNode(n, 0));
      if (!tree.children.length) {
        const d = document.createElement("div");
        d.className = "o-empty";
        d.textContent = this.data.length
          ? "No matches."
          : "No groups yet — run a Ruby script that creates groups.";
        tree.appendChild(d);
      }
    }
  },

  addPluginMenuItem(menuName, title) {
    const id = this._menuId++;
    this.pluginMenuItems.push({ id, title: (menuName && menuName !== "Plugins" ? menuName + " ▸ " : "") + title });
    return id;
  },

  openRubyFilePicker() { document.getElementById("file-open-ruby").click(); },

  loadRubyFile(name, code) {
    this.toggleConsole(true);
    RubyConsole.append("── Loading " + name + " ──", "info");
    RubyEngine.run(code, { echo: false });
  },

  /* ================= keyboard ================= */
  bindKeyboard() {
    window.addEventListener("keydown", e => {
      const t = e.target;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this.saveModel(); return; }
      // a bare Ctrl tap toggles copy in the Move tool (SketchUp behavior)
      if (e.key === "Control" && !e.repeat) { this.tools.key(e); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const toolKeys = {
        " ": "select", "l": "line", "r": "rect", "c": "circle",
        "a": "arc", "p": "pushpull", "m": "move", "q": "rotate",
        "s": "scale", "f": "offset", "t": "tape", "e": "eraser",
        "b": "paint", "o": "orbit", "h": "pan"
      };
      const key = e.key.toLowerCase();

      if (e.shiftKey && key === "z") { this.viewport.zoomExtents(); return; }
      if (key === "g" && !e.shiftKey) { e.preventDefault(); this.makeGroup(); return; }

      // digits & measurement characters route to the VCB (x, *, / for copy arrays)
      if (/^[\d.;,\-x*\/]$/i.test(e.key)) {
        const input = document.getElementById("vcb-input");
        input.focus();
        input.value = e.key;
        e.preventDefault();
        return;
      }

      if (toolKeys[key] !== undefined && !e.shiftKey) {
        e.preventDefault();
        this.tools.activate(toolKeys[key]);
        return;
      }
      this.tools.key(e);
    });
  },

  /* ================= menus ================= */
  menuDefs() {
    return {
      file: [
        { label: "New", shortcut: "", action: () => { if (confirm("Clear the current model?")) { this.pushUndo(); this.model.clear(); this.viewport.setSelection([]); } } },
        { label: "Open Model (.json)…", action: () => document.getElementById("file-open-model").click() },
        { label: "Save Model (.json)", shortcut: "Ctrl+S", action: () => this.saveModel() },
        { sep: true },
        { label: "Export OBJ…", action: () => this.download("model.obj", this.model.toOBJ()) }
      ],
      edit: [
        { label: "Undo", shortcut: "Ctrl+Z", action: () => this.undo() },
        { label: "Redo", shortcut: "Ctrl+Y", action: () => this.redo() },
        { sep: true },
        { label: "Make Group from Selection", shortcut: "G", action: () => this.makeGroup() },
        { label: "Explode Group", action: () => this.explodeSelection() },
        { sep: true },
        { label: "Delete Guides", action: () => { this.viewport.clearGuides(); this.setHint("All tape measure guides deleted."); } },
        { sep: true },
        { label: "Select All", action: () => this.viewport.setSelection([...this.model.edges.keys(), ...this.model.faces.keys()]) },
        { label: "Select None", shortcut: "Esc", action: () => this.viewport.setSelection([]) },
        { label: "Delete Selection", shortcut: "Del", action: () => { if (this.viewport.selection.size) { this.pushUndo(); this.model.eraseEntities([...this.viewport.selection]); this.viewport.setSelection([]); } } }
      ],
      camera: [
        { label: "Zoom Extents", shortcut: "Shift+Z", action: () => this.viewport.zoomExtents() },
        { sep: true },
        { label: "Iso View", action: () => this.viewport.setView("iso") },
        { label: "Top View", action: () => this.viewport.setView("top") },
        { label: "Front View", action: () => this.viewport.setView("front") },
        { label: "Right View", action: () => this.viewport.setView("right") },
        { label: "Back View", action: () => this.viewport.setView("back") },
        { label: "Left View", action: () => this.viewport.setView("left") }
      ],
      draw: [
        { label: "Line", shortcut: "L", action: () => this.tools.activate("line") },
        { label: "Rectangle", shortcut: "R", action: () => this.tools.activate("rect") },
        { label: "Circle", shortcut: "C", action: () => this.tools.activate("circle") },
        { label: "Arc", shortcut: "A", action: () => this.tools.activate("arc") }
      ],
      tools: [
        { label: "Select", shortcut: "Space", action: () => this.tools.activate("select") },
        { label: "Push/Pull", shortcut: "P", action: () => this.tools.activate("pushpull") },
        { label: "Move", shortcut: "M", action: () => this.tools.activate("move") },
        { label: "Rotate", shortcut: "Q", action: () => this.tools.activate("rotate") },
        { label: "Scale", shortcut: "S", action: () => this.tools.activate("scale") },
        { label: "Offset", shortcut: "F", action: () => this.tools.activate("offset") },
        { label: "Follow Me", action: () => this.tools.activate("followme") },
        { label: "Tape Measure", shortcut: "T", action: () => this.tools.activate("tape") },
        { label: "Paint Bucket", shortcut: "B", action: () => this.tools.activate("paint") },
        { label: "Eraser", shortcut: "E", action: () => this.tools.activate("eraser") },
        { sep: true },
        { label: "Orbit", shortcut: "O", action: () => this.tools.activate("orbit") },
        { label: "Pan", shortcut: "H", action: () => this.tools.activate("pan") }
      ],
      site: [
        { label: "New Site from Address…", action: () => Site.showNewSiteDialog() },
        { label: "Import Survey Points (CSV)…", action: () => Site.importCSV() },
        { sep: true },
        { label: "Sketch Footprint (floats above terrain)", action: () => Site.sketchFootprint() },
        { label: "Set Building Pad from Selected Face…", action: () => Site.padFromSelection() },
        { label: "Place Selection on Pad", action: () => Site.placeOnPad() },
        { label: "Drape Driveway from Selection…", action: () => Site.drapeFromSelection() },
        { label: "Reset Proposed Grade", action: () => Site.resetProposed() },
        { sep: true },
        { label: "Cut & Fill Report", action: () => Site.showReport() },
        { label: "Clear Site Terrain", action: () => Site.clearAll() }
      ],
      window: [
        { label: "Outliner", action: () => this.toggleOutliner() },
        { label: "Ruby Console", shortcut: "💎", action: () => this.toggleConsole() }
      ],
      extensions: (() => {
        const items = [
          { label: "Ruby Console", shortcut: "💎", action: () => this.toggleConsole() },
          { label: "Load Ruby Script…", action: () => this.openRubyFilePicker() },
          { label: "Load Ruby Script from URL…", action: () => this.loadRubyFromURL() },
          { sep: true },
          { label: "Install Extension (.rbz)…", action: () => this.openRbzFilePicker() },
          { label: "Install Extension from URL…", action: () => this.loadRbzFromURL() },
          { sep: true },
          { section: "Sample scripts" }
        ];
        for (const name of Object.keys(SAMPLE_SCRIPTS)) {
          items.push({ label: name, action: () => this.loadRubyFile(name, SAMPLE_SCRIPTS[name]) });
        }
        if (this.pluginMenuItems.length) {
          items.push({ sep: true }, { section: "Plugins (registered by scripts)" });
          for (const mi of this.pluginMenuItems) {
            items.push({ label: mi.title, action: () => RubyEngine.callMenuHandler(mi.id) });
          }
        }
        return items;
      })(),
      help: [
        { label: "Quick Reference (tools & shortcuts)", action: () => this.showHelp() },
        { label: "Ruby API Reference", action: () => this.showRubyHelp() },
        { label: "About Sketch Studio", action: () => this.showAbout() }
      ]
    };
  },

  buildMenus() {
    const dropdown = document.getElementById("menu-dropdown");
    let openMenu = null;

    const close = () => {
      dropdown.classList.add("hidden");
      document.querySelectorAll(".menu-root").forEach(m => m.classList.remove("open"));
      openMenu = null;
    };

    const open = rootEl => {
      const defs = this.menuDefs()[rootEl.dataset.menu] || [];
      dropdown.innerHTML = "";
      for (const item of defs) {
        if (item.sep) { const d = document.createElement("div"); d.className = "msep"; dropdown.appendChild(d); continue; }
        if (item.section) { const d = document.createElement("div"); d.className = "msection"; d.textContent = item.section; dropdown.appendChild(d); continue; }
        const d = document.createElement("div");
        d.className = "mi";
        d.innerHTML = "<span></span><span class='shortcut'></span>";
        d.firstChild.textContent = item.label;
        d.lastChild.textContent = item.shortcut || "";
        d.addEventListener("click", () => { close(); item.action && item.action(); });
        dropdown.appendChild(d);
      }
      const r = rootEl.getBoundingClientRect();
      dropdown.style.left = r.left + "px";
      dropdown.style.top = r.bottom + "px";
      dropdown.classList.remove("hidden");
      document.querySelectorAll(".menu-root").forEach(m => m.classList.remove("open"));
      rootEl.classList.add("open");
      openMenu = rootEl;
    };

    document.querySelectorAll(".menu-root").forEach(rootEl => {
      rootEl.addEventListener("click", e => {
        e.stopPropagation();
        openMenu === rootEl ? close() : open(rootEl);
      });
      rootEl.addEventListener("mouseenter", () => { if (openMenu && openMenu !== rootEl) open(rootEl); });
    });
    window.addEventListener("click", close);
    window.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  },

  /* ================= file I/O ================= */
  download(filename, text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },

  saveModel() {
    let text = this.model.toJSON();
    if (typeof Site !== "undefined" && Site.data) {
      const j = JSON.parse(text);
      j.site = Site.serialize();
      text = JSON.stringify(j);
    }
    this.download("model.skpjson.json", text);
    this.setHint("Model saved as model.skpjson.json" + (Site.data ? " (site terrain data included)" : ""));
  },

  loadModelText(text, name) {
    this.pushUndo();
    this.model.loadJSON(text);
    try {
      const j = JSON.parse(text);
      if (typeof Site !== "undefined") Site.restore(j.site || null);
    } catch (err) { /* older files have no site block */ }
    this.viewport.setSelection([]);
    this.viewport.zoomExtents();
    this.outliner.updateFromModel();
    this.setHint("Loaded " + name + (Site.data ? " — site terrain restored (Site ▸ Cut & Fill Report works)" : ""));
  },

  bindFileInputs() {
    document.getElementById("file-open-model").addEventListener("change", e => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then(text => {
        try { this.loadModelText(text, file.name); }
        catch (err) { alert("Could not load model: " + err.message); }
      });
      e.target.value = "";
    });
    document.getElementById("file-open-ruby").addEventListener("change", e => {
      for (const file of e.target.files) {
        file.text().then(code => this.loadRubyFile(file.name, code));
      }
      e.target.value = "";
    });
    document.getElementById("file-open-rbz").addEventListener("change", e => {
      for (const file of e.target.files) {
        file.arrayBuffer().then(buf => this.loadRbzFile(file.name, buf));
      }
      e.target.value = "";
    });
    document.getElementById("file-site-csv").addEventListener("change", e => {
      const file = e.target.files[0];
      if (file) file.text().then(text => Site.loadCSV(text, file.name));
      e.target.value = "";
    });
  },

  openRbzFilePicker() { document.getElementById("file-open-rbz").click(); },

  loadRbzFile(name, buffer) {
    this.toggleConsole(true);
    RubyConsole.append("── Installing extension " + name + " ──", "info");
    RubyEngine.installRbz(name, buffer);
  },

  loadRbzFromURL() {
    const url = window.prompt("URL of a .rbz extension to download and install:");
    if (!url) return;
    this.toggleConsole(true);
    RubyConsole.append("Downloading " + url + " …", "info");
    fetch(url)
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
      .then(buf => this.loadRbzFile(url.split("/").pop() || "extension.rbz", buf))
      .catch(err => RubyConsole.append("Download failed: " + err.message +
        " (the server must allow cross-origin requests)", "error"));
  },

  loadRubyFromURL() {
    const url = window.prompt("URL of a .rb script to download into the workspace:");
    if (!url) return;
    this.toggleConsole(true);
    RubyConsole.append("Downloading " + url + " …", "info");
    fetch(url)
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(code => this.loadRubyFile(url.split("/").pop() || "script.rb", code))
      .catch(err => RubyConsole.append("Download failed: " + err.message +
        " (the server must allow cross-origin requests)", "error"));
  },

  bindDragDrop() {
    let depth = 0;
    window.addEventListener("dragenter", e => { e.preventDefault(); depth++; document.body.classList.add("dragging-file"); });
    window.addEventListener("dragleave", e => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging-file"); } });
    window.addEventListener("dragover", e => e.preventDefault());
    window.addEventListener("drop", e => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove("dragging-file");
      for (const file of e.dataTransfer.files) {
        const name = file.name.toLowerCase();
        if (name.endsWith(".rb")) file.text().then(code => this.loadRubyFile(file.name, code));
        else if (name.endsWith(".rbz") || name.endsWith(".zip")) {
          file.arrayBuffer().then(buf => this.loadRbzFile(file.name, buf));
        }
        else if (name.endsWith(".json") || name.endsWith(".skpjson")) {
          file.text().then(text => this.loadModelText(text, file.name));
        }
      }
    });
  },

  /* ================= dialogs ================= */
  showDialog(title, bodyHTML) {
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-body").innerHTML = bodyHTML;
    document.getElementById("dialog-backdrop").classList.remove("hidden");
  },

  showHelp() {
    this.showDialog("Quick Reference", `
      <table>
        <tr><th>Tool</th><th>Key</th><th>How to use</th></tr>
        <tr><td>Select</td><td>Space</td><td>Click, Shift-click, or drag a box. Del erases.</td></tr>
        <tr><td>Line</td><td>L</td><td>Click points; closing a planar loop makes a face. Arrows lock axis.</td></tr>
        <tr><td>Rectangle</td><td>R</td><td>Two corner clicks. Type <code>48;36</code> + Enter for exact size.</td></tr>
        <tr><td>Circle</td><td>C</td><td>Center, then radius. Type a radius + Enter.</td></tr>
        <tr><td>Arc</td><td>A</td><td>Click start, end, then bow it out. Type a bulge + Enter, or <code>20s</code> to set segments.</td></tr>
        <tr><td>Follow Me</td><td></td><td>Select path edges, then click the profile face — it extrudes along the path with mitered corners.</td></tr>
        <tr><td>Push/Pull</td><td>P</td><td>Click a face, move, click. Type a distance + Enter.</td></tr>
        <tr><td>Move</td><td>M</td><td>Click entity, move, click. <b>Ctrl = copy</b>, then <code>x5</code> or <code>/5</code> multiplies. Arrow keys lock axis.</td></tr>
        <tr><td>Rotate</td><td>Q</td><td>Click center, reference point, then rotate. <b>Ctrl = copy</b>, then <code>x5</code>/<code>/5</code>. Type an angle + Enter.</td></tr>
        <tr><td>Scale</td><td>S</td><td>Drag a green grip — corners = uniform, sides = one axis. <b>Ctrl = about center</b>. Type <code>1.5</code> or <code>2,0.5</code> + Enter.</td></tr>
        <tr><td>Offset</td><td>F</td><td>Click a face, move in/out, click. Inward offset makes an inner face + ring — Push/Pull the ring for walls.</td></tr>
        <tr><td>Tape Measure</td><td>T</td><td>Click two points — adds a guide with the distance. Edit ▸ Delete Guides clears.</td></tr>
        <tr><td>Make Group</td><td>G</td><td>Wrap the selected faces/groups into a group.</td></tr>
        <tr><td>Paint</td><td>B</td><td>Pick a color, click faces.</td></tr>
        <tr><td>Eraser</td><td>E</td><td>Click or drag over edges/faces.</td></tr>
        <tr><td>Orbit / Pan</td><td>O / H</td><td>Middle-drag always orbits; Shift+middle pans; wheel zooms.</td></tr>
        <tr><td>Zoom Extents</td><td>Shift+Z</td><td>Frame the whole model.</td></tr>
        <tr><td>Undo / Redo</td><td>Ctrl+Z / Y</td><td>Every operation is undoable.</td></tr>
      </table>
      <p>Units are <b>inches</b> (like SketchUp). Lengths accept: <code>24</code>, <code>2'6"</code>,
      <code>1.5ft</code>, <code>30cm</code>, <code>150mm</code>, <code>2m</code>.
      Green dot = endpoint snap, cyan = midpoint, blue = on face, red = on edge,
      purple = tape measure guide (guide crossings snap like endpoints).</p>`);
  },

  showRubyHelp() {
    this.showDialog("Ruby API Reference (SketchUp-compatible)", `
      <p>Open the Ruby Console (💎), or load <code>.rb</code> files via
      <b>Extensions ▸ Load Ruby Script…</b>, drag &amp; drop, or from a URL. Units are <b>inches</b>,
      exactly like real SketchUp (<code>10.feet</code>, <code>2.m</code>, <code>30.cm</code> all convert).</p>
      <table>
        <tr><th>API</th><th>Notes</th></tr>
        <tr><td><code>Sketchup.active_model</code></td><td>the model</td></tr>
        <tr><td><code>model.entities / active_entities</code></td><td>geometry collection (Enumerable)</td></tr>
        <tr><td><code>entities.add_face(pts…)</code></td><td>points or an array of edges → Face</td></tr>
        <tr><td><code>entities.add_line(p1, p2)</code></td><td>→ Edge; closing loops auto-face</td></tr>
        <tr><td><code>entities.add_edges(pts…)</code></td><td>poly-line → [Edge]</td></tr>
        <tr><td><code>entities.add_circle(center, normal, r, segs)</code></td><td>→ [Edge], auto-faced</td></tr>
        <tr><td><code>face.pushpull(dist)</code></td><td>extrude along the normal</td></tr>
        <tr><td><code>face.material = [r,g,b] / "red" / "#aabbcc"</code></td><td>paint a face</td></tr>
        <tr><td><code>entities.erase_entities(…) / clear!</code></td><td>delete geometry</td></tr>
        <tr><td><code>entities.transform_entities(t, ents)</code></td><td>apply a Transformation</td></tr>
        <tr><td><code>Geom::Point3d / Vector3d / Transformation</code></td><td>translation, rotation, scaling, axes</td></tr>
        <tr><td><code>model.start_operation / commit_operation</code></td><td>one undo step</td></tr>
        <tr><td><code>model.selection</code></td><td>read / set the selection</td></tr>
        <tr><td><code>UI.messagebox / UI.inputbox</code></td><td>dialogs</td></tr>
        <tr><td><code>UI.menu("Plugins").add_item("X") { … }</code></td><td>adds a command under Extensions</td></tr>
      </table>
      <p>Groups are supported as flattened shims (<code>group.entities</code>,
      <code>group.transform!</code>, <code>group.erase!</code>). <code>puts</code> prints to this console.</p>`);
  },

  showAbout() {
    this.showDialog("About Sketch Studio", `
      <p><b>Sketch Studio</b> — a SketchUp-style 3D workspace that runs entirely in the browser.</p>
      <p>Rendering: Three.js · Scripting: real CRuby via <code>ruby.wasm</code> with a
      SketchUp-compatible API, so Ruby plugin scripts can be downloaded straight into the workspace.</p>
      <p>Geometry kernel: shared-vertex boundary representation with SketchUp behaviors —
      closed planar loops become faces, Push/Pull extrudes solids, erasing an edge erases its faces.</p>`);
  }
};

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("dialog-close").addEventListener("click", () =>
    document.getElementById("dialog-backdrop").classList.add("hidden"));
  document.getElementById("dialog-backdrop").addEventListener("click", e => {
    if (e.target.id === "dialog-backdrop") e.target.classList.add("hidden");
  });
  App.init();
});
window.App = App;
