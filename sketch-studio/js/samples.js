/* ============================================================
 * samples.js — bundled sample Ruby plugin scripts, written the
 * same way real SketchUp extensions are. Mirrored in /plugins.
 * Units are inches, exactly like real SketchUp.
 * ============================================================ */
"use strict";

const SAMPLE_SCRIPTS = {

"parametric_box.rb": String.raw`# Parametric Box — asks for dimensions and builds a box
model = Sketchup.active_model
ents  = model.active_entities

vals = UI.inputbox(["Width (ft)", "Depth (ft)", "Height (ft)"], [12.0, 10.0, 8.0], "Parametric Box")
if vals
  w, d, h = vals.map { |v| v.feet }
  model.start_operation("Box", true)
  face = ents.add_face([0,0,0], [w,0,0], [w,d,0], [0,d,0])
  face.pushpull(h)
  model.commit_operation
  puts "Built a #{vals[0]} x #{vals[1]} x #{vals[2]} ft box."
else
  puts "Box cancelled — no dimensions entered."
end
`,

"spiral_staircase.rb": String.raw`# Spiral Staircase — winds steps around a center column
model = Sketchup.active_model
ents  = model.active_entities

steps    = 18
rise     = 7.5        # inches per step
r_inner  = 14
r_outer  = 63
sweep    = 1.75 * Math::PI

model.start_operation("Spiral Staircase", true)

steps.times do |i|
  a1 = sweep * i / steps
  a2 = sweep * (i + 1) / steps
  z  = (i + 1) * rise
  pts = [
    [r_inner * Math.cos(a1), r_inner * Math.sin(a1), z],
    [r_outer * Math.cos(a1), r_outer * Math.sin(a1), z],
    [r_outer * Math.cos(a2), r_outer * Math.sin(a2), z],
    [r_inner * Math.cos(a2), r_inner * Math.sin(a2), z]
  ]
  face = ents.add_face(pts)
  face.material = [160 + rand(40), 120 + rand(30), 80]
  face.pushpull(-2.5)
end

# center column
column = ents.add_circle([0, 0, 0], [0, 0, 1], r_inner * 0.8, 16)
col_face = ents.add_face(column)
col_face.pushpull(steps * rise + 36)

model.commit_operation
puts "Spiral staircase: #{steps} steps, #{((steps * rise) / 12.0).round(1)} ft tall."
`,

"city_generator.rb": String.raw`# City Generator — a random grid of colorful towers
model = Sketchup.active_model
ents  = model.active_entities

blocks  = 5
lot     = 120.0    # 10 ft lots
street  = 56.0

model.start_operation("City", true)

blocks.times do |gx|
  blocks.times do |gy|
    x = gx * (lot + street)
    y = gy * (lot + street)
    inset = 8 + rand * 16
    h = 60 + rand * 360
    face = ents.add_face(
      [x + inset,       y + inset,       0],
      [x + lot - inset, y + inset,       0],
      [x + lot - inset, y + lot - inset, 0],
      [x + inset,       y + lot - inset, 0]
    )
    face.pushpull(h)
    shade = 140 + rand(90)
    face.material = [shade, shade, 150 + rand(80)]
  end
end

model.commit_operation
puts "Generated #{blocks * blocks} buildings. Try Camera > Zoom Extents!"
`,

"dome_temple.rb": String.raw`# Dome Temple — cylinder plinth, ring of columns, stepped dome
model = Sketchup.active_model
ents  = model.active_entities

model.start_operation("Dome Temple", true)

# plinth
plinth = ents.add_face(ents.add_circle([0, 0, 0], [0, 0, 1], 200, 28))
plinth.pushpull(20)
plinth_top = 20

# ring of columns
12.times do |i|
  a = i * Math::PI * 2 / 12
  cx = 160 * Math.cos(a)
  cy = 160 * Math.sin(a)
  col = ents.add_face(ents.add_circle([cx, cy, plinth_top], [0, 0, 1], 11, 10))
  col.pushpull(128)
  col.material = [235, 230, 215]
end

# roof slab + stepped dome
roof = ents.add_face(ents.add_circle([0, 0, plinth_top + 128], [0, 0, 1], 192, 28))
roof.pushpull(16)
z = plinth_top + 144
[152, 120, 88, 56, 28].each do |r|
  ring = ents.add_face(ents.add_circle([0, 0, z], [0, 0, 1], r, 24))
  ring.pushpull(18)
  ring.material = [200, 170, 120]
  z += 18
end

model.commit_operation
puts "Temple complete — orbit around it!"
`,

"plugins_menu_demo.rb": String.raw`# Extension menu demo — registers commands under Extensions,
# exactly like a real SketchUp plugin registers UI.menu items.

menu = UI.menu("Plugins")

menu.add_item("Random Tower") do
  ents = Sketchup.active_model.active_entities
  x = rand(480) - 240
  y = rand(480) - 240
  s = 32 + rand * 60
  face = ents.add_face([x, y, 0], [x + s, y, 0], [x + s, y + s, 0], [x, y + s, 0])
  face.pushpull(80 + rand * 320)
  face.material = [rand(255), rand(255), rand(255)]
end

menu.add_item("Clear Model") do
  Sketchup.active_model.active_entities.clear!
end

puts "Registered 'Random Tower' and 'Clear Model' under the Extensions menu."
UI.messagebox("Two new commands were added to the Extensions menu.")
`
};
