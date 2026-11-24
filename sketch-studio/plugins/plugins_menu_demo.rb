# Extension menu demo â€” registers commands under Extensions,
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

