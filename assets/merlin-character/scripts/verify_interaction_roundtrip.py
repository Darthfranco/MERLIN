"""Independently import MERLIN's GLB and compare its actual evaluated animation.

Run with Blender --background --python-exit-code 1 --python this_file.py.
This loads both delivered assets, samples every individual clip at its first,
midpoint and final frame, and checks a further intermediate display expansion.
It does not render or change either scene. Failed reports stay in /tmp.
"""
from pathlib import Path
import datetime
import hashlib
import json
import math
import sys
import tempfile

import bpy
from mathutils import Vector, kdtree

HERE=Path(__file__).resolve().parent
ASSET=HERE.parent
sys.path.insert(0,str(HERE))
from animate_character import BONE_NAMES
from interaction_support import apply_activity
from room_support import FACE_OBJECTS,BALL_NAME
from verify_character import parse_glb

REPORT=ASSET/'previews'/'interaction-roundtrip-validation.json'
LIMITS={'bones':2e-4,'face':2e-6,'objects':2e-4,'display_morphs':2e-6,'display_geometry':2e-4}


def world_vertices(obj):
    evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return [tuple(evaluated.matrix_world@v.co) for v in evaluated.data.vertices]


def snapshot(rig,objects,face_names,display_names,geometry=False):
    result={
        'bones':{n:list(rig.matrix_world@rig.pose.bones[n].head) for n in BONE_NAMES},
        'face':{},'objects':{},'display_morphs':{},'display_geometry':{},
    }
    for name,obj in objects.items():
        if name not in face_names:
            result['objects'][name]=[float(v) for row in obj.matrix_world for v in row]
        keys=obj.data.shape_keys if obj.type=='MESH' else None
        if keys:
            target=result['face'] if name in face_names else result['display_morphs']
            target[name]={k.name:float(k.value) for k in list(keys.key_blocks)[1:]}
        if name in display_names:
            points=world_vertices(obj)
            result['display_geometry'][name]={
                'bounds':[min(v[a] for v in points) for a in range(3)]+[max(v[a] for v in points) for a in range(3)],
            }
            if geometry:result['display_geometry'][name]['vertices']=points
    return result


def difference(actual,expected):
    errors={name:0. for name in LIMITS}
    errors['bones']=max((Vector(actual['bones'][n])-Vector(expected['bones'][n])).length for n in expected['bones'])
    for kind in ('face','display_morphs'):
        for name,shapes in expected[kind].items():
            if name not in actual[kind] or set(shapes)!=set(actual[kind][name]):
                raise ValueError('Morph target set differs for '+name)
            errors[kind]=max(errors[kind],max((abs(actual[kind][name][key]-value) for key,value in shapes.items()),default=0))
    for name,values in expected['objects'].items():
        errors['objects']=max(errors['objects'],max(abs(a-b) for a,b in zip(values,actual['objects'][name])))
    for name,values in expected['display_geometry'].items():
        errors['display_geometry']=max(errors['display_geometry'],max(abs(a-b) for a,b in zip(values['bounds'],actual['display_geometry'][name]['bounds'])))
    return errors


def geometry_distance(a,b):
    """Bidirectional nearest-vertex distance tolerates glTF seam vertex splits."""
    maximum=0.
    for source,target in ((a,b),(b,a)):
        tree=kdtree.KDTree(len(target))
        for i,co in enumerate(target):tree.insert(co,i)
        tree.balance()
        for co in source:maximum=max(maximum,tree.find(co)[2])
    return maximum


def select_imported(clip,frame,rig,datablocks):
    missing=[]
    for label,data in datablocks:
        ad=data.animation_data
        chosen=None
        if ad:
            for track in ad.nla_tracks:
                track.mute=True
                if track.name==clip and track.strips:chosen=track.strips[0].action
            ad.action=chosen
        if chosen is None:missing.append([clip,label])
    if missing:return missing,None
    beginning=float(rig.animation_data.action.frame_range[0])
    time=beginning+frame-1
    bpy.context.scene.frame_set(math.floor(time),subframe=time-math.floor(time))
    bpy.context.view_layer.update()
    return [],time


def gradient_samples():
    material=next(m for m in bpy.data.materials if 'cyan to ice gradient' in m.name)
    image=next(node.image for node in material.node_tree.nodes if node.type=='TEX_IMAGE' and node.image)
    width,height=image.size
    pixels=list(image.pixels)
    samples=[]
    for row in (0,height//4,height//2,3*height//4,height-1):
        for column in (0,width//2,width-1):
            index=4*(row*width+column)
            samples.append(pixels[index:index+4])
    return {'size':[width,height],'samples':samples}


def material_checks(document,binary):
    materials=document.get('materials',[])
    gradients=[(i,m) for i,m in enumerate(materials) if 'cyan to ice gradient' in m.get('name','')]
    records=[]
    for index,material in gradients:
        texture=material.get('emissiveTexture',{}).get('index')
        image_id=document['textures'][texture]['source'] if texture is not None else None
        image=document['images'][image_id] if image_id is not None else {}
        view=document.get('bufferViews',[])[image['bufferView']] if 'bufferView' in image else {}
        offset=view.get('byteOffset',0);length=view.get('byteLength',0)
        embedded=bool(length and binary[offset:offset+8]==b'\x89PNG\r\n\x1a\n')
        users=[]
        for node in document.get('nodes',[]):
            if 'mesh' in node and any(p.get('material')==index for p in document['meshes'][node['mesh']]['primitives']):users.append(node.get('name',''))
        records.append({'material':material.get('name'),'embedded_png':embedded,'bytes':length,'users':users})
    required=['Eye • L','Eye • R','Display mode • Eye • L','Display mode • Eye • R']+['Display mode • mouth bar %02d'%i for i in range(1,8)]
    shared=any(r['embedded_png'] and all(name in r['users'] for name in required) for r in records)
    names={m.get('name') for m in materials}
    return {'passed':shared and {'Panel • porcelain white','Display mode • same cornflower edge','Display mode • obsidian'}<=names,
            'shared_robot_and_fullscreen_gradient':shared,'gradient_records':records,
            'panel_white_material': 'Panel • porcelain white' in names,
            'blue_border_and_black_display_materials':{'Display mode • same cornflower edge','Display mode • obsidian'}<=names}


def main():
    manifest=json.loads((ASSET/'interactions.json').read_text())
    document,binary,_=parse_glb(ASSET/'merlin-interactions.glb')
    bpy.ops.wm.open_mainfile(filepath=str(ASSET/'merlin-interactions.blend'))
    scene=bpy.context.scene;rig=bpy.data.objects['MERLIN_Rig']
    face_names=list(FACE_OBJECTS)
    panel_names=sorted(o.name for o in bpy.data.objects if o.get('merlin_panel_owner'))
    display_names=sorted(o.name for o in bpy.data.objects if o.get('display_mode'))
    object_names=face_names+[BALL_NAME]+panel_names+display_names
    original_gradient=gradient_samples()
    objects={name:bpy.data.objects[name] for name in object_names}
    descriptor=[]
    for name,obj in objects.items():
        if name not in face_names:descriptor.append((name,'object'))
        if obj.type=='MESH' and obj.data.shape_keys:descriptor.append((name,'shape'))
    source={}
    for clip,guide in manifest['clips'].items():
        for frame in (1,round((guide['frames']+1)/2),guide['frames']):
            apply_activity(scene,clip,frame)
            source[(clip,frame)]=snapshot(rig,objects,face_names,display_names)
    apply_activity(scene,'ReadyToFace',23)
    expansion=snapshot(rig,objects,face_names,display_names,geometry=True)
    report={
        'schema_version':1,'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'blender_version':bpy.app.version_string,'source_blend':'merlin-interactions.blend','imported_glb':'merlin-interactions.glb',
        'glb_sha256':hashlib.sha256((ASSET/'merlin-interactions.glb').read_bytes()).hexdigest(),
        'blend_sha256':hashlib.sha256((ASSET/'merlin-interactions.blend').read_bytes()).hexdigest(),
        'expected_clips':list(manifest['clips']),'samples':[],'missing_objects':[],'missing_tracks':[],
        'max_errors':{k:0. for k in LIMITS},'tolerances':LIMITS,
        'materials':material_checks(document,binary),
        'scope':{'bone_joints':list(BONE_NAMES),'face_objects':face_names,'panel_objects':panel_names,'display_objects':display_names},
        'limitations':['Representative frame sampling proves these exported poses, not every fractional runtime blend.',
                       'Material linkage and embedded texture are checked numerically; browser lighting and bloom remain runtime choices.'],
    }
    # Actual Blender importer, rather than merely decoding animation accessors.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps=24
    bpy.ops.import_scene.gltf(filepath=str(ASSET/'merlin-interactions.glb'))
    rig=bpy.data.objects['MERLIN_Rig']
    imported_gradient=gradient_samples()
    pixel_error=max(abs(a-b) for arow,brow in zip(original_gradient['samples'],imported_gradient['samples']) for a,b in zip(arow,brow))
    gradient_match=original_gradient['size']==imported_gradient['size'] and pixel_error<=2/255
    report['materials']['imported_gradient_pixels']={'passed':gradient_match,'source_size':original_gradient['size'],'imported_size':imported_gradient['size'],'maximum_channel_error':pixel_error,'tolerance':2/255}
    report['materials']['passed']=report['materials']['passed'] and gradient_match
    report['imported_clips']=sorted(t.name for t in rig.animation_data.nla_tracks)
    objects={}
    for name in object_names:
        obj=bpy.data.objects.get(name)
        if name in face_names and (obj is None or obj.type!='MESH' or obj.data.shape_keys is None):
            # The importer separates a skinned node's original transform into
            # an Empty and gives its actual mesh a suffixed/data-derived name.
            candidates=[o for o in bpy.data.objects if o.type=='MESH' and o.data.shape_keys
                        and (o.name.startswith(name) or (name=='Face • luminous smile'
                             and 'Whistle' in o.data.shape_keys.key_blocks))]
            obj=candidates[0] if len(candidates)==1 else None
        if obj is None:report['missing_objects'].append(name)
        else:objects[name]=obj
    report['resolved_imported_objects']={name:obj.name for name,obj in objects.items()}
    if report['missing_objects']:raise RuntimeError('Imported objects missing: '+str(report['missing_objects']))
    datablocks=[('rig',rig)]
    for name,kind in descriptor:
        obj=objects[name]
        data=obj if kind=='object' else obj.data.shape_keys
        if data is None:raise RuntimeError('Imported morphs missing: '+name)
        datablocks.append((name+(' morphs' if kind=='shape' else ''),data))
    for (clip,frame),expected in source.items():
        missing,time=select_imported(clip,frame,rig,datablocks)
        report['missing_tracks']+=missing
        if missing:continue
        actual=snapshot(rig,objects,face_names,display_names)
        errors=difference(actual,expected)
        report['samples'].append({'clip':clip,'source_frame':frame,'imported_frame':time,'errors':errors})
        for key,value in errors.items():report['max_errors'][key]=max(report['max_errors'][key],value)
    missing,time=select_imported('ReadyToFace',23,rig,datablocks)
    report['missing_tracks']+=missing
    if not missing:
        actual=snapshot(rig,objects,face_names,display_names,geometry=True)
        expanded={name:geometry_distance(expansion['display_geometry'][name]['vertices'],actual['display_geometry'][name]['vertices']) for name in display_names}
        shape=objects['Display mode • expanding head'].data.shape_keys.key_blocks['Expand'].value
        report['intermediate_expansion']={'clip':'ReadyToFace','source_frame':23,'imported_frame':time,'expand_weight':shape,
                                          'world_vertex_errors':expanded,'passed':0<shape<1 and max(expanded.values())<LIMITS['display_geometry']}
    else:report['intermediate_expansion']={'passed':False,'missing_tracks':missing}
    report['sample_count']=len(report['samples'])
    report['passed']=(not report['missing_tracks'] and not report['missing_objects']
        and set(report['imported_clips'])==set(manifest['clips']) and len(report['samples'])==57
        and all(report['max_errors'][k]<LIMITS[k] for k in LIMITS)
        and report['intermediate_expansion']['passed'] and report['materials']['passed'])
    target=REPORT if report['passed'] else Path(tempfile.gettempdir())/'interaction-roundtrip-failed.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print('INTERACTION_ROUNDTRIP',json.dumps({'passed':report['passed'],'samples':len(report['samples']),
          'max_errors':report['max_errors'],'report':str(target),'missing_tracks':len(report['missing_tracks']),
          'expansion':report['intermediate_expansion'],'materials':report['materials']}),flush=True)
    if not report['passed']:raise RuntimeError('MERLIN interaction GLB re-import comparison failed')


if __name__=='__main__':main()
