# Tiny script used to smoke-test the ?script= bridge parameter.
ents = Sketchup.active_model.entities
f = ents.add_face([0,0,0],[24,0,0],[24,24,0],[0,24,0])
f.pushpull 12
puts "url-bridge ok"
