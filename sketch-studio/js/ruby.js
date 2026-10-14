/* ============================================================
 * ruby.js — real Ruby scripting via ruby.wasm (CRuby compiled
 * to WebAssembly), exposing a SketchUp-compatible Ruby API:
 *   Sketchup.active_model, Entities#add_face/add_line/add_circle,
 *   Face#pushpull, Geom::Point3d/Vector3d/Transformation,
 *   UI.messagebox/inputbox/menu, unit helpers (2.m, 30.cm)…
 * Scripts written for SketchUp's Ruby API largely run as-is.
 * ============================================================ */
"use strict";

/* ---------------- JS side of the bridge ---------------- */

function parseColorToHex(color) {
  if (Array.isArray(color)) {
    const [r, g, b] = color.map(c => Math.max(0, Math.min(255, Math.round(c))));
    return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
  }
  const ctx = parseColorToHex._ctx || (parseColorToHex._ctx = document.createElement("canvas").getContext("2d"));
  ctx.fillStyle = "#000";
  ctx.fillStyle = String(color);
  return ctx.fillStyle;   // canvas normalizes any CSS color to hex
}

const RubyCommands = {
  version: () => "Sketch Studio 1.0 (SketchUp-compatible Ruby API)",

  container_create({ name, parent }) {
    return App.model.createContainer(name, parent || 0);
  },

  container_set_name({ cid, name }) {
    const c = App.model.containers.get(cid);
    if (c) c.name = String(name);
    return true;
  },

  container_entities({ cid, deep }) {
    return App.model.entitiesInContainer(cid, !!deep).map(e => ({ id: e.id, type: e.type }));
  },

  add_line({ p1, p2, container }) {
    const { edge, faces } = App.model.addEdge(vec3(p1), vec3(p2), true, container || 0);
    return { edge: edge ? edge.id : null, faces: faces.map(f => f.id) };
  },

  add_edges({ pts, container }) {
    const ids = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const { edge } = App.model.addEdge(vec3(pts[i]), vec3(pts[i + 1]), true, container || 0);
      if (edge) ids.push(edge.id);
    }
    return ids;
  },

  add_face({ pts, color, container }) {
    const face = App.model.addFace(pts.map(vec3), color ? parseColorToHex(color) : null, container || 0);
    if (!face) throw new Error("add_face: points do not form a valid planar face");
    return { face: face.id };
  },

  add_face_from_edges({ edges }) {
    const model = App.model;
    const list = edges.map(id => model.edges.get(id)).filter(Boolean);
    if (list.length < 3) throw new Error("add_face: need at least 3 edges");
    // order the loop by walking shared vertices
    const loop = [list[0].v1, list[0].v2];
    const remaining = new Set(list.slice(1));
    while (remaining.size) {
      const tail = loop[loop.length - 1];
      let found = null;
      for (const e of remaining) {
        if (e.v1 === tail) { loop.push(e.v2); found = e; break; }
        if (e.v2 === tail) { loop.push(e.v1); found = e; break; }
      }
      if (!found) throw new Error("add_face: edges do not form a connected loop");
      remaining.delete(found);
    }
    if (loop[loop.length - 1] === loop[0]) loop.pop();
    const face = model.addFace(loop.map(v => v.pos), null, list[0].cid || 0);
    if (!face) throw new Error("add_face: edge loop is not a valid planar face");
    return { face: face.id };
  },

  add_circle({ center, normal, radius, segments, container }) {
    const c = vec3(center);
    const n = vec3(normal).normalize();
    if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
    const segs = Math.max(3, Math.min(96, segments || 24));
    let ref = Math.abs(n.z) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(ref, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const pts = [];
    for (let i = 0; i < segs; i++) {
      const a = i / segs * Math.PI * 2;
      pts.push(c.clone().add(u.clone().multiplyScalar(Math.cos(a) * radius)).add(v.clone().multiplyScalar(Math.sin(a) * radius)));
    }
    const face = App.model.addFace(pts, null, container || 0);
    if (!face) throw new Error("add_circle: invalid circle");
    const edgeIds = [];
    for (let i = 0; i < face.loop.length; i++) {
      const e = App.model.findEdge(face.loop[i], face.loop[(i + 1) % face.loop.length]);
      if (e) edgeIds.push(e.id);
    }
    return { face: face.id, edges: edgeIds };
  },

  pushpull({ face, dist }) {
    const f = App.model.faces.get(face);
    if (!f) throw new Error("pushpull: face " + face + " not found");
    const res = App.model.pushpull(f, dist);
    if (!res) return { top_face: face, created: [] };
    return { top_face: res.topFace.id, created: res.created.map(e => e.id) };
  },

  erase({ ids }) {
    App.model.eraseEntities(ids);
    return ids.length;
  },

  clear() { App.model.clear(); App.viewport.setSelection([]); return true; },

  set_color({ id, color }) {
    const f = App.model.faces.get(id);
    if (!f) throw new Error("material: face " + id + " not found");
    f.color = parseColorToHex(color);
    App.model.changed();
    return f.color;
  },

  entity_info({ id }) {
    const e = App.model.edges.get(id);
    if (e) {
      return {
        type: "edge", start: [e.v1.pos.x, e.v1.pos.y, e.v1.pos.z],
        end: [e.v2.pos.x, e.v2.pos.y, e.v2.pos.z], length: e.length,
        faces: App.model.facesOfEdge(e).map(f => f.id)
      };
    }
    const f = App.model.faces.get(id);
    if (f) {
      const n = f.normal(), c = f.center();
      const edgeIds = [];
      for (let i = 0; i < f.loop.length; i++) {
        const ed = App.model.findEdge(f.loop[i], f.loop[(i + 1) % f.loop.length]);
        if (ed) edgeIds.push(ed.id);
      }
      // area is intentionally not included: it triangulates, so it has its own command
      return {
        type: "face", normal: [n.x, n.y, n.z], center: [c.x, c.y, c.z],
        color: f.color, loop: f.points().map(p => [p.x, p.y, p.z]), edges: edgeIds
      };
    }
    return null;
  },

  face_area({ id }) {
    const f = App.model.faces.get(id);
    if (!f) throw new Error("area: face " + id + " not found");
    return f.area();
  },

  reverse_face({ id }) {
    const f = App.model.faces.get(id);
    if (!f) throw new Error("reverse: face " + id + " not found");
    f.loop.reverse();   // flips the winding, so the normal flips
    App.model.changed();
    return true;
  },

  set_color_if_default({ id, color }) {
    const f = App.model.faces.get(id);
    if (f && !f.color) { f.color = parseColorToHex(color); App.model.changed(); }
    return true;
  },

  all_entities() {
    const out = [];
    for (const e of App.model.edges.values()) out.push({ id: e.id, type: "edge" });
    for (const f of App.model.faces.values()) out.push({ id: f.id, type: "face" });
    return out;
  },

  /* bulk type lookup for group-scoped iteration; silently drops erased ids */
  entity_types({ ids }) {
    const out = [];
    for (const id of ids) {
      if (App.model.faces.has(id)) out.push({ id, type: "face" });
      else if (App.model.edges.has(id)) out.push({ id, type: "edge" });
    }
    return out;
  },

  count_entities() { return App.model.edges.size + App.model.faces.size; },

  /* Capture geometry (points + colors) so it can be re-stamped as instances */
  snapshot_entities({ ids }) {
    const model = App.model;
    const out = { faces: [], edges: [] };
    const covered = new Set();   // vertex-pair keys already owned by a face perimeter
    const pkey = p => p.x.toFixed(4) + "," + p.y.toFixed(4) + "," + p.z.toFixed(4);
    for (const id of ids) {
      const f = model.faces.get(id);
      if (!f) continue;
      out.faces.push({ pts: f.points().map(p => [p.x, p.y, p.z]), color: f.color });
      for (let i = 0; i < f.loop.length; i++) {
        const a = f.loop[i].pos, b = f.loop[(i + 1) % f.loop.length].pos;
        covered.add(pkey(a) + "|" + pkey(b));
        covered.add(pkey(b) + "|" + pkey(a));
      }
    }
    for (const id of ids) {
      const e = model.edges.get(id);
      if (!e) continue;
      if (covered.has(pkey(e.v1.pos) + "|" + pkey(e.v2.pos))) continue;
      out.edges.push([[e.v1.pos.x, e.v1.pos.y, e.v1.pos.z], [e.v2.pos.x, e.v2.pos.y, e.v2.pos.z]]);
    }
    return out;
  },

  /* Rebuild snapshotted geometry through a transformation matrix,
   * inside a fresh container so the instance is an isolated unit */
  instantiate({ snapshot, matrix, parent, name }) {
    const m = new THREE.Matrix4().fromArray(matrix);
    const cid = App.model.createContainer(name || "Component", parent || 0);
    const created = [];
    for (const f of snapshot.faces || []) {
      const pts = f.pts.map(a => vec3(a).applyMatrix4(m));
      const face = App.model.addFace(pts, f.color || null, cid);
      if (face) {
        created.push(face.id);
        for (const e of face._createdEdges || []) created.push(e.id);
      }
    }
    for (const e of snapshot.edges || []) {
      const r = App.model.addEdge(vec3(e[0]).applyMatrix4(m), vec3(e[1]).applyMatrix4(m), true, cid);
      if (r.edge) created.push(r.edge.id);
    }
    return { created, container: cid };
  },

  transform({ ids, matrix }) {
    const m = new THREE.Matrix4().fromArray(matrix);   // column-major, like Geom::Transformation#to_a
    App.model.transformEntities(ids, m);
    return true;
  },

  bounds({ ids }) {
    const box = new THREE.Box3();
    if (ids && ids.length) {
      for (const v of App.model.vertexSetOf(ids)) box.expandByPoint(v.pos);
    } else {
      box.copy(App.model.bbox());
    }
    if (box.isEmpty()) return null;
    return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  },

  selection_get() { return [...App.viewport.selection]; },
  selection_set({ ids }) { App.viewport.setSelection(ids); return ids.length; },
  selection_clear() { App.viewport.setSelection([]); return true; },

  start_operation({ name }) { App.pushUndo(); return true; },
  commit_operation() { return true; },
  abort_operation() { App.undo(); return true; },

  messagebox({ msg }) { window.alert(msg); return 6; },

  inputbox({ prompts, defaults, title }) {
    const out = [];
    for (let i = 0; i < prompts.length; i++) {
      const v = window.prompt((title ? title + " — " : "") + prompts[i], defaults[i] != null ? defaults[i] : "");
      if (v === null) return null;
      out.push(v);
    }
    return out;
  },

  add_menu_item({ menu, title }) {
    return App.addPluginMenuItem(menu || "Plugins", title);
  },

  status_text({ text }) { App.setHint(String(text)); return true; },
  zoom_extents() { App.viewport.zoomExtents(); return true; },

  // Sketchup.read_default / write_default — plugin settings in localStorage
  read_default({ section, key }) {
    const v = localStorage.getItem("su-default:" + section + ":" + key);
    if (v === null) return null;
    try { return JSON.parse(v); } catch { return v; }
  },
  write_default({ section, key, value }) {
    localStorage.setItem("su-default:" + section + ":" + key, JSON.stringify(value === undefined ? null : value));
    return true;
  }
};

function vec3(a) { return new THREE.Vector3(a[0] || 0, a[1] || 0, a[2] || 0); }

const RubyBridge = {
  pendingCode: "",
  getPendingCode() { return RubyBridge.pendingCode; },
  // .rbz install: JS stages { path: source } here, Ruby pulls via SUFiles.ingest_pending
  pendingFilesJson: "{}",
  getPendingFiles() { return RubyBridge.pendingFilesJson; },
  print(s) {
    // each console entry is its own line already — drop one trailing newline
    RubyConsole.append(String(s).replace(/\n$/, ""), "ln");
  },
  evalResult(inspect) { RubyConsole.append("=> " + inspect, "result"); },
  evalError(msg) { RubyConsole.append(String(msg), "error"); },
  stats: { calls: {}, totalMs: 0 },
  resetStats() { RubyBridge.stats = { calls: {}, totalMs: 0 }; },
  statsSummary() {
    const s = RubyBridge.stats;
    const top = Object.entries(s.calls).sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
      .map(([cmd, v]) => cmd + "×" + v.n + " (" + (v.ms / 1000).toFixed(1) + "s)").join(", ");
    const total = Object.values(s.calls).reduce((acc, v) => acc + v.n, 0);
    return total + " bridge calls, " + (s.totalMs / 1000).toFixed(1) + "s — top: " + top;
  },
  invoke(cmd, argsJson) {
    const t0 = performance.now();
    try {
      const fn = RubyCommands[cmd];
      if (!fn) throw new Error("Unknown bridge command: " + cmd);
      const result = fn(argsJson ? JSON.parse(argsJson) : {});
      return JSON.stringify({ result: result === undefined ? null : result });
    } catch (err) {
      return JSON.stringify({ error: String(err && err.message || err) });
    } finally {
      const ms = performance.now() - t0;
      const s = RubyBridge.stats;
      s.totalMs += ms;
      const rec = s.calls[cmd] || (s.calls[cmd] = { n: 0, ms: 0 });
      rec.n++; rec.ms += ms;
    }
  }
};
window.RubyBridge = RubyBridge;

/* ---------------- Ruby prelude: the SketchUp-style API ---------------- */

const RUBY_PRELUDE = String.raw`
require "js"
require "json"

module SUBridge
  def self.invoke(cmd, args = {})
    raw = JS.global[:RubyBridge].call(:invoke, cmd.to_s, JSON.generate(args)).to_s
    data = JSON.parse(raw)
    raise data["error"].to_s if data["error"]
    data["result"]
  end
  def self.pt(p)
    return p.to_a[0, 3].map(&:to_f) if p.respond_to?(:to_a) && !p.is_a?(String)
    raise ArgumentError, "expected a point, got #{p.inspect}"
  end
end

class SUConsoleIO
  def write(*args)
    args.each { |a| JS.global[:RubyBridge].call(:print, a.to_s) }
    args.map { |a| a.to_s.bytesize }.sum
  end
  def print(*args) write(*args); nil end
  def puts(*args)
    if args.empty?
      write("\n")
    else
      args.flatten.each do |a|
        s = a.to_s
        write(s.end_with?("\n") ? s : s + "\n")
      end
    end
    nil
  end
  def printf(fmt, *args) write(format(fmt, *args)); nil end
  def <<(s) write(s.to_s); self end
  def flush; self end
  def sync; true end
  def sync=(v); v end
  def tty?; false end
  def fileno; 1 end
end
$stdout = SUConsoleIO.new
$stderr = $stdout

# Watchdog: the browser tab is blocked while a script runs, so runaway
# scripts are aborted after a time budget with a backtrace showing where
# they were stuck. Raise the budget with:  SUWatchdog.limit = 600
module SUWatchdog
  @limit = 120.0
  class << self
    attr_accessor :limit
    def now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    rescue StandardError
      Time.now.to_f
    end
    def start
      @count = 0
      @deadline = now + @limit
      @tp ||= TracePoint.new(:line) do
        @count += 1
        if (@count & 0xFFF).zero? && now > @deadline
          @tp.disable
          raise Interrupt, "Script stopped by the Sketch Studio watchdog after #{@limit.to_i}s — " \
                           "likely an infinite loop (see backtrace below for where). " \
                           "Geometry built so far is kept. Raise the budget with SUWatchdog.limit = 600"
        end
      end
      @tp.enable
    end
    def stop
      @tp.disable if @tp
    end
  end
end

# --- Unit helpers: SketchUp scripts write 10.feet, 2.m, 30.cm ... ---
# Sketch Studio's native unit is the INCH, exactly like real SketchUp,
# so raw numbers in SketchUp scripts come out at the right scale.
class Numeric
  def inch;   to_f;             end
  def feet;   to_f * 12.0;      end
  def yard;   to_f * 36.0;      end
  def mm;     to_f / 25.4;      end
  def cm;     to_f / 2.54;      end
  def m;      to_f / 0.0254;    end
  def km;     to_f / 0.0000254; end
  def mile;   to_f * 63360.0;   end
  def degrees; to_f * Math::PI / 180.0 end
  def radians; to_f * 180.0 / Math::PI end
  def to_inch; to_f;            end
  def to_feet; to_f / 12.0;     end
  def to_yard; to_f / 36.0;     end
  def to_mm;  to_f * 25.4;      end
  def to_cm;  to_f * 2.54;      end
  def to_m;   to_f * 0.0254;    end
  def to_km;  to_f * 0.0000254; end
end

module Geom
  class Point3d
    attr_accessor :x, :y, :z
    def initialize(x = 0, y = 0, z = 0)
      @x, @y, @z = x.to_f, y.to_f, z.to_f
    end
    def self.from(o)
      return o if o.is_a?(Point3d)
      a = o.to_a
      Point3d.new(a[0] || 0, a[1] || 0, a[2] || 0)
    end
    def +(v) Point3d.new(@x + v.x, @y + v.y, @z + v.z) end
    def -(o)
      if o.is_a?(Vector3d)
        Point3d.new(@x - o.x, @y - o.y, @z - o.z)
      else
        o = Point3d.from(o)
        Vector3d.new(@x - o.x, @y - o.y, @z - o.z)
      end
    end
    def offset(vector, length = nil)
      v = length ? vector.normalize * length : vector
      self + v
    end
    def offset!(vector, length = nil)
      p = offset(vector, length)
      @x, @y, @z = p.x, p.y, p.z
      self
    end
    def vector_to(p) Point3d.from(p) - self end
    def distance(p)
      p = Point3d.from(p)
      Math.sqrt((@x - p.x)**2 + (@y - p.y)**2 + (@z - p.z)**2)
    end
    def transform(t) t.apply_point(self) end
    def transform!(t)
      p = t.apply_point(self)
      @x, @y, @z = p.x, p.y, p.z
      self
    end
    def to_a; [@x, @y, @z] end
    def [](i) to_a[i] end
    def ==(o) o.respond_to?(:to_a) && to_a.zip(o.to_a).all? { |a, b| (a - b).abs < 1e-9 } end
    def clone; Point3d.new(@x, @y, @z) end
    def to_s; "(#{@x}, #{@y}, #{@z})" end
    def inspect; "Point3d#{to_s}" end
  end

  class Vector3d
    attr_accessor :x, :y, :z
    def initialize(x = 0, y = 0, z = 0)
      @x, @y, @z = x.to_f, y.to_f, z.to_f
    end
    def self.from(o)
      return o if o.is_a?(Vector3d)
      a = o.to_a
      Vector3d.new(a[0] || 0, a[1] || 0, a[2] || 0)
    end
    def length; Math.sqrt(@x**2 + @y**2 + @z**2) end
    def length=(len)
      n = normalize
      @x, @y, @z = n.x * len, n.y * len, n.z * len
      len
    end
    def normalize
      l = length
      l < 1e-12 ? Vector3d.new(0, 0, 0) : Vector3d.new(@x / l, @y / l, @z / l)
    end
    def normalize!
      n = normalize
      @x, @y, @z = n.x, n.y, n.z
      self
    end
    def dot(v) v = Vector3d.from(v); @x * v.x + @y * v.y + @z * v.z end
    def cross(v)
      v = Vector3d.from(v)
      Vector3d.new(@y * v.z - @z * v.y, @z * v.x - @x * v.z, @x * v.y - @y * v.x)
    end
    def *(o) o.is_a?(Numeric) ? Vector3d.new(@x * o, @y * o, @z * o) : cross(o) end
    def %(v) dot(v) end
    def +(v) Vector3d.new(@x + v.x, @y + v.y, @z + v.z) end
    def -(v) Vector3d.new(@x - v.x, @y - v.y, @z - v.z) end
    def reverse; Vector3d.new(-@x, -@y, -@z) end
    def reverse!; @x, @y, @z = -@x, -@y, -@z; self end
    def angle_between(v)
      v = Vector3d.from(v)
      d = dot(v) / (length * v.length)
      Math.acos([[d, -1.0].max, 1.0].min)
    end
    def parallel?(v) (angle_between(v) < 1e-6) || ((Math::PI - angle_between(v)).abs < 1e-6) end
    def perpendicular?(v) (angle_between(v) - Math::PI / 2).abs < 1e-6 end
    def valid?; length > 1e-12 end
    def unitvector?; (length - 1.0).abs < 1e-9 end
    def transform(t) t.apply_vector(self) end
    def to_a; [@x, @y, @z] end
    def [](i) to_a[i] end
    def ==(o) o.respond_to?(:to_a) && to_a.zip(o.to_a).all? { |a, b| (a - b).abs < 1e-9 } end
    def clone; Vector3d.new(@x, @y, @z) end
    def to_s; "(#{@x}, #{@y}, #{@z})" end
    def inspect; "Vector3d#{to_s}" end
  end

  # Axis-aligned bounding box, mirroring SketchUp's Geom::BoundingBox
  # (width = x extent, height = y extent, depth = z extent)
  class BoundingBox
    def initialize
      @min = nil
      @max = nil
    end
    def self.from_hash(h)
      bb = BoundingBox.new
      bb.add(Point3d.from(h["min"]), Point3d.from(h["max"])) if h
      bb
    end
    def empty?; @min.nil? end
    def valid?; !empty? end
    def min; @min ? @min.clone : Point3d.new(0, 0, 0) end
    def max; @max ? @max.clone : Point3d.new(0, 0, 0) end
    def center
      return Point3d.new(0, 0, 0) if empty?
      Point3d.new((@min.x + @max.x) / 2.0, (@min.y + @max.y) / 2.0, (@min.z + @max.z) / 2.0)
    end
    def width;  empty? ? 0.0 : @max.x - @min.x end
    def height; empty? ? 0.0 : @max.y - @min.y end
    def depth;  empty? ? 0.0 : @max.z - @min.z end
    def diagonal; empty? ? 0.0 : @min.distance(@max) end
    def corner(i)
      Point3d.new(
        (i & 1).zero? ? min.x : max.x,
        (i & 2).zero? ? min.y : max.y,
        (i & 4).zero? ? min.z : max.z
      )
    end
    def add(*things)
      things.each do |t|
        if t.is_a?(BoundingBox)
          next if t.empty?
          add(t.min, t.max)
        elsif t.is_a?(Array) && !t.first.is_a?(Numeric)
          add(*t)   # a list of points, not a single [x,y,z] point
        else
          p = Point3d.from(t)
          if empty?
            @min = p.clone
            @max = p.clone
          else
            @min = Point3d.new([@min.x, p.x].min, [@min.y, p.y].min, [@min.z, p.z].min)
            @max = Point3d.new([@max.x, p.x].max, [@max.y, p.y].max, [@max.z, p.z].max)
          end
        end
      end
      self
    end
    def contains?(pt)
      return false if empty?
      p = Point3d.from(pt)
      p.x >= @min.x && p.x <= @max.x && p.y >= @min.y && p.y <= @max.y && p.z >= @min.z && p.z <= @max.z
    end
    def intersect(other)
      BoundingBox.new  # not tracked precisely; returns an empty box
    end
    def inspect
      empty? ? "BoundingBox(empty)" : "BoundingBox(#{@min.inspect} .. #{@max.inspect})"
    end
  end

  # 4x4 transformation, column-major like SketchUp's Transformation#to_a
  class Transformation
    attr_reader :m
    def initialize(arg = nil)
      case arg
      when Array
        if arg.length == 16
          @m = arg.map(&:to_f)
        elsif arg.length == 3   # SketchUp: Transformation.new(point) = translation
          @m = [1,0,0,0, 0,1,0,0, 0,0,1,0, arg[0].to_f, arg[1].to_f, arg[2].to_f, 1]
        else
          @m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
        end
      when Point3d then @m = Transformation.translation(ORIGIN.vector_to(arg)).m
      when Vector3d then @m = Transformation.translation(arg).m
      else @m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
      end
    end
    def self.translation(vec)
      v = Vector3d.from(vec)
      Transformation.new([1,0,0,0, 0,1,0,0, 0,0,1,0, v.x,v.y,v.z,1])
    end
    def self.scaling(*args)
      if args.length == 1 && args[0].is_a?(Numeric)
        s = args[0].to_f
        Transformation.new([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1])
      elsif args.length == 3
        sx, sy, sz = args.map(&:to_f)
        Transformation.new([sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1])
      elsif args.length == 2   # point, scale
        p = Point3d.from(args[0]); s = args[1].to_f
        translation(ORIGIN.vector_to(p)) * scaling(s) * translation(p.vector_to(ORIGIN))
      else
        Transformation.new
      end
    end
    def self.rotation(point, axis, angle)
      p = Point3d.from(point)
      a = Vector3d.from(axis).normalize
      c = Math.cos(angle); s = Math.sin(angle); t = 1 - c
      x, y, z = a.x, a.y, a.z
      r = Transformation.new([
        t*x*x + c,   t*x*y + s*z, t*x*z - s*y, 0,
        t*x*y - s*z, t*y*y + c,   t*y*z + s*x, 0,
        t*x*z + s*y, t*y*z - s*x, t*z*z + c,   0,
        0, 0, 0, 1
      ])
      translation(ORIGIN.vector_to(p)) * r * translation(p.vector_to(ORIGIN))
    end
    def self.axes(origin, xaxis, yaxis, zaxis)
      o = Point3d.from(origin)
      x = Vector3d.from(xaxis); y = Vector3d.from(yaxis); z = Vector3d.from(zaxis)
      Transformation.new([x.x,x.y,x.z,0, y.x,y.y,y.z,0, z.x,z.y,z.z,0, o.x,o.y,o.z,1])
    end
    def *(other)
      if other.is_a?(Transformation)
        a = @m; b = other.m
        out = Array.new(16, 0.0)
        4.times do |col|
          4.times do |row|
            sum = 0.0
            4.times { |k| sum += a[k * 4 + row] * b[col * 4 + k] }
            out[col * 4 + row] = sum
          end
        end
        Transformation.new(out)
      elsif other.is_a?(Point3d)
        apply_point(other)
      elsif other.is_a?(Vector3d)
        apply_vector(other)
      end
    end
    def apply_point(p)
      Point3d.new(
        @m[0]*p.x + @m[4]*p.y + @m[8]*p.z  + @m[12],
        @m[1]*p.x + @m[5]*p.y + @m[9]*p.z  + @m[13],
        @m[2]*p.x + @m[6]*p.y + @m[10]*p.z + @m[14]
      )
    end
    def apply_vector(v)
      Vector3d.new(
        @m[0]*v.x + @m[4]*v.y + @m[8]*v.z,
        @m[1]*v.x + @m[5]*v.y + @m[9]*v.z,
        @m[2]*v.x + @m[6]*v.y + @m[10]*v.z
      )
    end
    def identity?; @m == [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] end
    def origin; Point3d.new(@m[12], @m[13], @m[14]) end
    def to_a; @m.dup end
    def inspect; "Transformation#{@m.inspect}" end
  end
end

ORIGIN = Geom::Point3d.new(0, 0, 0)
X_AXIS = Geom::Vector3d.new(1, 0, 0)
Y_AXIS = Geom::Vector3d.new(0, 1, 0)
Z_AXIS = Geom::Vector3d.new(0, 0, 1)
IDENTITY = Geom::Transformation.new

module Sketchup
  def self.version; SUBridge.invoke(:version) end
  def self.active_model; @model ||= Model.new end
  def self.status_text=(t) SUBridge.invoke(:status_text, text: t.to_s) end
  def self.set_status_text(t, *rest) SUBridge.invoke(:status_text, text: t.to_s) end
  # Sketchup.require loads from installed .rbz archives (SUFiles), falling
  # back to Ruby's own require for stdlib.
  def self.require(path)
    if SUFiles.include?(path)
      SUFiles.load(path)
    else
      begin
        Kernel.send(:require, path.to_s)
      rescue LoadError
        $stdout.puts "[Sketch Studio] Sketchup.require(#{path.inspect}): not found in any installed extension."
        false
      end
    end
  end
  def self.load(path) self.require(path) end

  EXTENSIONS = {}
  def self.register_extension(ext, load = false)
    EXTENSIONS[ext.name.to_s] = ext
    if load && ext.loader_path
      if SUFiles.include?(ext.loader_path)
        SUFiles.load(ext.loader_path)
        $stdout.puts "[Sketch Studio] Extension loaded: #{ext.name}#{ext.version ? " #{ext.version}" : ""}"
      else
        $stdout.puts "[Sketch Studio] Extension #{ext.name}: loader #{ext.loader_path.inspect} not found in the archive."
      end
    end
    true
  end
  def self.extensions; EXTENSIONS.values end
  def self.plugins_disabled?; false end
  def self.temp_dir; "/tmp" end
  def self.find_support_file(*) nil end
  def self.platform; :platform_web end
  def self.is_pro?; true end

  # Persistent plugin settings (SketchUp's registry/plist), kept in localStorage
  def self.read_default(section, key, default = nil)
    v = SUBridge.invoke(:read_default, section: section.to_s, key: key.to_s)
    v.nil? ? default : v
  end
  def self.write_default(section, key, value)
    SUBridge.invoke(:write_default, section: section.to_s, key: key.to_s, value: value)
    true
  end

  # SketchUp attribute dictionaries (set_attribute/get_attribute), stored per object
  module AttributeStore
    def set_attribute(dict, key, value)
      @su_attrs ||= {}
      (@su_attrs[dict.to_s] ||= {})[key.to_s] = value
      value
    end
    def get_attribute(dict, key, default = nil)
      @su_attrs ||= {}
      d = @su_attrs[dict.to_s]
      d && d.key?(key.to_s) ? d[key.to_s] : default
    end
    def attribute_dictionaries; @su_attrs ||= {} end
    def attribute_dictionary(name, create = false)
      @su_attrs ||= {}
      create ? (@su_attrs[name.to_s] ||= {}) : @su_attrs[name.to_s]
    end
    def delete_attribute(dict, key = nil)
      @su_attrs ||= {}
      key ? (@su_attrs[dict.to_s] || {}).delete(key.to_s) : @su_attrs.delete(dict.to_s)
    end
  end

  # Unknown SketchUp API calls warn once and return nil instead of crashing,
  # so scripts written for full SketchUp degrade gracefully.
  module SoftShim
    def method_missing(name, *args, &block)
      $su_shim_warned ||= {}
      key = "#{self.class.name}##{name}"
      unless $su_shim_warned[key]
        $su_shim_warned[key] = true
        $stdout.puts "[Sketch Studio] #{key} is not supported in this shim — call ignored."
      end
      nil
    end
  end

  class Color
    attr_accessor :red, :green, :blue, :alpha
    def initialize(*args)
      if args.length == 1 && args[0].is_a?(String)
        @name = args[0]
        @red = @green = @blue = nil
      else
        @red, @green, @blue = args[0] || 0, args[1] || 0, args[2] || 0
        @alpha = args[3] || 255
      end
    end
    def to_bridge; @name || [@red, @green, @blue] end
    def to_a; [@red, @green, @blue, @alpha || 255] end
    def inspect; @name ? "Color(#{@name})" : "Color(#{@red}, #{@green}, #{@blue})" end
  end

  class Material
    attr_accessor :name
    def initialize(name) @name = name; @color = nil end
    def color; @color end
    def color=(c) @color = c end
    def to_bridge
      case @color
      when Color then @color.to_bridge
      when Array, String then @color
      else @name   # try the material name as a CSS color
      end
    end
  end

  class Materials
    include Enumerable
    include SoftShim
    def initialize; @mats = {} end
    def add(name) @mats[name] ||= Material.new(name) end
    def [](name) @mats[name] end
    def each(&b) @mats.values.each(&b) end
    def length; @mats.length end
    alias size length
    def current; @current end
    def current=(m) @current = m end
  end

  class Entity
    include AttributeStore
    include SoftShim
    attr_reader :entity_id
    def initialize(id) @entity_id = id end
    def ==(o) o.is_a?(Entity) && o.entity_id == entity_id end
    alias eql? ==
    def hash; entity_id.hash end
    def info; SUBridge.invoke(:entity_info, id: entity_id) end
    def valid?; !info.nil? end
    def deleted?; info.nil? end
    def erase!; SUBridge.invoke(:erase, ids: [entity_id]); nil end
    def bounds
      Geom::BoundingBox.from_hash(SUBridge.invoke(:bounds, ids: [entity_id]))
    end
    def model; Sketchup.active_model end
    def typename; self.class.name.split("::").last end
    def inspect; "#<Sketchup::#{typename}:#{entity_id}>" end
  end

  # matches SketchUp's hierarchy so is_a?(Sketchup::Drawingelement) checks work
  class Drawingelement < Entity
    def layer; @layer end
    def layer=(l) @layer = l end
    def hidden?; !!@hidden end
    def hidden=(v) @hidden = v end
    def visible?; !@hidden end
    def casts_shadows=(v) v end
    def receives_shadows=(v) v end
  end

  class Vertex
    def initialize(pt) @pt = Geom::Point3d.from(pt) end
    def position; @pt end
    def inspect; "#<Vertex #{@pt.inspect}>" end
  end

  class Edge < Drawingelement
    def start; Vertex.new(info["start"]) end
    define_method(:end) { Vertex.new(info["end"]) }
    def length; info["length"] end
    def line
      i = info
      s = Geom::Point3d.from(i["start"])
      [s, s.vector_to(Geom::Point3d.from(i["end"])).normalize]
    end
    def vertices; i = info; [Vertex.new(i["start"]), Vertex.new(i["end"])] end
    def faces
      ((info || {})["faces"] || []).map { |id| Face.new(id) }
    end
  end

  class Face < Drawingelement
    def pushpull(dist, copy = false)
      # extruded geometry lands in the same container as this face (kernel rule)
      r = SUBridge.invoke(:pushpull, face: entity_id, dist: dist.to_f)
      Face.new(r["top_face"])
    end
    def normal; Geom::Vector3d.from(info["normal"]) end
    def area; SUBridge.invoke(:face_area, id: entity_id) end
    def center; Geom::Point3d.from(info["center"]) end
    def vertices; info["loop"].map { |p| Vertex.new(p) } end
    def outer_loop; self end
    def material=(m)
      c = case m
          when Material then m.to_bridge
          when Color then m.to_bridge
          else m
          end
      SUBridge.invoke(:set_color, id: entity_id, color: c)
      m
    end
    def material
      c = info && info["color"]
      c ? Color.new(c) : nil
    end
    def back_material=(m) self.material = m end
    def reverse!
      SUBridge.invoke(:reverse_face, id: entity_id)
      self
    end
    def edges
      ((info || {})["edges"] || []).map { |id| Edge.new(id) }
    end
  end

  class Entities
    include Enumerable
    include SoftShim
    # cid: the kernel container these entities live in (nil = model space).
    # Geometry in different containers never welds together — group isolation.
    # owner: the Group these entities belong to (for material inheritance).
    def initialize(cid = nil, owner = nil)
      @cid = cid
      @owner = owner
    end

    def container_id; @cid || 0 end

    # SketchUp: faces with the default material display their group's material
    def apply_owner_material(face_id)
      return unless face_id && @owner && @owner.respond_to?(:material_for_new_faces)
      c = @owner.material_for_new_faces
      SUBridge.invoke(:set_color_if_default, id: face_id, color: c) if c
    end

    def add_line(p1, p2)
      r = SUBridge.invoke(:add_line, p1: SUBridge.pt(p1), p2: SUBridge.pt(p2), container: container_id)
      r["edge"] ? Edge.new(r["edge"]) : nil
    end

    def add_edges(*pts)
      # accept both add_edges(p1, p2, ...) and add_edges([p1, p2, ...])
      pts = pts.first if pts.length == 1 && pts.first.is_a?(Array) && !pts.first.first.is_a?(Numeric)
      ids = SUBridge.invoke(:add_edges, pts: pts.map { |p| SUBridge.pt(p) }, container: container_id)
      ids.map { |id| Edge.new(id) }
    end

    def add_face(*args)
      args = args.first if args.length == 1 && args.first.is_a?(Array)
      if args.all? { |a| a.is_a?(Edge) }
        r = SUBridge.invoke(:add_face_from_edges, edges: args.map(&:entity_id))
      else
        r = SUBridge.invoke(:add_face, pts: args.map { |p| SUBridge.pt(p) }, container: container_id)
      end
      apply_owner_material(r["face"])
      Face.new(r["face"])
    end

    def add_circle(center, normal, radius, numsegs = 24)
      r = SUBridge.invoke(:add_circle,
        center: SUBridge.pt(center), normal: SUBridge.pt(normal),
        radius: radius.to_f, segments: numsegs.to_i, container: container_id)
      apply_owner_material(r["face"])
      r["edges"].map { |id| Edge.new(id) }
    end

    def add_ngon(center, normal, radius, numsegs = 6)
      add_circle(center, normal, radius, numsegs)
    end

    def add_group(*ents) Group.new(container_id) end

    def add_instance(definition, tr = Geom::Transformation.new)
      raise ArgumentError, "add_instance expects a ComponentDefinition" unless definition.is_a?(ComponentDefinition)
      snap = definition.freeze_geometry!
      r = SUBridge.invoke(:instantiate, snapshot: snap, matrix: tr.to_a,
                          parent: container_id, name: definition.name)
      inst = ComponentInstance.new(definition, r["container"])
      definition.instances << inst
      inst
    end

    def add_cpoint(pt) nil end
    def add_cline(*a) nil end
    def add_text(*a) nil end

    def erase_entities(*ents)
      ids = ents.flatten.map { |e| e.is_a?(Entity) ? e.entity_id : e }
      SUBridge.invoke(:erase, ids: ids)
      nil
    end

    def transform_entities(tr, *ents)
      ids = ents.flatten.map { |e| e.is_a?(Entity) ? e.entity_id : e }
      SUBridge.invoke(:transform, ids: ids, matrix: tr.to_a)
      true
    end

    def clear!; SUBridge.invoke(:clear); nil end

    # Group/definition entities iterate ONLY their own contents; the model's
    # entities iterate everything. This mirrors real SketchUp scoping.
    def each
      list = @cid ? SUBridge.invoke(:container_entities, cid: @cid, deep: false)
                  : SUBridge.invoke(:all_entities)
      list.each do |h|
        yield(h["type"] == "face" ? Face.new(h["id"]) : Edge.new(h["id"]))
      end
    end
    def length
      if @cid
        SUBridge.invoke(:container_entities, cid: @cid, deep: false).length
      else
        SUBridge.invoke(:count_entities)
      end
    end
    alias size length
    # count is intentionally NOT aliased to length: Enumerable#count keeps block support
    def [](i) to_a[i] end
    def at(i) to_a[i] end
    def model; Sketchup.active_model end
    def parent; Sketchup.active_model end
  end

  # Groups are flattened in Sketch Studio: geometry lands in the model,
  # but the ids created through the group are tracked so transform!/move!
  # and erase! still work on the group as a unit.
  class Group < Drawingelement
    attr_reader :cid
    def initialize(parent_cid = 0)
      @cid = SUBridge.invoke(:container_create, name: "Group", parent: parent_cid)
      @entities = Entities.new(@cid, self)
      super(-1)
    end
    def material_for_new_faces; @material_bridge end
    def entities; @entities end
    def ids
      SUBridge.invoke(:container_entities, cid: @cid, deep: true).map { |h| h["id"] }
    end
    def transformation; Geom::Transformation.new end
    def transform!(t)
      SUBridge.invoke(:transform, ids: ids, matrix: t.to_a)
      self
    end
    def move!(t) transform!(t) end
    def transformation=(t) transform!(t) end
    def erase!
      SUBridge.invoke(:erase, ids: ids)
      nil
    end
    def explode; [] end
    def name; @name.to_s end
    def name=(n)
      @name = n
      SUBridge.invoke(:container_set_name, cid: @cid, name: n.to_s)
      n
    end
    def material=(m)
      @material_bridge = case m
                         when Material, Color then m.to_bridge
                         else m
                         end
      # apply to existing default-colored faces; future faces inherit on creation
      SUBridge.invoke(:container_entities, cid: @cid, deep: true).each do |h|
        next unless h["type"] == "face"
        SUBridge.invoke(:set_color_if_default, id: h["id"], color: @material_bridge)
      end
      m
    end
    def bounds
      Geom::BoundingBox.from_hash(SUBridge.invoke(:bounds, ids: ids))
    end
  end

  # Components: draw into definition.entities, then stamp copies with
  # add_instance(defn, transformation). The definition's source geometry is
  # snapshotted and removed from the model when the first instance is placed.
  class ComponentDefinition
    include AttributeStore
    include SoftShim
    attr_reader :name
    def initialize(name)
      @name = name.to_s
      @cid = SUBridge.invoke(:container_create, name: "<definition> " + @name, parent: 0)
      @entities = Entities.new(@cid, self)
      @snapshot = nil
    end
    def entities; @entities end
    def instances; @instances ||= [] end
    def count_instances; instances.length end
    def group?; false end
    def image?; false end
    def freeze_geometry!
      return @snapshot if @snapshot
      ids = SUBridge.invoke(:container_entities, cid: @cid, deep: true).map { |h| h["id"] }
      @snapshot = SUBridge.invoke(:snapshot_entities, ids: ids)
      SUBridge.invoke(:erase, ids: ids)
      @snapshot
    end
    def inspect; "#<Sketchup::ComponentDefinition #{@name} (#{count_instances} instances)>" end
  end

  class ComponentInstance < Drawingelement
    attr_reader :definition, :cid
    def initialize(defn, cid)
      super(-1)
      @definition = defn
      @cid = cid
    end
    def ids
      SUBridge.invoke(:container_entities, cid: @cid, deep: true).map { |h| h["id"] }
    end
    def entities; @entities ||= Entities.new(@cid, self) end
    def transform!(t) SUBridge.invoke(:transform, ids: ids, matrix: t.to_a); self end
    def move!(t) transform!(t) end
    def transformation=(t) transform!(t) end
    def transformation; Geom::Transformation.new end
    def erase!; SUBridge.invoke(:erase, ids: ids); nil end
    def name; @definition ? @definition.name : "" end
    def explode; [] end
    def bounds; Geom::BoundingBox.from_hash(SUBridge.invoke(:bounds, ids: ids)) end
    def inspect; "#<Sketchup::ComponentInstance of #{name}>" end
  end

  class DefinitionList
    include Enumerable
    include SoftShim
    def initialize; @defs = {} end
    def add(name) @defs[name.to_s] ||= ComponentDefinition.new(name) end
    def [](key) key.is_a?(Integer) ? @defs.values[key] : @defs[key.to_s] end
    def each(&b) @defs.values.each(&b) end
    def length; @defs.length end
    alias size length
    def unique_name(base) base end
  end

  class Layer
    include AttributeStore
    include SoftShim
    attr_accessor :name
    def initialize(name) @name = name.to_s end
    def visible?; true end
    def visible=(v) v end
    def inspect; "#<Sketchup::Layer #{@name}>" end
  end
  Tag = Layer

  class Layers
    include Enumerable
    include SoftShim
    def initialize; @layers = { "Layer0" => Layer.new("Layer0") } end
    def add(name) @layers[name.to_s] ||= Layer.new(name) end
    alias add_layer add
    def [](key) key.is_a?(Integer) ? @layers.values[key] : @layers[key.to_s] end
    def each(&b) @layers.values.each(&b) end
    def length; @layers.length end
    alias size length
    def unique_name(base) base end
  end

  class Selection
    include Enumerable
    include SoftShim
    def add(*ents)
      ids = ents.flatten.map { |e| e.is_a?(Entity) ? e.entity_id : e }
      SUBridge.invoke(:selection_set, ids: (to_ids + ids).uniq)
    end
    def clear; SUBridge.invoke(:selection_clear) end
    def to_ids; SUBridge.invoke(:selection_get) end
    def each
      to_ids.each do |id|
        info = SUBridge.invoke(:entity_info, id: id)
        next unless info
        yield(info["type"] == "face" ? Face.new(id) : Edge.new(id))
      end
    end
    def length; to_ids.length end
    alias size length
    def empty?; to_ids.empty? end
    def [](i) to_a[i] end
    def first; to_a.first end
  end

  class Model
    include AttributeStore
    include SoftShim
    def entities; @entities ||= Entities.new end
    def active_entities; entities end
    def selection; @selection ||= Selection.new end
    def materials; @materials ||= Materials.new end
    def start_operation(name, *rest) SUBridge.invoke(:start_operation, name: name.to_s); true end
    def commit_operation; SUBridge.invoke(:commit_operation); true end
    def abort_operation; SUBridge.invoke(:abort_operation); true end
    def bounds; Geom::BoundingBox.from_hash(SUBridge.invoke(:bounds, ids: nil)) end
    def title; "Untitled" end
    def name; title end
    def path; "" end
    def active_view; nil end
    def options; {} end
    def definitions; @definitions ||= DefinitionList.new end
    def layers; @model_layers ||= Layers.new end
    alias tags layers
    def active_layer; layers[0] end
    def active_layer=(l) l end
    def edit_transform; Geom::Transformation.new end
    def close_active; false end
    def valid?; true end
  end
end

module Sketchup
  # lightweight stand-ins so is_a?/case checks in real SketchUp scripts resolve
  %w[Image Text ConstructionPoint ConstructionLine Curve ArcCurve Loop EdgeUse
     Dimension DimensionLinear DimensionRadial SectionPlane Axes Camera View
     InputPoint Style Styles Page Pages RenderingOptions ShadowInfo OptionsManager
     Behavior Texture UVHelper Tool AppObserver ModelObserver EntitiesObserver
     SelectionObserver ToolsObserver ViewObserver].each do |n|
    const_set(n, Class.new(Entity)) unless const_defined?(n)
  end
  class AttributeDictionary < Hash; end unless const_defined?(:AttributeDictionary)
end

# SketchUp's Length: lengths behave as numbers; to_l parses/passes through
class Numeric
  def to_l; to_f end
end
class String
  def to_l; Float(self) rescue self.to_f end
end
Length = Float unless defined?(Length)

module UI
  MENU_HANDLERS = {}

  class Menu
    def initialize(name) @name = name end
    def add_item(title, &block)
      id = SUBridge.invoke(:add_menu_item, menu: @name.to_s, title: title.to_s)
      MENU_HANDLERS[id] = block
      id
    end
    def add_submenu(title) Menu.new(title) end
    def add_separator; nil end
  end

  def self.menu(name = "Plugins") Menu.new(name) end

  def self.call_menu_handler(id)
    handler = MENU_HANDLERS[id]
    handler.call if handler
  rescue Exception => e
    $stdout.puts "Error in menu handler: #{e.class}: #{e.message}"
  end

  def self.messagebox(msg, type = 0)
    SUBridge.invoke(:messagebox, msg: msg.to_s)
    6   # IDYES-ish, scripts mostly ignore it
  end

  def self.inputbox(prompts, defaults = [], *rest)
    title = rest.reverse.find { |r| r.is_a?(String) } || ""
    vals = SUBridge.invoke(:inputbox, prompts: prompts.map(&:to_s),
                           defaults: defaults.map(&:to_s), title: title)
    return false if vals.nil?
    vals.each_with_index.map do |v, i|
      d = defaults[i]
      case d
      when Integer then v.to_i
      when Numeric then v.to_f
      else v
      end
    end
  end

  def self.beep; nil end
  def self.start_timer(*args) 0 end
  def self.stop_timer(id) nil end
  def self.openpanel(*a) nil end
  def self.savepanel(*a) nil end
  def self.refresh_toolbars; nil end
end

# ── Virtual plugin filesystem: .rbz archives unzip into here ──
# Keys are archive-relative paths ("my_ext/main.rb"); require/require_relative/
# Sketchup.require/File.read all check this store before the real (wasi) FS,
# so multi-file extensions run unmodified. Files eval with their virtual path
# as __FILE__, which keeps File.dirname(__FILE__)-style loaders working.
module SUFiles
  STORE = {}
  LOADED = {}

  def self.normalize(p)
    p.to_s.tr("\\", "/").sub(%r{\A\./}, "").sub(%r{\A/}, "")
  end

  # JS stages a JSON object of { path => source } before calling this.
  def self.ingest_pending
    files = JSON.parse(JS.global[:RubyBridge].call(:getPendingFiles).to_s)
    files.each { |path, src| STORE[normalize(path)] = src }
    files.length
  end

  def self.resolve(path, base_dir = nil)
    p = normalize(path)
    cands = []
    if base_dir && !base_dir.to_s.empty? && base_dir != "."
      cands << "#{normalize(base_dir)}/#{p}"
    end
    cands << p
    cands.flat_map { |c| c.end_with?(".rb") ? [c] : [c, "#{c}.rb"] }
         .find { |c| STORE.key?(c) }
  end

  def self.include?(path, base_dir = nil)
    !resolve(path, base_dir).nil?
  end

  def self.load_key(key)
    return false if LOADED[key]
    LOADED[key] = true
    begin
      TOPLEVEL_BINDING.eval(STORE[key], key)
    rescue Exception
      LOADED.delete(key)   # a failed load may be retried after a fix
      raise
    end
    true
  end

  def self.load(path, base_dir = nil)
    key = resolve(path, base_dir)
    raise LoadError, "cannot load such file -- #{path} (not found in any installed extension)" unless key
    load_key(key)
  end

  # dir of the virtual file that called into us, or nil if the caller is real
  def self.caller_dir(locations)
    loc = locations&.first
    return nil unless loc
    p = normalize(loc.path.to_s)
    STORE.key?(p) ? File.dirname(p) : nil
  end
end

# require / require_relative look inside installed extensions first.
module Kernel
  # features SketchUp itself ships — our shim already provides these APIs
  SU_BUILTIN_FEATURES = %w[sketchup sketchup.rb extensions extensions.rb
                           langhandler langhandler.rb LangHandler.rb su_dynamiccomponents.rb].freeze

  alias_method :__su_orig_require, :require
  def require(path)
    p = path.to_s
    return true if SU_BUILTIN_FEATURES.include?(p) || SU_BUILTIN_FEATURES.include?(File.basename(p))
    key = SUFiles.resolve(p, SUFiles.caller_dir(caller_locations(1, 1)))
    return SUFiles.load_key(key) if key
    __su_orig_require(p)
  end

  alias_method :__su_orig_require_relative, :require_relative
  def require_relative(path)
    dir = SUFiles.caller_dir(caller_locations(1, 1))
    if dir
      key = SUFiles.resolve(path, dir)
      return SUFiles.load_key(key) if key
    end
    __su_orig_require_relative(path)
  end
end

# File reads fall through to the archive store (extension data/template files).
class << File
  alias_method :__su_orig_read, :read
  def read(path, *args, **kw)
    src = SUFiles::STORE[SUFiles.normalize(path)]
    src.nil? ? __su_orig_read(path, *args, **kw) : src
  end
  alias_method :__su_orig_exist?, :exist?
  def exist?(path)
    SUFiles::STORE.key?(SUFiles.normalize(path)) || __su_orig_exist?(path)
  end
  alias_method :__su_orig_file?, :file?
  def file?(path)
    SUFiles::STORE.key?(SUFiles.normalize(path)) || __su_orig_file?(path)
  end
end

# SketchUp's per-language string tables — pass keys through untranslated.
class LanguageHandler
  def initialize(*) end
  def [](key) key.to_s end
  def GetString(key) key.to_s end
  def strings; Hash.new { |_h, k| k.to_s } end
  def resource_path(name) name.to_s end
end

# SketchUp extension registration boilerplate. The loader path given to
# SketchupExtension.new is loaded from the archive by Sketchup.register_extension.
class SketchupExtension
  attr_accessor :name, :description, :version, :creator, :copyright
  attr_reader :loader_path
  def initialize(name, path = nil)
    @name = name
    @loader_path = path
    $stdout.puts "[Sketch Studio] Extension registered: #{name}"
  end
  def check; true end
end
$__su_loaded_files = {}
def file_loaded?(path) $__su_loaded_files.key?(path.to_s) end
def file_loaded(path) $__su_loaded_files[path.to_s] = true end

$stdout.puts "SketchUp-compatible Ruby API ready — Ruby #{RUBY_VERSION} (ruby.wasm). Units: inches."
$stdout.puts "Try: Sketchup.active_model.entities.add_face([0,0,0],[48,0,0],[48,48,0],[0,48,0]).pushpull(96)"
`;

/* The runner passes code through the bridge instead of string-escaping it,
 * evaluates in TOPLEVEL_BINDING so console locals persist between runs. */
const RUBY_RUNNER = String.raw`
begin
  __su_code = JS.global[:RubyBridge].call(:getPendingCode).to_s
  SUWatchdog.start
  begin
    __su_result = TOPLEVEL_BINDING.eval(__su_code)
  ensure
    SUWatchdog.stop
  end
  JS.global[:RubyBridge].call(:evalResult, __su_result.inspect[0, 400])
rescue Exception => __su_e
  __su_bt = (__su_e.backtrace || []).reject { |l| l.include?("/usr/local/lib") }.first(6).join("\n")
  JS.global[:RubyBridge].call(:evalError, "#{__su_e.class}: #{__su_e.message}\n#{__su_bt}")
end
`;

/* ---------------- Ruby engine loader ---------------- */

const RubyEngine = {
  vm: null,
  _loading: null,

  async ensureLoaded() {
    if (this.vm) return this.vm;
    if (!this._loading) this._loading = this._load();
    return this._loading;
  },

  async _load() {
    const status = t => { RubyConsole.setStatus(t); RubyConsole.append(t, "info"); };
    try {
      status("Loading Ruby engine (ruby.wasm ≈ 25 MB, one-time download)…");
      const esm = await import("https://cdn.jsdelivr.net/npm/@ruby/wasm-wasi@2/dist/browser/+esm");
      const wasmUrl = "https://cdn.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@2/dist/ruby+stdlib.wasm";
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error("Failed to download ruby.wasm: HTTP " + response.status);
      status("Compiling Ruby WebAssembly module…");
      let module;
      try {
        module = await WebAssembly.compileStreaming(response);
      } catch (e) {
        const buf = await (await fetch(wasmUrl)).arrayBuffer();
        module = await WebAssembly.compile(buf);
      }
      status("Booting Ruby VM…");
      const { vm } = await esm.DefaultRubyVM(module);
      vm.eval(RUBY_PRELUDE);
      this.vm = vm;
      RubyConsole.setStatus("Ruby " + vm.eval("RUBY_VERSION").toString() + " ready");
      return vm;
    } catch (err) {
      this._loading = null;
      RubyConsole.setStatus("Ruby engine failed to load");
      RubyConsole.append("Could not load the Ruby engine: " + (err && err.message || err) +
        "\n(An internet connection is required for the one-time ruby.wasm download.)", "error");
      throw err;
    }
  },

  /* Run Ruby code. Echoes to console, snapshots for a single undo step.
   * Rendering is batched: the scene rebuilds once when the script finishes,
   * not after every geometry call. */
  async run(code, { echo = true, label = null } = {}) {
    if (echo) {
      const shown = label ? "# " + label : code;
      let lines = shown.split("\n");
      if (lines.length > 32) {
        lines = lines.slice(0, 30).concat(["… (+" + (lines.length - 30) + " more lines)"]);
      }
      RubyConsole.append(lines.map(l => "▸ " + l).join("\n"), "echo");
    }
    let vm;
    try { vm = await this.ensureLoaded(); } catch (e) { return; }
    // let the browser paint the status before the synchronous eval blocks the tab
    // (setTimeout, not rAF — rAF never fires in hidden/background tabs)
    RubyConsole.setStatus("Running script… (tab is busy until it finishes)");
    await new Promise(r => setTimeout(r, 40));
    const before = App.model.toJSON();
    RubyBridge.pendingCode = code;
    RubyBridge.resetStats();
    const t0 = performance.now();
    App.model.beginBatch();
    try {
      vm.eval(RUBY_RUNNER);
    } catch (err) {
      RubyConsole.append("Ruby VM error: " + (err && err.message || err), "error");
    } finally {
      App.model.endBatch();
    }
    const secs = (performance.now() - t0) / 1000;
    RubyConsole.setStatus("Ruby ready — last run " + secs.toFixed(1) + "s");
    if (secs > 2) RubyConsole.append("⏱ " + secs.toFixed(1) + "s — " + RubyBridge.statsSummary(), "info");
    if (App.model.toJSON() !== before) App.pushUndoSnapshot(before);
    this.refreshOutliner();
  },

  /* Install a SketchUp .rbz extension: unzip in the browser, put every text
   * file into the Ruby-side virtual FS (SUFiles), then run each root-level
   * .rb loader exactly the way SketchUp would on install. */
  async installRbz(name, buffer) {
    let vm;
    try { vm = await this.ensureLoaded(); } catch (e) { return; }

    RubyConsole.setStatus("Unpacking " + name + "…");
    let entries;
    try {
      const { unzipSync } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js");
      entries = unzipSync(new Uint8Array(buffer));
    } catch (err) {
      RubyConsole.append("Could not unpack " + name + ": " + (err && err.message || err), "error");
      RubyConsole.setStatus("Ruby ready");
      return;
    }

    // .rbz = zip of the plugins folder: loader .rb at the root + a subfolder.
    // Only text files matter to the Ruby side; binaries (images, .so) are skipped.
    const TEXT_EXT = /\.(rb|rbs|txt|json|csv|html?|css|js|xml|ya?ml|md|dat|def|lang|strings|lst|cfg|ini|svg|erb)$/i;
    const dec = new TextDecoder("utf-8");
    const files = {};
    const loaders = [];
    let skipped = 0;
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith("/")) continue;
      const norm = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      if (!norm || norm.startsWith("__MACOSX/") || norm.split("/").pop().startsWith(".")) { skipped++; continue; }
      if (!TEXT_EXT.test(norm)) { skipped++; continue; }
      files[norm] = dec.decode(data);
      if (/^[^/]+\.rb$/i.test(norm)) loaders.push(norm);
    }

    const count = Object.keys(files).length;
    if (!count) {
      RubyConsole.append(name + " contains no Ruby files — is it really an extension .rbz?", "error");
      RubyConsole.setStatus("Ruby ready");
      return;
    }

    RubyBridge.pendingFilesJson = JSON.stringify(files);
    try {
      vm.eval("SUFiles.ingest_pending");
    } finally {
      RubyBridge.pendingFilesJson = "{}";
    }
    RubyConsole.append("📦 " + name + " installed: " + count + " file" + (count === 1 ? "" : "s") +
      (skipped ? " (" + skipped + " binary/support file" + (skipped === 1 ? "" : "s") + " skipped)" : ""), "info");

    if (!loaders.length) {
      RubyConsole.append("No root-level .rb loader found in the archive. Load a file manually with " +
        'Sketchup.require("path/inside/archive")', "info");
      RubyConsole.setStatus("Ruby ready");
      return;
    }
    for (const loader of loaders.sort()) {
      await this.run('SUFiles.load(' + JSON.stringify(loader) + ')', { echo: false });
    }
    RubyConsole.append("Check Extensions ▸ Plugins for any menu items the extension registered.", "info");
  },

  /* The group tree lives in the model's containers now — just re-read it */
  refreshOutliner() {
    if (window.App && App.outliner) App.outliner.updateFromModel();
  },

  async callMenuHandler(id) {
    if (!this.vm) return;
    const before = App.model.toJSON();
    App.model.beginBatch();
    try {
      this.vm.eval("UI.call_menu_handler(" + Number(id) + ")");
    } catch (err) {
      RubyConsole.append("Menu handler error: " + (err && err.message || err), "error");
    } finally {
      App.model.endBatch();
    }
    if (App.model.toJSON() !== before) App.pushUndoSnapshot(before);
    this.refreshOutliner();
  }
};

/* ---------------- Console UI ---------------- */

const RubyConsole = {
  history: [],
  historyIndex: -1,

  init() {
    this.output = document.getElementById("ruby-output");
    this.input = document.getElementById("ruby-input");
    this.statusEl = document.getElementById("ruby-status");
    this.runBtn = document.getElementById("btn-ruby-run");

    this.runBtn.addEventListener("click", () => this.runInput());
    this.input.addEventListener("keydown", e => {
      // Enter runs (like SketchUp's Ruby console); Shift+Enter inserts a newline
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.runInput(); }
      if (e.key === "ArrowUp" && !this.input.value.includes("\n") && this.history.length) {
        e.preventDefault();
        this.historyIndex = Math.max(0, this.historyIndex - 1);
        this.input.value = this.history[this.historyIndex] || "";
      }
      if (e.key === "ArrowDown" && !this.input.value.includes("\n") && this.history.length) {
        e.preventDefault();
        this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
        this.input.value = this.history[this.historyIndex] || "";
      }
      e.stopPropagation();   // don't trigger app shortcuts while typing Ruby
    });
    document.getElementById("btn-ruby-clear").addEventListener("click", () => { this.output.innerHTML = ""; });
    document.getElementById("btn-ruby-close").addEventListener("click", () => App.toggleConsole(false));
    document.getElementById("btn-ruby-load").addEventListener("click", () => App.openRubyFilePicker());

    this.append("💎 Ruby Console — SketchUp-compatible scripting.", "info");
    this.append("Load .rb scripts or install .rbz extensions via the Extensions menu, drag & drop them here,", "info");
    this.append("or type code below and press Enter. The engine downloads on the first run", "info");
    this.append("(≈ 25 MB — watch the status text next to the Run button).", "info");
  },

  runInput() {
    const code = this.input.value.trim();
    if (!code) {
      this.append("Nothing to run — type Ruby code above, then press Enter or ▶ Run.", "info");
      return;
    }
    this.history.push(code);
    this.historyIndex = this.history.length;
    this.input.value = "";
    RubyEngine.run(code);
  },

  /* Output is buffered and flushed once per animation frame: a script that
   * prints thousands of lines costs one DOM reflow, not one per line. */
  append(text, cls = "ln") {
    this._pending = this._pending || [];
    if (this._pending.length >= 2000) { this._dropped = (this._dropped || 0) + 1; return; }
    this._pending.push([text, cls]);
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      setTimeout(() => this.flush(), 30);   // not rAF: must fire in hidden tabs too
    }
  },

  flush() {
    this._flushScheduled = false;
    const pending = this._pending || [];
    this._pending = [];
    if (this._dropped) {
      pending.push(["… (" + this._dropped + " output lines dropped — script prints too much)", "info"]);
      this._dropped = 0;
    }
    if (!pending.length) return;
    const frag = document.createDocumentFragment();
    for (const [text, cls] of pending) {
      const div = document.createElement("div");
      div.className = "ln " + cls;
      div.textContent = text;
      frag.appendChild(div);
    }
    this.output.appendChild(frag);
    while (this.output.childNodes.length > 800) this.output.removeChild(this.output.firstChild);
    this.output.scrollTop = this.output.scrollHeight;
  },

  setStatus(t) { this.statusEl.textContent = t; }
};
