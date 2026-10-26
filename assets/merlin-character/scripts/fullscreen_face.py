"""A camera-aligned expansion of MERLIN's real display into an expressive face.

Authored geometry and morph targets, with portable glTF tracks. The expanded
surface starts at the evaluated ready head; no character proportions change.
"""
import math
import bpy
from mathutils import Vector
from animate_character import _smooth
from animate_transitions import _sample, _key, _context, _new_action, _finish
from transition_support import linear, new_action

PREFIX = 'Display mode • '
LENGTHS = {'ReadyToFace': 40, 'FullFaceIdle': 96, 'FaceToReady': 36}


def _collection():
    coll = bpy.data.collections.get('MERLIN • Display mode')
    if not coll:
        coll = bpy.data.collections.new('MERLIN • Display mode')
        bpy.context.scene.collection.children.link(coll)
    return coll


def _material(name, color, strength=1):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (0,0,0,1)
    bsdf.inputs['Roughness'].default_value = .8
    bsdf.inputs['Specular IOR Level'].default_value = 0
    bsdf.inputs['Emission Color'].default_value = (*color,1)
    bsdf.inputs['Emission Strength'].default_value = strength
    return mat


def _mesh(name, verts, faces, materials):
    data = bpy.data.meshes.new(PREFIX+name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(PREFIX+name, data)
    _collection().objects.link(obj)
    for mat in materials:
        data.materials.append(mat)
    return obj


def _target_frame():
    camera = bpy.context.scene.camera
    matrix = camera.matrix_world
    right = matrix.to_3x3() @ Vector((1,0,0))
    up = matrix.to_3x3() @ Vector((0,1,0))
    toward = matrix.to_3x3() @ Vector((0,0,1))
    center = matrix.translation - toward*8
    return center, right, up, toward


def _uv_copy(source, obj):
    if source.data.uv_layers:
        uv = obj.data.uv_layers.new(name='Display gradient')
        original = source.data.uv_layers.active
        for a,b in zip(uv.data, original.data):
            a.uv = b.uv


def _shape(obj, name, values):
    key=obj.shape_key_add(name=name)
    for item, co in zip(key.data, values):
        item.co=co
    return key


def create_fullscreen_geometry():
    scene=bpy.context.scene
    rig=bpy.data.objects['MERLIN_Rig']
    rig.animation_data.action=bpy.data.actions['ReadyIdle']
    scene.frame_set(1)
    for n in ('Eye • L','Eye • R','Face • luminous smile'):
        keys=bpy.data.objects[n].data.shape_keys
        keys.animation_data.action=None
        for k in list(keys.key_blocks)[1:]:k.value=0
    bpy.context.view_layer.update()
    center,right,up,toward=_target_frame()
    deps=bpy.context.evaluated_depsgraph_get()
    source=bpy.data.objects['Head • integrated flush display']
    evaluated=source.evaluated_get(deps)
    count=1+28*192
    verts=[evaluated.matrix_world@v.co+toward*.004 for v in list(evaluated.data.vertices)[:count]]
    polys=[p for p in evaluated.data.polygons if all(i<count for i in p.vertices)]
    # Same material regions and silhouette as the authored robot head.
    obj=_mesh('expanding head',verts,[tuple(p.vertices) for p in polys],list(source.data.materials))
    for p,original in zip(obj.data.polygons,polys):p.material_index=original.material_index
    _shape(obj,'Basis',verts)
    target=[center]
    def sp(v,p):return math.copysign(abs(v)**p,v)
    angles=[2*math.pi*i/192 for i in range(192)]
    lens=[(4.89*sp(math.cos(a),.48),3.62*sp(math.sin(a),.48)) for a in angles]
    outer=[(5.00*sp(math.cos(a),.48),3.73*sp(math.sin(a),.48)) for a in angles]
    for j in range(1,17):
        radius=j/16
        for x,y in lens:target.append(center+right*x*radius+up*y*radius)
    for t in [.015,.04,.08,.14,.23,.34,.47,.61,.74,.85,.93,1]:
        for (x,y),(a,b) in zip(lens,outer):target.append(center+right*(x*(1-t)+a*t)+up*(y*(1-t)+b*t))
    _shape(obj,'Expand',target)
    # Gentle blue self-illumination makes the edge readable at its final position.
    edge=source.data.materials[0].copy();edge.name='Display mode • same cornflower edge'
    bsdf=edge.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Emission Color'].default_value=(.052,.19,.52,1)
    bsdf.inputs['Emission Strength'].default_value=.65
    obj.data.materials[0]=edge
    black=_material('Display mode • obsidian',(.003,.007,.014),.48)
    obj.data.materials[1]=black
    obj.data.materials[2]=black
    for p in obj.data.polygons:p.use_smooth=True
    objects=[obj]
    for name, sign in [('Eye • L',1),('Eye • R',-1),('Face • luminous smile',0)]:
        source=bpy.data.objects[name]
        ev=source.evaluated_get(deps)
        verts=[ev.matrix_world@v.co+toward*.008 for v in ev.data.vertices]
        copy=_mesh(name,verts,[tuple(p.vertices) for p in ev.data.polygons],list(source.data.materials))
        _uv_copy(source,copy)
        _shape(copy,'Basis',verts)
        if sign:
            target=[center+right*(sign*1.92+v.co.x*4.5)+up*(.75+v.co.z*4.5)+toward*.008 for v in source.data.vertices]
        else:
            target=[center+right*v.co.x*4.5+up*(-1.1+(v.co.z-2.80)*4.5)+toward*.01 for v in source.data.vertices]
        _shape(copy,'Expand',target)
        if sign:
            delta=[]
            for v, t in zip(source.data.vertices,target):delta.append(verts[len(delta)]-up*(v.co.z*4.5*.94))
            _shape(copy,'FullBlink',delta)
            _shape(copy,'FullLookLeft',[v-right*.14 for v in verts])
            _shape(copy,'FullLookRight',[v+right*.14 for v in verts])
            _shape(copy,'FullHappy',[v-up*(source.data.vertices[i].co.z*4.5*.35) for i,v in enumerate(verts)])
        objects.append(copy)
    # A restrained midnight backing takes over the room only after the face fills it.
    backdrop=_mesh('full frame backing',
        [center-toward*.018+right*x+up*y for x,y in [(-5.2,-3.9),(5.2,-3.9),(5.2,3.9),(-5.2,3.9)]],
        [(0,1,2,3)],[black])
    objects.append(backdrop)
    # Seven rounded luminous bars form the smiling waveform from the reference.
    glow=bpy.data.materials['08 • Display / cyan to ice gradient']
    for i in range(7):
        height=[.31,.47,.62,.69,.62,.47,.31][i]
        width=.31
        radius=width/2
        center_y=-1.14-height*.35 + abs(i-3)*.035
        # Use conventional top/right semicircle then bottom/left outline.
        points=[]
        for j in range(17):
            a=math.pi*j/16
            points.append((radius*math.cos(a),height/2-radius+radius*math.sin(a)))
        for j in range(17):
            a=math.pi+math.pi*j/16
            points.append((radius*math.cos(a),-height/2+radius+radius*math.sin(a)))
        v=[(0,0,0)]+[(x,0,y) for x,y in points]
        mesh=_mesh('mouth bar %02d'%(i+1),v,[(0,j+1,(j+1)%len(points)+1) for j in range(len(points))],[glow])
        mesh.rotation_euler=scene.camera.rotation_euler
        # local mesh is X/Z, camera's local plane is X/Y: explicit basis below.
        from mathutils import Matrix
        mesh.rotation_euler=Matrix((right,-toward,up)).transposed().to_euler()
        mesh.location=center+right*((i-3)*.48)+up*center_y+toward*.015
        mesh['final_location']=list(mesh.location)
        mesh['index']=i
        uv=mesh.data.uv_layers.new(name='Display gradient')
        for polygon in mesh.data.polygons:
            for li in polygon.loop_indices:
                co=mesh.data.vertices[mesh.data.loops[li].vertex_index].co
                uv.data[li].uv=(co.x/width+.5,co.z/height+.5)
        objects.append(mesh)
    for o in objects:
        o['display_mode']=True
        label=o.name.removeprefix(PREFIX)
        o['owner_id']={'expanding head':'DisplayHead','Eye • L':'DisplayEyeL','Eye • R':'DisplayEyeR','Face • luminous smile':'DisplaySmile','full frame backing':'DisplayBackdrop'}.get(label, 'DisplayBar'+str(int(o.get('index',0))+1))
        o['portable_animation']='morph targets and transforms'
    return objects


def fullscreen_owners():
    result=[]
    coll=bpy.data.collections.get('MERLIN • Display mode')
    if coll:
        for o in coll.objects:
            owner=o['owner_id']
            result.append((owner,o))
            if o.data.shape_keys:result.append((owner+'Shape',o.data.shape_keys))
    return result


def fullscreen_action_for(clip,owner):
    return bpy.data.actions.get(clip+' • '+owner)


def _pulse(f,c,w):
    return .5+.5*math.cos(math.pi*(f-c)/w) if abs(f-c)<w else 0.


def build_fullscreen_companions(name,length):
    special=name in LENGTHS
    for owner,data in fullscreen_owners():
        data.animation_data_create()
        action=new_action(name+' • '+owner)
        data.animation_data.action=action
        is_keys=owner.endswith('Shape')
        for frame in range(1,length+1):
            if name=='ReadyToFace':t=_smooth((frame-5)/25)
            elif name=='FaceToReady':t=1-_smooth((frame-3)/27)
            elif name=='FullFaceIdle':t=1.
            else:t=0.
            if is_keys:
                for key in list(data.key_blocks)[1:]:
                    value=t if key.name=='Expand' else 0.
                    if name=='FullFaceIdle':
                        if key.name=='FullBlink':value=max(_pulse(frame,30 if 'EyeL' in owner else 30.6,3),_pulse(frame,72,3))
                        if key.name=='FullLookLeft':value=.6*_smooth((frame-37)/8)*(1-_smooth((frame-55)/8))
                        if key.name=='FullHappy':value=.2*math.sin(math.pi*(frame-1)/95)**2
                    key.value=value;key.keyframe_insert('value',frame=frame)
            else:
                visible=1. if t>0 else 0.
                if owner.startswith('DisplayBar'):
                    visible=_smooth((t-.55)/.4)
                    i=int(data['index'])
                    amplitude=1
                    if name=='FullFaceIdle':amplitude=1+.12*math.sin(2*math.pi*(frame-1)/95)*math.sin(i*.65+1)
                    data.scale=(visible,visible,visible*amplitude)
                    start=Vector(((i-3)*.048,-.538,2.79+abs(i-3)*.014))
                    data.location=start.lerp(Vector(data['final_location']),t)+_target_frame()[3]*(.65*math.sin(math.pi*t))
                elif owner=='DisplaySmile':
                    visible=1-_smooth((t-.48)/.28) if t>0 else 0
                    # Scale around the evaluated mouth center, not world origin.
                    data.scale=(visible,visible,visible)
                    center,right,up,toward=_target_frame()
                    mouth_center=Vector((0,-.535,2.80)).lerp(center-up*1.1+toward*.01,t)
                    data.location=mouth_center*(1-visible)+toward*(.65*math.sin(math.pi*t)*visible)
                elif owner=='DisplayBackdrop':
                    visible=_smooth((t-.76)/.24)
                    data.scale=(visible,visible,visible)
                    center,_,_,_=_target_frame()
                    data.location=center*(1-visible)-_target_frame()[3]*(12*(1-t)+.03)
                else:
                    data.scale=(visible,visible,visible)
                    if owner.startswith('DisplayEye'):
                        data.location=_target_frame()[3]*(.65*math.sin(math.pi*t))
                for path in ('location','rotation_euler','scale'):data.keyframe_insert(path,frame=frame)
        linear(action)


def build_fullscreen_actions(rig):
    create_fullscreen_geometry()
    context=_context(rig)
    ready=_sample(rig,'ReadyIdle',1)
    actions={}
    for name,length in LENGTHS.items():
        guide={'frames':length,'loop':name=='FullFaceIdle','source_activity':'FullFaceIdle' if name in ('FaceToReady','FullFaceIdle') else 'ReadyIdle',
               'source_frame':1,'target_activity':'ReadyIdle' if name=='FaceToReady' else 'FullFaceIdle','target_frame':1}
        action=_new_action(name,guide)
        for frame in range(1,length+1):_key(rig,action,frame,ready,context,exact=True)
        actions[name]=_finish(action,guide)
        build_fullscreen_companions(name,length)
    return actions
