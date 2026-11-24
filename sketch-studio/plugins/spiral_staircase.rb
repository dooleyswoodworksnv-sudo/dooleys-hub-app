# Spiral Staircase â€” winds steps around a center column
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

