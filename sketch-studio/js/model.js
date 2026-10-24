/* ============================================================
 * model.js — SketchUp-style boundary-representation kernel.
 * Entities: shared vertices, edges, faces (planar loops).
 * Closing a loop of coplanar edges auto-creates a face,
 * push/pull extrudes a face into a solid, like SketchUp.
 * Units are inches (like real SketchUp). Z is up.
 *
 * Indexed for large scripted models: O(1) vertex merge lookup
 * (spatial hash), O(1) edge/face dedup lookup, incremental
 * vertex→edge adjacency, and batched change notification so a
 * script triggers a single scene rebuild.
 * ============================================================ */
"use strict";

const SU_EPS = 1e-3;          // vertex merge tolerance (0.001 in ≈ 0.025 mm)
const SU_PLANE_TOL = 1e-2;    // coplanarity tolerance for auto-facing (0.01 in)

function newellNormal(pts) {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n;
}

class SUVertex {
  constructor(id, pos, cid = 0) { this.id = id; this.pos = pos.clone(); this.cid = cid; }
}

class SUEdge {
  constructor(id, v1, v2, cid = 0) { this.id = id; this.v1 = v1; this.v2 = v2; this.cid = cid; this.type = "edge"; }
  get length() { return this.v1.pos.distanceTo(this.v2.pos); }
  midpoint() { return this.v1.pos.clone().add(this.v2.pos).multiplyScalar(0.5); }
  hasVertex(v) { return this.v1 === v || this.v2 === v; }
}

class SUFace {
  constructor(id, loop, color, cid = 0) {
    this.id = id;
    this.loop = loop;          // SUVertex[] ordered outer perimeter
    this.holes = [];           // SUVertex[][] — cut openings (windows/doors)
    this.color = color || null; // "#rrggbb" or null for default
    this.cid = cid;            // container (group) id, 0 = loose geometry
    this.type = "face";
  }
  points() { return this.loop.map(v => v.pos); }
  allVertices() { return this.loop.concat(...this.holes); }
  normal() {
    const n = newellNormal(this.points());
    return n.lengthSq() > 1e-12 ? n.normalize() : new THREE.Vector3(0, 0, 1);
  }
  center() {
    const c = new THREE.Vector3();
    this.loop.forEach(v => c.add(v.pos));
    return c.multiplyScalar(1 / this.loop.length);
  }
  area() {
    const { pts, tris } = faceTriangles(this);
    let total = 0;
    for (const t of tris) {
      const ab = pts[t[1]].clone().sub(pts[t[0]]);
      const ac = pts[t[2]].clone().sub(pts[t[0]]);
      total += ab.cross(ac).length() / 2;
    }
    return total;
  }
}

/* Triangulate a planar polygon face (holes supported).
 * Returns { pts, tris }: tris index into pts = outer loop + hole loops. */
function faceTriangles(face) {
  const outer = face.points();
  const holePts = face.holes.map(h => h.map(v => v.pos));
  const pts = outer.concat(...holePts);
  if (outer.length < 3) return { pts, tris: [] };
  const n = newellNormal(outer);
  if (n.lengthSq() < 1e-14) return { pts, tris: [] };
  n.normalize();
  let ref = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(n, ref).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const to2 = p => new THREE.Vector2(p.dot(u), p.dot(v));
  let tris = [];
  try {
    tris = THREE.ShapeUtils.triangulateShape(outer.map(to2), holePts.map(h => h.map(to2)));
  } catch (e) { tris = []; }
  if (!tris.length && !holePts.length) {
    for (let i = 1; i < outer.length - 1; i++) tris.push([0, i, i + 1]);
  }
  return { pts, tris };
}

/* 2D point-in-polygon; points on the boundary count as inside (door sills
 * sit exactly on the wall's bottom edge). */
function pointInPoly2(p, poly, eps) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy || 1e-12;
    let t = ((p[0] - xi) * dx + (p[1] - yi) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = xi + t * dx - p[0], ey = yi + t * dy - p[1];
    if (ex * ex + ey * ey < eps * eps) return true;   // on boundary
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < dx * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class SUModel {
  constructor() {
    this.vertices = new Map();
    this.edges = new Map();
    this.faces = new Map();
    this._id = 1;
    this.listeners = [];
    this._batch = 0;
    this._dirty = false;
    this._gridDirty = false;
    this.vertexGrid = new Map();   // "ix_iy_iz" -> SUVertex[] (cell size = SU_EPS)
    this.edgeIndex = new Map();    // "minVid_maxVid" -> SUEdge
    this.faceIndex = new Map();    // sorted vertex-id key -> SUFace
    this.vertexEdges = new Map();  // vertex id -> Set<SUEdge>
    this.edgeFaces = new Map();    // "minVid_maxVid" -> Set<SUFace> bordering that edge
    // Containers = groups/components. Geometry in different containers never
    // welds together: vertex merging is scoped per container (SketchUp's
    // "groups isolate geometry" rule). cid 0 = loose model-level geometry.
    this.containers = new Map();   // cid -> { id, name, parent }
  }

  /* ---------- containers (groups) ---------- */
  createContainer(name, parent = 0) {
    const id = this.nextId();
    this.containers.set(id, { id, name: name || "Group", parent: parent || 0 });
    return id;
  }

  topContainerOf(entityId) {
    const e = this.getEntity(entityId);
    if (!e || !e.cid) return 0;
    let c = this.containers.get(e.cid);
    while (c && c.parent && this.containers.get(c.parent)) c = this.containers.get(c.parent);
    return c ? c.id : 0;
  }

  containerDescendants(cid) {
    const set = new Set([cid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of this.containers.values())
        if (set.has(c.parent) && !set.has(c.id)) { set.add(c.id); grew = true; }
    }
    return set;
  }

  entitiesInContainer(cid, deep = true) {
    const cids = deep ? this.containerDescendants(cid) : new Set([cid]);
    const out = [];
    for (const e of this.edges.values()) if (cids.has(e.cid)) out.push(e);
    for (const f of this.faces.values()) if (cids.has(f.cid)) out.push(f);
    return out;
  }

  /* Move selected loose entities into container cid ("Make Group").
   * Faces bring their perimeter edges. Edges also bounding unselected faces
   * are cloned (the original stays outside). Vertices shared with outside
   * geometry are split so the group is fully isolated — SketchUp rules. */
  groupEntitiesInto(cid, ids) {
    const faces = [], edgeSet = new Set();
    for (const id of ids) {
      const f = this.faces.get(id);
      if (f) { faces.push(f); continue; }
      const e = this.edges.get(id);
      if (e) edgeSet.add(e);
    }
    const groupedFaceIds = new Set(faces.map(f => f.id));
    // perimeter (and hole) edges of grouped faces come along
    const candidates = new Set(edgeSet);
    for (const f of faces) {
      const rings = [f.loop, ...f.holes];
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const ed = this.findEdge(ring[i], ring[(i + 1) % ring.length]);
          if (ed) candidates.add(ed);
        }
    }
    // explicit selection moves an edge; implied perimeter edges that also
    // bound unselected faces are cloned instead
    const moveEdges = [], cloneEdges = [];
    for (const e of candidates) {
      if (edgeSet.has(e)) { moveEdges.push(e); continue; }
      const allBordersIn = this.facesOfEdge(e).every(f => groupedFaceIds.has(f.id));
      (allBordersIn ? moveEdges : cloneEdges).push(e);
    }
    if (!faces.length && !moveEdges.length && !cloneEdges.length) return false;

    // vertices still used by anything staying outside must be split
    const movedIds = new Set([...groupedFaceIds, ...moveEdges.map(e => e.id)]);
    const outsideUse = new Set();
    for (const e of this.edges.values())
      if (!movedIds.has(e.id)) { outsideUse.add(e.v1.id); outsideUse.add(e.v2.id); }
    for (const f of this.faces.values())
      if (!movedIds.has(f.id)) f.allVertices().forEach(v => outsideUse.add(v.id));

    for (const f of faces) this._unregisterFace(f);
    for (const e of moveEdges) this._unregisterEdge(e);

    const vmap = new Map();
    const mapV = v => {
      let nv = vmap.get(v.id);
      if (nv) return nv;
      if (outsideUse.has(v.id)) {
        nv = new SUVertex(this.nextId(), v.pos, cid);   // split: outside keeps the original
        this.vertices.set(nv.id, nv);
      } else {
        v.cid = cid;
        nv = v;
      }
      vmap.set(v.id, nv);
      return nv;
    };

    for (const e of moveEdges) { e.v1 = mapV(e.v1); e.v2 = mapV(e.v2); e.cid = cid; }
    for (const f of faces) {
      f.loop = f.loop.map(mapV);
      f.holes = f.holes.map(h => h.map(mapV));
      f.cid = cid;
    }
    for (const e of moveEdges) if (e.v1 !== e.v2 && !this.findEdge(e.v1, e.v2)) this._registerEdge(e);
    for (const f of faces) this._registerFace(f);
    for (const e of cloneEdges) {
      const v1 = mapV(e.v1), v2 = mapV(e.v2);
      if (v1 !== v2 && !this.findEdge(v1, v2)) this._registerEdge(new SUEdge(this.nextId(), v1, v2, cid));
    }
    this._gridDirty = true;   // reassigned vertices changed grid cells
    this.changed();
    return true;
  }

  /* Deep-copy entities through a matrix (Ctrl+Move duplicate).
   * Groups fully covered by the copy are cloned with their whole hierarchy;
   * partially-copied geometry lands back in its original container. */
  duplicateEntities(ids, matrix) {
    const idSet = new Set(ids);
    const fullCids = new Set();
    for (const c of this.containers.values()) {
      if (String(c.name).startsWith("<definition>")) continue;
      const ents = this.entitiesInContainer(c.id, true);
      if (ents.length && ents.every(e => idSet.has(e.id))) fullCids.add(c.id);
    }
    const cidMap = new Map();
    const mapCid = cid => {
      if (!cid || !fullCids.has(cid)) return cid || 0;
      if (cidMap.has(cid)) return cidMap.get(cid);
      const c = this.containers.get(cid);
      const ncid = this.createContainer(c.name, mapCid(c.parent));
      cidMap.set(cid, ncid);
      return ncid;
    };
    const vmap = new Map();
    const mapV = v => {
      let nv = vmap.get(v.id);
      if (!nv) {
        nv = new SUVertex(this.nextId(), v.pos.clone().applyMatrix4(matrix), mapCid(v.cid));
        this.vertices.set(nv.id, nv);
        this._gridAdd(nv);
        vmap.set(v.id, nv);
      }
      return nv;
    };
    const created = [];
    for (const id of ids) {
      const e = this.edges.get(id);
      if (e) {
        const v1 = mapV(e.v1), v2 = mapV(e.v2);
        if (v1 !== v2 && !this.findEdge(v1, v2)) {
          const ne = new SUEdge(this.nextId(), v1, v2, mapCid(e.cid));
          this._registerEdge(ne);
          created.push(ne.id);
        }
        continue;
      }
      const f = this.faces.get(id);
      if (f) {
        const loop = f.loop.map(mapV);
        if (this.faceWithVertices(loop)) continue;
        const nf = new SUFace(this.nextId(), loop, f.color, mapCid(f.cid));
        nf.holes = f.holes.map(h => h.map(mapV));
        this._registerFace(nf);
        created.push(nf.id);
      }
    }
    this.changed();
    return { created, containers: [...cidMap.values()] };
  }

  /* Dissolve a container: its contents (and child groups) join the parent.
   * Coincident vertices do not auto-weld until touched, like a fresh paste. */
  explodeContainer(cid) {
    const c = this.containers.get(cid);
    if (!c) return false;
    const parent = c.parent || 0;
    for (const child of this.containers.values())
      if (child.parent === cid) child.parent = parent;
    const verts = new Set();
    for (const ent of this.entitiesInContainer(cid, false)) {
      ent.cid = parent;
      if (ent.type === "edge") { verts.add(ent.v1); verts.add(ent.v2); }
      else ent.allVertices().forEach(v => verts.add(v));
    }
    for (const v of verts) if (v.cid === cid) v.cid = parent;
    this.containers.delete(cid);
    this._gridDirty = true;
    this.changed();
    return true;
  }

  /* What does a click on entityId mean inside edit context ctx (0 = model)?
   *  - "outside": the entity is not in the open group — exit the context
   *  - "entity":  a loose entity at this level — select just it
   *  - "group":   wraps the direct child group — select/enter it as a unit */
  resolveInContext(entityId, ctx = 0) {
    const e = this.getEntity(entityId);
    if (!e) return null;
    if (!e.cid) {
      return ctx ? { kind: "outside" } : { kind: "entity", ids: [entityId] };
    }
    const chain = [];   // leaf container → root
    let c = this.containers.get(e.cid);
    while (c) { chain.push(c.id); c = this.containers.get(c.parent); }
    if (ctx) {
      if (e.cid === ctx) return { kind: "entity", ids: [entityId] };
      const idx = chain.indexOf(ctx);
      if (idx <= 0) return { kind: "outside" };
      const child = chain[idx - 1];
      return { kind: "group", cid: child, ids: this.entitiesInContainer(child, true).map(x => x.id) };
    }
    const top = chain[chain.length - 1];
    return { kind: "group", cid: top, ids: this.entitiesInContainer(top, true).map(x => x.id) };
  }

  nextId() { return this._id++; }
  onChange(fn) { this.listeners.push(fn); }

  /* ---------- batched change notification ---------- */
  beginBatch() { this._batch++; }
  endBatch() {
    if (--this._batch <= 0) {
      this._batch = 0;
      if (this._dirty) {
        this._dirty = false;
        this.listeners.forEach(fn => fn());
      }
    }
  }
  changed() {
    if (this._batch > 0) { this._dirty = true; return; }
    this.listeners.forEach(fn => fn());
  }
  /* call after mutating vertex positions directly (move tool, transforms) */
  markGridDirty() { this._gridDirty = true; }

  getEntity(id) { return this.edges.get(id) || this.faces.get(id) || null; }

  /* ---------- vertex spatial hash ---------- */
  _gridKey(cid, ix, iy, iz) { return cid + "|" + ix + "_" + iy + "_" + iz; }
  _gridAdd(v) {
    const key = this._gridKey(v.cid,
      Math.round(v.pos.x / SU_EPS), Math.round(v.pos.y / SU_EPS), Math.round(v.pos.z / SU_EPS));
    const arr = this.vertexGrid.get(key);
    if (arr) arr.push(v); else this.vertexGrid.set(key, [v]);
  }
  rebuildVertexGrid() {
    this.vertexGrid.clear();
    for (const v of this.vertices.values()) this._gridAdd(v);
    this._gridDirty = false;
  }

  /* Vertex merging is scoped per container: geometry in a group never welds
   * to geometry outside it, so touching a group does not "stick". */
  vertexAt(pos, cid = 0) {
    if (this._gridDirty) this.rebuildVertexGrid();
    const ix = Math.round(pos.x / SU_EPS), iy = Math.round(pos.y / SU_EPS), iz = Math.round(pos.z / SU_EPS);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const arr = this.vertexGrid.get(this._gridKey(cid, ix + dx, iy + dy, iz + dz));
          if (!arr) continue;
          for (const v of arr)
            if (v.pos.distanceTo(pos) < SU_EPS) return v;
        }
    const v = new SUVertex(this.nextId(), pos, cid);
    this.vertices.set(v.id, v);
    this._gridAdd(v);
    return v;
  }

  /* ---------- edge / face indexes ---------- */
  edgeKey(v1, v2) { return v1.id < v2.id ? v1.id + "_" + v2.id : v2.id + "_" + v1.id; }
  faceKey(loop) { return loop.map(v => v.id).sort((a, b) => a - b).join("_"); }

  _registerEdge(e) {
    this.edges.set(e.id, e);
    this.edgeIndex.set(this.edgeKey(e.v1, e.v2), e);
    for (const v of [e.v1, e.v2]) {
      let set = this.vertexEdges.get(v.id);
      if (!set) { set = new Set(); this.vertexEdges.set(v.id, set); }
      set.add(e);
    }
  }
  _unregisterEdge(e) {
    this.edges.delete(e.id);
    this.edgeIndex.delete(this.edgeKey(e.v1, e.v2));
    for (const v of [e.v1, e.v2]) {
      const set = this.vertexEdges.get(v.id);
      if (set) { set.delete(e); if (!set.size) this.vertexEdges.delete(v.id); }
    }
  }
  _registerFace(f) {
    this.faces.set(f.id, f);
    this.faceIndex.set(this.faceKey(f.loop), f);
    for (let i = 0; i < f.loop.length; i++) {
      const key = this.edgeKey(f.loop[i], f.loop[(i + 1) % f.loop.length]);
      let set = this.edgeFaces.get(key);
      if (!set) { set = new Set(); this.edgeFaces.set(key, set); }
      set.add(f);
    }
  }
  _unregisterFace(f) {
    this.faces.delete(f.id);
    const key = this.faceKey(f.loop);
    if (this.faceIndex.get(key) === f) this.faceIndex.delete(key);
    for (let i = 0; i < f.loop.length; i++) {
      const ekey = this.edgeKey(f.loop[i], f.loop[(i + 1) % f.loop.length]);
      const set = this.edgeFaces.get(ekey);
      if (set) { set.delete(f); if (!set.size) this.edgeFaces.delete(ekey); }
    }
  }
  facesOfEdge(e) {
    return [...(this.edgeFaces.get(this.edgeKey(e.v1, e.v2)) || [])];
  }

  findEdge(v1, v2) { return this.edgeIndex.get(this.edgeKey(v1, v2)) || null; }
  faceWithVertices(loop) { return this.faceIndex.get(this.faceKey(loop)) || null; }

  /* Add an edge between two points. autoFace tries to close planar loops. */
  addEdge(p1, p2, autoFace = true, cid = 0) {
    const v1 = this.vertexAt(p1, cid), v2 = this.vertexAt(p2, cid);
    if (v1 === v2) return { edge: null, faces: [] };
    let edge = this.findEdge(v1, v2);
    let faces = [];
    if (!edge) {
      edge = new SUEdge(this.nextId(), v1, v2, cid);
      this._registerEdge(edge);
      if (autoFace) faces = this.detectFaces(edge);
    }
    this.changed();
    return { edge, faces };
  }

  /* Find the shortest planar cycle closed by `edge` and create a face for it. */
  detectFaces(edge) {
    // BFS shortest path v2 → v1 over the persistent adjacency, avoiding the new edge
    const prev = new Map([[edge.v2.id, null]]);
    const queue = [edge.v2.id];
    let head = 0, found = false;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === edge.v1.id) { found = true; break; }
      if (head > 5000) return [];
      const set = this.vertexEdges.get(cur);
      if (!set) continue;
      for (const e of set) {
        if (e === edge) continue;
        const nb = e.v1.id === cur ? e.v2.id : e.v1.id;
        if (!prev.has(nb)) { prev.set(nb, cur); queue.push(nb); }
      }
    }
    if (!found) return [];
    const path = [];
    for (let c = edge.v1.id; c !== null; c = prev.get(c)) path.push(c);
    if (path.length < 3 || path.length > 64) return [];
    const loop = path.map(id => this.vertices.get(id));
    // coplanarity check
    const pts = loop.map(v => v.pos);
    const n = newellNormal(pts);
    if (n.lengthSq() < 1e-12) return [];
    n.normalize();
    const d0 = pts[0].dot(n);
    for (const p of pts) if (Math.abs(p.dot(n) - d0) > SU_PLANE_TOL) return [];
    if (this.faceWithVertices(loop)) return [];
    const face = new SUFace(this.nextId(), loop, null, edge.cid);
    this._registerFace(face);
    this._attachAsHole(face);
    return [face];
  }

  /* SketchUp face-split (lite): a new face drawn entirely inside a coplanar
   * face of the same container becomes a cutting loop in that host — erase
   * the inner face and a real hole is left behind (windows/doors). */
  _attachAsHole(face) {
    const n = face.normal();
    const p0 = face.loop[0].pos;
    for (const host of this.faces.values()) {
      if (host === face || host.cid !== face.cid || host.loop.length < 3) continue;
      const hn = host.normal();
      if (Math.abs(hn.dot(n)) < 0.999) continue;                                   // not coplanar
      if (Math.abs(hn.dot(p0) - hn.dot(host.loop[0].pos)) > SU_PLANE_TOL * 2) continue;
      let ref = Math.abs(hn.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(hn, ref).normalize();
      const v = new THREE.Vector3().crossVectors(hn, u);
      const to2 = p => [p.dot(u), p.dot(v)];
      const hostPoly = host.loop.map(x => to2(x.pos));
      if (!face.loop.every(x => pointInPoly2(to2(x.pos), hostPoly, 0.02))) continue;
      // must not sit inside an existing hole of the host
      const inHole = host.holes.some(h => {
        const holePoly = h.map(x => to2(x.pos));
        return face.loop.every(x => pointInPoly2(to2(x.pos), holePoly, 1e-4));
      });
      if (inHole) continue;
      host.holes.push(face.loop.slice());
      return host;
    }
    return null;
  }

  /* Create a face (plus its perimeter edges) from an ordered point list. */
  addFace(points, color = null, cid = 0) {
    const verts = [];
    for (const p of points) {
      const v = this.vertexAt(p, cid);
      if (!verts.length || verts[verts.length - 1] !== v) verts.push(v);
    }
    if (verts.length > 1 && verts[0] === verts[verts.length - 1]) verts.pop();
    if (verts.length < 3) return null;
    const existing = this.faceWithVertices(verts);
    if (existing) {
      if (color) existing.color = color;
      this.changed();
      return existing;
    }
    const createdEdges = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (!this.findEdge(a, b)) {
        const e = new SUEdge(this.nextId(), a, b, cid);
        this._registerEdge(e);
        createdEdges.push(e);
      }
    }
    const face = new SUFace(this.nextId(), verts, color, cid);
    this._registerFace(face);
    this._attachAsHole(face);
    this.changed();
    face._createdEdges = createdEdges;
    return face;
  }

  /* Extrude a face along its normal. Returns { topFace, created } */
  pushpull(face, dist) {
    if (!face || Math.abs(dist) < SU_EPS) return null;
    const n = face.normal();
    const cid = face.cid;   // extrusion stays inside the face's container
    const offset = n.clone().multiplyScalar(dist);
    const bottom = face.loop.slice();
    const top = bottom.map(v => this.vertexAt(v.pos.clone().add(offset), cid));
    const created = [];

    const ensureEdge = (a, b) => {
      if (a === b) return null;
      let e = this.findEdge(a, b);
      if (!e) {
        e = new SUEdge(this.nextId(), a, b, cid);
        this._registerEdge(e);
        created.push(e);
      }
      return e;
    };

    const makeRing = (bot, tp) => {
      for (let i = 0; i < bot.length; i++) {
        const j = (i + 1) % bot.length;
        ensureEdge(tp[i], tp[j]);       // top perimeter
        ensureEdge(bot[i], tp[i]);      // vertical
        // side quad
        const quad = [bot[i], bot[j], tp[j], tp[i]];
        if (new Set(quad).size >= 3 && !this.faceWithVertices(quad)) {
          const f = new SUFace(this.nextId(), quad, face.color, cid);
          this._registerFace(f);
          created.push(f);
        }
      }
    };
    makeRing(bottom, top);
    // holes extrude too: window/door openings become tunnels through the solid
    const topHoles = face.holes.map(h => h.map(v => this.vertexAt(v.pos.clone().add(offset), cid)));
    face.holes.forEach((h, hi) => makeRing(h, topHoles[hi]));

    let topFace = this.faceWithVertices(top);
    if (!topFace) {
      topFace = new SUFace(this.nextId(), top, face.color, cid);
      topFace.holes = topHoles;
      this._registerFace(topFace);
      created.push(topFace);
    }
    this.changed();
    return { topFace, created };
  }

  eraseEntities(ids) {
    const erasedPairs = new Set();
    for (const id of ids) {
      const face = this.faces.get(id);
      if (face) { this._unregisterFace(face); continue; }
      const edge = this.edges.get(id);
      if (edge) {
        this._unregisterEdge(edge);
        erasedPairs.add(this.edgeKey(edge.v1, edge.v2));
      }
    }
    if (erasedPairs.size) {
      // faces bounded by an erased edge die with it (SketchUp behavior)
      for (const key of erasedPairs) {
        const set = this.edgeFaces.get(key);
        if (set) for (const f of [...set]) this._unregisterFace(f);
      }
    }
    this.cleanupOrphans();
    this.changed();
  }

  cleanupOrphans() {
    const used = new Set();
    for (const e of this.edges.values()) { used.add(e.v1.id); used.add(e.v2.id); }
    for (const f of this.faces.values()) f.allVertices().forEach(v => used.add(v.id));
    let removed = false;
    for (const id of [...this.vertices.keys()])
      if (!used.has(id)) { this.vertices.delete(id); removed = true; }
    if (removed) this._gridDirty = true;
  }

  /* Collect the vertex set touched by a list of entity ids */
  vertexSetOf(ids) {
    const set = new Set();
    for (const id of ids) {
      const e = this.edges.get(id);
      if (e) { set.add(e.v1); set.add(e.v2); continue; }
      const f = this.faces.get(id);
      if (f) f.allVertices().forEach(v => set.add(v));
    }
    return set;
  }

  translateVertices(vertexSet, delta) {
    for (const v of vertexSet) v.pos.add(delta);
    this._gridDirty = true;
    this.changed();
  }

  transformEntities(ids, matrix4) {
    for (const v of this.vertexSetOf(ids)) v.pos.applyMatrix4(matrix4);
    this._gridDirty = true;
    this.changed();
  }

  clear() {
    this.vertices.clear(); this.edges.clear(); this.faces.clear();
    this.vertexGrid.clear(); this.edgeIndex.clear(); this.faceIndex.clear();
    this.vertexEdges.clear(); this.edgeFaces.clear(); this.containers.clear();
    this._gridDirty = false;
    this.changed();
  }

  bbox() {
    const box = new THREE.Box3();
    for (const v of this.vertices.values()) box.expandByPoint(v.pos);
    return box;
  }

  isEmpty() { return this.edges.size === 0 && this.faces.size === 0; }

  /* ---------- serialization ---------- */
  toJSON() {
    return JSON.stringify({
      version: 2,
      containers: [...this.containers.values()].map(c => [c.id, c.name, c.parent]),
      vertices: [...this.vertices.values()].map(v => [v.id, +v.pos.x.toFixed(6), +v.pos.y.toFixed(6), +v.pos.z.toFixed(6), v.cid]),
      edges: [...this.edges.values()].map(e => [e.id, e.v1.id, e.v2.id, e.cid]),
      faces: [...this.faces.values()].map(f => ({
        id: f.id, loop: f.loop.map(v => v.id), color: f.color, cid: f.cid,
        holes: f.holes.length ? f.holes.map(h => h.map(v => v.id)) : undefined
      })),
      nextId: this._id
    });
  }

  loadJSON(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    this.vertices.clear(); this.edges.clear(); this.faces.clear();
    this.vertexGrid.clear(); this.edgeIndex.clear(); this.faceIndex.clear();
    this.vertexEdges.clear(); this.edgeFaces.clear(); this.containers.clear();
    let maxId = 1;
    for (const [id, name, parent] of data.containers || []) {
      this.containers.set(id, { id, name, parent: parent || 0 });
      maxId = Math.max(maxId, id);
    }
    for (const [id, x, y, z, cid] of data.vertices || []) {
      const v = new SUVertex(id, new THREE.Vector3(x, y, z), cid || 0);
      this.vertices.set(id, v);
      this._gridAdd(v);
      maxId = Math.max(maxId, id);
    }
    for (const [id, a, b, cid] of data.edges || []) {
      const v1 = this.vertices.get(a), v2 = this.vertices.get(b);
      if (v1 && v2) this._registerEdge(new SUEdge(id, v1, v2, cid || 0));
      maxId = Math.max(maxId, id);
    }
    for (const f of data.faces || []) {
      const loop = f.loop.map(id => this.vertices.get(id)).filter(Boolean);
      if (loop.length >= 3) {
        const face = new SUFace(f.id, loop, f.color, f.cid || 0);
        for (const h of f.holes || []) {
          const hl = h.map(id => this.vertices.get(id)).filter(Boolean);
          if (hl.length >= 3) face.holes.push(hl);
        }
        this._registerFace(face);
      }
      maxId = Math.max(maxId, f.id);
    }
    this._id = Math.max(maxId + 1, data.nextId || 1);
    this._gridDirty = false;
    this.changed();
  }

  /* ---------- OBJ export ---------- */
  toOBJ() {
    const lines = ["# Exported from Sketch Studio", "# Units: meters, Z-up", "o SketchStudioModel"];
    const vIndex = new Map();
    let idx = 1;
    for (const v of this.vertices.values()) {
      vIndex.set(v.id, idx++);
      lines.push(`v ${v.pos.x} ${v.pos.y} ${v.pos.z}`);
    }
    for (const f of this.faces.values()) {
      const verts = f.allVertices();
      const { tris } = faceTriangles(f);
      for (const t of tris) {
        lines.push(`f ${vIndex.get(verts[t[0]].id)} ${vIndex.get(verts[t[1]].id)} ${vIndex.get(verts[t[2]].id)}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
