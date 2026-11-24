# Parametric Box â€” asks for dimensions and builds a box
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
  puts "Box cancelled â€” no dimensions entered."
end

