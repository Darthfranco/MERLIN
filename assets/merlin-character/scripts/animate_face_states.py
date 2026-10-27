"""Authored camera, thinking and search states for MERLIN's full-frame face.

The camera canvas is an original synthetic preview, never a device feed. All
state curves are sampled or explicit held channels; no drivers or live camera
access are required. Existing head geometry, cyan material and room are retained.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

from fullscreen_face import _target_frame
from interaction_support import owners as existing_owners, action_for as existing_action_for
from transition_support import new_action, linear

COLLECTION = 'MERLIN • Face states'
LENGTHS = {'FaceToCamera':24, 'CameraIdle':96, 'CameraToFace':24,
           'FaceToThink':24, 'FaceThink':96, 'ThinkToFace':24,
           'FaceToSearch':24, 'FaceSearch':96, 'SearchToFace':24}
FAMILIES = {'Camera':('FaceToCamera','CameraIdle','CameraToFace'),
            'Think':('FaceToThink','FaceThink','ThinkToFace'),
            'Search':('FaceToSearch','FaceSearch','SearchToFace')}


def _smooth(t):
    t=max(0.,min(1.,t));return t*t*t*(t*(t*6-15)+10)


def _pulse(f,c,w):
    return .5+.5*math.cos(math.pi*(f-c)/w) if abs(f-c)<w else 0.


def _collection():
    coll=bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll=bpy.data.collections.new(COLLECTION)
        bpy.context.scene.collection.children.link(coll)
    return coll


def _emission(name,color,strength=1.):
    mat=bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes=True
    p=mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(0,0,0,1)
    p.inputs['Roughness'].default_value=.85
    p.inputs['Specular IOR Level'].default_value=0
    p.inputs['Emission Color'].default_value=(*color,1)
    p.inputs['Emission Strength'].default_value=strength
    return mat


def _ring(radius,width,segments=96):
    v=[]
    for r in (radius,radius-width):
        v += [(r*math.cos(2*math.pi*i/segments),r*math.sin(2*math.pi*i/segments)) for i in range(segments)]
    f=[(i,(i+1)%segments,(i+1)%segments+segments,i+segments) for i in range(segments)]
    return v,f


def _disc(radius,segments=96,center=(0,0)):
    v=[center]+[(center[0]+radius*math.cos(2*math.pi*i/segments),center[1]+radius*math.sin(2*math.pi*i/segments)) for i in range(segments)]
    return v,[(0,i+1,(i+1)%segments+1) for i in range(segments)]


def _stroke(a,b,width):
    a,b=Vector(a),Vector(b);along=(b-a).normalized();across=Vector((-along.y,along.x))*width/2
    v=[tuple(a+across),tuple(b+across),tuple(b-across),tuple(a-across)]
    faces=[(0,1,2,3)]
    for end in (a,b):
        d,f=_disc(width/2,24,tuple(end));offset=len(v);v+=d;faces += [tuple(offset+i for i in face) for face in f]
    return v,faces


def _rounded(width,height,radius):
    outline=[]
    for cx,cy,a0 in [(width/2-radius,height/2-radius,0),(-width/2+radius,height/2-radius,90),(-width/2+radius,-height/2+radius,180),(width/2-radius,-height/2+radius,270)]:
        for j in range(13):
            a=math.radians(a0+j*90/12)
            outline.append((cx+radius*math.cos(a),cy+radius*math.sin(a)))
    v=[(0,0)]+outline
    return v,[(0,i+1,(i+1)%len(outline)+1) for i in range(len(outline))]


def _new_mesh(owner,label,parts,materials,location,uv_bounds=None,depth=.04):
    old=bpy.data.objects.get('Face state • '+label)
    if old:bpy.data.objects.remove(old,do_unlink=True)
    verts=[];faces=[];indices=[]
    for part in parts:
        points,polygons,index=part[:3]
        layer=part[3] if len(part)>3 else 0.
        offset=len(verts);verts += [(x,-layer,z) for x,z in points]
        faces += [tuple(offset+i for i in face) for face in polygons]
        indices += [index]*len(polygons)
    mesh=bpy.data.meshes.new('Face state • '+label)
    mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new('Face state • '+label,mesh);_collection().objects.link(obj)
    for mat in materials:mesh.materials.append(mat)
    for poly,index in zip(mesh.polygons,indices):poly.material_index=index
    center,right,up,toward=_target_frame()
    obj.location=center+right*location[0]+up*location[1]+toward*depth
    obj.rotation_euler=Matrix((right,-toward,up)).transposed().to_euler()
    obj['owner_id']=owner;obj['face_state_helper']=True
    obj['rest_location']=list(obj.location);obj['rest_rotation']=list(obj.rotation_euler)
    obj['rest_scale']=[1.,1.,1.]
    if uv_bounds is None:
        xs=[v[0] for v in verts];zs=[v[2] for v in verts]
        uv_bounds=(min(xs),max(xs),min(zs),max(zs))
    x0,x1,z0,z1=uv_bounds
    uv=mesh.uv_layers.new(name='UVMap')
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            co=mesh.vertices[mesh.loops[li].vertex_index].co
            u=(co.x-x0)/max(.001,x1-x0);v=(co.z-z0)/max(.001,z1-z0)
            snap=lambda q: 0. if abs(q)<1e-6 else 1. if abs(q-1)<1e-6 else max(0.,min(1.,q))
            uv.data[li].uv=(snap(u),snap(v))
    obj.scale=(0,0,0)
    return obj


def _synthetic_camera_material():
    """Original abstract still-life texture with a stable application canvas API."""
    w,h=320,160
    y,x=np.mgrid[0:h,0:w];u=x/(w-1);v=y/(h-1)
    rgba=np.empty((h,w,4),dtype=np.float32)
    rgba[:,:,:3]=np.array([.055,.13,.19])[None,None,:]+(.08*v+.035*u)[:,:,None]
    rgba[:,:,3]=1
    floor=v<.33
    rgba[floor,:3]=np.array([.10,.21,.28])+.035*u[floor,None]
    # A small geometric still life makes clear this is synthetic demo content.
    cube=(u>.43)&(u<.64)&(v>.32)&(v<.70)
    rgba[cube,:3]=np.array([.30,.58,.71])+.12*v[cube,None]
    top=(u>.43)&(u<.64)&(v>.65)&(v<.70)
    rgba[top,:3]=(.57,.79,.86)
    side=(u>.60)&(u<.64)&(v>.32)&(v<.65)
    rgba[side,:3]=(.20,.39,.51)
    orb=((u-.28)/.075)**2+((v-.43)/.15)**2<1
    rgba[orb,:3]=np.array([.12,.45,.53])+.16*v[orb,None]
    stripe=(np.abs(v-.33)<.004)
    rgba[stripe,:3]=(.15,.30,.37)
    image=bpy.data.images.get('MERLIN synthetic camera preview') or bpy.data.images.new('MERLIN synthetic camera preview',w,h,alpha=True)
    image.pixels.foreach_set(rgba.ravel());image.pack();image.colorspace_settings.name='sRGB'
    mat=_emission('MERLIN_Screen_camera',(1,1,1),1.)
    mat['merlin_screen_id']='camera';mat['preview_kind']='original synthetic still life; no camera capture'
    node=mat.node_tree.nodes.get('MERLIN Screen Content') or mat.node_tree.nodes.new('ShaderNodeTexImage')
    node.name='MERLIN Screen Content';node.label='Camera canvas';node.image=image
    node.interpolation='Linear';node.extension='EXTEND'
    p=mat.node_tree.nodes.get('Principled BSDF')
    mat.node_tree.links.new(node.outputs['Color'],p.inputs['Emission Color'])
    return mat


def _create_geometry():
    glow=bpy.data.materials['08 • Display / cyan to ice gradient']
    lens_dark=_emission('Face state • lens glass',(.007,.028,.050),1)
    iris=_emission('Face state • aperture blue',(.028,.18,.29),1)
    line=_emission('Face state • quiet cyan',(.025,.27,.38),1)
    for side,sign in [('L',1),('R',-1)]:
        parts=[]
        for radius,width,index in [(.65,.045,0),(.54,.018,2),(.44,.012,2)]:
            v,f=_ring(radius,width);parts.append((v,f,index,.002 if index else 0.))
        v,f=_disc(.60);parts.insert(0,(v,f,1))
        v,f=_disc(.060,32,(-.21,.23));parts.append((v,f,0,.004))
        _new_mesh('CamLens'+side,'camera lens '+side,parts,[glow,lens_dark,line],(sign*1.92,.75))
        parts=[]
        for i in range(6):
            angle=2*math.pi*i/6
            points=[]
            for r,a in [(.40,angle),(.40,angle+math.pi/3),(.18,angle+math.pi/3+.25),(.18,angle+.25)]:
                points.append((r*math.cos(a),r*math.sin(a)))
            parts.append((points,[(0,1,2,3)],0))
        v,f=_ring(.18,.018,64);parts.append((v,f,1,.001))
        _new_mesh('CamIris'+side,'camera aperture '+side,parts,[iris,glow],(sign*1.92,.75),depth=.047)
        v,f=_ring(.60,.075)
        a,b=_stroke((.40,-.40),(.86,-.86),.105)
        _new_mesh('Search'+side,'search lens '+side,[(v,f,0),(a,b,0)],[glow],(sign*1.92,.85),depth=.045)
        # A small inset arc suggests glass without introducing glossy reflections.
        pts=[]
        for i in range(19):
            a0=math.radians(62+i*65/18)
            pts.append((.43*math.cos(a0),.43*math.sin(a0)))
        arcs=[]
        for a0,b0 in zip(pts,pts[1:]):
            a,b=_stroke(a0,b0,.025);arcs.append((a,b,0))
        _new_mesh('SearchGlass'+side,'search glint '+side,arcs,[line],(sign*1.92,.85),depth=.047)
    v,f=_rounded(5.65,1.96,.16)
    screen=_new_mesh('CamScreen','camera screen',[(v,f,0)],[_synthetic_camera_material()],(0,-1.68),uv_bounds=(-2.825,2.825,-.98,.98),depth=.045)
    screen['merlin_screen_id']='camera';screen['merlin_screen_material_index']=0
    screen['merlin_screen_uv_origin']='top-left';screen['merlin_blender_uv_origin']='bottom-left'
    screen.active_material['merlin_screen_uv_origin']='top-left'
    screen.active_material['merlin_blender_uv_origin']='bottom-left'
    screen['content_note']='Synthetic preview. Replace texture through the screen-content API; no device access is performed.'
    parts=[]
    for sx in (-1,1):
        for sy in (-1,1):
            a,b=_stroke((sx*2.69,sy*.84),(sx*2.41,sy*.84),.035);parts.append((a,b,0))
            a,b=_stroke((sx*2.69,sy*.84),(sx*2.69,sy*.59),.035);parts.append((a,b,0))
    _new_mesh('CamFrame','viewfinder corners',parts,[glow],(0,-1.68),depth=.052)
    parts=[]
    for a0,b0 in [((-.12,0),(-.035,0)),((.035,0),(.12,0)),((0,-.12),(0,-.035)),((0,.035),(0,.12))]:
        a,b=_stroke(a0,b0,.018);parts.append((a,b,0))
    _new_mesh('CamReticle','viewfinder focus',parts,[glow],(0,-1.68),depth=.054)


def face_state_owners():
    coll=bpy.data.collections.get(COLLECTION)
    return sorted([(str(o['owner_id']),o) for o in coll.objects],key=lambda x:x[0]) if coll else []


def state_action_for(clip,owner):
    return bpy.data.actions.get(clip+' • '+owner)


def _channels(action,frame):
    return {(curve.data_path,curve.array_index):float(curve.evaluate(frame)) for curve in action.fcurves}


def _write_action(name,rows):
    action=new_action(name)
    for (path,index) in rows[0]:
        curve=action.fcurves.new(path,index=index)
        values=[value for frame,row in enumerate(rows,1) for value in (frame,row[(path,index)])]
        curve.keyframe_points.add(len(rows));curve.keyframe_points.foreach_set('co',values)
    linear(action);return action


def _transform(location,rotation,scale):
    return {(path,i):float(values[i]) for path,values in [('location',location),('rotation_euler',rotation),('scale',scale)] for i in range(3)}


def _settings(family,kind,frame,length):
    p=0. if frame in (1,length) else (frame-1)/(length-1)
    u=1. if kind=='loop' else _smooth((frame-1)/(length-1))
    if kind=='exit':u=1-u
    if kind!='loop':p=0.
    return u,p


def _existing_row(owner,base,family,u,p):
    row=dict(base);center,right,up,toward=_target_frame();phase=2*math.pi*p
    if owner in ('DisplayEyeL','DisplayEyeR'):
        sign=1 if owner=='DisplayEyeL' else -1
        if family in ('Camera','Search'):
            hide=_smooth((u-.05)/.90)
            pivot=center+right*(sign*1.92)+up*.75+toward*.008
            for i in range(3):
                row[('scale',i)]=1-hide
                row[('location',i)]=base.get(('location',i),0)+pivot[i]*hide
        elif family=='Think':
            shift=right*(.11*math.sin(phase))+up*(.055*math.sin(phase+.6)-.055*math.sin(.6))
            for i in range(3):row[('location',i)]=base.get(('location',i),0)+shift[i]*u
    elif owner in ('DisplayEyeLShape','DisplayEyeRShape') and family=='Think':
        side=1 if owner=='DisplayEyeLShape' else -1
        blink=.18+.20*_pulse(p,.39 if side>0 else .398,.042)+.38*_pulse(p,.82,.035)
        values={'FullBlink':blink,'FullHappy':.25+.10*math.sin(phase),
                'FullLookLeft':.75*max(0.,math.sin(phase)),
                'FullLookRight':.75*max(0.,-math.sin(phase))}
        for key,value in values.items():
            path='key_blocks["'+key+'"].value'
            row[(path,0)]=base.get((path,0),0)*(1-u)+value*u
    elif owner.startswith('DisplayBar'):
        index=int(owner.removeprefix('DisplayBar'))-1
        if family=='Camera':
            for i in range(3):row[('scale',i)]=base.get(('scale',i),1)*(1-u)
        elif family=='Think':
            height=.64+.54*(.5+.5*math.sin(phase-index*.80))
            row[('scale',2)]=1-u+u*height
        elif family=='Search':
            row[('scale',2)]=1+u*.10*math.sin(phase-index*.36)
    return row


def _helper_row(obj,family,u,p):
    owner=str(obj['owner_id']);loc=Vector(obj['rest_location']);rot=Vector(obj['rest_rotation'])
    scale=Vector((0,0,0));_,right,up,_=_target_frame();phase=2*math.pi*p
    show=_smooth((u-.08)/.92)
    if owner.startswith('Cam') and family=='Camera':
        scale=Vector((show,show,show))
        if owner.startswith('CamIris'):
            focus=1+.055*math.sin(phase)
            scale*=focus
            # Local Y is the lens normal; rotate through the camera-plane basis.
            base=Matrix((right,-_target_frame()[3],up)).transposed()
            spin=Matrix.Rotation(.13*math.sin(phase),3,'Y')
            rot=(base@spin).to_euler()
        if owner=='CamReticle':
            scale*=.92+.08*math.cos(phase)
    elif owner.startswith('Search') and family=='Search':
        scale=Vector((show,show,show))
        loc+=right*(.19*math.sin(phase))+up*(.07*math.sin(2*phase))
    return _transform(loc,rot,scale)


def ensure_face_state_companions(clip,frames):
    """Explicit hidden/reset helper channels for every unrelated clip."""
    for owner,obj in face_state_owners():
        if clip in LENGTHS and state_action_for(clip,owner) is not None:
            continue
        row=_transform(obj['rest_location'],obj['rest_rotation'],(0,0,0))
        _write_action(clip+' • '+owner,[dict(row) for _ in range(frames)])


def build_face_states(rig):
    """Build nine connected actions and every required companion track.

    Requires the reviewed FullFaceIdle and existing interaction companions.
    The returned dictionary maps each clip name to its rig Action. Select the
    full owner set (existing interaction owners plus face_state_owners) together.
    """
    if rig.name!='MERLIN_Rig':raise ValueError('The MERLIN character rig is required.')
    baseline={owner:_channels(existing_action_for('FullFaceIdle',owner),1) for owner,_ in existing_owners()}
    _create_geometry();actions={}
    for family,names in FAMILIES.items():
        for kind,name in zip(('enter','loop','exit'),names):
            length=LENGTHS[name]
            for owner,_ in existing_owners():
                rows=[]
                for frame in range(1,length+1):
                    u,p=_settings(family,kind,frame,length)
                    rows.append(_existing_row(owner,baseline[owner],family,u,p))
                suffix='' if owner=='rig' else ' • Ball' if owner=='ball' else ' • '+owner
                action=_write_action(name+suffix,rows)
                if owner=='rig':actions[name]=action
            for owner,obj in face_state_owners():
                rows=[]
                for frame in range(1,length+1):
                    u,p=_settings(family,kind,frame,length);rows.append(_helper_row(obj,family,u,p))
                _write_action(name+' • '+owner,rows)
            action=actions[name]
            action['frames']=length;action['fps']=24;action['loop']=kind=='loop'
            action['source_activity']=names[1] if kind in ('loop','exit') else 'FullFaceIdle'
            action['source_frame']=1
            action['target_activity']=names[1] if kind in ('enter','loop') else 'FullFaceIdle'
            action['target_frame']=1
            action['face_state']=family
            action['note']='Authored display animation; camera canvas is synthetic and performs no device capture.'
    for clip in ('FullFaceIdle',):ensure_face_state_companions(clip,round(bpy.data.actions[clip].frame_range[1]))
    return actions
