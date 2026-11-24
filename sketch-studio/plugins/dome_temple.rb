# Dome Temple â€” cylinder plinth, ring of columns, stepped dome
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
puts "Temple complete â€” orbit around it!"

