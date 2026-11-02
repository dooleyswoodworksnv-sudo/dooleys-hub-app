/* ============================================================
 * viewport.js — Three.js viewport: rendering, camera controls
 * (SketchUp-style: middle-drag orbit, shift+middle pan, wheel
 * zoom-to-cursor), picking and inference snapping.
 * ============================================================ */
"use strict";

const SU_COLORS = {
  faceDefault: 0xf6f6ef,
  faceHover: 0xbcd8f0,
  faceSelected: 0x74aede,
  edgeDefault: 0x1c1c1c,
  edgeSelected: 0x1667c9,
  axisX: 0xe53935,
  axisY: 0x43a047,
  axisZ: 0x1e88e5,
  snap: {
    endpoint: 0x2ecc40,
    midpoint: 0x00bcd4,
    edge: 0xe53935,
    face: 0x1e88e5,
    ground: 0x777777,
    axis: 0x999999,
    guide: 0xb06cd9,       // on a tape measure guide line
    guidepoint: 0x7d3f9e   // guide endpoint or guide × guide crossing
  }
};

/* Closest points between two segments (Ericson, Real-Time Collision Detection) */
function segSegClosest(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  const c = d1.dot(r), b = d1.dot(d2);
  const denom = a * e - b * b;
  let s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
  let t = e > 1e-12 ? (b * s + f) / e : 0;
  if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
  else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
  const c1 = p1.clone().add(d1.multiplyScalar(s));
  const c2 = p2.clone().add(d2.multiplyScalar(t));
  return { c1, c2, dist: c1.distanceTo(c2) };
}

class Viewport {
  constructor(container, model) {
    this.container = container;
    this.model = model;
    this.selection = new Set();
    this.guides = [];       // [{ p1, p2 }] — tape measure guides (snappable)
    this._guidePts = [];    // endpoints + guide×guide crossings, for inference
    this.softCids = new Set();   // containers drawn without edges (terrain meshes)
    this.hiddenIds = new Set();   // entity ids hidden via the Outliner
    this.hiddenLayerNames = new Set(); // container names hidden via the Layers panel
    this.editCids = null;         // Set of container ids in the open edit context
    this.editContextId = 0;
    this.contextHelper = null;
    this.hoverId = null;
    this.target = new THREE.Vector3(80, 80, 0);

    THREE.Object3D.DefaultUp = new THREE.Vector3(0, 0, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 400000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(550, -670, 400);
    this.camera.lookAt(this.target);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    // lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a929c, 0.85);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.55);
    dir.position.set(10, -14, 20);
    this.scene.add(dir);

    this.buildGridAndAxes();

    this.facesGroup = new THREE.Group();
    this.edgesGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.guidesGroup = new THREE.Group();   // tape measure guides — survive rebuilds
    this.scene.add(this.facesGroup, this.edgesGroup, this.previewGroup, this.guidesGroup);

    this.raycaster = new THREE.Raycaster();

    // snap indicator
    this.snapMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x2ecc40, depthTest: false })
    );
    this.snapMarker.renderOrder = 10;
    this.snapMarker.visible = false;
    this.scene.add(this.snapMarker);

    model.onChange(() => this.rebuild());
    this.setupNavigation();

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.rebuild();

    const loop = () => { this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  buildGridAndAxes() {
    // 160 ft square, 12-inch cells (heavier line each foot)
    const grid = new THREE.GridHelper(1920, 160, 0xc4c4c4, 0xe1e1e1);
    grid.rotation.x = Math.PI / 2;   // GridHelper is XZ by default → rotate into XY ground
    grid.position.z = -0.05;
    grid.material.depthWrite = false;
    this.scene.add(grid);

    const axisLen = 20000;
    const mkAxis = (dir, color) => {
      // solid positive side
      let g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(axisLen)]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
      // dashed negative side
      g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(-axisLen)]);
      const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 10, gapSize: 10, opacity: 0.55, transparent: true }));
      line.computeLineDistances();
      this.scene.add(line);
    };
    mkAxis(new THREE.Vector3(1, 0, 0), SU_COLORS.axisX);
    mkAxis(new THREE.Vector3(0, 1, 0), SU_COLORS.axisY);
    mkAxis(new THREE.Vector3(0, 0, 1), SU_COLORS.axisZ);
  }

  /* ---------- scene sync ---------- */
  rebuild() {
    const dispose = group => {
      for (const child of [...group.children]) {
        group.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      }
    };
    dispose(this.facesGroup);
    dispose(this.edgesGroup);

    // Layers panel: hide every container whose name is toggled off, plus all
    // its child containers (each framing member is its own named group)
    const hiddenLayerCids = new Set();
    if (this.hiddenLayerNames.size) {
      const kids = new Map();
      for (const c of this.model.containers.values()) {
        if (!kids.has(c.parent)) kids.set(c.parent, []);
        kids.get(c.parent).push(c.id);
      }
      const queue = [];
      for (const c of this.model.containers.values())
        if (this.hiddenLayerNames.has(String(c.name))) queue.push(c.id);
      while (queue.length) {
        const id = queue.pop();
        if (hiddenLayerCids.has(id)) continue;
        hiddenLayerCids.add(id);
        const ch = kids.get(id);
        if (ch) for (const k of ch) queue.push(k);
      }
    }

    for (const face of this.model.faces.values()) {
      if (this.hiddenIds.has(face.id)) continue;
      if (hiddenLayerCids.has(face.cid)) continue;
      const { pts, tris } = faceTriangles(face);
      if (!tris.length) continue;
      const positions = [];
      for (const t of tris)
        for (const i of t) positions.push(pts[i].x, pts[i].y, pts[i].z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      const dimmed = this.editCids && !this.editCids.has(face.cid);
      let color = face.color ? new THREE.Color(face.color) : new THREE.Color(SU_COLORS.faceDefault);
      if (!dimmed) {
        if (this.selection.has(face.id)) color = new THREE.Color(SU_COLORS.faceSelected);
        else if (this.hoverId === face.id) color = new THREE.Color(SU_COLORS.faceHover);
      }
      const mat = new THREE.MeshLambertMaterial({
        color, side: THREE.DoubleSide,
        transparent: dimmed, opacity: dimmed ? 0.22 : 1, depthWrite: !dimmed,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { type: "face", id: face.id };
      this.facesGroup.add(mesh);
    }

    for (const edge of this.model.edges.values()) {
      if (this.hiddenIds.has(edge.id)) continue;
      if (hiddenLayerCids.has(edge.cid)) continue;
      // softened containers (terrain meshes): faces only, no wireframe clutter
      if (this.softCids.has(edge.cid) && !this.selection.has(edge.id)) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([edge.v1.pos, edge.v2.pos]);
      const dimmed = this.editCids && !this.editCids.has(edge.cid);
      const selected = !dimmed && this.selection.has(edge.id);
      const hovered = !dimmed && this.hoverId === edge.id;
      const mat = new THREE.LineBasicMaterial({
        color: dimmed ? 0xbdbdbd : selected ? SU_COLORS.edgeSelected : hovered ? SU_COLORS.faceSelected : SU_COLORS.edgeDefault,
        transparent: dimmed, opacity: dimmed ? 0.35 : 1
      });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 1;
      line.userData = { type: "edge", id: edge.id };
      this.edgesGroup.add(line);
    }

    // dashed-style bounding box around the group being edited
    if (this.contextHelper) {
      this.scene.remove(this.contextHelper);
      this.contextHelper.geometry.dispose();
      this.contextHelper.material.dispose();
      this.contextHelper = null;
    }
    if (this.editContextId && this.editCids) {
      const box = new THREE.Box3();
      for (const f of this.model.faces.values())
        if (this.editCids.has(f.cid)) f.allVertices().forEach(v => box.expandByPoint(v.pos));
      for (const e of this.model.edges.values())
        if (this.editCids.has(e.cid)) { box.expandByPoint(e.v1.pos); box.expandByPoint(e.v2.pos); }
      if (!box.isEmpty()) {
        box.expandByScalar(2);
        this.contextHelper = new THREE.Box3Helper(box, 0x8a8a8a);
        this.scene.add(this.contextHelper);
      }
    }
  }

  setEditContext(cid) {
    this.editContextId = cid || 0;
    this.editCids = cid ? this.model.containerDescendants(cid) : null;
    this.rebuild();
  }

  setHiddenLayerNames(names) {
    this.hiddenLayerNames = new Set(names);
    this.rebuild();
  }

  setSelection(ids) {
    this.selection = new Set(ids);
    this.rebuild();
  }

  setHover(id) {
    if (this.hoverId === id) return;
    // hover highlight requires a scene rebuild — too costly on huge models
    if (this.model.faces.size + this.model.edges.size > 4000) { this.hoverId = null; return; }
    this.hoverId = id;
    this.rebuild();
  }

  /* ---------- preview helpers (tools draw into previewGroup) ---------- */
  clearPreview() {
    for (const child of [...this.previewGroup.children]) {
      this.previewGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.snapMarker.visible = false;
  }

  previewLine(p1, p2, color = 0x000000) {
    const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 9;
    this.previewGroup.add(line);
    return line;
  }

  previewLoop(pts, color = 0x000000) {
    const geo = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 9;
    this.previewGroup.add(line);
    return line;
  }

  previewPolyline(pts, color = 0x000000) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 9;
    this.previewGroup.add(line);
    return line;
  }

  previewDashedLine(p1, p2, color = 0x7d3f9e) {
    const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color, dashSize: 4, gapSize: 3, depthTest: false
    }));
    line.computeLineDistances();
    line.renderOrder = 9;
    this.previewGroup.add(line);
    return line;
  }

  previewMesh(positions, color = 0x9fc5e8, opacity = 0.45) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false
    }));
    this.previewGroup.add(mesh);
    return mesh;
  }

  /* ---------- tape measure guides ---------- */
  _rebuildGuidePoints() {
    this._guidePts = [];
    for (const g of this.guides) {
      this._guidePts.push({ point: g.p1.clone() }, { point: g.p2.clone() });
    }
    // guide × guide crossings are layout gold — snap right to them
    for (let i = 0; i < this.guides.length; i++) {
      for (let j = i + 1; j < this.guides.length; j++) {
        const a = this.guides[i], b = this.guides[j];
        const { c1, c2, dist } = segSegClosest(a.p1, a.p2, b.p1, b.p2);
        if (dist < 0.05)
          this._guidePts.push({ point: c1.add(c2).multiplyScalar(0.5), cross: true });
      }
    }
  }

  addGuide(p1, p2, label) {
    this.guides.push({ p1: p1.clone(), p2: p2.clone() });
    this._rebuildGuidePoints();
    const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color: 0x7d3f9e, dashSize: 4, gapSize: 3
    }));
    line.computeLineDistances();
    line.renderOrder = 2;
    this.guidesGroup.add(line);
    for (const p of [p1, p2]) {
      const s = Math.max(this.camera.position.distanceTo(p) * 0.003, 0.05);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(s, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x7d3f9e })
      );
      dot.position.copy(p);
      this.guidesGroup.add(dot);
    }
    if (label) {
      const mid = p1.clone().add(p2).multiplyScalar(0.5);
      this.guidesGroup.add(this.makeLabelSprite(label, mid));
    }
  }

  clearGuides() {
    this.guides = [];
    this._guidePts = [];
    for (const child of [...this.guidesGroup.children]) {
      this.guidesGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
  }

  makeLabelSprite(text, pos) {
    const fs = 28, pad = 10;
    const canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d");
    ctx.font = "600 " + fs + 'px "Segoe UI", sans-serif';
    canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    canvas.height = fs + pad * 2;
    ctx = canvas.getContext("2d");   // resize resets state
    ctx.font = "600 " + fs + 'px "Segoe UI", sans-serif';
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#7d3f9e";
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    ctx.fillStyle = "#5b2d7a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.renderOrder = 11;
    sp.position.copy(pos);
    const h = this.camera.position.distanceTo(pos) * 0.028;
    sp.scale.set(h * canvas.width / canvas.height, h, 1);
    return sp;
  }

  showSnapMarker(point, type) {
    this.snapMarker.visible = true;
    this.snapMarker.position.copy(point);
    this.snapMarker.material.color.setHex(SU_COLORS.snap[type] || 0x777777);
    const dist = this.camera.position.distanceTo(point);
    const s = dist * 0.004 * (type === "ground" || type === "face" ? 0.8 : 1.2);
    this.snapMarker.scale.setScalar(Math.max(s, 0.002));
  }

  /* ---------- picking ---------- */
  ndc(mx, my) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((mx - r.left) / r.width) * 2 - 1, -((my - r.top) / r.height) * 2 + 1);
  }

  setRay(mx, my) {
    this.raycaster.setFromCamera(this.ndc(mx, my), this.camera);
    this.raycaster.params.Line = { threshold: this.camera.position.distanceTo(this.target) * 0.008 };
    return this.raycaster;
  }

  pick(mx, my, { faces = true, edges = true, skipIds = null } = {}) {
    const ray = this.setRay(mx, my);
    const ok = obj => !skipIds || !skipIds.has(obj.userData.id);
    let edgeHit = null, faceHit = null;
    if (edges) {
      const hits = ray.intersectObjects(this.edgesGroup.children.filter(ok));
      // the ray threshold scales with camera distance and gets huge on large
      // scenes — accept an edge only if its hit point is near the CURSOR
      for (const h of hits) {
        const sp = this.worldToScreen(h.point);
        if (!sp.behind && Math.hypot(sp.x - mx, sp.y - my) <= 8) { edgeHit = h; break; }
      }
    }
    if (faces) {
      const hits = ray.intersectObjects(this.facesGroup.children.filter(ok));
      if (hits.length) faceHit = hits[0];
    }
    // edges win when roughly as close as the face behind them
    if (edgeHit && (!faceHit || edgeHit.distance <= faceHit.distance + 0.02 * faceHit.distance)) {
      return { type: "edge", id: edgeHit.object.userData.id, point: edgeHit.point.clone() };
    }
    if (faceHit) {
      const face = this.model.faces.get(faceHit.object.userData.id);
      return { type: "face", id: faceHit.object.userData.id, point: faceHit.point.clone(), normal: face ? face.normal() : null };
    }
    return null;
  }

  pickPlane(mx, my, plane) {
    const ray = this.setRay(mx, my);
    const pt = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, pt) ? pt : null;
  }

  pickGround(mx, my) {
    return this.pickPlane(mx, my, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
  }

  worldToScreen(p) {
    const v = p.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width + r.left, y: (-v.y + 1) / 2 * r.height + r.top, behind: v.z > 1 };
  }

  /* nearest guide endpoint / crossing within the snap radius (screen space) */
  guidePointSnap(mx, my) {
    const PIX = 9;
    let best = null;
    for (const gp of this._guidePts) {
      const s = this.worldToScreen(gp.point);
      if (s.behind) continue;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < PIX && (!best || d < best.d)) best = { d, point: gp.point.clone(), type: "guidepoint" };
    }
    return best;
  }

  /* nearest point anywhere along a guide line within the snap radius */
  guideLineSnap(mx, my) {
    if (!this.guides.length) return null;
    const PIX = 9;
    let best = null;
    const tmp = new THREE.Vector3();
    const ray = this.setRay(mx, my).ray;
    for (const g of this.guides) {
      ray.distanceSqToSegment(g.p1, g.p2, null, tmp);
      const s = this.worldToScreen(tmp);
      if (s.behind) continue;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < PIX && (!best || d < best.d)) best = { d, point: tmp.clone(), type: "guide" };
    }
    return best;
  }

  /* ---------- inference snapping ----------
   * Priority: endpoints & guide points → midpoints → on-guide →
   * on-edge → on-face → ground plane.
   * Returns { point, type, normal?, entityId? } or null. */
  snap(mx, my, { skipVertexIds = null, skipEntityIds = null, allowGround = true } = {}) {
    const PIX = 9;
    let best = null;
    // huge scripted models: skip per-vertex screen projection, keep guide/face/ground snapping
    if (this.model.vertices.size > 8000) {
      const gp = this.guidePointSnap(mx, my) || this.guideLineSnap(mx, my);
      if (gp) return gp;
      const hit = this.pick(mx, my, { skipIds: skipEntityIds });
      if (hit && hit.type === "face") return { point: hit.point, type: "face", normal: hit.normal, entityId: hit.id };
      const g = allowGround ? this.pickGround(mx, my) : null;
      if (g) return { point: g, type: "ground", normal: new THREE.Vector3(0, 0, 1) };
      return null;
    }
    for (const v of this.model.vertices.values()) {
      if (skipVertexIds && skipVertexIds.has(v.id)) continue;
      const s = this.worldToScreen(v.pos);
      if (s.behind) continue;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < PIX && (!best || d < best.d)) best = { d, point: v.pos.clone(), type: "endpoint" };
    }
    const gpt = this.guidePointSnap(mx, my);
    if (gpt && (!best || gpt.d < best.d)) best = gpt;
    if (best) return best;
    for (const e of this.model.edges.values()) {
      if (skipEntityIds && skipEntityIds.has(e.id)) continue;
      if (skipVertexIds && (skipVertexIds.has(e.v1.id) || skipVertexIds.has(e.v2.id))) continue;
      const mid = e.midpoint();
      const s = this.worldToScreen(mid);
      if (s.behind) continue;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < PIX && (!best || d < best.d)) best = { d, point: mid, type: "midpoint" };
    }
    if (best) return best;
    best = this.guideLineSnap(mx, my);
    if (best) return best;
    const hit = this.pick(mx, my, { skipIds: skipEntityIds });
    if (hit) {
      if (hit.type === "edge") {
        const e = this.model.edges.get(hit.id);
        if (e) {
          const line = new THREE.Line3(e.v1.pos, e.v2.pos);
          const pt = new THREE.Vector3();
          line.closestPointToPoint(hit.point, true, pt);
          return { point: pt, type: "edge", entityId: hit.id };
        }
      } else {
        return { point: hit.point, type: "face", normal: hit.normal, entityId: hit.id };
      }
    }
    if (allowGround) {
      const g = this.pickGround(mx, my);
      if (g) return { point: g, type: "ground", normal: new THREE.Vector3(0, 0, 1) };
    }
    // fall back: plane through target facing camera
    const n = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.target);
    const p = this.pickPlane(mx, my, plane);
    return p ? { point: p, type: "ground", normal: new THREE.Vector3(0, 0, 1) } : null;
  }

  /* ---------- camera navigation ---------- */
  setupNavigation() {
    const el = this.renderer.domElement;
    let navMode = null, lastX = 0, lastY = 0;

    el.addEventListener("pointerdown", e => {
      if (e.button === 1) {
        navMode = e.shiftKey ? "pan" : "orbit";
        lastX = e.clientX; lastY = e.clientY;
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      }
    });
    el.addEventListener("pointermove", e => {
      if (!navMode) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (navMode === "orbit") this.orbitBy(dx, dy);
      else this.panBy(dx, dy);
    });
    const endNav = e => { if (e.button === 1) navMode = null; };
    el.addEventListener("pointerup", endNav);
    el.addEventListener("pointercancel", () => navMode = null);
    el.addEventListener("wheel", e => {
      e.preventDefault();
      this.dollyAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 0.89);
    }, { passive: false });
    el.addEventListener("contextmenu", e => e.preventDefault());
  }

  orbitBy(dx, dy) {
    const offset = this.camera.position.clone().sub(this.target);
    const r = offset.length();
    let theta = Math.atan2(offset.y, offset.x);
    let phi = Math.acos(THREE.MathUtils.clamp(offset.z / r, -1, 1));
    theta -= dx * 0.006;
    phi = THREE.MathUtils.clamp(phi - dy * 0.006, 0.03, Math.PI - 0.03);
    offset.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi)
    );
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  panBy(dx, dy) {
    const dist = this.camera.position.distanceTo(this.target);
    const scale = dist * 0.0014;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const move = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
    this.camera.position.add(move);
    this.target.add(move);
    this.camera.lookAt(this.target);
  }

  dollyAt(mx, my, factor) {
    let focus = null;
    const hit = this.pick(mx, my, { edges: false });
    if (hit) focus = hit.point;
    if (!focus) focus = this.pickGround(mx, my);
    if (!focus) focus = this.target.clone();
    const dist = this.camera.position.distanceTo(focus);
    if (factor < 1 && dist < 2) return;
    this.camera.position.lerp(focus, 1 - factor);
    this.target.lerp(focus, (1 - factor) * 0.5);
    this.camera.lookAt(this.target);
  }

  zoomExtents() {
    let box = this.model.bbox();
    if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-200, -200, 0), new THREE.Vector3(200, 200, 120));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 40);
    const dir = this.camera.position.clone().sub(this.target).normalize();
    const dist = radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.25;
    this.target.copy(center);
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.lookAt(this.target);
  }

  setView(name) {
    let box = this.model.bbox();
    if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-200, -200, 0), new THREE.Vector3(200, 200, 120));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 40);
    const dist = radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.35;
    const dirs = {
      iso: new THREE.Vector3(1, -1.2, 0.75).normalize(),
      top: new THREE.Vector3(0, -0.001, 1).normalize(),
      front: new THREE.Vector3(0, -1, 0.0001).normalize(),
      right: new THREE.Vector3(1, 0, 0.0001).normalize(),
      back: new THREE.Vector3(0, 1, 0.0001).normalize(),
      left: new THREE.Vector3(-1, 0, 0.0001).normalize()
    };
    const dir = dirs[name] || dirs.iso;
    this.target.copy(center);
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.lookAt(this.target);
  }
}
