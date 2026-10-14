/* ============================================================
 * tools.js — SketchUp-style interactive tools.
 * Select, Line, Rectangle, Circle, Push/Pull, Move, Eraser,
 * Paint Bucket, Orbit, Pan. Typed measurements via the VCB.
 * ============================================================ */
"use strict";

const AXES3 = [
  { dir: new THREE.Vector3(1, 0, 0), color: SU_COLORS.axisX, name: "red (X)" },
  { dir: new THREE.Vector3(0, 1, 0), color: SU_COLORS.axisY, name: "green (Y)" },
  { dir: new THREE.Vector3(0, 0, 1), color: SU_COLORS.axisZ, name: "blue (Z)" }
];

/* Format inches as feet-and-inches, SketchUp style: 30.5 → 2' 6.5" */
function fmtLen(inches) {
  const sign = inches < 0 ? "-" : "";
  const a = Math.abs(inches);
  const trim = n => (Math.round(n * 100) / 100).toString();
  if (a >= 12) {
    const ft = Math.floor(a / 12);
    const rem = a - ft * 12;
    return rem < 0.005 ? sign + ft + "'" : sign + ft + "' " + trim(rem) + '"';
  }
  return sign + trim(a) + '"';
}

/* Parse '24', '24"', "2'", "2'6", "2' 6\"", '1.5ft', '30cm', '150mm', '2m' → inches. */
function parseLen(str) {
  let m = /^\s*(-?\d*\.?\d+)\s*'\s*(\d*\.?\d+)?\s*"?\s*$/.exec(str);
  if (m) {
    const ft = parseFloat(m[1]);
    const inch = m[2] ? parseFloat(m[2]) : 0;
    return ft * 12 + (ft < 0 ? -inch : inch);
  }
  m = /^\s*(-?\d*\.?\d+)\s*(mm|cm|m|ft|in|")?\s*$/i.exec(str);
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch ((m[2] || "in").toLowerCase()) {
    case "mm": return v / 25.4;
    case "cm": return v / 2.54;
    case "m": return v / 0.0254;
    case "ft": return v * 12;
    default: return v;
  }
}

class Tool {
  constructor(ctx) { this.ctx = ctx; }                  // ctx = { model, viewport, app }
  get model() { return this.ctx.model; }
  get vp() { return this.ctx.viewport; }
  get app() { return this.ctx.app; }
  activate() {}
  deactivate() { this.vp.clearPreview(); this.vp.setHover(null); }
  cancel() { this.vp.clearPreview(); }
  onDown(e, x, y) {}
  onMove(e, x, y) {}
  onUp(e, x, y) {}
  onKey(e) {}
  onVCB(text) {}
  cursor() { return "default"; }
  hint(text) { this.app.setHint(text); }
  vcb(label, value) { this.app.setVCB(label, value); }
}

/* =================== Select =================== */
class SelectTool extends Tool {
  activate() {
    this.hint("Select: click selects a group, double-click opens it for editing. Shift = add/remove. Del = erase.");
    this.downPos = null;
  }
  cursor() { return "default"; }
  onDown(e, x, y) { this.downPos = { x, y }; }

  onDblClick(e, x, y) {
    const hit = this.vp.pick(x, y);
    if (!hit) { this.app.exitContext(); return; }
    const res = this.model.resolveInContext(hit.id, this.app.activeContext);
    if (!res || res.kind === "outside") this.app.exitContext();
    else if (res.kind === "group") this.app.enterContext(res.cid);
  }
  onMove(e, x, y) {
    if (this.downPos && (Math.abs(x - this.downPos.x) > 4 || Math.abs(y - this.downPos.y) > 4)) {
      this.app.showSelectRect(this.downPos.x, this.downPos.y, x, y);
    }
  }
  onUp(e, x, y) {
    if (!this.downPos) return;
    const moved = Math.abs(x - this.downPos.x) > 4 || Math.abs(y - this.downPos.y) > 4;
    if (moved) {
      const x1 = Math.min(this.downPos.x, x), x2 = Math.max(this.downPos.x, x);
      const y1 = Math.min(this.downPos.y, y), y2 = Math.max(this.downPos.y, y);
      const inside = p => { const s = this.vp.worldToScreen(p); return !s.behind && s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2; };
      const ids = e.shiftKey ? new Set(this.vp.selection) : new Set();
      for (const edge of this.model.edges.values())
        if (inside(edge.v1.pos) && inside(edge.v2.pos)) ids.add(edge.id);
      for (const face of this.model.faces.values())
        if (face.loop.every(v => inside(v.pos))) ids.add(face.id);
      this.vp.setSelection(ids);
    } else {
      const hit = this.vp.pick(x, y);
      if (!hit) {
        // empty click: clear selection; when nothing was selected,
        // step out of the open group — SketchUp behavior
        if (!this.vp.selection.size && this.app.activeContext) this.app.exitContext();
        else if (!e.shiftKey) this.vp.setSelection([]);
      } else {
        const res = this.model.resolveInContext(hit.id, this.app.activeContext);
        if (!res || res.kind === "outside") {
          this.app.exitContext();               // clicked outside the open group
        } else {
          const targetIds = res.ids;
          const ids = new Set(e.shiftKey ? this.vp.selection : []);
          if (e.shiftKey && targetIds.some(id => ids.has(id))) targetIds.forEach(id => ids.delete(id));
          else targetIds.forEach(id => ids.add(id));
          this.vp.setSelection(ids);
        }
      }
    }
    this.app.hideSelectRect();
    this.downPos = null;
    const n = this.vp.selection.size;
    this.hint(n ? `${n} entit${n === 1 ? "y" : "ies"} selected.` : "Select: click entities. Shift = add/remove. Drag = box select.");
  }
  onKey(e) {
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.vp.selection.size) {
        this.app.pushUndo();
        this.model.eraseEntities([...this.vp.selection]);
        this.vp.setSelection([]);
      }
    }
    if (e.key === "Escape") {
      if (this.vp.selection.size) this.vp.setSelection([]);
      else this.app.exitContext();
    }
  }
}

/* =================== Line =================== */
class LineTool extends Tool {
  activate() {
    this.p1 = null;
    this.cur = null;
    this.lockedAxis = null;
    this.hint("Line: click start point. Closing a planar loop creates a face. Esc = restart.");
    this.vcb("Length", "");
  }
  cursor() { return "crosshair"; }

  computePoint(x, y) {
    const snap = this.vp.snap(x, y);
    if (!snap) return null;
    let point = snap.point, type = snap.type;
    if (this.p1) {
      const dif = point.clone().sub(this.p1);
      const len = dif.length();
      let axis = this.lockedAxis;
      if (!axis && len > 1e-6 && type !== "endpoint" && type !== "midpoint" && type !== "guidepoint") {
        for (const a of AXES3) {
          const d = Math.abs(dif.dot(a.dir)) / len;
          if (d > 0.9962) { axis = a; break; }   // within ~5°
        }
      }
      if (axis) {
        point = this.p1.clone().add(axis.dir.clone().multiplyScalar(dif.dot(axis.dir)));
        type = "axis";
        this.axisColor = axis.color;
      } else {
        this.axisColor = null;
      }
    }
    return { point, type };
  }

  onMove(e, x, y) {
    this.vp.clearPreview();
    const c = this.computePoint(x, y);
    if (!c) return;
    this.cur = c.point;
    this.vp.showSnapMarker(c.point, c.type === "axis" ? "axis" : c.type);
    if (this.p1) {
      this.vp.previewLine(this.p1, c.point, this.axisColor || 0x000000);
      this.vcb("Length", fmtLen(this.p1.distanceTo(c.point)));
    }
  }

  onDown(e, x, y) {
    const c = this.computePoint(x, y);
    if (!c) return;
    if (!this.p1) {
      this.p1 = c.point;
      this.hint("Line: click end point. Arrow keys lock to an axis. Type a length + Enter.");
    } else {
      this.commit(c.point);
    }
  }

  commit(point) {
    if (this.p1.distanceTo(point) < SU_EPS) return;
    this.app.pushUndo();
    const { faces } = this.model.addEdge(this.p1, point, true, this.app.activeContext || 0);
    if (faces.length) {
      this.p1 = null;
      this.hint(`Face created. Line: click start point.`);
    } else {
      this.p1 = point.clone();   // chain like SketchUp
    }
    this.lockedAxis = null;
    this.vp.clearPreview();
  }

  onVCB(text) {
    const len = parseLen(text);
    if (len === null || !this.p1 || !this.cur) return;
    const dir = this.cur.clone().sub(this.p1);
    if (dir.lengthSq() < 1e-12) return;
    dir.normalize();
    this.commit(this.p1.clone().add(dir.multiplyScalar(len)));
  }

  onKey(e) {
    if (e.key === "Escape") { this.p1 = null; this.lockedAxis = null; this.vp.clearPreview(); this.hint("Line: click start point."); }
    if (e.key === "ArrowRight") this.lockedAxis = AXES3[0];
    if (e.key === "ArrowLeft") this.lockedAxis = AXES3[1];
    if (e.key === "ArrowUp") this.lockedAxis = AXES3[2];
    if (e.key === "ArrowDown") this.lockedAxis = null;
  }
  cancel() { this.p1 = null; this.lockedAxis = null; super.cancel(); }
}

/* Helpers shared by planar draw tools: figure out the drawing plane
 * (a hovered face, or the ground) and an in-plane basis. */
function planeBasisAt(vp, model, x, y) {
  const snap = vp.snap(x, y);
  if (!snap) return null;
  let normal = new THREE.Vector3(0, 0, 1);
  if (snap.type === "face" && snap.normal) normal = snap.normal.clone();
  let ref = Math.abs(normal.z) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
  if (Math.abs(normal.z) > 0.99) { u.set(1, 0, 0); }   // keep ground drawing axis-aligned
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  return { origin: snap.point.clone(), normal, u, v, snapType: snap.type };
}

/* =================== Rectangle =================== */
class RectTool extends Tool {
  activate() {
    this.basis = null;
    this.hint("Rectangle: click first corner (on ground or on a face).");
    this.vcb("Dimensions", "");
  }
  cursor() { return "crosshair"; }

  planePoint(x, y) {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.basis.normal, this.basis.origin);
    return this.vp.pickPlane(x, y, plane);
  }

  onMove(e, x, y) {
    this.vp.clearPreview();
    if (!this.basis) {
      const snap = this.vp.snap(x, y);
      if (snap) this.vp.showSnapMarker(snap.point, snap.type);
      return;
    }
    const p = this.planePoint(x, y);
    if (!p) return;
    const d = p.clone().sub(this.basis.origin);
    this.a = d.dot(this.basis.u);
    this.b = d.dot(this.basis.v);
    this.vp.previewLoop(this.corners(this.a, this.b), 0x000000);
    this.vcb("Dimensions", `${fmtLen(Math.abs(this.a))} × ${fmtLen(Math.abs(this.b))}`);
  }

  corners(a, b) {
    const { origin, u, v } = this.basis;
    return [
      origin.clone(),
      origin.clone().add(u.clone().multiplyScalar(a)),
      origin.clone().add(u.clone().multiplyScalar(a)).add(v.clone().multiplyScalar(b)),
      origin.clone().add(v.clone().multiplyScalar(b))
    ];
  }

  onDown(e, x, y) {
    if (!this.basis) {
      this.basis = planeBasisAt(this.vp, this.model, x, y);
      if (this.basis) this.hint("Rectangle: click opposite corner, or type “width;depth” + Enter.");
    } else {
      this.commit(this.a, this.b);
    }
  }

  commit(a, b) {
    if (Math.abs(a) < SU_EPS || Math.abs(b) < SU_EPS) return;
    this.app.pushUndo();
    this.model.addFace(this.corners(a, b), null, this.app.activeContext || 0);
    this.basis = null;
    this.vp.clearPreview();
    this.hint("Rectangle created. Click first corner for another.");
  }

  onVCB(text) {
    if (!this.basis) return;
    const parts = text.split(/[;,x]/i).map(s => parseLen(s));
    if (parts.length === 2 && parts[0] !== null && parts[1] !== null) {
      const sa = this.a < 0 ? -1 : 1, sb = this.b < 0 ? -1 : 1;
      this.commit(parts[0] * sa, parts[1] * sb);
    }
  }
  onKey(e) { if (e.key === "Escape") { this.basis = null; this.vp.clearPreview(); } }
  cancel() { this.basis = null; super.cancel(); }
}

/* =================== Circle =================== */
class CircleTool extends Tool {
  activate() {
    this.basis = null;
    this.segments = 24;
    this.hint("Circle: click center point.");
    this.vcb("Radius", "");
  }
  cursor() { return "crosshair"; }

  circlePoints(r) {
    const pts = [];
    const { origin, u, v } = this.basis;
    for (let i = 0; i < this.segments; i++) {
      const a = i / this.segments * Math.PI * 2;
      pts.push(origin.clone()
        .add(u.clone().multiplyScalar(Math.cos(a) * r))
        .add(v.clone().multiplyScalar(Math.sin(a) * r)));
    }
    return pts;
  }

  onMove(e, x, y) {
    this.vp.clearPreview();
    if (!this.basis) {
      const snap = this.vp.snap(x, y);
      if (snap) this.vp.showSnapMarker(snap.point, snap.type);
      return;
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.basis.normal, this.basis.origin);
    const p = this.vp.pickPlane(x, y, plane);
    if (!p) return;
    this.r = p.distanceTo(this.basis.origin);
    if (this.r > SU_EPS) this.vp.previewLoop(this.circlePoints(this.r), 0x000000);
    this.vcb("Radius", fmtLen(this.r));
  }

  onDown(e, x, y) {
    if (!this.basis) {
      this.basis = planeBasisAt(this.vp, this.model, x, y);
      if (this.basis) this.hint("Circle: click to set radius, or type radius + Enter.");
    } else {
      this.commit(this.r);
    }
  }

  commit(r) {
    if (!r || r < SU_EPS) return;
    this.app.pushUndo();
    this.model.addFace(this.circlePoints(r), null, this.app.activeContext || 0);
    this.basis = null;
    this.vp.clearPreview();
    this.hint("Circle created. Click center point for another.");
  }

  onVCB(text) {
    const r = parseLen(text);
    if (r !== null && this.basis) this.commit(r);
  }
  onKey(e) { if (e.key === "Escape") { this.basis = null; this.vp.clearPreview(); } }
  cancel() { this.basis = null; super.cancel(); }
}

/* =================== Push/Pull =================== */
class PushPullTool extends Tool {
  activate() {
    this.active = null;
    this.hint("Push/Pull: click a face, move, click again (or type a distance + Enter).");
    this.vcb("Distance", "");
  }
  cursor() { return "ns-resize"; }

  onMove(e, x, y) {
    if (!this.active) {
      const hit = this.vp.pick(x, y, { edges: false });
      this.vp.setHover(hit ? hit.id : null);
      return;
    }
    this.vp.clearPreview();
    this.dist = this.distFromMouse(x, y);
    this.drawPreview(this.dist);
    this.vcb("Distance", fmtLen(this.dist));
  }

  distFromMouse(x, y) {
    // closest-point parameter t on the extrusion line base + normal*t to the
    // mouse ray: minimizing |(w0 + n t - rd s)|^2 gives t = (b*e - d)/(1 - b^2)
    const { base, normal } = this.active;
    const ray = this.vp.setRay(x, y).ray;
    const w0 = base.clone().sub(ray.origin);
    const b = normal.dot(ray.direction);
    const d = normal.dot(w0), eDot = ray.direction.dot(w0);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-9) return 0;
    return (b * eDot - d) / denom;
  }

  drawPreview(dist) {
    const face = this.model.faces.get(this.active.faceId);
    if (!face) return;
    const loop = face.points();
    const off = this.active.normal.clone().multiplyScalar(dist);
    const loopTop = loop.map(p => p.clone().add(off));
    this.vp.previewLoop(loopTop, 0x1667c9);
    for (let i = 0; i < loop.length; i++) this.vp.previewLine(loop[i], loopTop[i], 0x1667c9);
    const { pts, tris } = faceTriangles(face);
    const positions = [];
    for (const t of tris)
      for (const i of t) {
        const p = pts[i];
        positions.push(p.x + off.x, p.y + off.y, p.z + off.z);
      }
    if (positions.length) this.vp.previewMesh(positions);
  }

  onDown(e, x, y) {
    if (!this.active) {
      const hit = this.vp.pick(x, y, { edges: false });
      if (!hit || hit.type !== "face") return;
      const face = this.model.faces.get(hit.id);
      this.active = { faceId: hit.id, base: hit.point.clone(), normal: face.normal() };
      this.dist = 0;
      this.hint("Push/Pull: move to extrude, click to commit. Esc = cancel.");
    } else {
      this.commit(this.dist);
    }
  }

  commit(dist) {
    const face = this.model.faces.get(this.active && this.active.faceId);
    this.vp.clearPreview();
    if (face && Math.abs(dist) > SU_EPS) {
      this.app.pushUndo();
      this.model.pushpull(face, dist);
    }
    this.active = null;
    this.hint("Push/Pull: click a face.");
    this.vcb("Distance", "");
  }

  onVCB(text) {
    const d = parseLen(text);
    if (d !== null && this.active) this.commit(d);
  }
  onKey(e) {
    if (e.key === "Escape") { this.active = null; this.vp.clearPreview(); this.hint("Push/Pull: click a face."); }
  }
  cancel() { this.active = null; super.cancel(); }
}

/* =================== Move =================== */
class MoveTool extends Tool {
  activate() {
    this.moving = null;
    this.lockedAxis = null;
    this.copyMode = false;
    this.origMoving = null;
    this.lastCopy = null;
    this.hint("Move: click an entity, move, click again. Ctrl = copy. Arrows lock axis. Esc = cancel.");
    this.vcb("Distance", "");
  }
  cursor() { return "move"; }

  /* Ctrl during a move: place a duplicate instead of moving the original */
  toggleCopy() {
    if (!this.moving) return;
    const delta = this.delta ? this.delta.clone() : new THREE.Vector3();
    if (!this.copyMode) {
      // restore the original, spawn a duplicate at the current offset,
      // and continue dragging the duplicate
      const { vertices, orig } = this.moving;
      for (let i = 0; i < vertices.length; i++) vertices[i].pos.copy(orig[i]);
      const mtx = new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z);
      const dup = this.model.duplicateEntities([...this.moving.ids], mtx);
      this.origMoving = this.moving;
      const vertsNew = [...this.model.vertexSetOf(dup.created)];
      this.moving = {
        ids: new Set(dup.created),
        vertices: vertsNew,
        vertexIds: new Set(vertsNew.map(v => v.id)),
        orig: vertsNew.map(v => v.pos.clone().sub(delta)),
        base: this.origMoving.base,
        snapshot: this.origMoving.snapshot,
        dupContainers: dup.containers
      };
      this.copyMode = true;
      this.vp.setSelection([...this.moving.ids]);
      this.model.changed();
      this.hint("⊕ Copy — placing a duplicate. Ctrl again cancels the copy, click places it.");
    } else {
      // drop the duplicate, go back to moving the original
      this.model.eraseEntities([...this.moving.ids]);
      for (const cid of this.moving.dupContainers || []) this.model.containers.delete(cid);
      this.moving = this.origMoving;
      this.origMoving = null;
      this.copyMode = false;
      this.applyDelta(delta);
      this.vp.setSelection([...this.moving.ids]);
      this.hint("Copy cancelled — moving the original again. Ctrl = copy.");
    }
  }

  onDown(e, x, y) {
    if (!this.moving) {
      this.lastCopy = null;   // starting a new operation ends the multiplier window
      const hit = this.vp.pick(x, y);
      if (!hit) return;
      let ids;
      if (this.vp.selection.size && this.vp.selection.has(hit.id)) {
        ids = [...this.vp.selection];
      } else {
        // moving a group moves the whole group; inside an open group,
        // individual pieces move independently
        const res = this.model.resolveInContext(hit.id, this.app.activeContext);
        if (!res || res.kind === "outside") return;
        ids = res.ids;
        this.vp.setSelection(ids);
      }
      const vertices = [...this.model.vertexSetOf(ids)];
      // grab-point inference: picking up at a corner/midpoint of the moved
      // geometry uses that exact point as the base, so drops land exactly
      let base = hit.point.clone();
      const snapBase = this.vp.snap(x, y);
      if (snapBase && (snapBase.type === "endpoint" || snapBase.type === "midpoint")) {
        const p = snapBase.point;
        let ours = vertices.some(v => v.pos.distanceTo(p) < SU_EPS);
        if (!ours && snapBase.type === "midpoint") {
          for (const id of ids) {
            const ed = this.model.edges.get(id);
            if (ed && ed.midpoint().distanceTo(p) < SU_EPS) { ours = true; break; }
          }
        }
        if (ours) base = p.clone();
      }
      this.moving = {
        ids: new Set(ids),
        vertices,
        vertexIds: new Set(vertices.map(v => v.id)),
        orig: vertices.map(v => v.pos.clone()),
        base,
        snapshot: this.model.toJSON()
      };
      this.hint("Move: click destination point. Arrows lock axis. Type distance + Enter.");
    } else {
      this.commit();
    }
  }

  onMove(e, x, y) {
    if (!this.moving) {
      const hit = this.vp.pick(x, y);
      this.vp.setHover(hit ? hit.id : null);
      return;
    }
    this.vp.clearPreview();
    const snap = this.vp.snap(x, y, { skipVertexIds: this.moving.vertexIds, skipEntityIds: this.moving.ids });
    if (!snap) return;
    let delta = snap.point.clone().sub(this.moving.base);
    if (this.lockedAxis) {
      const d = delta.dot(this.lockedAxis.dir);
      delta = this.lockedAxis.dir.clone().multiplyScalar(d);
    }
    this.delta = delta;
    this.applyDelta(delta);
    this.vp.showSnapMarker(this.moving.base.clone().add(delta), snap.type);
    this.vp.previewLine(this.moving.base, this.moving.base.clone().add(delta),
      this.lockedAxis ? this.lockedAxis.color : 0x555555);
    this.vcb("Distance", fmtLen(delta.length()));
  }

  applyDelta(delta) {
    const { vertices, orig } = this.moving;
    for (let i = 0; i < vertices.length; i++)
      vertices[i].pos.copy(orig[i]).add(delta);
    this.model.markGridDirty();   // positions changed under the spatial hash
    this.model.changed();
  }

  commit() {
    if (this.moving) {
      const wasCopy = this.copyMode && this.origMoving && this.delta && this.delta.lengthSq() > 1e-12;
      this.app.pushUndoSnapshot(this.moving.snapshot);
      if (wasCopy) {
        // keep the operation open for the SketchUp array multiplier: x5 or /5
        this.lastCopy = {
          sourceIds: [...this.origMoving.ids],
          delta: this.delta.clone(),
          extraIds: [],
          extraContainers: []
        };
        this.hint("Copy placed — type x5 (row of 5) or /5 (5 evenly spaced) + Enter to multiply.");
        this.vcb("Copies", "");
      } else {
        this.lastCopy = null;
        this.hint("Move: click an entity to move. Ctrl = copy.");
      }
      this.moving = null;
      this.origMoving = null;
      this.copyMode = false;
      this.lockedAxis = null;
      this.vp.clearPreview();
    }
  }

  /* xN: row of N copies at 1d..Nd. /N: N copies at d/N..d. Retype to adjust. */
  applyMultiplier(kind, n) {
    const lc = this.lastCopy;
    if (!lc || !Number.isFinite(n) || n < 1 || n > 500) return;
    if (lc.extraIds.length) {   // retyping replaces the previous array
      this.model.eraseEntities(lc.extraIds);
      for (const cid of lc.extraContainers) this.model.containers.delete(cid);
      lc.extraIds = [];
      lc.extraContainers = [];
    }
    const offsets = [];
    if (kind === "x") {
      for (let k = 2; k <= n; k++) offsets.push(lc.delta.clone().multiplyScalar(k));
    } else {
      for (let k = 1; k < n; k++) offsets.push(lc.delta.clone().multiplyScalar(k / n));
    }
    for (const off of offsets) {
      const m4 = new THREE.Matrix4().makeTranslation(off.x, off.y, off.z);
      const dup = this.model.duplicateEntities(lc.sourceIds, m4);
      lc.extraIds.push(...dup.created);
      lc.extraContainers.push(...dup.containers);
    }
    this.model.changed();
    this.hint(n + (kind === "x" ? " copies in a row" : " copies dividing the distance") +
      " — retype xN or /N to adjust, or start the next operation.");
  }

  abort() {
    if (this.moving) {
      this.model.loadJSON(this.moving.snapshot);
      this.vp.setSelection([]);
      this.moving = null;
      this.origMoving = null;
      this.copyMode = false;
      this.lockedAxis = null;
      this.vp.clearPreview();
    }
  }

  onVCB(text) {
    // array multiplier after a placed copy: x5, 5x, *5, /5
    const mult = /^\s*(?:[x*]\s*(\d+)|(\d+)\s*[x*])\s*$/i.exec(text);
    if (mult && this.lastCopy) { this.applyMultiplier("x", parseInt(mult[1] || mult[2], 10)); return; }
    const div = /^\s*\/\s*(\d+)\s*$/.exec(text);
    if (div && this.lastCopy) { this.applyMultiplier("/", parseInt(div[1], 10)); return; }

    const len = parseLen(text);
    if (len === null || !this.moving || !this.delta || this.delta.lengthSq() < 1e-12) return;
    const dir = this.delta.clone().normalize();
    this.delta = dir.multiplyScalar(len);   // the typed distance IS the delta (multiplier uses it)
    this.applyDelta(this.delta.clone());
    this.commit();
  }

  onKey(e) {
    if (e.key === "Escape") this.abort();
    if (e.key === "Control") this.toggleCopy();
    if (e.key === "ArrowRight") this.lockedAxis = AXES3[0];
    if (e.key === "ArrowLeft") this.lockedAxis = AXES3[1];
    if (e.key === "ArrowUp") this.lockedAxis = AXES3[2];
    if (e.key === "ArrowDown") this.lockedAxis = null;
  }
  cancel() { this.abort(); super.cancel(); }
  deactivate() { this.abort(); super.deactivate(); }
}

/* =================== Rotate =================== */
function rotMatrixAround(center, axis, rad) {
  return new THREE.Matrix4().makeTranslation(center.x, center.y, center.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, rad))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
}

/* Parse '45', '-30', '45°', '90deg' → degrees. */
function parseAngle(str) {
  const m = /^\s*(-?\d*\.?\d+)\s*(?:°|deg(?:rees)?)?\s*$/i.exec(str);
  return m ? parseFloat(m[1]) : null;
}

class RotateTool extends Tool {
  activate() {
    this.stage = 0;          // 0 = place protractor, 1 = reference point, 2 = rotating
    this.sel = null;         // { ids, vertices, vertexIds, orig, snapshot }
    this.origSel = null;
    this.copyMode = false;
    this.center = null;
    this.normal = null;
    this.lockedNormal = null;
    this.startDir = null;
    this.angle = 0;          // degrees
    this.lastRotate = null;  // multiplier window after a rotate-copy
    this.lastXY = null;      // last mouse position, for instant redraw on axis lock
    this.baseNormal = null;  // unlocked plane normal captured at the center click
    this.hint(this.vp.selection.size
      ? "Rotate: click the rotation center. Protractor aligns to faces/ground — arrows lock the axis."
      : "Rotate: click a group or face to rotate (or select first), then click the rotation center.");
    this.vcb("Angle", "");
  }
  cursor() { return "crosshair"; }

  basisFor(normal) {
    const ref = Math.abs(normal.z) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
    if (Math.abs(normal.z) > 0.99) u.set(1, 0, 0);
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    return { u, v };
  }

  protColor(n) {
    if (Math.abs(n.z) > 0.95) return SU_COLORS.axisZ;
    if (Math.abs(n.x) > 0.95) return SU_COLORS.axisX;
    if (Math.abs(n.y) > 0.95) return SU_COLORS.axisY;
    return 0x333333;
  }

  drawProtractor(center, normal) {
    const { u, v } = this.basisFor(normal);
    const r = this.vp.camera.position.distanceTo(center) * 0.07;
    const color = this.protColor(normal);
    const ring = [];
    for (let i = 0; i < 48; i++) {
      const a = i / 48 * Math.PI * 2;
      ring.push(center.clone()
        .add(u.clone().multiplyScalar(Math.cos(a) * r))
        .add(v.clone().multiplyScalar(Math.sin(a) * r)));
    }
    this.vp.previewLoop(ring, color);
    for (let deg = 0; deg < 360; deg += 15) {
      const a = deg * Math.PI / 180;
      const dir = u.clone().multiplyScalar(Math.cos(a)).add(v.clone().multiplyScalar(Math.sin(a)));
      const inner = deg % 90 === 0 ? 0.8 : 0.9;
      this.vp.previewLine(
        center.clone().add(dir.clone().multiplyScalar(r * inner)),
        center.clone().add(dir.multiplyScalar(r)), color);
    }
    return r;
  }

  drawArc(r) {
    if (Math.abs(this.angle) < 0.01) return;
    const steps = Math.max(2, Math.ceil(Math.abs(this.angle) / 5));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = THREE.MathUtils.degToRad(this.angle * i / steps);
      const d = this.startDir.clone().applyAxisAngle(this.normal, a);
      pts.push(this.center.clone().add(d.multiplyScalar(r * 0.65)));
    }
    this.vp.previewPolyline(pts, 0x333333);
  }

  /* Vector from center to the cursor, projected into the rotation plane.
   * Prefers real geometry snaps so exact angles can be picked off model points. */
  pointOnPlane(x, y) {
    const opts = this.sel && this.stage === 2
      ? { skipVertexIds: this.sel.vertexIds, skipEntityIds: this.sel.ids } : {};
    const snap = this.vp.snap(x, y, opts);
    let p = null;
    if (snap && snap.type !== "ground") p = snap.point;
    if (!p) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal, this.center);
      p = this.vp.pickPlane(x, y, plane) || (snap && snap.point);
    }
    if (!p) return null;
    const d = p.clone().sub(this.center);
    return d.sub(this.normal.clone().multiplyScalar(d.dot(this.normal)));
  }

  onMove(e, x, y) {
    this.lastXY = { x, y };   // remembered so arrow keys can redraw in place
    this.vp.clearPreview();
    if (this.stage === 0) {
      if (!this.vp.selection.size) {
        const hit = this.vp.pick(x, y);
        this.vp.setHover(hit ? hit.id : null);
        return;
      }
      const snap = this.vp.snap(x, y);
      if (!snap) return;
      const n = this.lockedNormal || (snap.normal ? snap.normal.clone() : new THREE.Vector3(0, 0, 1));
      this.vp.showSnapMarker(snap.point, snap.type);
      this.drawProtractor(snap.point, n);
    } else if (this.stage === 1) {
      const r = this.drawProtractor(this.center, this.normal);
      const d = this.pointOnPlane(x, y);
      if (!d || d.lengthSq() < 1e-9) return;
      const p = this.center.clone().add(d);
      this.vp.showSnapMarker(p, "axis");
      this.vp.previewLine(this.center, p, 0x555555);
      void r;
    } else {
      const r = this.drawProtractor(this.center, this.normal);
      const d = this.pointOnPlane(x, y);
      if (!d || d.lengthSq() < 1e-9) return;
      const cur = d.clone().normalize();
      let deg = THREE.MathUtils.radToDeg(Math.atan2(
        new THREE.Vector3().crossVectors(this.startDir, cur).dot(this.normal),
        this.startDir.dot(cur)));
      const snapped = Math.round(deg / 15) * 15;
      if (Math.abs(deg - snapped) < 1.5) deg = snapped;   // gentle 15° detents
      this.applyRotation(deg);
      this.vp.previewLine(this.center,
        this.center.clone().add(this.startDir.clone().multiplyScalar(r)), 0x999999);
      this.vp.previewLine(this.center,
        this.center.clone().add(cur.clone().multiplyScalar(r)), this.protColor(this.normal));
      this.drawArc(r);
      this.vcb("Angle", (Math.round(deg * 10) / 10) + "°");
    }
  }

  onDown(e, x, y) {
    if (this.stage === 0) {
      this.lastRotate = null;   // starting a new operation ends the multiplier window
      if (!this.vp.selection.size) {
        const hit = this.vp.pick(x, y);
        if (!hit) { this.hint("Rotate: nothing there — click a group or face to rotate."); return; }
        const res = this.model.resolveInContext(hit.id, this.app.activeContext);
        if (!res || res.kind === "outside") return;
        this.vp.setSelection(res.ids);
        this.hint("Rotate: now click the rotation center (snap to a corner for precision).");
        return;
      }
      const snap = this.vp.snap(x, y);
      if (!snap) return;
      this.center = snap.point.clone();
      this.baseNormal = snap.normal ? snap.normal.clone() : new THREE.Vector3(0, 0, 1);
      this.normal = this.lockedNormal ? this.lockedNormal.clone() : this.baseNormal.clone();
      const ids = [...this.vp.selection];
      const vertices = [...this.model.vertexSetOf(ids)];
      this.sel = {
        ids: new Set(ids),
        vertices,
        vertexIds: new Set(vertices.map(v => v.id)),
        orig: vertices.map(v => v.pos.clone()),
        snapshot: this.model.toJSON()
      };
      this.stage = 1;
      this.hint("Rotate: click a reference point — the zero-angle direction.");
    } else if (this.stage === 1) {
      const d = this.pointOnPlane(x, y);
      if (!d || d.lengthSq() < 1e-6) return;
      this.startDir = d.normalize();
      this.stage = 2;
      this.angle = 0;
      this.hint("Rotate: move to rotate, click to commit. Ctrl = rotate a copy. Type an angle + Enter.");
    } else {
      this.commit();
    }
  }

  applyRotation(deg) {
    this.angle = deg;
    const m = rotMatrixAround(this.center, this.normal, THREE.MathUtils.degToRad(deg));
    const { vertices, orig } = this.sel;
    for (let i = 0; i < vertices.length; i++)
      vertices[i].pos.copy(orig[i]).applyMatrix4(m);
    this.model.markGridDirty();
    this.model.changed();
  }

  /* Ctrl during a rotate: rotate a duplicate instead of the original */
  toggleCopy() {
    if (!this.sel || this.stage < 1) return;
    const m = rotMatrixAround(this.center, this.normal, THREE.MathUtils.degToRad(this.angle || 0));
    if (!this.copyMode) {
      const { vertices, orig } = this.sel;
      for (let i = 0; i < vertices.length; i++) vertices[i].pos.copy(orig[i]);
      const dup = this.model.duplicateEntities([...this.sel.ids], m);
      this.origSel = this.sel;
      const vertsNew = [...this.model.vertexSetOf(dup.created)];
      const inv = m.clone().invert();
      this.sel = {
        ids: new Set(dup.created),
        vertices: vertsNew,
        vertexIds: new Set(vertsNew.map(v => v.id)),
        orig: vertsNew.map(v => v.pos.clone().applyMatrix4(inv)),
        snapshot: this.origSel.snapshot
      };
      this.sel.dupContainers = dup.containers;
      this.copyMode = true;
      this.vp.setSelection([...this.sel.ids]);
      this.model.changed();
      this.hint("⊕ Copy — rotating a duplicate. Ctrl again cancels the copy, click commits.");
    } else {
      this.model.eraseEntities([...this.sel.ids]);
      for (const cid of this.sel.dupContainers || []) this.model.containers.delete(cid);
      this.sel = this.origSel;
      this.origSel = null;
      this.copyMode = false;
      if (this.stage === 2) this.applyRotation(this.angle);
      this.vp.setSelection([...this.sel.ids]);
      this.hint("Copy cancelled — rotating the original again. Ctrl = copy.");
    }
  }

  commit() {
    if (!this.sel) return;
    const wasCopy = this.copyMode && this.origSel && Math.abs(this.angle) > 1e-9;
    this.app.pushUndoSnapshot(this.sel.snapshot);
    if (wasCopy) {
      this.lastRotate = {
        sourceIds: [...this.origSel.ids],
        angle: this.angle,
        center: this.center.clone(),
        normal: this.normal.clone(),
        extraIds: [],
        extraContainers: []
      };
      this.hint("Copy rotated — type x5 (fan of 5) or /5 (5 dividing the angle) + Enter to multiply.");
      this.vcb("Copies", "");
    } else {
      this.lastRotate = null;
      this.hint("Rotate: click the rotation center for the next rotation.");
    }
    this.sel = null;
    this.origSel = null;
    this.copyMode = false;
    this.stage = 0;
    this.center = null;
    this.startDir = null;
    this.angle = 0;
    this.lockedNormal = null;   // axis lock is per-operation, like SketchUp
    this.vp.clearPreview();
  }

  /* xN: fan of N copies at 1a..Na. /N: N copies at a/N..a. Retype to adjust. */
  applyMultiplier(kind, n) {
    const lr = this.lastRotate;
    if (!lr || !Number.isFinite(n) || n < 1 || n > 500) return;
    if (lr.extraIds.length) {
      this.model.eraseEntities(lr.extraIds);
      for (const cid of lr.extraContainers) this.model.containers.delete(cid);
      lr.extraIds = [];
      lr.extraContainers = [];
    }
    const angles = [];
    if (kind === "x") {
      for (let k = 2; k <= n; k++) angles.push(lr.angle * k);
    } else {
      for (let k = 1; k < n; k++) angles.push(lr.angle * k / n);
    }
    for (const a of angles) {
      const m = rotMatrixAround(lr.center, lr.normal, THREE.MathUtils.degToRad(a));
      const dup = this.model.duplicateEntities(lr.sourceIds, m);
      lr.extraIds.push(...dup.created);
      lr.extraContainers.push(...dup.containers);
    }
    this.model.changed();
    this.hint(n + (kind === "x" ? " copies fanned out" : " copies dividing the angle") +
      " — retype xN or /N to adjust, or start the next operation.");
  }

  abort() {
    if (this.sel && (this.stage === 2 || this.copyMode)) {
      this.model.loadJSON(this.sel.snapshot);
      this.vp.setSelection([]);
    }
    this.sel = null;
    this.origSel = null;
    this.copyMode = false;
    this.stage = 0;
    this.center = null;
    this.startDir = null;
    this.angle = 0;
    this.lockedNormal = null;
    this.vp.clearPreview();
  }

  onVCB(text) {
    const mult = /^\s*(?:[x*]\s*(\d+)|(\d+)\s*[x*])\s*$/i.exec(text);
    if (mult && this.lastRotate) { this.applyMultiplier("x", parseInt(mult[1] || mult[2], 10)); return; }
    const div = /^\s*\/\s*(\d+)\s*$/.exec(text);
    if (div && this.lastRotate) { this.applyMultiplier("/", parseInt(div[1], 10)); return; }
    const a = parseAngle(text);
    if (a === null || this.stage !== 2) return;
    this.applyRotation(a);
    this.commit();
  }

  onKey(e) {
    if (e.key === "Escape") { this.abort(); this.hint("Rotate: click the rotation center."); }
    if (e.key === "Control") this.toggleCopy();
    // axis lock: before the center is placed, or while picking the reference
    // point (stage 1) — once rotation starts (stage 2) the plane is fixed
    if (this.stage <= 1) {
      const map = {
        ArrowRight: { dir: new THREE.Vector3(1, 0, 0), name: "red" },
        ArrowLeft: { dir: new THREE.Vector3(0, 1, 0), name: "green" },
        ArrowUp: { dir: new THREE.Vector3(0, 0, 1), name: "blue" }
      };
      let handled = false, name = "";
      if (e.key === "ArrowDown") {
        this.lockedNormal = null;
        handled = true;
      } else if (map[e.key]) {
        const { dir } = map[e.key];
        // pressing the same arrow again unlocks (SketchUp behavior)
        this.lockedNormal = this.lockedNormal && this.lockedNormal.distanceToSquared(dir) < 1e-9
          ? null : dir.clone();
        name = map[e.key].name;
        handled = true;
      }
      if (handled) {
        if (this.stage === 1)
          this.normal = (this.lockedNormal || this.baseNormal || new THREE.Vector3(0, 0, 1)).clone();
        this.hint(this.lockedNormal
          ? "🔒 Rotation plane locked to the " + name + " axis — same arrow or ↓ unlocks."
          : "Protractor unlocked — it aligns to the surface under the cursor again.");
        if (this.lastXY) this.onMove({ shiftKey: false }, this.lastXY.x, this.lastXY.y);
      }
    }
  }
  cancel() { this.abort(); super.cancel(); }
  deactivate() { this.abort(); super.deactivate(); }
}

/* =================== Tape Measure =================== */
class TapeTool extends Tool {
  activate() {
    this.p1 = null;
    this.cur = null;
    this.lockedAxis = null;
    this.axisColor = null;
    this.hint("Tape Measure: click two points to measure — a guide with the distance is added. Arrows lock axis.");
    this.vcb("Length", "");
  }
  cursor() { return "crosshair"; }

  computePoint(x, y) {
    const snap = this.vp.snap(x, y);
    if (!snap) return null;
    let point = snap.point, type = snap.type;
    if (this.p1) {
      const dif = point.clone().sub(this.p1);
      const len = dif.length();
      let axis = this.lockedAxis;
      if (!axis && len > 1e-6 && type !== "endpoint" && type !== "midpoint" && type !== "guidepoint") {
        for (const a of AXES3) {
          const d = Math.abs(dif.dot(a.dir)) / len;
          if (d > 0.9962) { axis = a; break; }
        }
      }
      if (axis) {
        point = this.p1.clone().add(axis.dir.clone().multiplyScalar(dif.dot(axis.dir)));
        type = "axis";
        this.axisColor = axis.color;
      } else {
        this.axisColor = null;
      }
    }
    return { point, type };
  }

  onMove(e, x, y) {
    this.vp.clearPreview();
    const c = this.computePoint(x, y);
    if (!c) return;
    this.cur = c.point;
    this.vp.showSnapMarker(c.point, c.type === "axis" ? "axis" : c.type);
    if (this.p1) {
      this.vp.previewDashedLine(this.p1, c.point, this.axisColor || 0x7d3f9e);
      const d = this.p1.distanceTo(c.point);
      this.vcb("Length", fmtLen(d));
      this.hint("Tape Measure: " + fmtLen(d) + " — click to place a guide, or type an exact length + Enter.");
    }
  }

  onDown(e, x, y) {
    const c = this.computePoint(x, y);
    if (!c) return;
    if (!this.p1) {
      this.p1 = c.point;
      this.hint("Tape Measure: click the end point, or type a distance + Enter for an exact guide.");
    } else {
      this.commit(c.point);
    }
  }

  commit(p2) {
    const d = this.p1.distanceTo(p2);
    if (d < SU_EPS) return;
    this.vp.addGuide(this.p1, p2, fmtLen(d));
    this.hint("Measured " + fmtLen(d) + " — guide added. Edit ▸ Delete Guides removes all guides.");
    this.vcb("Length", fmtLen(d));
    this.p1 = null;
    this.lockedAxis = null;
    this.vp.clearPreview();
  }

  onVCB(text) {
    const len = parseLen(text);
    if (len === null || !this.p1 || !this.cur) return;
    const dir = this.cur.clone().sub(this.p1);
    if (dir.lengthSq() < 1e-12) return;
    dir.normalize();
    this.commit(this.p1.clone().add(dir.multiplyScalar(len)));
  }

  onKey(e) {
    if (e.key === "Escape") { this.p1 = null; this.lockedAxis = null; this.vp.clearPreview(); this.hint("Tape Measure: click the first point."); }
    if (e.key === "ArrowRight") this.lockedAxis = AXES3[0];
    if (e.key === "ArrowLeft") this.lockedAxis = AXES3[1];
    if (e.key === "ArrowUp") this.lockedAxis = AXES3[2];
    if (e.key === "ArrowDown") this.lockedAxis = null;
  }
  cancel() { this.p1 = null; this.lockedAxis = null; super.cancel(); }
}

/* =================== Scale =================== */
class ScaleTool extends Tool {
  activate() {
    this.ids = null;         // entity ids being scaled
    this.grips = null;       // [{ pos, axes: [x?,y?,z?], g: [gx,gy,gz] }]
    this.bbox = null;
    this.hoverGrip = -1;
    this.drag = null;        // { grip, anchor, dir, t0, vertices, orig, snapshot, factors }
    this.aboutCenter = false;
    this.lastScale = null;   // retype window after a commit
    if (this.vp.selection.size) {
      this.setupGrips([...this.vp.selection]);
      this.hint("Scale: drag a green grip — corners scale uniformly, edge/side grips scale 1–2 axes. Ctrl = about center.");
    } else {
      this.hint("Scale: click a group or face to scale (or select first).");
    }
    this.vcb("Scale", "");
    if (this.grips) { this.vp.clearPreview(); this.drawGrips(); }
  }
  cursor() { return "nesw-resize"; }

  setupGrips(ids) {
    this.ids = new Set(ids);
    const box = new THREE.Box3();
    for (const v of this.model.vertexSetOf(ids)) box.expandByPoint(v.pos);
    if (box.isEmpty()) { this.ids = null; this.grips = null; return; }
    this.bbox = box;
    const size = box.getSize(new THREE.Vector3());
    this.grips = [];
    const seen = new Set();
    for (const gx of [0, 0.5, 1]) for (const gy of [0, 0.5, 1]) for (const gz of [0, 0.5, 1]) {
      if (gx === 0.5 && gy === 0.5 && gz === 0.5) continue;
      const axes = [
        gx !== 0.5 && size.x > SU_EPS,
        gy !== 0.5 && size.y > SU_EPS,
        gz !== 0.5 && size.z > SU_EPS
      ];
      if (!axes.some(Boolean)) continue;
      const pos = new THREE.Vector3(
        box.min.x + gx * size.x, box.min.y + gy * size.y, box.min.z + gz * size.z);
      const key = pos.toArray().map(n => Math.round(n / SU_EPS)).join("_");
      if (seen.has(key)) continue;   // flat geometry collapses duplicate grips
      seen.add(key);
      this.grips.push({ pos, axes, g: [gx, gy, gz] });
    }
  }

  mirrorAnchor(grip) {
    const b = this.bbox;
    return new THREE.Vector3(
      b.min.x + (1 - grip.g[0]) * (b.max.x - b.min.x),
      b.min.y + (1 - grip.g[1]) * (b.max.y - b.min.y),
      b.min.z + (1 - grip.g[2]) * (b.max.z - b.min.z));
  }

  drawGrips() {
    if (!this.grips || !this.bbox) return;
    this.vp.previewGroup.add(new THREE.Box3Helper(this.bbox.clone(), 0x43a047));
    this.grips.forEach((g, i) => {
      const s = Math.max(this.vp.camera.position.distanceTo(g.pos) * 0.008, 0.05);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshBasicMaterial({ color: i === this.hoverGrip ? 0xe53935 : 0x2ecc40, depthTest: false }));
      mesh.renderOrder = 10;
      mesh.position.copy(g.pos);
      this.vp.previewGroup.add(mesh);
    });
  }

  nearestGrip(x, y) {
    let best = -1, bd = 14;
    this.grips.forEach((g, i) => {
      const s = this.vp.worldToScreen(g.pos);
      if (s.behind) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  onMove(e, x, y) {
    if (this.drag) { this.updateDrag(e, x, y); return; }
    this.vp.clearPreview();
    if (!this.grips) {
      const hit = this.vp.pick(x, y);
      this.vp.setHover(hit ? hit.id : null);
      return;
    }
    this.hoverGrip = this.nearestGrip(x, y);
    this.drawGrips();
  }

  onDown(e, x, y) {
    if (this.drag) { this.commit(); return; }
    if (this.grips && this.hoverGrip >= 0) { this.startDrag(this.hoverGrip); return; }
    const hit = this.vp.pick(x, y);
    if (!hit) return;
    const res = this.model.resolveInContext(hit.id, this.app.activeContext);
    if (!res || res.kind === "outside") return;
    this.vp.setSelection(res.ids);
    this.setupGrips(res.ids);
    this.vp.clearPreview();
    this.drawGrips();
    this.hint("Scale: drag a green grip — corners = uniform, sides = one axis. Ctrl = about center.");
  }

  startDrag(i) {
    const grip = this.grips[i];
    const anchor = this.aboutCenter ? this.bbox.getCenter(new THREE.Vector3()) : this.mirrorAnchor(grip);
    const dir = grip.pos.clone().sub(anchor);
    const t0 = dir.length();
    if (t0 < SU_EPS) return;
    const ids = [...this.ids];
    const vertices = [...this.model.vertexSetOf(ids)];
    this.lastScale = null;
    this.drag = {
      grip,
      anchor,
      dir: dir.multiplyScalar(1 / t0),
      t0,
      vertices,
      orig: vertices.map(v => v.pos.clone()),
      snapshot: this.model.toJSON(),
      factors: null
    };
    this.hint("Scale: move to scale, click to commit — or type a factor + Enter (e.g. 1.5 or 2,0.5). Ctrl = about center, Shift = uniform.");
  }

  scaleMatrix(f) {
    const a = this.drag ? this.drag.anchor : this.lastScale.anchor;
    return new THREE.Matrix4().makeTranslation(a.x, a.y, a.z)
      .multiply(new THREE.Matrix4().makeScale(f[0], f[1], f[2]))
      .multiply(new THREE.Matrix4().makeTranslation(-a.x, -a.y, -a.z));
  }

  applyFactors(f) {
    const m = this.scaleMatrix(f);
    const { vertices, orig } = this.drag || this.lastScale;
    for (let i = 0; i < vertices.length; i++)
      vertices[i].pos.copy(orig[i]).applyMatrix4(m);
    this.model.markGridDirty();
    this.model.changed();
    return m;
  }

  updateDrag(e, x, y) {
    const d = this.drag;
    // parameter t along the anchor→grip line closest to the mouse ray
    const ray = this.vp.setRay(x, y).ray;
    const w0 = d.anchor.clone().sub(ray.origin);
    const b = d.dir.dot(ray.direction);
    const dd = d.dir.dot(w0), ee = ray.direction.dot(w0);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-9) return;
    let s = ((b * ee - dd) / denom) / d.t0;
    if (Math.abs(s) < 0.01) s = s < 0 ? -0.01 : 0.01;   // don't collapse through zero
    const f = d.grip.axes.map(a => (a || e.shiftKey) ? s : 1);
    d.factors = f;
    const m = this.applyFactors(f);
    this.vp.clearPreview();
    this.vp.previewGroup.add(new THREE.Box3Helper(this.bbox.clone().applyMatrix4(m), 0x43a047));
    this.vp.previewLine(d.anchor, d.grip.pos.clone().applyMatrix4(m), 0x43a047);
    this.vp.showSnapMarker(d.anchor, "endpoint");
    this.vcb("Scale", (Math.round(s * 1000) / 1000).toString());
  }

  commit() {
    const d = this.drag;
    if (!d) return;
    if (!d.factors) { this.abortDrag(); return; }   // clicked without moving
    this.app.pushUndoSnapshot(d.snapshot);
    this.lastScale = { vertices: d.vertices, orig: d.orig, anchor: d.anchor.clone(), axes: d.grip.axes.slice() };
    this.drag = null;
    this.setupGrips([...this.ids]);
    this.vp.clearPreview();
    this.drawGrips();
    this.hint("Scaled ✓ — type a factor + Enter to adjust it, or drag another grip.");
    this.vcb("Scale", "");
  }

  abortDrag() {
    if (!this.drag) return;
    const { vertices, orig } = this.drag;
    for (let i = 0; i < vertices.length; i++) vertices[i].pos.copy(orig[i]);
    this.model.markGridDirty();
    this.model.changed();
    this.drag = null;
    this.vp.clearPreview();
    this.drawGrips();
  }

  factorsFromTyped(parts, axes) {
    if (parts.some(p => Math.abs(p) < 0.001)) return null;   // 0 would flatten it
    if (parts.length === 1) return axes.map(a => a ? parts[0] : 1);
    let k = 0;
    return axes.map(a => a ? (parts[Math.min(k++, parts.length - 1)]) : 1);
  }

  onVCB(text) {
    const parts = text.split(/[,;]/).map(t => parseFloat(t.trim())).filter(n => Number.isFinite(n));
    if (!parts.length) return;
    if (this.drag) {
      const f = this.factorsFromTyped(parts, this.drag.grip.axes);
      if (!f) { this.hint("Scale factor can't be 0."); return; }
      this.drag.factors = f;
      this.applyFactors(f);
      this.commit();
    } else if (this.lastScale) {
      const f = this.factorsFromTyped(parts, this.lastScale.axes);
      if (!f) { this.hint("Scale factor can't be 0."); return; }
      this.applyFactors(f);
      this.setupGrips([...this.ids]);
      this.vp.clearPreview();
      this.drawGrips();
      this.hint("Scale adjusted to " + parts.join(" × ") + " — retype to adjust again.");
    }
  }

  onKey(e) {
    if (e.key === "Escape") {
      if (this.drag) { this.abortDrag(); this.hint("Scale cancelled."); }
      else { this.ids = null; this.grips = null; this.lastScale = null; this.vp.setSelection([]); this.vp.clearPreview(); this.hint("Scale: click a group or face to scale."); }
    }
    if (e.key === "Control") {
      this.aboutCenter = !this.aboutCenter;
      if (this.drag) {
        const d = this.drag;
        const anchor = this.aboutCenter ? this.bbox.getCenter(new THREE.Vector3()) : this.mirrorAnchor(d.grip);
        const dir = d.grip.pos.clone().sub(anchor);
        const t0 = dir.length();
        if (t0 > SU_EPS) {
          d.anchor = anchor;
          d.dir = dir.multiplyScalar(1 / t0);
          d.t0 = t0;
          if (d.factors) this.applyFactors(d.factors);
        }
      }
      this.hint(this.aboutCenter
        ? "⊙ Scaling about the center — Ctrl again scales about the opposite grip."
        : "Scaling about the opposite corner/side — Ctrl = about center.");
    }
  }
  cancel() { this.abortDrag(); super.cancel(); }
  deactivate() { this.abortDrag(); super.deactivate(); }
}

/* =================== Offset =================== */
function polyArea2(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

class OffsetTool extends Tool {
  activate() {
    this.active = null;   // { face, loop, normal, plane, u, v, poly2, inwardSign }
    this.dist = 0;
    this.hint("Offset: click a face, move inward or outward, click to commit (or type a distance + Enter).");
    this.vcb("Distance", "");
  }
  cursor() { return "crosshair"; }

  onMove(e, x, y) {
    if (!this.active) {
      const hit = this.vp.pick(x, y, { edges: false });
      this.vp.setHover(hit ? hit.id : null);
      return;
    }
    this.vp.clearPreview();
    const p = this.vp.pickPlane(x, y, this.active.plane);
    if (!p) return;
    this.dist = this.signedDist(p);
    const pts = this.offsetPoints(this.dist);
    if (pts) this.vp.previewLoop(pts, 0x1667c9);
    this.vcb("Distance", fmtLen(Math.abs(this.dist)));
    this.hint("Offset " + fmtLen(Math.abs(this.dist)) + (this.dist >= 0 ? " inward" : " outward") +
      " — click to commit, or type an exact distance + Enter.");
  }

  onDown(e, x, y) {
    if (!this.active) {
      const hit = this.vp.pick(x, y, { edges: false });
      if (!hit || hit.type !== "face") return;
      const face = this.model.faces.get(hit.id);
      if (!face || face.loop.length < 3) return;
      const loop = face.points().map(p => p.clone());
      const normal = face.normal();
      const ref = Math.abs(normal.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(normal, ref).normalize();
      const v = new THREE.Vector3().crossVectors(normal, u);
      const to2 = q => [q.dot(u), q.dot(v)];
      const poly2 = loop.map(to2);
      // does cross(normal, edge) point into the polygon? probe just inside edge 0
      let minEdge = Infinity;
      for (let i = 0; i < loop.length; i++)
        minEdge = Math.min(minEdge, loop[i].distanceTo(loop[(i + 1) % loop.length]));
      const step = Math.max(Math.min(minEdge * 0.05, 1), 0.01);
      const e0 = loop[1].clone().sub(loop[0]).normalize();
      const nIn = new THREE.Vector3().crossVectors(normal, e0);
      const probe = loop[0].clone().add(loop[1]).multiplyScalar(0.5).add(nIn.clone().multiplyScalar(step));
      const inwardSign = pointInPoly2(to2(probe), poly2, 1e-9) ? 1 : -1;
      this.active = {
        face, loop, normal, u, v, poly2, inwardSign,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, loop[0])
      };
      this.dist = 0;
      this.hint("Offset: move inward or outward, click to commit. Type a distance + Enter.");
    } else {
      this.commit(this.dist);
    }
  }

  /* Signed distance from a point (in the face plane) to the boundary: + inside, − outside */
  signedDist(p) {
    const { loop, poly2, u, v } = this.active;
    let dmin = Infinity;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < loop.length; i++) {
      const seg = new THREE.Line3(loop[i], loop[(i + 1) % loop.length]);
      seg.closestPointToPoint(p, true, tmp);
      dmin = Math.min(dmin, tmp.distanceTo(p));
    }
    return pointInPoly2([p.dot(u), p.dot(v)], poly2, 1e-9) ? dmin : -dmin;
  }

  /* Miter-offset the loop by d (+ inward, − outward) */
  offsetPoints(d) {
    if (Math.abs(d) < SU_EPS) return null;
    const { loop, normal, inwardSign, u, v } = this.active;
    const n = loop.length;
    const out = [];
    const c2 = (a, b) => a[0] * b[1] - a[1] * b[0];
    for (let i = 0; i < n; i++) {
      const p = loop[i];
      const ePrev = p.clone().sub(loop[(i - 1 + n) % n]).normalize();
      const eNext = loop[(i + 1) % n].clone().sub(p).normalize();
      const nPrev = new THREE.Vector3().crossVectors(normal, ePrev).multiplyScalar(inwardSign);
      const nNext = new THREE.Vector3().crossVectors(normal, eNext).multiplyScalar(inwardSign);
      const A = p.clone().add(nPrev.multiplyScalar(d));
      const B = p.clone().add(nNext.multiplyScalar(d));
      const d1 = [ePrev.dot(u), ePrev.dot(v)], d2 = [eNext.dot(u), eNext.dot(v)];
      const denom = c2(d1, d2);
      if (Math.abs(denom) < 1e-9) { out.push(A); continue; }   // straight-through vertex
      const ab = [B.dot(u) - A.dot(u), B.dot(v) - A.dot(v)];
      const t = c2(ab, d2) / denom;
      out.push(A.add(ePrev.clone().multiplyScalar(t)));
    }
    return out;
  }

  commit(d) {
    const a = this.active;
    this.vp.clearPreview();
    if (!a || Math.abs(d) < SU_EPS) { this.active = null; return; }
    const pts = this.offsetPoints(d);
    if (!pts) { this.active = null; return; }
    const to2 = q => [q.dot(a.u), q.dot(a.v)];
    const A0 = polyArea2(a.poly2), A1 = polyArea2(pts.map(to2));
    if (!Number.isFinite(A1) || A0 * A1 <= 0 || Math.abs(A1) < 1e-6) {
      this.hint("Offset too large — the loop would fold over itself. Try a smaller distance.");
      return;   // stay active so the distance can be adjusted
    }
    this.app.pushUndo();
    this.model.addFace(pts, null, a.face.cid);
    this.active = null;
    this.dist = 0;
    this.hint(d > 0
      ? "Offset " + fmtLen(d) + " inward ✓ — inner face + ring created. Push/Pull the ring to make walls."
      : "Offset " + fmtLen(-d) + " outward ✓ — outer loop created.");
    this.vcb("Distance", "");
  }

  onVCB(text) {
    const len = parseLen(text);
    if (len === null || !this.active) return;
    const sign = this.dist < 0 ? -1 : 1;   // keep the side the mouse is on
    this.commit(sign * Math.abs(len));
  }

  onKey(e) {
    if (e.key === "Escape") { this.active = null; this.dist = 0; this.vp.clearPreview(); this.hint("Offset: click a face."); }
  }
  cancel() { this.active = null; super.cancel(); }
}

/* =================== Arc (3-point: start, end, bulge) =================== */
class ArcTool extends Tool {
  activate() {
    this.stage = 0;        // 0 = start point, 1 = end point, 2 = bulge
    this.p1 = null;
    this.p2 = null;
    this.basis = null;     // drawing plane from the first click
    this.bulge = 0;
    this.cur = null;
    if (!this.segments) this.segments = 12;
    this.hint("Arc: click the start point (on a face or the ground).");
    this.vcb("Length", "");
  }
  cursor() { return "crosshair"; }

  /* points along the arc through p1→p2 bulging by `bulge` along `perp` */
  arcPoints(bulge) {
    const { p1, p2 } = this;
    const chord = p2.clone().sub(p1);
    const c = chord.length();
    if (c < SU_EPS || Math.abs(bulge) < SU_EPS) return null;
    const uAxis = chord.multiplyScalar(1 / c);
    const perp = new THREE.Vector3().crossVectors(this.basis.normal, uAxis).normalize();
    const h = Math.abs(bulge);
    const R = h / 2 + (c * c) / (8 * h);
    const sign = bulge >= 0 ? 1 : -1;
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    const center = mid.clone().add(perp.clone().multiplyScalar(sign * (h - R)));
    const ang = p => {
      const d = p.clone().sub(center);
      return Math.atan2(d.dot(perp), d.dot(uAxis));
    };
    const a1 = ang(p1), a2 = ang(p2);
    const peak = mid.clone().add(perp.clone().multiplyScalar(sign * h));
    const aPeak = ang(peak);
    const TAU = Math.PI * 2;
    const ccw = (a2 - a1 + TAU) % TAU;
    const peakInCcw = (aPeak - a1 + TAU) % TAU < ccw;
    const delta = peakInCcw ? ccw : ccw - TAU;
    const pts = [p1.clone()];
    for (let i = 1; i < this.segments; i++) {
      const a = a1 + delta * i / this.segments;
      pts.push(center.clone()
        .add(uAxis.clone().multiplyScalar(Math.cos(a) * R))
        .add(perp.clone().multiplyScalar(Math.sin(a) * R)));
    }
    pts.push(p2.clone());
    return pts;
  }

  planePoint(x, y) {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.basis.normal, this.basis.origin);
    return this.vp.pickPlane(x, y, plane);
  }

  onMove(e, x, y) {
    this.vp.clearPreview();
    if (this.stage === 0) {
      const snap = this.vp.snap(x, y);
      if (snap) this.vp.showSnapMarker(snap.point, snap.type);
    } else if (this.stage === 1) {
      const snap = this.vp.snap(x, y);
      if (!snap) return;
      // stay in the drawing plane
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.basis.normal, this.basis.origin);
      const p = plane.projectPoint(snap.point, new THREE.Vector3());
      this.cur = p;
      this.vp.showSnapMarker(p, snap.type);
      this.vp.previewLine(this.p1, p, 0x555555);
      this.vcb("Length", fmtLen(this.p1.distanceTo(p)));
    } else {
      const p = this.planePoint(x, y);
      if (!p) return;
      const chord = this.p2.clone().sub(this.p1);
      const uAxis = chord.clone().normalize();
      const perp = new THREE.Vector3().crossVectors(this.basis.normal, uAxis).normalize();
      const mid = this.p1.clone().add(this.p2).multiplyScalar(0.5);
      this.bulge = p.clone().sub(mid).dot(perp);
      const pts = this.arcPoints(this.bulge);
      this.vp.previewDashedLine(this.p1, this.p2, 0xaaaaaa);
      if (pts) this.vp.previewPolyline(pts, 0x000000);
      this.vcb("Bulge", fmtLen(Math.abs(this.bulge)));
      this.hint("Arc: click to commit — or type a bulge + Enter, or segments like 20s (now " + this.segments + ").");
    }
  }

  onDown(e, x, y) {
    if (this.stage === 0) {
      this.basis = planeBasisAt(this.vp, this.model, x, y);
      if (!this.basis) return;
      this.p1 = this.basis.origin.clone();
      this.stage = 1;
      this.hint("Arc: click the end point of the chord (type a length + Enter for exact).");
    } else if (this.stage === 1) {
      if (!this.cur || this.cur.distanceTo(this.p1) < SU_EPS) return;
      this.p2 = this.cur.clone();
      this.stage = 2;
      this.hint("Arc: move to bow the arc out, click to commit. Type a bulge + Enter.");
      this.vcb("Bulge", "");
    } else {
      this.commit();
    }
  }

  commit() {
    const pts = this.arcPoints(this.bulge);
    if (!pts) return;
    this.app.pushUndo();
    this.model.beginBatch();
    const cid = this.app.activeContext || 0;
    for (let i = 0; i < pts.length - 1; i++)
      this.model.addEdge(pts[i], pts[i + 1], true, cid);
    this.model.endBatch();
    this.stage = 0;
    this.p1 = this.p2 = this.cur = null;
    this.bulge = 0;
    this.vp.clearPreview();
    this.hint("Arc created (" + this.segments + " segments). Click a start point for another.");
    this.vcb("Length", "");
  }

  onVCB(text) {
    const seg = /^\s*(\d+)\s*s\s*$/i.exec(text);
    if (seg) {
      const n = parseInt(seg[1], 10);
      if (n >= 2 && n <= 200) {
        this.segments = n;
        this.hint("Arc segments: " + n);
        if (this.stage === 2) {
          this.vp.clearPreview();
          const pts = this.arcPoints(this.bulge);
          this.vp.previewDashedLine(this.p1, this.p2, 0xaaaaaa);
          if (pts) this.vp.previewPolyline(pts, 0x000000);
        }
      }
      return;
    }
    const len = parseLen(text);
    if (len === null) return;
    if (this.stage === 1 && this.cur) {
      const dir = this.cur.clone().sub(this.p1);
      if (dir.lengthSq() < 1e-12) return;
      this.p2 = this.p1.clone().add(dir.normalize().multiplyScalar(len));
      this.stage = 2;
      this.hint("Arc: move to bow the arc out, click to commit. Type a bulge + Enter.");
      this.vcb("Bulge", "");
    } else if (this.stage === 2) {
      const sign = this.bulge < 0 ? -1 : 1;
      this.bulge = sign * Math.abs(len);
      this.commit();
    }
  }

  onKey(e) {
    if (e.key === "Escape") {
      this.stage = 0;
      this.p1 = this.p2 = this.cur = null;
      this.bulge = 0;
      this.vp.clearPreview();
      this.hint("Arc: click the start point.");
    }
  }
  cancel() { this.stage = 0; this.p1 = this.p2 = null; super.cancel(); }
}

/* =================== Follow Me =================== */
class FollowMeTool extends Tool {
  activate() {
    const nEdges = [...this.vp.selection].filter(id => this.model.edges.get(id)).length;
    this.hint(nEdges
      ? "Follow Me: path of " + nEdges + " edge" + (nEdges === 1 ? "" : "s") + " selected — click the profile face to extrude it along the path."
      : "Follow Me: first select the path edges (Select tool), then click the profile face.");
  }
  cursor() { return "crosshair"; }

  onMove(e, x, y) {
    const hit = this.vp.pick(x, y, { edges: false });
    this.vp.setHover(hit ? hit.id : null);
  }

  /* Order selected edges into a polyline. Returns { pts } or an error string. */
  orderPath(edgeIds, near) {
    const edges = edgeIds.map(id => this.model.edges.get(id)).filter(Boolean);
    if (!edges.length) return "Select the path edges first, then click the profile face.";
    const adj = new Map();
    for (const e of edges) {
      for (const [a, b] of [[e.v1, e.v2], [e.v2, e.v1]]) {
        if (!adj.has(a.id)) adj.set(a.id, []);
        adj.get(a.id).push({ v: a, other: b, edge: e });
      }
    }
    if ([...adj.values()].some(l => l.length > 2)) return "The path branches — select a single chain of edges.";
    const ends = [...adj.values()].filter(l => l.length === 1).map(l => l[0].v);
    if (ends.length === 0) return "Closed-loop paths aren't supported yet — leave a gap in the path.";
    // start from the end nearest the profile
    let start = ends[0];
    if (near && ends[1] && ends[1].pos.distanceTo(near) < ends[0].pos.distanceTo(near)) start = ends[1];
    const pts = [start.pos.clone()];
    let cur = start, prevEdge = null;
    for (let guard = 0; guard <= edges.length + 1; guard++) {
      const nexts = (adj.get(cur.id) || []).filter(x => x.edge !== prevEdge);
      if (!nexts.length) break;
      prevEdge = nexts[0].edge;
      cur = nexts[0].other;
      pts.push(cur.pos.clone());
    }
    if (pts.length !== edges.length + 1) return "The path isn't a connected chain of edges.";
    return { pts };
  }

  onDown(e, x, y) {
    const hit = this.vp.pick(x, y, { edges: false });
    if (!hit || hit.type !== "face") return;
    const face = this.model.faces.get(hit.id);
    if (!face) return;
    const pathIds = [...this.vp.selection].filter(id => {
      const ed = this.model.edges.get(id);
      return ed && !face.loop.some((v, i) =>
        (ed.v1 === v && ed.v2 === face.loop[(i + 1) % face.loop.length]) ||
        (ed.v2 === v && ed.v1 === face.loop[(i + 1) % face.loop.length]));
    });
    const centroid = face.center();
    const path = this.orderPath(pathIds, centroid);
    if (typeof path === "string") { this.hint("Follow Me: " + path); return; }
    const snapshot = this.model.toJSON();
    try {
      const made = this.sweep(face, path.pts);
      this.app.pushUndoSnapshot(snapshot);
      this.vp.setSelection([]);
      this.hint("Follow Me ✓ — profile swept along " + (path.pts.length - 1) + " segments, " + made + " faces created.");
    } catch (err) {
      this.model.loadJSON(snapshot);
      this.hint("Follow Me: " + (err.suMessage || "the path turns back on itself too sharply — soften the corner or shorten the profile."));
    }
  }

  /* Sweep the profile ring along the path with mitered joints:
   * each ring is the previous ring projected along the segment
   * direction onto the bisecting plane at the next path point. */
  sweep(face, pathPts) {
    const cid = face.cid;
    const color = face.color;
    let ring = face.points().map(p => p.clone());
    // dedupe consecutive identical path points, build segment directions
    const pts = [pathPts[0]];
    for (const p of pathPts) if (p.distanceTo(pts[pts.length - 1]) > SU_EPS) pts.push(p);
    const dirs = [];
    for (let i = 0; i < pts.length - 1; i++)
      dirs.push(pts[i + 1].clone().sub(pts[i]).normalize());
    if (!dirs.length) { const e = new Error(); e.suMessage = "the path has no length."; throw e; }
    let made = 0;
    this.model.beginBatch();
    try {
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        const isLast = i === dirs.length - 1;
        let nrm = isLast ? d.clone() : d.clone().add(dirs[i + 1]);
        if (nrm.lengthSq() < 1e-9) { const e = new Error(); e.suMessage = "the path reverses on itself."; throw e; }
        nrm.normalize();
        const dot = d.dot(nrm);
        if (Math.abs(dot) < 0.1) { const e = new Error(); e.suMessage = "a corner in the path is too sharp to miter."; throw e; }
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, pts[i + 1]);
        const newRing = ring.map(v => v.clone().add(d.clone().multiplyScalar(-plane.distanceToPoint(v) / dot)));
        for (let k = 0; k < ring.length; k++) {
          const k2 = (k + 1) % ring.length;
          const quad = [ring[k], ring[k2], newRing[k2], newRing[k]];
          if (new Set(quad.map(q => q.toArray().map(n => Math.round(n / SU_EPS)).join("_"))).size >= 3) {
            if (this.model.addFace(quad, color, cid)) made++;
          }
        }
        ring = newRing;
      }
      if (this.model.addFace(ring, color, cid)) made++;   // end cap
    } finally {
      this.model.endBatch();
    }
    return made;
  }

  onKey(e) {
    if (e.key === "Escape") { this.vp.setSelection([]); this.hint("Follow Me: select path edges, then click the profile face."); }
  }
}

/* =================== Eraser =================== */
class EraserTool extends Tool {
  activate() {
    this.stroking = false;
    this.pushed = false;
    this.hint("Eraser: click or drag across edges and faces to erase.");
  }
  cursor() { return "cell"; }
  eraseAt(x, y) {
    const hit = this.vp.pick(x, y);
    if (hit) {
      if (!this.pushed) { this.app.pushUndo(); this.pushed = true; }
      // erasing a group erases the whole group; inside an open group,
      // the eraser works piece by piece
      const res = this.model.resolveInContext(hit.id, this.app.activeContext);
      if (!res || res.kind === "outside") return;
      this.model.eraseEntities(res.ids);
      res.ids.forEach(id => this.vp.selection.delete(id));
    }
  }
  onDown(e, x, y) { this.stroking = true; this.pushed = false; this.eraseAt(x, y); }
  onMove(e, x, y) {
    if (this.stroking) this.eraseAt(x, y);
    else { const hit = this.vp.pick(x, y); this.vp.setHover(hit ? hit.id : null); }
  }
  onUp() { this.stroking = false; }
}

/* =================== Paint =================== */
class PaintTool extends Tool {
  activate() {
    this.hint("Paint: pick a color in the Materials panel, then click faces.");
    this.app.showPalette(true);
  }
  deactivate() { this.app.showPalette(false); super.deactivate(); }
  cursor() { return "copy"; }
  onMove(e, x, y) {
    const hit = this.vp.pick(x, y, { edges: false });
    this.vp.setHover(hit ? hit.id : null);
  }
  onDown(e, x, y) {
    const hit = this.vp.pick(x, y, { edges: false });
    if (hit && hit.type === "face") {
      const face = this.model.faces.get(hit.id);
      if (face) {
        this.app.pushUndo();
        face.color = this.app.currentColor;
        this.model.changed();
      }
    }
  }
}

/* =================== Orbit / Pan =================== */
class OrbitTool extends Tool {
  activate() { this.hint("Orbit: drag to orbit the camera. (Middle mouse orbits in any tool.)"); this.drag = null; }
  cursor() { return "grab"; }
  onDown(e, x, y) { this.drag = { x, y }; }
  onMove(e, x, y) {
    if (this.drag) { this.vp.orbitBy(x - this.drag.x, y - this.drag.y); this.drag = { x, y }; }
  }
  onUp() { this.drag = null; }
}

class PanTool extends Tool {
  activate() { this.hint("Pan: drag to pan the camera. (Shift+middle mouse pans in any tool.)"); this.drag = null; }
  cursor() { return "grab"; }
  onDown(e, x, y) { this.drag = { x, y }; }
  onMove(e, x, y) {
    if (this.drag) { this.vp.panBy(x - this.drag.x, y - this.drag.y); this.drag = { x, y }; }
  }
  onUp() { this.drag = null; }
}

/* =================== Tool manager =================== */
class ToolManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.tools = {
      select: new SelectTool(ctx),
      line: new LineTool(ctx),
      rect: new RectTool(ctx),
      circle: new CircleTool(ctx),
      pushpull: new PushPullTool(ctx),
      move: new MoveTool(ctx),
      rotate: new RotateTool(ctx),
      scale: new ScaleTool(ctx),
      offset: new OffsetTool(ctx),
      arc: new ArcTool(ctx),
      followme: new FollowMeTool(ctx),
      tape: new TapeTool(ctx),
      eraser: new EraserTool(ctx),
      paint: new PaintTool(ctx),
      orbit: new OrbitTool(ctx),
      pan: new PanTool(ctx)
    };
    this.current = null;
    this.currentName = null;

    const el = ctx.viewport.renderer.domElement;
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !this.current) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      this.current.onDown(e, e.clientX, e.clientY);
    });
    el.addEventListener("pointermove", e => {
      if (this.current) this.current.onMove(e, e.clientX, e.clientY);
    });
    el.addEventListener("pointerup", e => {
      if (e.button === 0 && this.current) this.current.onUp(e, e.clientX, e.clientY);
    });
    // pointerdown.detail is always 0 per spec — double-clicks must come from
    // the native dblclick event
    el.addEventListener("dblclick", e => {
      if (this.current && this.current.onDblClick) this.current.onDblClick(e, e.clientX, e.clientY);
    });
  }

  activate(name) {
    if (this.current) this.current.deactivate();
    this.currentName = name;
    this.current = this.tools[name];
    this.current.activate();
    this.ctx.viewport.renderer.domElement.style.cursor = this.current.cursor();
    this.ctx.app.markActiveTool(name);
  }

  key(e) { if (this.current) this.current.onKey(e); }
  vcbSubmit(text) { if (this.current) this.current.onVCB(text); }
}
