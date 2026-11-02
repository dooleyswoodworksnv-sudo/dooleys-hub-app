# City Generator â€” a random grid of colorful towers
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

