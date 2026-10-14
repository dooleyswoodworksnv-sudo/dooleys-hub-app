/* ============================================================
 * site.js — automated site modeling: address → USGS terrain,
 * building pad grading, and grid-method cut & fill analysis.
 *
 * Data model: two heightfields (existing / proposed) on a regular
 * grid, in feet. Terrain solids are generated watertight from the
 * fields; volumes come from the fields directly (grid method),
 * never from boolean solids.
 * ============================================================ */
"use strict";

/* Footprint sketcher: a rectangle tool locked to a horizontal plane floating
 * above the terrain, with dashed drop-lines showing where the corners land.
 * Sketching ON the undulating terrain buries the rectangle and makes it
 * unpickable — floating above it is how the pros do it (then drape/grade). */
class SiteSketchTool extends Tool {
  activate() {
    this.basis = null;
    this.a = 0; this.b = 0;
    this.hint("Footprint: click the first corner — the yellow sketch floats above the terrain. Type 40,60 + Enter for a 40×60 ft footprint.");
    this.vcb("Dimensions", "");
  }
  cursor() { return "crosshair"; }
  plane() { return new THREE.Plane(new THREE.Vector3(0, 0, 1), -Site.sketchZ()); }
  pt(x, y) { return this.vp.pickPlane(x, y, this.plane()); }

  corners() {
    const o = this.basis;
    return [
      o.clone(),
      o.clone().add(new THREE.Vector3(this.a, 0, 0)),
      o.clone().add(new THREE.Vector3(this.a, this.b, 0)),
      o.clone().add(new THREE.Vector3(0, this.b, 0))
    ];
  }

  onMove(e, x, y) {
    this.vp.clearPreview();
    const p = this.pt(x, y);
    if (!p) return;
    // drop-line under the cursor so you always see where you are on the land
    const gz = Site.terrainZAt(p.x, p.y);
    if (gz !== null) this.vp.previewDashedLine(p, new THREE.Vector3(p.x, p.y, gz), 0xe0a010);
    this.vp.showSnapMarker(p, "ground");
    if (!this.basis) return;
    this.a = p.x - this.basis.x;
    this.b = p.y - this.basis.y;
    this.vp.previewLoop(this.corners(), 0xe0a010);
    for (const c of this.corners()) {
      const cz = Site.terrainZAt(c.x, c.y);
      if (cz !== null) this.vp.previewDashedLine(c, new THREE.Vector3(c.x, c.y, cz), 0xe0a010);
    }
    this.vcb("Dimensions", fmtLen(Math.abs(this.a)) + " × " + fmtLen(Math.abs(this.b)));
  }

  onDown(e, x, y) {
    const p = this.pt(x, y);
    if (!p) return;
    if (!this.basis) {
      this.basis = p;
      this.hint("Footprint: click the opposite corner, or type 40,60 + Enter.");
    } else {
      this.commit();
    }
  }

  commit() {
    if (Math.abs(this.a) < SU_EPS || Math.abs(this.b) < SU_EPS) return;
    this.app.pushUndo();
    const f = this.model.addFace(this.corners(), "#e8c547", 0);
    Site.lastSketch = f ? f.id : null;
    if (f) this.vp.setSelection([f.id]);
    this.basis = null;
    this.vp.clearPreview();
    this.hint("Footprint placed & selected — now Site ▸ Set Building Pad or Drape Driveway.");
  }

  onVCB(text) {
    // at site scale a bare "40,60" means FEET; explicit units still work (40', 480", 12m)
    const asLen = s => /[a-z"']/i.test(s) ? parseLen(s) : (Number.isFinite(parseFloat(s)) ? parseFloat(s) * 12 : null);
    const p = text.split(/[;,x]/i).map(s => asLen(s.trim()));
    if (this.basis && p.length === 2 && p[0] !== null && p[1] !== null) {
      this.a = (this.a < 0 ? -1 : 1) * p[0];
      this.b = (this.b < 0 ? -1 : 1) * p[1];
      this.commit();
    }
  }
  onKey(e) { if (e.key === "Escape") { this.basis = null; this.vp.clearPreview(); this.hint("Footprint: click the first corner."); } }
  cancel() { this.basis = null; super.cancel(); }
}

/* Sutherland–Hodgman: clip an arbitrary polygon against a CONVEX polygon */
function clipPolyConvex(subject, clip) {
  const sign = polyArea2(clip) >= 0 ? 1 : -1;
  let out = subject.slice();
  for (let e = 0; e < clip.length && out.length; e++) {
    const a = clip[e], b = clip[(e + 1) % clip.length];
    const input = out;
    out = [];
    const side = p => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    for (let k = 0; k < input.length; k++) {
      const P = input[k], Q = input[(k + 1) % input.length];
      const sp = side(P), sq = side(Q);
      if (sp >= 0) out.push(P);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]);
      }
    }
  }
  return out;
}

/* Interpolate z at 2D point p inside triangle t (2D verts) with corner heights z */
function triBaryZ(p, t, z) {
  const [A, B, C] = t;
  const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
  if (Math.abs(det) < 1e-12) return z[0];
  const l1 = ((B[1] - C[1]) * (p[0] - C[0]) + (C[0] - B[0]) * (p[1] - C[1])) / det;
  const l2 = ((C[1] - A[1]) * (p[0] - C[0]) + (A[0] - C[0]) * (p[1] - C[1])) / det;
  return l1 * z[0] + l2 * z[1] + (1 - l1 - l2) * z[2];
}

const Site = {
  data: null,          // { addr, lat, lon, n, spacingFt, datumFt, existing, proposed, cidExisting, cidProposed }
  TRUCK_YD3: 12,       // tandem dump truck
  SLOPE_RATIO: 3,      // 3:1 horizontal:vertical transition slopes
  SWELL: 1.25,         // bank → loose volume factor for hauling

  /* =================== save / load =================== */
  serialize() {
    const d = this.data;
    if (!d) return null;
    return {
      addr: d.addr, loc: d.loc, n: d.n, spacingFt: d.spacingFt, datumFt: d.datumFt,
      existing: Array.from(d.existing), proposed: Array.from(d.proposed),
      pads: d.pads, driveways: d.driveways,
      cidExisting: d.cidExisting, cidProposed: d.cidProposed
    };
  },

  restore(s) {
    if (!s) { this.data = null; return; }
    this.data = {
      addr: s.addr, loc: s.loc, n: s.n, spacingFt: s.spacingFt, datumFt: s.datumFt,
      existing: Float64Array.from(s.existing), proposed: Float64Array.from(s.proposed),
      pads: s.pads || [], driveways: s.driveways || [],
      cidExisting: s.cidExisting || 0, cidProposed: s.cidProposed || 0
    };
    // the terrain geometry itself comes back with the model's containers
    if (!App.model.containers.has(this.data.cidExisting)) this.data.cidExisting = 0;
    if (!App.model.containers.has(this.data.cidProposed)) this.data.cidProposed = 0;
    for (const dw of this.data.driveways)
      if (!App.model.containers.has(dw.cid)) dw.cid = 0;
    // restored terrain renders softened, same as freshly built
    for (const cid of [this.data.cidExisting, this.data.cidProposed,
                       ...this.data.driveways.map(w => w.cid)])
      if (cid) App.viewport.softCids.add(cid);
    App.viewport.rebuild();
  },

  /* =================== New site dialog =================== */
  showNewSiteDialog() {
    App.showDialog("New Site from Address", `
      <p>Builds the <b>existing grade</b> terrain from free USGS 3DEP elevation data
      (about 1&nbsp;m resolution where available). US addresses only. Good for
      pre-bid estimates — survey data is still king for construction numbers.</p>
      <table>
        <tr><th style="width:110px">Address</th>
            <td><input id="site-addr" style="width:100%;padding:4px" placeholder="1234 W 44th Ave, Golden, CO — or paste 39.83111, -105.13001">
            <div style="color:#888;font-size:11px;margin-top:3px">New lot not mapped yet? Right-click it in Google Maps, copy the coordinates, paste them here.</div></td></tr>
        <tr><th>Site size</th>
            <td><input id="site-size" value="150" size="5" style="padding:3px"> ft square, centered on the point
            <div style="color:#888;font-size:11px;margin-top:3px">1 ac ≈ 209 ft · 5 ac ≈ 467 ft · 10 ac ≈ 660 ft · 40 ac ≈ 1320 ft (square parcels)</div></td></tr>
        <tr><th>Grid spacing</th>
            <td><input id="site-spacing" value="10" size="5" style="padding:3px"> ft — auto-coarsened on big sites to keep the model fast</td></tr>
      </table>
      <p id="site-progress" style="color:#666;min-height:18px"></p>
      <p><button id="site-go" style="padding:6px 20px;background:#3d7a4f;color:#fff;border:none;border-radius:4px;cursor:pointer">Build Terrain</button>
      <span style="color:#888;font-size:11px;margin-left:10px">usually just a few seconds</span></p>`);
    document.getElementById("site-go").addEventListener("click", () => this.buildFromAddress());
    document.getElementById("site-addr").focus();
  },

  progress(msg) {
    const el = document.getElementById("site-progress");
    if (el) el.textContent = msg;
    App.setHint(msg);
  },

  async buildFromAddress() {
    const addr = document.getElementById("site-addr").value.trim();
    const sizeFt = parseFloat(document.getElementById("site-size").value) || 150;
    const spacingFt = Math.max(2, parseFloat(document.getElementById("site-spacing").value) || 10);
    if (!addr) { this.progress("Enter an address first."); return; }
    const btn = document.getElementById("site-go");
    btn.disabled = true;
    try {
      // cap the grid at 61×61 so the model stays responsive — coarsen the
      // spacing automatically on large parcels
      const MAXN = 61;
      let spacing = spacingFt;
      let n = Math.max(4, Math.round(sizeFt / spacing)) + 1;
      if (n > MAXN) {
        spacing = Math.ceil(sizeFt / (MAXN - 1));
        n = Math.max(4, Math.round(sizeFt / spacing)) + 1;
      }
      this.progress("Geocoding address…");
      const loc = await this.geocode(addr);
      this.progress(`Found: ${loc.name}` +
        (spacing !== spacingFt ? ` — large site, grid spacing bumped to ${spacing} ft` : "") +
        " — fetching USGS elevations…");
      const field = await this.fetchGrid(loc.lat, loc.lon, n, spacing);
      this.buildSite(addr, loc, n, spacing, field);
      document.getElementById("dialog-backdrop").classList.add("hidden");
      App.viewport.zoomExtents();
      const relief = (Math.max(...field) - Math.min(...field)).toFixed(1);
      App.setHint(`Existing terrain built — ${n}×${n} grid, ${relief} ft of relief. ` +
        `Draw a pad footprint and use Site ▸ Set Building Pad, then Site ▸ Cut & Fill Report.`);
    } catch (err) {
      this.progress("Failed: " + err.message);
      if (btn) btn.disabled = false;
    }
  },

  /* JSONP — the Census geocoder blocks CORS but supports script callbacks */
  jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = "siteGeoCb" + Math.floor(Math.random() * 1e9);
      const s = document.createElement("script");
      window[cb] = data => { delete window[cb]; s.remove(); resolve(data); };
      s.onerror = () => { delete window[cb]; s.remove(); reject(new Error("unreachable")); };
      s.src = url + "&callback=" + cb;
      document.head.appendChild(s);
      setTimeout(() => { if (window[cb]) { window[cb] = () => {}; s.remove(); reject(new Error("timeout")); } }, 10000);
    });
  },

  /* Tiered: pasted lat,lon → US Census (best for street addresses, incl. newer
   * construction) → Nominatim (POIs, roads, towns) → Photon (fuzzy). */
  async geocode(addr) {
    // escape hatch: paste coordinates straight from Google Maps (right-click a lot → copy)
    const ll = /^\s*(-?\d{1,3}\.?\d*)\s*,\s*(-?\d{1,3}\.?\d*)\s*$/.exec(addr);
    if (ll) {
      const lat = parseFloat(ll[1]), lon = parseFloat(ll[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        return { lat, lon, name: "coordinates " + lat.toFixed(5) + ", " + lon.toFixed(5) };
    }
    try {
      const j = await this.jsonp("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=" +
        encodeURIComponent(addr) + "&benchmark=Public_AR_Current&format=jsonp");
      const m = j.result && j.result.addressMatches && j.result.addressMatches[0];
      if (m) return { lat: m.coordinates.y, lon: m.coordinates.x, name: m.matchedAddress + " (Census)" };
    } catch (e) { /* fall through */ }
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" +
        encodeURIComponent(addr));
      if (r.ok) {
        const j = await r.json();
        if (j.length) return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), name: j[0].display_name.split(",").slice(0, 3).join(",") + " (OSM)" };
      }
    } catch (e) { /* fall through */ }
    try {
      const r = await fetch("https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(addr));
      if (r.ok) {
        const j = await r.json();
        const f = j.features && j.features[0];
        if (f) {
          const p = f.properties;
          return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
            name: [p.name || p.street, p.city, p.state].filter(Boolean).join(", ") + " (Photon)" };
        }
      }
    } catch (e) { /* fall through */ }
    throw new Error("address not found in any geocoder. New-construction lots often aren't mapped yet — " +
      "right-click the lot in Google Maps, copy the coordinates, and paste them here (e.g. 39.83111, -105.13001).");
  },

  /* Fetch an n×n grid of elevations (feet) centered on lat/lon.
   * Bulk queries against the 3DEP ImageServer (≈400 points/request,
   * order-preserving), EPQS single-point fallback for gaps, hard
   * timeouts so one stuck request can never hang the build. */
  async fetchGrid(lat, lon, n, spacingFt) {
    const ftPerDegLat = 364567;                       // ~69.05 miles
    const ftPerDegLon = ftPerDegLat * Math.cos(lat * Math.PI / 180);
    const half = (n - 1) / 2;
    const coords = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        coords.push([lon + (i - half) * spacingFt / ftPerDegLon, lat + (j - half) * spacingFt / ftPerDegLat]);
    const field = new Float64Array(n * n).fill(NaN);
    const total = coords.length;
    let done = 0;

    const timedFetch = (url, opts, ms) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      return fetch(url, Object.assign({ signal: ctl.signal }, opts)).finally(() => clearTimeout(timer));
    };

    const CHUNK = 400;
    const fetchChunk = async start => {
      const pts = coords.slice(start, start + CHUNK);
      for (let attempt = 0; attempt < 2 && Number.isNaN(field[start]); attempt++) {
        try {
          const body = new URLSearchParams({
            geometry: JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }),
            geometryType: "esriGeometryMultipoint", returnFirstValueOnly: "true", f: "json"
          });
          const r = await timedFetch(
            "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples",
            { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }, 25000);
          const j = await r.json();
          const samples = j.samples || [];
          if (samples.length === pts.length) {
            for (let k = 0; k < samples.length; k++) {
              const m = parseFloat(samples[k].value);
              if (Number.isFinite(m) && m > -3000) field[start + k] = m * 3.28084;   // meters → feet
            }
          } else {
            // length mismatch: map samples back by location
            for (const s of samples) {
              const m = parseFloat(s.value);
              if (!Number.isFinite(m) || m <= -3000) continue;
              for (let k = 0; k < pts.length; k++)
                if (Math.abs(pts[k][0] - s.location.x) < 1e-9 && Math.abs(pts[k][1] - s.location.y) < 1e-9) {
                  field[start + k] = m * 3.28084;
                  break;
                }
            }
          }
        } catch (e) { /* retry, then EPQS fallback */ }
      }
      done += pts.length;
      this.progress(`Fetching USGS elevations… ${Math.min(done, total)} / ${total}`);
    };

    // limited concurrency so we're polite to the USGS server
    const starts = [];
    for (let s = 0; s < total; s += CHUNK) starts.push(s);
    const workers = Array.from({ length: Math.min(4, starts.length) }, async () => {
      while (starts.length) await fetchChunk(starts.shift());
    });
    await Promise.all(workers);

    // per-point fallback for whatever the bulk service missed
    const missing = [];
    for (let k = 0; k < field.length; k++) if (Number.isNaN(field[k])) missing.push(k);
    if (missing.length && missing.length <= 300) {
      this.progress(`Filling ${missing.length} gaps from EPQS…`);
      await Promise.all(missing.map(async k => {
        try {
          const r = await timedFetch(
            `https://epqs.nationalmap.gov/v1/json?x=${coords[k][0]}&y=${coords[k][1]}&units=Feet&wkid=4326&includeDate=false`,
            {}, 12000);
          const v = (await r.json()).value;
          if (typeof v === "number" && v > -11000) field[k] = v;
        } catch (e) { /* neighbor patch below */ }
      }));
    }

    // patch remaining small holes from neighbors (multi-pass grows inward)
    for (let pass = 0; pass < 8; pass++) {
      let patched = 0, bad = 0;
      for (let k = 0; k < field.length; k++) {
        if (!Number.isNaN(field[k])) continue;
        const i = k % n, j = (k - i) / n;
        const nb = [];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii >= 0 && ii < n && jj >= 0 && jj < n && !Number.isNaN(field[jj * n + ii])) nb.push(field[jj * n + ii]);
        }
        if (nb.length) { field[k] = nb.reduce((a, b) => a + b) / nb.length; patched++; }
        else bad++;
      }
      if (!bad) break;
      if (!patched) throw new Error(bad + " grid points had no elevation data (outside USGS coverage?)");
    }
    return field;
  },

  /* =================== survey CSV import =================== */
  importCSV() {
    document.getElementById("file-site-csv").click();
  },

  loadCSV(text, name) {
    // rows of x,y,z in FEET (surveyor local coordinates); header row optional
    const pts = [];
    for (const line of text.split(/\r?\n/)) {
      const c = line.split(/[,;\t]/).map(s => parseFloat(s));
      if (c.length >= 3 && c.slice(0, 3).every(Number.isFinite)) pts.push(c.slice(0, 3));
    }
    if (pts.length < 3) { App.setHint("No x,y,z rows found in " + name + " — expected feet, comma separated."); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    const span = Math.max(maxX - minX, maxY - minY);
    if (span < 1) { App.setHint("Survey points span less than a foot — are the units feet?"); return; }
    const spacingFt = Math.max(1, Math.round(span / 40));
    const n = Math.round(span / spacingFt) + 1;
    // inverse-distance-weighted interpolation with a bucket hash
    const cell = spacingFt * 2;
    const buckets = new Map();
    const bkey = (x, y) => Math.floor(x / cell) + "_" + Math.floor(y / cell);
    for (const p of pts) {
      const k = bkey(p[0], p[1]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    }
    const field = new Float64Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const gx = minX + i * spacingFt, gy = minY + j * spacingFt;
        let num = 0, den = 0, ring = 1;
        while (den === 0 && ring < 40) {
          const cx = Math.floor(gx / cell), cy = Math.floor(gy / cell);
          for (let bx = cx - ring; bx <= cx + ring; bx++)
            for (let by = cy - ring; by <= cy + ring; by++)
              for (const p of buckets.get(bx + "_" + by) || []) {
                const d2 = (p[0] - gx) ** 2 + (p[1] - gy) ** 2;
                const w = 1 / Math.max(d2, 1e-6);
                num += p[2] * w; den += w;
              }
          ring++;
        }
        field[j * n + i] = den ? num / den : pts[0][2];
      }
    this.buildSite(name, null, n, spacingFt, field);
    App.viewport.zoomExtents();
    App.setHint(`Survey terrain built from ${pts.length} points — ${n}×${n} grid at ${spacingFt} ft spacing.`);
  },

  /* =================== terrain geometry =================== */
  buildSite(addr, loc, n, spacingFt, field) {
    App.pushUndo();
    if (this.data) this.clearAll(true);
    const datumFt = Math.floor(Math.min(...field));
    this.data = {
      addr, loc, n, spacingFt, datumFt,
      existing: Float64Array.from(field),
      proposed: Float64Array.from(field),
      pads: [],
      driveways: [],
      cidExisting: 0, cidProposed: 0
    };
    this.data.cidExisting = this.buildTerrain("existing");
    App.outliner && App.outliner.updateFromModel && App.outliner.updateFromModel();
  },

  /* Build one watertight terrain solid from a heightfield. Returns cid. */
  buildTerrain(kind) {
    const d = this.data;
    const m = App.model;
    const field = kind === "existing" ? d.existing : d.proposed;
    const name = kind === "existing" ? "Existing Site" : "Proposed Site";
    const cid = m.createContainer(name, 0);
    App.viewport.softCids.add(cid);   // before the batch ends and triggers the render
    const sp = d.spacingFt * 12;                       // inches
    const zOf = k => (field[k] - d.datumFt) * 12;
    const baseZ = -24;                                 // 2 ft below datum → closed solid
    const P = (i, j) => new THREE.Vector3(i * sp, j * sp, zOf(j * d.n + i));
    const B = (i, j) => new THREE.Vector3(i * sp, j * sp, baseZ);
    const grass = "#7ba05b", dirt = "#b08d5f";
    const cellColor = (i, j) => {
      if (kind === "existing") return grass;
      // pad surface reads as compacted gravel/concrete, like a real prepared pad
      const cx = (i + 0.5) * sp, cy = (j + 0.5) * sp;
      if (d.pads.some(p => pointInPoly2([cx, cy], p.poly, 1))) return "#b6b3a8";
      // otherwise color by what happens in this cell
      let diff = 0;
      for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]])
        diff += d.proposed[(j + dj) * d.n + (i + di)] - d.existing[(j + dj) * d.n + (i + di)];
      diff /= 4;
      if (diff > 0.08) return "#7fa6d9";               // fill (blue)
      if (diff < -0.08) return "#d98c7f";              // cut (red)
      return grass;
    };
    m.beginBatch();
    for (let j = 0; j < d.n - 1; j++)
      for (let i = 0; i < d.n - 1; i++) {
        const col = cellColor(i, j);
        m.addFace([P(i, j), P(i + 1, j), P(i + 1, j + 1)], col, cid);
        m.addFace([P(i, j), P(i + 1, j + 1), P(i, j + 1)], col, cid);
      }
    const N = d.n - 1;
    for (let i = 0; i < N; i++) {                      // four perimeter skirts
      m.addFace([P(i, 0), P(i + 1, 0), B(i + 1, 0), B(i, 0)], dirt, cid);
      m.addFace([P(i, N), P(i + 1, N), B(i + 1, N), B(i, N)], dirt, cid);
      m.addFace([P(0, i), P(0, i + 1), B(0, i + 1), B(0, i)], dirt, cid);
      m.addFace([P(N, i), P(N, i + 1), B(N, i + 1), B(N, i)], dirt, cid);
    }
    m.addFace([B(0, 0), B(N, 0), B(N, N), B(0, N)], dirt, cid);   // bottom
    m.endBatch();
    return cid;
  },

  destroyContainer(cid) {
    if (!cid) return;
    const ids = App.model.entitiesInContainer(cid, true).map(e => e.id);
    if (ids.length) App.model.eraseEntities(ids);
    App.model.containers.delete(cid);
    App.viewport.softCids.delete(cid);
  },

  /* proposed-terrain elevation (inches, model space) at plan point x,y — bilinear */
  terrainZAt(x, y) {
    const d = this.data;
    if (!d) return null;
    const sp = d.spacingFt * 12;
    const fi = Math.min(Math.max(x / sp, 0), d.n - 1.001);
    const fj = Math.min(Math.max(y / sp, 0), d.n - 1.001);
    const i = Math.floor(fi), j = Math.floor(fj);
    const u = fi - i, v = fj - j;
    const z = (ii, jj) => (d.proposed[jj * d.n + ii] - d.datumFt) * 12;
    return z(i, j) * (1 - u) * (1 - v) + z(i + 1, j) * u * (1 - v) +
           z(i, j + 1) * (1 - u) * v + z(i + 1, j + 1) * u * v;
  },

  /* the floating sketch plane: 5 ft above the terrain's highest point */
  sketchZ() {
    const d = this.data;
    if (!d) return 60;
    let hi = -Infinity;
    for (let k = 0; k < d.proposed.length; k++) hi = Math.max(hi, d.proposed[k]);
    return (hi - d.datumFt) * 12 + 60;
  },

  lastSketch: null,

  sketchFootprint() {
    if (!this.data) { App.setHint("No site yet — Site ▸ New Site from Address first."); return; }
    if (!App.tools.tools.sitesketch) App.tools.tools.sitesketch = new SiteSketchTool(App.tools.ctx);
    App.tools.activate("sitesketch");
  },

  /* =================== proposed grade =================== */
  padFromSelection() {
    const d = this.data;
    if (!d) { App.setHint("No site yet — Site ▸ New Site from Address first."); return; }
    const sel = [...App.viewport.selection];
    let face = sel.map(id => App.model.faces.get(id)).find(Boolean);
    if (!face && this.lastSketch) face = App.model.faces.get(this.lastSketch);   // last floating footprint
    if (!face) { App.setHint("No footprint — use Site ▸ Sketch Footprint (or draw and select a rectangle), then run this."); return; }
    if (!sel.length) App.viewport.setSelection([face.id]);
    const poly = face.points().map(p => [p.x, p.y]);   // inches, plan view
    // sensible default: balance point — the average existing grade under the pad
    let sum = 0, cnt = 0;
    for (let k = 0; k < d.existing.length; k++) {
      const i = k % d.n, j = (k - i) / d.n;
      if (pointInPoly2([i * d.spacingFt * 12, j * d.spacingFt * 12], poly, 1)) { sum += d.existing[k]; cnt++; }
    }
    const avg = cnt ? sum / cnt : d.datumFt;
    const answer = window.prompt(
      "Pad elevation in feet above sea level.\n(Average existing grade under this footprint is " +
      avg.toFixed(1) + " ft — that balances cut against fill.)", avg.toFixed(1));
    if (answer === null) return;
    const padFt = parseFloat(answer);
    if (!Number.isFinite(padFt)) { App.setHint("Couldn't read that elevation."); return; }
    this.applyPad(poly, padFt);
    const del = [...App.viewport.selection];           // consume the footprint sketch
    App.model.eraseEntities(del.filter(id => {
      const e = App.model.getEntity(id);
      return e && !e.cid;
    }));
    App.viewport.setSelection([]);
    this.rebuildProposed();
    this.showReport();
  },

  /* Grade the proposed field: pad flat inside the polygon, then a
   * max-slope transition (SLOPE_RATIO:1) back to existing grade. */
  applyPad(polyInches, padFt) {
    const d = this.data;
    const s = this.SLOPE_RATIO;
    d.pads.push({ poly: polyInches, padFt });
    for (let k = 0; k < d.proposed.length; k++) {
      const i = k % d.n, j = (k - i) / d.n;
      const gx = i * d.spacingFt * 12, gy = j * d.spacingFt * 12;
      if (pointInPoly2([gx, gy], polyInches, 1)) { d.proposed[k] = padFt; continue; }
      // distance (ft) from the node to the pad edge, in plan
      let distIn = Infinity;
      for (let e = 0; e < polyInches.length; e++) {
        const a = polyInches[e], b = polyInches[(e + 1) % polyInches.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L2 = dx * dx + dy * dy || 1e-9;
        let t = ((gx - a[0]) * dx + (gy - a[1]) * dy) / L2;
        t = Math.max(0, Math.min(1, t));
        distIn = Math.min(distIn, Math.hypot(a[0] + t * dx - gx, a[1] + t * dy - gy));
      }
      const dFt = distIn / 12;
      const lo = padFt - dFt / s, hi = padFt + dFt / s;
      d.proposed[k] = Math.min(Math.max(d.proposed[k], lo), hi);
    }
  },

  rebuildProposed() {
    const d = this.data;
    this.destroyContainer(d.cidProposed);
    d.cidProposed = this.buildTerrain("proposed");
    this.redrapeAll();
    // hide the existing terrain so the graded site is what you see
    App.outliner.hiddenOids.add(d.cidExisting);
    App.outliner.hiddenOids.delete(d.cidProposed);
    App.outliner.updateFromModel();
    App.outliner.applyHidden();
    App.toggleOutliner(true);
  },

  /* Drop the selected group(s) onto the most recent pad: centered in plan,
   * bounding-box bottom sitting exactly at pad elevation. */
  placeOnPad() {
    const d = this.data;
    if (!d || !d.pads.length) { App.setHint("No pad yet — Site ▸ Set Building Pad first."); return; }
    const sel = [...App.viewport.selection];
    if (!sel.length) {
      App.setHint("Select the house first (click its row in the Outliner selects the whole group), then run this again.");
      return;
    }
    const verts = [...App.model.vertexSetOf(sel)];
    if (!verts.length) { App.setHint("Selection has no geometry."); return; }
    const box = new THREE.Box3();
    for (const v of verts) box.expandByPoint(v.pos);
    const pad = d.pads[d.pads.length - 1];
    const c = pad.poly.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map(v => v / pad.poly.length);
    const padZ = (pad.padFt - d.datumFt) * 12;
    const mid = box.getCenter(new THREE.Vector3());
    const delta = new THREE.Vector3(c[0] - mid.x, c[1] - mid.y, padZ - box.min.z);
    App.pushUndo();
    for (const v of verts) v.pos.add(delta);
    App.model.markGridDirty();
    App.model.changed();
    App.setHint("Placed on the " + pad.padFt.toFixed(1) + " ft pad — use Move (M) to fine-tune position, corners snap to the pad.");
  },

  /* =================== driveway drape =================== */
  drapeFromSelection() {
    const d = this.data;
    if (!d) { App.setHint("No site yet — Site ▸ New Site from Address first."); return; }
    let sel = [...App.viewport.selection];
    let faces = sel.map(id => App.model.faces.get(id)).filter(f => f && !f.cid);
    if (!faces.length && this.lastSketch && App.model.faces.get(this.lastSketch)) {
      faces = [App.model.faces.get(this.lastSketch)];   // last floating footprint
      sel = [faces[0].id];
    }
    if (!faces.length) {
      App.setHint("No footprint — use Site ▸ Sketch Footprint (or draw and select faces), then run this again.");
      return;
    }
    const ans = window.prompt("Base excavation under the driveway, in inches (for gravel section — 0 = drape only):", "8");
    if (ans === null) return;
    const depthIn = Math.max(0, parseFloat(ans) || 0);
    App.pushUndo();
    const m = App.model;
    m.beginBatch();
    let made = 0;
    const polys = faces.map(f => f.points().map(p => [p.x, p.y]));
    const cid = m.createContainer("Driveway", 0);
    App.viewport.softCids.add(cid);
    for (const poly of polys) made += this.drapePoly(poly, cid);
    m.eraseEntities(sel.filter(id => { const e = m.getEntity(id); return e && !e.cid; }));
    m.endBatch();
    if (!made) {
      this.destroyContainer(cid);
      App.setHint("The footprint doesn't overlap the terrain grid — draw it over the site.");
      return;
    }
    const areaFt2 = polys.reduce((a, p) => a + Math.abs(polyArea2(p)), 0) / 144;
    d.driveways.push({ polys, baseDepthIn: depthIn, areaFt2, cid });
    App.viewport.setSelection([]);
    App.outliner.updateFromModel();
    App.setHint("Driveway draped onto the terrain (" + made + " faces, " +
      Math.round(areaFt2) + " ft²" + (depthIn ? ", " + depthIn + '" base section' : "") + ").");
    this.showReport();
  },

  /* Project one plan polygon onto the proposed terrain surface. */
  drapePoly(poly, cid) {
    const d = this.data;
    const sp = d.spacingFt * 12;
    const zOf = (i, j) => (d.proposed[j * d.n + i] - d.datumFt) * 12;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    const clampI = v => Math.max(0, Math.min(d.n - 2, v));
    const i0 = clampI(Math.floor(minX / sp)), i1 = clampI(Math.floor(maxX / sp));
    const j0 = clampI(Math.floor(minY / sp)), j1 = clampI(Math.floor(maxY / sp));
    let made = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x0 = i * sp, y0 = j * sp, x1 = x0 + sp, y1 = y0 + sp;
        const z00 = zOf(i, j), z10 = zOf(i + 1, j), z11 = zOf(i + 1, j + 1), z01 = zOf(i, j + 1);
        // same diagonal split as the terrain triangles, so the drape sits flush
        const tris = [
          { t: [[x0, y0], [x1, y0], [x1, y1]], z: [z00, z10, z11] },
          { t: [[x0, y0], [x1, y1], [x0, y1]], z: [z00, z11, z01] }
        ];
        for (const tri of tris) {
          const clip = clipPolyConvex(poly, tri.t);
          if (clip.length < 3 || Math.abs(polyArea2(clip)) < 2) continue;   // skip slivers
          const pts = clip.map(p => new THREE.Vector3(p[0], p[1], triBaryZ(p, tri.t, tri.z) + 0.5));
          if (App.model.addFace(pts, "#6f6f6f", cid)) made++;
        }
      }
    return made;
  },

  /* Driveways follow the grade — regenerate them whenever the terrain changes */
  redrapeAll() {
    const d = this.data;
    if (!d || !d.driveways) return;
    App.model.beginBatch();
    for (const dw of d.driveways) {
      this.destroyContainer(dw.cid);
      dw.cid = App.model.createContainer("Driveway", 0);
      App.viewport.softCids.add(dw.cid);
      let made = 0;
      for (const poly of dw.polys) made += this.drapePoly(poly, dw.cid);
      if (!made) { this.destroyContainer(dw.cid); dw.cid = 0; }
    }
    App.model.endBatch();
  },

  resetProposed() {
    const d = this.data;
    if (!d) return;
    App.pushUndo();
    d.proposed = Float64Array.from(d.existing);
    d.pads = [];
    this.destroyContainer(d.cidProposed);
    d.cidProposed = 0;
    this.redrapeAll();   // driveways stay, following the restored grade
    App.outliner.hiddenOids.delete(d.cidExisting);
    App.outliner.updateFromModel();
    App.outliner.applyHidden();
    App.setHint("Proposed grade reset to existing." + (d.driveways.length ? " Driveways re-draped." : ""));
  },

  clearAll(keepData) {
    if (!this.data) return;
    if (!keepData) App.pushUndo();
    this.destroyContainer(this.data.cidExisting);
    this.destroyContainer(this.data.cidProposed);
    for (const dw of this.data.driveways || []) this.destroyContainer(dw.cid);
    App.outliner.updateFromModel();
    if (!keepData) {
      this.data = null;
      App.setHint("Site terrain cleared.");
    }
  },

  /* =================== cut & fill (grid method) =================== */
  computeCutFill() {
    const d = this.data;
    const cellFt2 = d.spacingFt * d.spacingFt;
    let cutFt3 = 0, fillFt3 = 0, disturbedFt2 = 0;
    for (let j = 0; j < d.n - 1; j++)
      for (let i = 0; i < d.n - 1; i++) {
        let diff = 0;
        for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]])
          diff += d.proposed[(j + dj) * d.n + (i + di)] - d.existing[(j + dj) * d.n + (i + di)];
        diff /= 4;                                     // average depth over the cell, ft
        if (diff > 0.001) fillFt3 += diff * cellFt2;
        else if (diff < -0.001) cutFt3 += -diff * cellFt2;
        if (Math.abs(diff) > 0.02) disturbedFt2 += cellFt2;
      }
    return { cutYd3: cutFt3 / 27, fillYd3: fillFt3 / 27, disturbedFt2 };
  },

  showReport() {
    const d = this.data;
    if (!d) { App.setHint("No site loaded."); return; }
    const { cutYd3, fillYd3, disturbedFt2 } = this.computeCutFill();
    const dwAreaFt2 = d.driveways.reduce((a, w) => a + w.areaFt2, 0);
    const dwBaseYd3 = d.driveways.reduce((a, w) => a + w.areaFt2 * (w.baseDepthIn / 12) / 27, 0);
    const net = cutYd3 + dwBaseYd3 - fillYd3;          // bank yd³ (driveway base is extra cut)
    const looseNet = Math.abs(net) * (net > 0 ? this.SWELL : 1);   // hauling off swells; importing is ordered loose
    const trucks = Math.ceil(looseNet / this.TRUCK_YD3);
    const fmt = v => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    const dwRows = d.driveways.length ? `
        <tr><th>Driveway</th><td>${fmt(dwAreaFt2)} ft² draped${dwBaseYd3 ? " — base excavation " + fmt(dwBaseYd3) + " yd³ (gravel extra)" : ""}</td></tr>` : "";
    App.showDialog("Cut & Fill Report — " + (d.addr || "site"), `
      <table>
        <tr><th>Cut (excavate)</th><td>${fmt(cutYd3)} yd³ bank</td></tr>
        <tr><th>Fill (place)</th><td>${fmt(fillYd3)} yd³ compacted</td></tr>${dwRows}
        <tr><th>Net</th><td><b>${fmt(Math.abs(net))} yd³ ${net > 0 ? "surplus — haul OFF site" : "shortfall — import"}</b></td></tr>
        <tr><th>Haul volume</th><td>${fmt(looseNet)} yd³ loose${net > 0 ? " (× " + this.SWELL + " swell)" : ""}</td></tr>
        <tr><th>Truckloads (${this.TRUCK_YD3} yd³)</th><td><b>≈ ${trucks} loads</b></td></tr>
        <tr><th>Disturbed area</th><td>${fmt(disturbedFt2)} ft² (${fmt(disturbedFt2 / 43560)} ac)</td></tr>
        <tr><th>Grid</th><td>${d.n}×${d.n} @ ${d.spacingFt} ft — datum ${d.datumFt} ft</td></tr>
        <tr><th>Pads</th><td>${d.pads.length ? d.pads.map(p => p.padFt.toFixed(1) + " ft").join(", ") : "none yet"}</td></tr>
      </table>
      <p style="color:#888;font-size:11px">Grid-method estimate on ${d.loc ? "USGS 3DEP data — verify against a survey before bidding" : "imported survey points"}.
      Gray cells = pad, red = cut, blue = fill. Swell ${this.SWELL} on hauled material; compaction shrink not modeled.</p>`);
  }
};
