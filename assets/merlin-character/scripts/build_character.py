"""Build MERLIN's editable character, rig, materials, stage and portable glTF.

Tested with Blender 4.0.2: blender --background --python scripts/build_character.py
Optional arguments after --: --render (hero still), --preview (animation).
All geometry and the packed display gradient are authored here; no downloaded assets.
"""
from pathlib import Path
import math
import bisect
import sys
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
sys.path.insert(0, str(HERE))
from animate_character import build_actions

PI = math.pi
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for collection in list(bpy.data.collections):
    if collection.name != 'Collection':
        bpy.data.collections.remove(collection)
character = bpy.data.collections.get('Collection')
character.name = 'MERLIN • Character'
stage = bpy.data.collections.new('STUDIO • Dark room')
bpy.context.scene.collection.children.link(stage)
lights = bpy.data.collections.new('LIGHTS • Softboxes + underglow')
bpy.context.scene.collection.children.link(lights)


def move_to(obj, collection):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def material(name, color, metallic=0, roughness=.3, coat=0, emission=None):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Specular IOR Level'].default_value = .22
    p.inputs['Coat Weight'].default_value = coat
    p.inputs['Coat Roughness'].default_value = .16
    if emission:
        p.inputs['Emission Color'].default_value = (*emission[0], 1)
        p.inputs['Emission Strength'].default_value = emission[1]
    return m


blue = material('01 • Cornflower / matte ceramic', (.052, .19, .52), 0, .72, 0)
glass = material('02 • Obsidian / matte display', (.003, .007, .014), 0, .70, 0)
rubber = material('03 • Graphite / soft joints', (.011, .017, .025), 0, .65)
trim = material('04 • Midnight / satin edge', (.016, .035, .067), .10, .58)
cyan = material('05 • Cyan / luminous smile', (.035, .56, .83), .0, .35, emission=((.025, .57, .90), 1.55))
glow = material('06 • Ice / sole light', (.07, .60, .94), .15, .22, emission=((.015, .48, 1), 3.2))
floor_mat = material('07 • Studio / midnight matte', (.008, .013, .024), 0, .55)
seam_mat = material('09 • Panel joins / muted blue', (.025,.075,.16), 0, .65, 0)

# An original packed gradient makes the eye color portable in the GLB too.
eye_mat=material('08 • Display / cyan to ice gradient',(0,0,0),0,.4,emission=((1,1,1),2.2))
eye_image=bpy.data.images.new('MERLIN • authored display gradient',width=64,height=256,alpha=True)
eye_image.colorspace_settings.name='sRGB'
pixels=[]
def srgb(value):
    return 12.92*value if value<=.0031308 else 1.055*value**(1/2.4)-.055
for row in range(256):
    v=row/255
    blend=(1-v)**1.7
    blue_tone=(.005,.48,.78)
    ice_tone=(.22,.82,1.0)
    color=[srgb(a+(b-a)*blend) for a,b in zip(blue_tone,ice_tone)]
    pixels.extend((color+[1])*64)
eye_image.pixels.foreach_set(pixels)
eye_image.pack()
tex=eye_mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.name='Cyan above / pale ice below'
tex.image=eye_image
shader=eye_mat.node_tree.nodes.get('Principled BSDF')
eye_mat.node_tree.links.new(tex.outputs['Color'],shader.inputs['Emission Color'])

bound = []


def finish(obj, name, mat, bone=None):
    obj.name = name
    move_to(obj, character)
    if mat:
        obj.data.materials.append(mat)
    if obj.type == 'MESH':
        for poly in obj.data.polygons:
            poly.use_smooth = True
    if bone:
        bound.append((obj, bone))
    return obj


def apply_modifiers(obj):
    bpy.context.view_layer.objects.active = obj
    if hasattr(obj.data, 'use_auto_smooth'):
        obj.data.use_auto_smooth = True
    for poly in obj.data.polygons:
        poly.use_smooth = True
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def rounded_box(name, loc, size, radius, mat, bone, bevel_segments=8):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    b = o.modifiers.new('Continuous corner radius', 'BEVEL')
    b.width = radius
    b.segments = bevel_segments
    n = o.modifiers.new('Weighted surface normals', 'WEIGHTED_NORMAL')
    n.keep_sharp = True
    apply_modifiers(o)
    return finish(o, name, mat, bone)


def sphere(name, loc, size, mat, bone, segments=40, rings=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=loc)
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, name, mat, bone)


def superellipsoid(name, loc, size, mat, bone, vertical=.6, horizontal=.6, n=64, m=32, taper=0):
    def sp(v, p):
        return math.copysign(abs(v)**p, v)
    def arc_angles(start, end, power, sx, sy, count):
        # Arc-length sampling keeps the glossy surface even around flat faces,
        # poles and tight corners; uniform angles bunch badly on superellipses.
        dense=4096
        angles=[start+(end-start)*i/dense for i in range(dense+1)]
        points=[(sx*sp(math.cos(t),power),sy*sp(math.sin(t),power)) for t in angles]
        lengths=[0]
        for p,q in zip(points,points[1:]):
            lengths.append(lengths[-1]+math.dist(p,q))
        result=[]
        for i in range(count+1):
            distance=lengths[-1]*i/count
            index=min(dense,max(1,bisect.bisect_left(lengths,distance)))
            weight=(distance-lengths[index-1])/(lengths[index]-lengths[index-1])
            result.append(angles[index-1]*(1-weight)+angles[index]*weight)
        return result
    n=max(n,96)
    m=max(m,48)
    us=arc_angles(0,2*PI,horizontal,size[0],size[1],n)[:-1]
    vs=arc_angles(-PI/2,PI/2,vertical,max(size[:2]),size[2],m)
    verts = [(0, 0, -size[2]/2)]
    for j in range(1, m):
        v = vs[j]
        for i in range(n):
            u = us[i]
            verts.append((size[0]/2*sp(math.cos(v), vertical)*sp(math.cos(u), horizontal),
                          size[1]/2*sp(math.cos(v), vertical)*sp(math.sin(u), horizontal),
                          size[2]/2*sp(math.sin(v), vertical)))
    verts.append((0, 0, size[2]/2))
    faces = []
    for i in range(n):
        faces.append((0, 1+(i+1)%n, 1+i))
    for j in range(m-2):
        for i in range(n):
            a = 1+j*n+i
            b = 1+j*n+(i+1)%n
            faces.append((a,b,b+n,a+n))
    top = len(verts)-1
    for i in range(n):
        faces.append((1+(m-2)*n+i, 1+(m-2)*n+(i+1)%n, top))
    mesh = bpy.data.meshes.new(name)
    shaped=[(x*(1+taper*z/(size[2]/2)),y,z) for x,y,z in verts]
    mesh.from_pydata(shaped, [], faces)
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    character.objects.link(o)
    o.location = loc
    finish(o, name, mat, bone)
    # Exact implicit-surface normals avoid lumpy reflected softbox edges.
    normals=[]
    for x,y,z in verts:
        xx,yy,zz=x/(size[0]/2),y/(size[1]/2),z/(size[2]/2)
        ring=max(1e-16,abs(xx)**(2/horizontal)+abs(yy)**(2/horizontal))
        common=ring**(horizontal/vertical-1)
        normal=Vector((common*sp(xx,2/horizontal-1)/(size[0]/2),
                       common*sp(yy,2/horizontal-1)/(size[1]/2),
                       sp(zz,2/vertical-1)/(size[2]/2)))
        if taper:
            factor=1+taper*zz
            normal.z-=normal.x*x*taper/(size[2]/2)/factor
            normal.x/=factor
        normals.append(tuple(normal.normalized()))
    mesh.use_auto_smooth=True
    mesh.normals_split_custom_set_from_vertices(normals)
    return o


def rounded_outline(w, h, r, count=12):
    result=[]
    for cx,cz,start in [(w/2-r,h/2-r,0),(-w/2+r,h/2-r,90),(-w/2+r,-h/2+r,180),(w/2-r,-h/2+r,270)]:
        for i in range(count+1):
            a=math.radians(start+90*i/count)
            result.append((cx+r*math.cos(a), cz+r*math.sin(a)))
    # Evenly spaced straight sections avoid broad shading ripples on the lens.
    even=[]
    for i,first in enumerate(result):
        last=result[(i+1)%len(result)]
        steps=max(1,math.ceil(math.dist(first,last)/.065))
        for step in range(steps):
            t=step/steps
            even.append((first[0]*(1-t)+last[0]*t,first[1]*(1-t)+last[1]*t))
    return even


def head_front(x,z):
    """Surface of the rounded shell, used to make the display sit flush."""
    exponent=.65
    inside=max(0,1-abs(x/1.04)**(2/exponent)-abs((z-2.98)/.71)**(2/exponent))
    return -.54*inside**(exponent/2)


def seamless_head():
    """One continuous closed surface: glass, fine seam and shell share edges.

    The display is a material region in the head itself, with no raised panel.
    """
    n=192
    def sp(v,p):
        return math.copysign(abs(v)**p,v)
    angles=[2*PI*i/n for i in range(n)]
    lens=[(.885*sp(math.cos(t),.68),.55*sp(math.sin(t),.68)) for t in angles]
    outer=[(1.04*sp(math.cos(t),.65),.71*sp(math.sin(t),.65)) for t in angles]
    rows=[]
    regions=[]
    for j in range(1,17):
        r=j/16
        rows.append([(x*r,head_front(x*r,z*r+2.98),z*r) for x,z in lens])
        regions.append(1)
    for t in [.015,.04,.08,.14,.23,.34,.47,.61,.74,.85,.93,1]:
        coords=[(a[0]*(1-t)+b[0]*t,a[1]*(1-t)+b[1]*t) for a,b in zip(lens,outer)]
        rows.append([(x,head_front(x,z+2.98),z) for x,z in coords])
        regions.append(2 if t<=.015 else 0)
    for j in range(19,0,-1):
        r=j/20
        rows.append([(x*r,-head_front(x*r,z*r+2.98),z*r) for x,z in outer])
        regions.append(0)
    verts=[(0,-.54,0)]+[v for row in rows for v in row]+[(0,.54,0)]
    faces=[]
    mats=[]
    for i in range(n):
        faces.append((0,1+i,1+(i+1)%n))
        mats.append(1)
    for j in range(len(rows)-1):
        for i in range(n):
            a=1+j*n+i
            b=1+j*n+(i+1)%n
            faces.append((a,a+n,b+n,b))
            mats.append(regions[j+1])
    for i in range(n):
        faces.append((len(verts)-1,1+(len(rows)-1)*n+(i+1)%n,1+(len(rows)-1)*n+i))
        mats.append(0)
    mesh=bpy.data.meshes.new('Head • seamless glass and ceramic')
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    obj=bpy.data.objects.new('Head • integrated flush display',mesh)
    character.objects.link(obj)
    obj.location.z=2.98
    finish(obj,obj.name,blue,'head')
    mesh.materials.append(glass)
    mesh.materials.append(trim)
    for polygon,index in zip(mesh.polygons,mats):
        polygon.material_index=index
    normals=[]
    for x,y,z in verts:
        v=Vector((sp(x/1.04,2/.65-1)/1.04,sp(y/.54,2/.65-1)/.54,sp(z/.71,2/.65-1)/.71))
        normals.append(tuple(v.normalized()))
    mesh.use_auto_smooth=True
    mesh.normals_split_custom_set_from_vertices(normals)
    return obj


def panel(name, center, width, height, radius, mat, bone, bulge=.035, depth=.04, oval=0, head_offset=None, decal=False):
    """A closed, gently crowned rounded-rectangle lens with predictable silhouette."""
    if oval:
        outline=[]
        for i in range(128):
            a=2*PI*i/128
            outline.append((width/2*math.copysign(abs(math.cos(a))**oval,math.cos(a)),
                            height/2*math.copysign(abs(math.sin(a))**oval,math.sin(a))))
    else:
        outline=rounded_outline(width,height,radius)
    count=len(outline)
    verts=[(0,-bulge,0)]
    scales=[.23,.48,.72,.90,1]
    for s in scales:
        verts += [(x*s,-bulge*(1-s*s),z*s) for x,z in outline]
    if not decal:
        verts += [(x,depth,z) for x,z in outline]
        verts += [(0,depth,0)]
    faces=[]
    for i in range(count):
        faces.append((0,1+i,1+(i+1)%count))
    for j in range(len(scales)-(1 if decal else 0)):
        for i in range(count):
            a=1+j*count+i
            b=1+j*count+(i+1)%count
            faces.append((a,a+count,b+count,b))
    if not decal:
        back=len(verts)-1
        for i in range(count):
            faces.append((back,1+len(scales)*count+(i+1)%count,1+len(scales)*count+i))
    if head_offset is not None:
        verts=[(x,head_front(x+center[0],z+center[2])+head_offset+(depth if y>0 else 0)-center[1],z) for x,y,z in verts]
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    o=bpy.data.objects.new(name,mesh)
    character.objects.link(o)
    o.location=center
    uv=mesh.uv_layers.new(name='Display UV')
    for polygon in mesh.polygons:
        for index in polygon.loop_indices:
            co=mesh.vertices[mesh.loops[index].vertex_index].co
            uv.data[index].uv=(co.x/width+.5,co.z/height+.5)
    if not decal:
        sub=o.modifiers.new('Continuous lens curvature','SUBSURF')
        sub.levels=1
        sub.render_levels=1
        apply_modifiers(o)
    return finish(o,name,mat,bone)


def display_smile():
    """A luminous surface stroke; nothing protrudes from the display."""
    verts=[]
    faces=[]
    count=64
    for i in range(count+1):
        a=PI*i/count
        x=.155*math.cos(a)
        z=2.827-.084*math.sin(a)
        normal=Vector((.084*math.cos(a),-.155*math.sin(a))).normalized()
        for sign in [1,-1]:
            xx=x+sign*.0165*normal.x
            zz=z+sign*.0165*normal.y
            verts.append((xx,head_front(xx,zz)-.0015,zz))
    for i in range(count):
        faces.append((2*i,2*i+1,2*i+3,2*i+2))
    for x in [-.155,.155]:
        start=len(verts)
        verts.append((x,head_front(x,2.827)-.0015,2.827))
        for i in range(32):
            a=2*PI*i/32
            xx=x+.0165*math.cos(a)
            zz=2.827+.0165*math.sin(a)
            verts.append((xx,head_front(xx,zz)-.0015,zz))
        for i in range(32):
            faces.append((start,start+1+i,start+1+(i+1)%32))
    mesh=bpy.data.meshes.new('Smile • screen pixels')
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    obj=bpy.data.objects.new('Face • luminous smile',mesh)
    character.objects.link(obj)
    finish(obj,obj.name,cyan,'head')


def tube(name, points, radius, mat, bone, cyclic=False):
    curve=bpy.data.curves.new(name,'CURVE')
    curve.dimensions='3D'
    curve.resolution_u=16
    curve.bevel_depth=radius
    curve.bevel_resolution=5
    curve.use_fill_caps=True
    poly=curve.splines.new('POLY')
    poly.points.add(len(points)-1)
    for p,co in zip(poly.points,points):
        p.co=(*co,1)
    poly.use_cyclic_u=cyclic
    o=bpy.data.objects.new(name,curve)
    character.objects.link(o)
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active=o
    bpy.ops.object.convert(target='MESH')
    return finish(bpy.context.object,name,mat,bone)


def cylinder(name, loc, radius, depth, mat, bone, axis='Z'):
    bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=radius,depth=depth,location=loc)
    o=bpy.context.object
    if axis=='X':
        o.rotation_euler[1]=PI/2
    elif axis=='Y':
        o.rotation_euler[0]=PI/2
    bevel=o.modifiers.new('Soft machined edge','BEVEL')
    bevel.width=.022
    bevel.segments=4
    norm=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    apply_modifiers(o)
    return finish(o,name,mat,bone)


# Large, friendly head; uninterrupted shell and a subtly curved dark lens.
seamless_head()
# A single restrained shell join follows the back cap, away from the display.
cap_y=.12
cap_r=(1-(cap_y/.54)**(2/.65))**(.65/2)
cap_points=[]
for i in range(240):
    a=2*PI*i/240
    x=1.04*cap_r*math.copysign(abs(math.cos(a))**.65,math.cos(a))
    z=.71*cap_r*math.copysign(abs(math.sin(a))**.65,math.sin(a))
    cap_points.append((x,cap_y,z+2.98))
tube('Head • fine rear-cap seam',cap_points,.003,seam_mat,'head',True)
for side in [-1,1]:
    panel('Eye • '+('L' if side>0 else 'R'),(side*.40,0,3.075),.175,.39,.087,eye_mat,'head',.008,.018,head_offset=-.0015,decal=True)
display_smile()
for side,label in [(1,'L'),(-1,'R')]:
    cylinder('Ear '+label+' • isolated mount',(side*.995,0,2.98),.303,.12,rubber,'head','X')
    cylinder('Ear '+label+' • blue cap',(side*1.058,0,2.98),.276,.125,blue,'head','X')
    cylinder('Ear '+label+' • inset disc',(side*1.128,0,2.98),.216,.017,trim,'head','X')
    ring=[(side*1.139,.238*math.cos(a),2.98+.238*math.sin(a)) for a in [2*PI*i/96 for i in range(96)]]
    tube('Ear '+label+' • light ring',ring,.010,glow,'head',True)

# Soft body and minimal articulation: no vents, screws or busy armor plates.
cylinder('Neck • graphite swivel',(0,0,2.24),.20,.24,rubber,'body')
superellipsoid('Body • rounded tapered torso',(0,.015,1.75),(1.12,.72,1.00),blue,'body',1.0,.94,taper=.18)
def torso_front(x,z):
    zz=(z-1.75)/.50
    xx=x/(.56*(1+.18*zz))
    available=max(0,(max(0,1-zz*zz))**(1/.94)-abs(xx)**(2/.94))
    return .015-.36*available**(.94/2)
chest_join=[]
for control in [((-0.29,2.10),(-.42,1.98),(-.40,1.67),(-.24,1.52)),
                ((-.24,1.52),(-.14,1.45),(.14,1.45),(.24,1.52)),
                ((.24,1.52),(.40,1.67),(.42,1.98),(.29,2.10))]:
    for step in range(41):
        t=step/40
        weights=((1-t)**3,3*(1-t)**2*t,3*(1-t)*t*t,t**3)
        x=sum(p[0]*w for p,w in zip(control,weights))
        z=sum(p[1]*w for p,w in zip(control,weights))
        chest_join.append((x,torso_front(x,z)+.001,z))
tube('Torso • fine curved chest seam',chest_join,.003,seam_mat,'body')
superellipsoid('Hip • dark core',(0,.035,1.25),(.66,.44,.23),rubber,'body',.90,.90)
panel('Chest • recessed status socket',(0,-.339,1.89),.23,.075,.035,trim,'body',.008,.018)
panel('Chest • quiet status light',(0,-.352,1.89),.16,.027,.013,cyan,'body',.003,.008)

for side,label in [(1,'L'),(-1,'R')]:
    shoulder=(side*.64,.015,1.99)
    sphere('Shoulder '+label+' • joint',shoulder,(.17,.19,.20),rubber,'upper_arm.'+label)
    cap=superellipsoid('Arm '+label+' • upper shell',(side*.735,.01,1.83),(.29,.36,.43),blue,'upper_arm.'+label,.96,.95,48,24)
    cap.rotation_euler[1]=-side*.20
    sphere('Elbow '+label+' • joint',(side*.80,.006,1.63),(.135,.15,.14),rubber,'forearm.'+label)
    fore=superellipsoid('Arm '+label+' • forearm shell',(side*.865,-.012,1.48),(.31,.345,.39),blue,'forearm.'+label,.94,.94,48,24)
    fore.rotation_euler[1]=-side*.19
    sphere('Wrist '+label+' • joint',(side*.905,-.02,1.31),(.105,.112,.10),rubber,'hand.'+label)
    palm=superellipsoid('Hand '+label+' • soft mitten',(side*.94,-.035,1.20),(.235,.23,.26),rubber,'hand.'+label,.7,.8,40,24)
    palm.rotation_euler[1]=-side*.14
    sphere('Hand '+label+' • thumb',(side*.818,-.083,1.218),(.073,.083,.107),rubber,'hand.'+label,32,20)
    # A single discreet seam suggests fingers without mechanical clutter.
    seam=[(side*(.865+i*.015),-.151,1.164) for i in range(10)]
    tube('Hand '+label+' • palm seam',seam,.005,trim,'hand.'+label)
    sphere('Hip '+label+' • joint',(side*.30,.015,1.13),(.17,.18,.18),rubber,'thigh.'+label)
    superellipsoid('Leg '+label+' • upper shell',(side*.32,.02,.94),(.37,.41,.42),blue,'thigh.'+label,.94,.90,48,24)
    sphere('Knee '+label+' • joint',(side*.33,.005,.713),(.15,.175,.13),rubber,'shin.'+label)
    superellipsoid('Leg '+label+' • shin',(side*.34,-.015,.53),(.385,.42,.40),blue,'shin.'+label,.90,.85,48,24,taper=-.10)
    superellipsoid('Foot '+label+' • graphite outsole',(side*.34,-.15,.105),(.51,.77,.14),rubber,'foot.'+label,.48,.82,48,24)
    superellipsoid('Foot '+label+' • continuous light sole',(side*.34,-.15,.158),(.492,.75,.048),glow,'foot.'+label,.35,.82,48,20)
    superellipsoid('Foot '+label+' • rounded blue toe',(side*.34,-.15,.276),(.50,.75,.265),blue,'foot.'+label,.93,.86,48,24)

# Rigid weighted geometry keeps perfectly clean hard-surface articulation.
arm_data=bpy.data.armatures.new('MERLIN • skeleton')
rig=bpy.data.objects.new('MERLIN_Rig',arm_data)
character.objects.link(rig)
bpy.context.view_layer.objects.active=rig
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
positions={'root':(0,0,0),'body':(0,0,1.30),'head':(0,0,2.25)}
parents={'body':'root','head':'body'}
for side,label in [(1,'L'),(-1,'R')]:
    positions.update({'upper_arm.'+label:(side*.66,0,2.00),'forearm.'+label:(side*.82,0,1.65),'hand.'+label:(side*.91,-.02,1.35),'thigh.'+label:(side*.30,0,1.16),'shin.'+label:(side*.33,0,.70),'foot.'+label:(side*.33,-.12,.25)})
    parents.update({'upper_arm.'+label:'body','forearm.'+label:'upper_arm.'+label,'hand.'+label:'forearm.'+label,'thigh.'+label:'root','shin.'+label:'thigh.'+label,'foot.'+label:'shin.'+label})
for name,pos in positions.items():
    b=arm_data.edit_bones.new(name)
    b.head=pos
    b.tail=Vector(pos)+Vector((0,0,.15 if name!='root' else .25))
for name,parent in parents.items():
    arm_data.edit_bones[name].parent=arm_data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
rig.show_in_front=True
rig.data.display_type='STICK'
for obj,bone in bound:
    group=obj.vertex_groups.new(name=bone)
    group.add(list(range(len(obj.data.vertices))),1.0,'REPLACE')
    modifier=obj.modifiers.new('MERLIN • rigid articulation','ARMATURE')
    modifier.object=rig
    obj.parent=rig

actions=build_actions(rig)
for a in actions.values():
    a.use_fake_user=True

scene=bpy.context.scene
scene.render.fps=24
scene.frame_start=1
scene.frame_end=192
rig.animation_data.action=actions['Showcase']
scene.frame_set(1)
rig['Character']='MERLIN / first design study / 2026-10-26'
rig['Clips']='Idle 1–96 • Wave 1–96 • Jump 1–72 • Showcase 1–192 @ 24 fps'
rig['Design']='Matte light-blue ceramic, rounded head and tapered oval body, flush matte display, subtle panel seams, cyan-to-ice eyes and cyan underglow. Original authored geometry inspired by owner-supplied references.'

# A dark product-photo stage with broad reflections, softly separated silhouette.
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,.024))
ground=bpy.context.object
ground.name='Studio • seamless midnight floor'
ground.data.materials.append(floor_mat)
move_to(ground,stage)
world=bpy.data.worlds.new('World • midnight')
world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.022,.031,.058,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.18
scene.world=world


def aim(obj, target):
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def area(name,loc,target,power,color,size,size_y=None):
    data=bpy.data.lights.new(name,'AREA')
    data.energy=power
    data.color=color
    data.shape='DISK' if size_y is None else 'RECTANGLE'
    data.size=size
    if size_y is not None:
        data.size_y=size_y
    o=bpy.data.objects.new(name,data)
    lights.objects.link(o)
    o.location=loc
    aim(o,target)
    return o


area('Key • long silk',(-3.6,-4.5,6.0),(0,0,2),380,(.78,.86,1),3.0,5.0)
area('Fill • cool card',(4,-2.0,3.8),(0,0,2),220,(.43,.67,1),2.4,4.0)
area('Rim • pearl',(-2.5,2.3,5.0),(0,0,2.0),380,(.55,.73,1),2.6,3.5)
area('Top • highlight',(0,1,6.5),(0,0,2),160,(.85,.92,1),3)
for side,label in [(1,'L'),(-1,'R')]:
    # Place the helper at the forward sole edge so the opaque outsole does not
    # block it. It supplies the same restrained cyan floor spill in Eevee.
    o=area('Sole '+label+' • floor bounce',(side*.34,-.55,.12),(side*.34,-.55,0),8,(.025,.52,1),.42)
    bpy.context.view_layer.update()
    world_matrix=o.matrix_world.copy()
    o.parent=rig
    o.parent_type='BONE'
    o.parent_bone='foot.'+label
    bpy.context.view_layer.update()
    o.matrix_world=world_matrix
    bpy.context.view_layer.update()

bpy.ops.object.camera_add(location=(4.1,-11.5,4.5))
camera=bpy.context.object
camera.name='Camera • product portrait'
move_to(camera,stage)
aim(camera,(0,0,1.96))
camera.data.type='ORTHO'
camera.data.ortho_scale=5.25
camera.data.lens=65
scene.camera=camera
scene.render.resolution_x=1200
scene.render.resolution_y=1400
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.film_transparent=False
scene.render.engine='CYCLES'
scene.cycles.samples=96
scene.cycles.use_denoising=True
scene.cycles.max_bounces=7
scene.cycles.diffuse_bounces=3
scene.cycles.glossy_bounces=4
try:
    prefs=bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type='METAL'
    prefs.refresh_devices()
    for dev in prefs.devices:
        dev.use=(dev.type=='METAL')
    scene.cycles.device='GPU'
except Exception:
    scene.cycles.device='CPU'
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
scene.view_settings.exposure=.35
scene.render.image_settings.color_mode='RGBA'
scene.use_nodes=True
nodes=scene.node_tree.nodes
nodes.clear()
render=nodes.new('CompositorNodeRLayers')
render.location=(0,0)
bloom=nodes.new('CompositorNodeGlare')
bloom.name='Subtle optical bloom'
bloom.glare_type='FOG_GLOW'
bloom.quality='HIGH'
bloom.threshold=1.0
bloom.size=8
bloom.mix=-.88
bloom.location=(220,0)
composite=nodes.new('CompositorNodeComposite')
composite.location=(450,0)
scene.node_tree.links.new(render.outputs['Image'],bloom.inputs['Image'])
scene.node_tree.links.new(bloom.outputs['Image'],composite.inputs['Image'])

# Named timeline markers make the two requested gestures easy to find.
for frame,label in [(1,'HELLO / idle'),(44,'WAVE'),(112,'RESET'),(142,'JUMP / anticipation'),(158,'AIR'),(169,'LAND'),(192,'SETTLE')]:
    scene.timeline_markers.new(label,frame=frame)

# Export just the character. Multiple named actions remain separate clips.
bpy.ops.object.select_all(action='DESELECT')
for o in character.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active=rig
rig.animation_data.action=actions['Idle']
scene.frame_set(1)
# Showcase is for Blender's presentation timeline, not a fourth runtime clip.
actions['Showcase'].use_fake_user=False
rig.animation_data.action=None
for name in ['Idle','Wave','Jump']:
    track=rig.animation_data.nla_tracks.new()
    track.name=name
    strip=track.strips.new(name,1,actions[name])
    strip.action_frame_start=1
    strip.action_frame_end=96 if name!='Jump' else 72
    track.mute=True
bpy.ops.export_scene.gltf(filepath=str(OUT/'merlin.glb'),export_format='GLB',use_selection=True,
    export_animations=True,export_animation_mode='NLA_TRACKS',export_nla_strips=True,
    export_frame_range=False,export_force_sampling=True,export_anim_slide_to_zero=True,
    export_skins=True,export_cameras=False,export_lights=False,export_extras=True)
for t in list(rig.animation_data.nla_tracks):
    rig.animation_data.nla_tracks.remove(t)
actions['Showcase'].use_fake_user=True
rig.animation_data.action=actions['Showcase']
scene.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active=rig
for screen in bpy.data.screens:
    for a in screen.areas:
        if a.type=='VIEW_3D':
            a.spaces.active.region_3d.view_perspective='CAMERA'
            a.spaces.active.overlay.show_overlays=False
            a.spaces.active.shading.type='MATERIAL'
            a.spaces.active.shading.use_scene_lights=True
            a.spaces.active.shading.use_scene_world=True
            a.spaces.active.shading.studiolight_rotate_z=.5
scene.render.filepath='//previews/merlin-hero.png'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'merlin.blend'),compress=True)
print('MERLIN_BUILD_COMPLETE',len(bound),'rigged meshes',len(arm_data.bones),'bones')

if '--render' in sys.argv:
    bpy.ops.render.render(write_still=True)
if '--preview' in sys.argv:
    scene.render.engine='BLENDER_EEVEE'
    scene.eevee.use_gtao=True
    scene.eevee.gtao_distance=.35
    scene.eevee.gtao_factor=1.2
    scene.eevee.use_ssr=True
    scene.eevee.taa_render_samples=32
    scene.render.resolution_x=640
    scene.render.resolution_y=752
    scene.render.image_settings.file_format='FFMPEG'
    scene.render.ffmpeg.format='MPEG4'
    scene.render.ffmpeg.codec='H264'
    scene.render.ffmpeg.constant_rate_factor='HIGH'
    scene.render.filepath=str(OUT/'previews'/'merlin-wave-jump.mp4')
    bpy.ops.render.render(animation=True)
