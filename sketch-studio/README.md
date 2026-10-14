# Sketch Studio â€” SketchUp-style 3D Workspace with Ruby Scripting

A SketchUp-like 3D modeling workspace that runs entirely in the browser, with a **real
Ruby engine** (CRuby compiled to WebAssembly via `ruby.wasm`) exposing a
**SketchUp-compatible Ruby API** â€” so `.rb` plugin scripts can be downloaded straight
into the workspace and run, just like SketchUp extensions.

## Running it

Open `index.html` in any modern browser (Chrome/Edge/Firefox). An internet connection is
needed the first time: Three.js and the ~25 MB `ruby.wasm` runtime load from a CDN (the
Ruby engine only downloads when you first run a script).

Optionally serve it locally for a cleaner setup:

```
cd sketch-studio
npx http-server -p 8080
```

## Modeling tools (SketchUp-style)

| Tool | Key | Behavior |
|---|---|---|
| Select | Space | Click / Shift-click / drag box select, Del erases |
| Line | L | Click points; **closing a planar loop auto-creates a face**; arrow keys lock to the red/green/blue axis |
| Rectangle | R | Two corners, on the ground or on any face; type `48;36` for exact size |
| Circle | C | Center + radius, 24 segments |
| Push/Pull | P | Click a face, move, click â€” extrudes a solid; type an exact distance |
| Move | M | Click entity/selection, move, click; arrow keys lock axis |
| Paint Bucket | B | Materials palette, click faces |
| Eraser | E | Click/drag edges & faces; erasing an edge erases its faces (SketchUp rule) |
| Orbit / Pan | O / H | Middle-drag always orbits, Shift+middle pans, wheel zooms to cursor |

Inference snapping: **green** = endpoint, **cyan** = midpoint, **red** = on edge,
**blue** = on face. The measurements box (bottom right) accepts typed values with units
(`24`, `2'6"`, `1.5ft`, `30cm`) â€” just start typing while using a tool and press Enter.

Also: full undo/redo (Ctrl+Z/Y), standard views (Camera menu), Zoom Extents (Shift+Z),
save/load models as JSON, OBJ export.

## Ruby scripting â€” getting scripts into the workspace

Three ways to load a `.rb` script:

1. **Extensions â–¸ Load Ruby Scriptâ€¦** â€” pick one or more `.rb` files
2. **Drag & drop** a `.rb` file anywhere onto the window
3. **Extensions â–¸ Load Ruby Script from URLâ€¦** â€” download a script from the web

Or open the **Ruby Console** (ðŸ’Ž button) and type code directly (Ctrl+Enter to run).
Console locals persist between runs; `puts` prints to the console.

Sample plugins are bundled under **Extensions â–¸ Sample scripts** and as files in
[`plugins/`](plugins/) â€” a parametric box, spiral staircase, city generator, dome
temple, and a demo that registers its own menu commands via `UI.menu`.

### Installing `.rbz` extensions

SketchUp's standard extension packages install directly: **Extensions / Install
Extension (.rbz)…**, drag & drop the `.rbz` onto the window, or **Install
Extension from URL…**.

The archive is unzipped in the browser into a **virtual plugin filesystem**; the
root-level loader `.rb` runs exactly as SketchUp would run it on install.
`Sketchup.register_extension(ext, true)`, `Sketchup.require`, `require` /
`require_relative` between archive files, `File.read`/`exist?` of archive files,
`file_loaded?` guards, `LanguageHandler`, and `Sketchup.read_default` /
`write_default` (persisted in localStorage) all work. Binary files in the
archive (images, compiled libs) are skipped. `plugins/bevel_test.rbz` is a tiny
sample with the classic loader + subfolder layout.

What still won't run: extensions needing `UI::HtmlDialog` web UIs, custom
interactive `Tool` classes, observers, or native/compiled code.

## Supported Ruby API (SketchUp-compatible)

```ruby
model = Sketchup.active_model
ents  = model.active_entities

face = ents.add_face([0,0,0], [48,0,0], [48,48,0], [0,48,0])
face.pushpull 96                       # extrude 8 ft
face.material = "red"                  # or [r,g,b] or "#aabbcc"

edges = ents.add_circle(ORIGIN, Z_AXIS, 1.2, 24)
ents.add_face(edges).pushpull 3

ents.add_line [0,0,0], [0,0,5]
ents.transform_entities Geom::Transformation.rotation(ORIGIN, Z_AXIS, 45.degrees), ents.to_a
```

- `Sketchup.active_model`, `model.entities` / `active_entities`, `model.selection`, `model.materials`
- `Entities#add_face` (points **or** an edge array), `#add_line`, `#add_edges`, `#add_circle`, `#add_ngon`, `#erase_entities`, `#clear!`, `#transform_entities`, Enumerable
- `Face#pushpull`, `#normal`, `#area`, `#vertices`, `#material=`; `Edge#start/#end/#length`; `Vertex#position`
- `Geom::Point3d`, `Geom::Vector3d` (dot/cross/normalize/angle_betweenâ€¦), `Geom::Transformation` (translation/rotation/scaling/axes, composition with `*`)
- Constants `ORIGIN`, `X_AXIS`, `Y_AXIS`, `Z_AXIS`, `IDENTITY`; unit helpers `10.feet`, `2.m`, `30.cm`, `45.degrees` (base unit: inch, like SketchUp)
- `model.start_operation` / `commit_operation` â†’ one undo step
- `UI.messagebox`, `UI.inputbox`, `UI.menu("Plugins").add_item("â€¦") { }` â€” registered items appear under the **Extensions** menu
- `SketchupExtension` + `Sketchup.register_extension` run real loader boilerplate; `Sketchup.require` / `require_relative` resolve inside installed `.rbz` archives; `Sketchup.read_default`/`write_default` persist plugin settings

**Differences from real SketchUp:** groups/components are flattened shims
(`group.entities` is scoped to the group's own contents and `group.transform!` /
`group.erase!` work, but there is no edit isolation); no observers or pages; unknown
API calls warn once and return nil instead of raising. The internal unit is the
**inch**, exactly like real SketchUp.

## Architecture

| File | Role |
|---|---|
| `js/model.js` | Boundary-rep geometry kernel: shared vertices, edges, planar faces, loop auto-facing, push/pull, OBJ/JSON |
| `js/viewport.js` | Three.js rendering (Z-up), camera navigation, picking, inference snapping |
| `js/tools.js` | Interactive tools + measurements box parsing |
| `js/ruby.js` | ruby.wasm loader, JSâ†”Ruby JSON bridge, the SketchUp-compatible Ruby prelude, console UI |
| `js/app.js` | Menus, toolbar, shortcuts, undo, file I/O, drag & drop |
| `plugins/*.rb` | Sample plugin scripts you can load (or edit) |

