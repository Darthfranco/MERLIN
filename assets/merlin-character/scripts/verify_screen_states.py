"""Independent checks for the saved 37-clip screen/state asset.

Run with the full Blender executable against merlin-states.blend. A separate
read-only Blender process fingerprints the preceding interaction asset; no
baseline is rebuilt or linked into the active scene. Scene-only evidence is
written to /tmp. Add -- --glb for the complete delivery report, or --glb-only
to append export checks to an unchanged, already-validated scene fingerprint.
"""
from array import array
from pathlib import Path
import datetime
import hashlib
import json
import math
import subprocess
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

HERE=Path(__file__).resolve().parent
OUT=HERE.parent
sys.path.insert(0,str(HERE))
import screen_state_support as support
from animate_body_states import BODY_STATE_GUIDE,body_state_owners
from animate_left_panel import LEFT_PANEL_GUIDE,left_panel_owners
from animate_face_states import LENGTHS as FACE_LENGTHS,face_state_owners,FAMILIES
from animate_casual import _rig_points,_extreme
from animate_character import BONE_NAMES
from verify_character import parse_glb,scalar_floats
from verify_transitions import accessor_values,glb_state

NEW_LENGTHS={**{k:v['frames'] for k,v in BODY_STATE_GUIDE.items()},
             **{k:v['frames'] for k,v in LEFT_PANEL_GUIDE.items()},**FACE_LENGTHS}
BASELINE=OUT/'merlin-interactions.blend'
TEMP=Path(tempfile.gettempdir())
SCENE_REPORT=TEMP/'merlin-states-scene-validation.json'
FINAL_REPORT=OUT/'previews/states-validation.json'
TOL=3e-5


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def flat(matrix):return [float(v) for row in matrix for v in row]

def digest_collection(collection,property,count):
    values=array('f',[0.])*count
    collection.foreach_get(property,values)
    return hashlib.sha256(values.tobytes()).hexdigest()

def material_snapshot(material):
    if not material.use_nodes:return {'diffuse_color':list(material.diffuse_color)}
    nodes={}
    for node in material.node_tree.nodes:
        if node.type=='BSDF_PRINCIPLED':
            nodes[node.name]={}
            for name in ('Base Color','Metallic','Roughness','Specular IOR Level','Coat Weight','Emission Color','Emission Strength'):
                socket=node.inputs.get(name)
                if socket:
                    value=socket.default_value
                    nodes[node.name][name]=float(value) if isinstance(value,(int,float)) else list(value)
        elif node.type=='TEX_IMAGE' and node.image:
            image=node.image
            nodes[node.name]={'image':image.name,'size':list(image.size),
                              'pixels_sha256':hashlib.sha256(np.asarray(image.pixels[:],dtype=np.float32).tobytes()).hexdigest()}
    return nodes

def baseline_snapshot():
    rig=bpy.data.objects['MERLIN_Rig'];scene=bpy.context.scene
    meshes={}
    for obj in scene.objects:
        if obj.type=='MESH' and any(m.type=='ARMATURE' and m.object==rig for m in obj.modifiers):
            meshes[obj.name]={'vertices':len(obj.data.vertices),
                'basis_sha256':digest_collection(obj.data.vertices,'co',len(obj.data.vertices)*3),
                'matrix_world':flat(obj.matrix_world),'material_slots':[m.name if m else None for m in obj.data.materials]}
    background=scene.world.node_tree.nodes['Background']
    return {'fingerprint_version':2,'blend_sha256':sha(Path(bpy.data.filepath)),'rig_scale':list(rig.scale),
        'bones':{b.name:flat(b.matrix_local) for b in rig.data.bones},'meshes':meshes,
        'materials':{m.name:material_snapshot(m) for m in bpy.data.materials if not m.name.startswith(('Panel •','MERLIN_Screen_'))},
        'lights':{o.name:{'type':o.data.type,'color':list(o.data.color),'energy':o.data.energy,
                         'size':getattr(o.data,'size',None),'matrix_basis':flat(o.matrix_basis),
                         'matrix_parent_inverse':flat(o.matrix_parent_inverse),
                         'parent':o.parent.name if o.parent else None,
                         'parent_type':o.parent_type,'parent_bone':o.parent_bone}
                  for o in scene.objects if o.type=='LIGHT'},
        'world':{'color':list(background.inputs['Color'].default_value),'strength':background.inputs['Strength'].default_value},
        'view':{k:getattr(scene.view_settings,k) for k in ('view_transform','look','exposure','gamma')},
        'camera':{'matrix_world':flat(scene.camera.matrix_world),'type':scene.camera.data.type,'ortho_scale':scene.camera.data.ortho_scale}}


def check(name,passed,**details):report['checks'].append({'name':name,'passed':bool(passed),**details})

def select(clip,frame):support.apply_activity(bpy.context.scene,clip,frame)

def snapshot(clip,frame):
    select(clip,frame);result={}
    for owner,data in support.owners():
        if isinstance(data,bpy.types.Key):result[owner]={'weights':[float(k.value) for k in list(data.key_blocks)[1:]]}
        elif data.type=='ARMATURE':result[owner]={'bones':{b.name:flat(data.matrix_world@b.matrix) for b in data.pose.bones}}
        else:result[owner]={'matrix':flat(data.matrix_world),'scale':list(data.scale)}
    return result

def difference(a,b):
    errors=[];maximum=0.
    for owner in a:
        x,y=a[owner],b[owner]
        if 'bones' in x:pairs=[(n,x['bones'][n],y['bones'][n]) for n in x['bones']]
        elif 'weights' in x:pairs=[('weights',x['weights'],y['weights'])]
        else:
            field='scale' if max(abs(v) for v in x['scale']+y['scale'])<1e-6 else 'matrix'
            pairs=[(field,x[field],y[field])]
        for label,u,v in pairs:
            error=max(abs(c-d) for c,d in zip(u,v));maximum=max(maximum,error)
            if error>TOL:errors.append([owner,label,error])
    return maximum,errors


def validate_structure():
    old=json.loads((OUT/'interactions.json').read_text())
    expected=set(old['clips'])|set(NEW_LENGTHS)
    check('exactly_37_manifest_clips',set(clips)==expected and len(clips)==37,actual=len(clips),missing=sorted(expected-set(clips)),extra=sorted(set(clips)-expected))
    owners=support.owners();ids=[name for name,_ in owners]
    check('unique_owner_ids',len(ids)==len(set(ids)),owners=len(ids))
    missing=[];invalid=[];lengths=[];channel_errors=[]
    for clip,metadata in clips.items():
        for owner,data in owners:
            action=support.action_for(clip,owner)
            if not action:missing.append([clip,owner]);continue
            if list(action.frame_range)!=[1.,float(metadata['frames'])]:lengths.append([clip,owner,list(action.frame_range)])
            actual={(c.data_path,c.array_index) for c in action.fcurves}
            if isinstance(data,bpy.types.Key):expected_channels={(k.path_from_id('value'),0) for k in list(data.key_blocks)[1:]}
            elif data.type=='ARMATURE':
                # The three original portrait actions precede explicit scale
                # baking. Their unchanged rigid rig supplies unit defaults.
                paths=('location','rotation_euler') if clip in ('Idle','Wave','Jump') else ('location','rotation_euler','scale')
                expected_channels={(f'pose.bones["{n}"].{p}',i) for n in BONE_NAMES for p in paths for i in range(3)}
            else:expected_channels={(p,i) for p in ('location','rotation_euler','scale') for i in range(3)}
            absent=expected_channels-actual
            if absent:channel_errors.append([clip,owner,sorted(absent)])
            for curve in action.fcurves:
                values=np.empty(len(curve.keyframe_points)*2)
                curve.keyframe_points.foreach_get('co',values)
                if not len(values) or not np.isfinite(values).all():invalid.append([clip,owner,curve.data_path,curve.array_index])
                if isinstance(data,bpy.types.Key) and len(values) and (values[1::2].min() < -1e-6 or values[1::2].max()>1+1e-6):
                    invalid.append([clip,owner,'morph outside 0..1',curve.data_path])
    check('all_owner_actions_present',not missing,missing=missing)
    check('all_companion_lengths_match',not lengths,errors=lengths)
    check('all_expected_channels_present',not channel_errors,errors=channel_errors)
    check('all_animation_values_finite_and_morphs_bounded',not invalid,errors=invalid)
    scene=bpy.context.scene
    check('original_15_bones_unit_scale_and_24fps',set(bpy.data.objects['MERLIN_Rig'].data.bones.keys())==set(BONE_NAMES)
          and list(bpy.data.objects['MERLIN_Rig'].scale)==[1,1,1] and scene.render.fps/scene.render.fps_base==24)


def validate_boundaries():
    for clip in NEW_LENGTHS:
        guide=clips[clip];length=guide['frames']
        for label,f in [('source',1),('target',length)]:
            reference=guide[label];reference_frame=guide[label+'_frame']
            maximum,errors=difference(snapshot(clip,f),snapshot(reference,reference_frame))
            check(clip+'_'+label+'_continuity',not errors,maximum_error=maximum,errors=errors)
    for key in ('dance','bodyThink','left','camera','faceThink','search'):
        clip=manifest['states'][key]['idle']
        maximum,errors=difference(snapshot(clip,1),snapshot(clip,clips[clip]['frames']))
        check(clip+'_loop_seam',not errors,maximum_error=maximum,errors=errors)


def validate_visibility():
    errors=[];owners=dict(support.owners())
    families={}
    for owner,data in support.owners():
        if isinstance(data,bpy.types.Key) or data.type=='ARMATURE':continue
        if data.get('merlin_body_state_owner'):allowed={'ReadyToDance','Dance','DanceToReady'}
        elif data.get('merlin_left_panel_owner'):allowed=set(LEFT_PANEL_GUIDE)
        elif data.get('merlin_panel_owner'):allowed={'ReadyToPanel','PanelIdle','PanelToReady'}
        elif data.get('display_mode'):allowed={'ReadyToFace','FullFaceIdle','FaceToReady'}|set(FACE_LENGTHS)
        elif data.get('face_state_helper'):
            allowed=set(FAMILIES['Camera' if owner.startswith('Cam') else 'Search'])
        else:continue
        families[owner]=allowed
        for clip in set(clips)-allowed:
            action=support.action_for(clip,owner)
            curves=[c for c in action.fcurves if c.data_path=='scale'] if action else []
            if len(curves)!=3 or any(abs(k.co.y)>1e-7 or k.interpolation not in ('LINEAR','CONSTANT') for c in curves for k in c.keyframe_points):errors.append([clip,owner])
    check('all_helpers_explicitly_hidden_outside_family',not errors,helper_owners=len(families),errors=errors)
    visible={}
    for clip,predicate,count in [('Dance',lambda o:o.get('merlin_body_state_owner'),4),
            ('LeftPanelIdle',lambda o:o.get('merlin_left_panel_owner') and o.get('panel_kind')=='card',1),
            ('PanelIdle',lambda o:o.get('merlin_panel_owner') and o.get('panel_kind')=='card',1),
            ('CameraIdle',lambda o:o.get('face_state_helper') and str(o.get('owner_id','')).startswith('Cam'),7),
            ('FaceSearch',lambda o:o.get('face_state_helper') and str(o.get('owner_id','')).startswith('Search'),4)]:
        select(clip,1)
        objects=[o for o in bpy.context.scene.objects if predicate(o)]
        current=[o.name for o in objects if min(o.scale)>.5]
        visible[clip]=current
        check(clip+'_intended_helpers_visible',len(objects)==count and len(current)==count,visible=current,expected_count=count)
    report['measurements']['visible_helpers']=visible


def validate_screens():
    found={};errors=[]
    for obj in bpy.context.scene.objects:
        sid=obj.get('merlin_screen_id')
        if not sid:continue
        found.setdefault(sid,[]).append(obj.name)
        uv=obj.data.uv_layers.active
        if not uv:errors.append([obj.name,'no active UV']);continue
        if obj.get('merlin_screen_uv_origin')!='top-left' or obj.get('merlin_blender_uv_origin')!='bottom-left':errors.append([obj.name,'UV convention missing'])
        slots=[i for i,m in enumerate(obj.data.materials) if m and m.get('merlin_screen_id')==sid]
        if not slots:errors.append([obj.name,'no matching screen material'])
        face_count=0
        for polygon in obj.data.polygons:
            if polygon.material_index not in slots:continue
            face_count+=1
            for li in polygon.loop_indices:
                value=uv.data[li].uv
                if min(value)<-1e-5 or max(value)>1+1e-5:errors.append([obj.name,'UV bounds',list(value)])
                co=obj.data.vertices[obj.data.loops[li].vertex_index].co
                if sid in ('left','right'):
                    center=obj['panel_center_local'];expected=((co.x+center[0])/4.75+.5,(co.y+center[1])/5.7+.5)
                else:expected=((co.x+2.825)/5.65,(co.z+.98)/1.96)
                if max(abs(a-b) for a,b in zip(value,expected))>1e-5:errors.append([obj.name,'UV orientation or panel-fragment placement'])
        if not face_count:errors.append([obj.name,'no screen-facing polygons'])
        for i in slots:
            mat=obj.data.materials[i];node=mat.node_tree.nodes.get('MERLIN Screen Content')
            if node is None or node.image is None:errors.append([obj.name,'no image texture']);continue
            image=node.image
            if image.size[0]<2 or image.size[1]<2 or not image.packed_file:errors.append([obj.name,'invalid or unpacked texture'])
            if not any(l.from_node==node and l.to_socket.name=='Emission Color' for l in mat.node_tree.links):errors.append([obj.name,'texture not linked to emission'])
    check('three_editable_screen_ids',set(found)=={'left','right','camera'},nodes=found)
    check('all_screen_front_materials_uvs_and_embedded_images_valid',not errors,errors=errors[:100],error_count=len(errors))
    check('screen_node_counts',len(found.get('left',[]))==31 and len(found.get('right',[]))==31 and len(found.get('camera',[]))==1,
          counts={k:len(v) for k,v in found.items()})
    check('manifest_screen_ids_match_scene',set(manifest['screens'])==set(found))


def validate_preservation():
    path=TEMP/'merlin-states-baseline-snapshot.json'
    cached=json.loads(path.read_text()) if path.is_file() else {}
    if cached.get('blend_sha256')!=sha(BASELINE) or cached.get('fingerprint_version')!=2:
        result=subprocess.run([bpy.app.binary_path,'-b',str(BASELINE),'--python-exit-code','1','--python',str(Path(__file__).resolve()),'--','--baseline-snapshot',str(path)],capture_output=True,text=True)
        if result.returncode:raise RuntimeError('Baseline reader failed: '+result.stdout[-1500:]+result.stderr[-1500:])
    old=json.loads(path.read_text());new=baseline_snapshot()
    for field in ('bones','meshes','lights','world','view','camera'):
        # The new material slots belong only to unrigged information panels.
        check('baseline_'+field+'_preserved',old[field]==new[field])
    missing=[];changed=[]
    for name,data in old['materials'].items():
        if name not in new['materials']:missing.append(name)
        elif data!=new['materials'][name]:changed.append(name)
    check('baseline_character_materials_and_gradients_preserved',not missing and not changed,missing=missing,changed=changed)
    report['measurements']['baseline']={'blend':BASELINE.name,'sha256':old['blend_sha256'],'rigged_meshes':len(old['meshes'])}


def validate_new_geometry():
    rig=bpy.data.objects['MERLIN_Rig'];clouds=_rig_points(rig);scene=bpy.context.scene;measurements={}
    for clip in NEW_LENGTHS:
        # Face-state rigs hold the already reviewed centered body; their helpers
        # receive continuous visibility and finite-channel checks above.
        frames=range(1,NEW_LENGTHS[clip]+1) if clip not in FACE_LENGTHS else (1,NEW_LENGTHS[clip]//2,NEW_LENGTHS[clip])
        low=math.inf;volume=math.inf;scale_error=0.;outside=[];extent=[math.inf,-math.inf]
        for frame in frames:
            select(clip,frame)
            low=min(low,_extreme(rig,clouds,2));extent=[min(extent[0],_extreme(rig,clouds,0)),max(extent[1],_extreme(rig,clouds,0,maximum=True))]
            scale_error=max(scale_error,max(abs(v-1) for bone in rig.pose.bones for v in bone.matrix.to_scale()))
            head=rig.pose.bones['head'].matrix@rig.data.bones['head'].matrix_local.inverted();inverse=np.array(head.inverted())
            for name,points in clouds.items():
                if not name.startswith(('upper_arm.','forearm.','hand.')):continue
                matrix=np.array(rig.pose.bones[name].matrix);world=points@matrix[:3,:3].T+matrix[:3,3]
                local=world@inverse[:3,:3].T+inverse[:3,3]
                values=np.abs(local[:,0]/1.04)**(2/.65)+np.abs(local[:,1]/.54)**(2/.65)+np.abs((local[:,2]-2.98)/.71)**(2/.65)
                volume=min(volume,float(values.min()))
            for owner,obj in body_state_owners():
                if max(obj.scale)<1e-6:continue
                for corner in obj.bound_box:
                    p=world_to_camera_view(scene,scene.camera,obj.matrix_world@Vector(corner))
                    if min(p.x,p.y)<0 or max(p.x,p.y)>1 or p.z<=0:outside.append([frame,owner])
        check(clip+'_body_clearance_and_unit_scale',low>=.03 and extent[0]>=-4.5 and extent[1]<=4.5 and volume>=.999 and scale_error<2e-5,
              minimum_floor_z=low,minimum_arm_head_implicit_volume=volume,x_extent=extent,maximum_scale_error=scale_error)
        check(clip+'_music_notes_inside_camera',not outside,violations=outside)
        measurements[clip]={'frames_checked':len(frames),'floor_min':low,'arm_head_minimum_implicit_volume':volume}
    report['measurements']['geometry']=measurements


def validate_glb():
    path=OUT/'merlin-states.glb'
    if not path.is_file():raise FileNotFoundError(path)
    document,binary,size=parse_glb(path);animations={a['name']:a for a in document.get('animations',[])}
    check('glb_exactly_37_clips',set(animations)==set(clips),missing=sorted(set(clips)-set(animations)),extra=sorted(set(animations)-set(clips)))
    expected={(n,p) for n in BONE_NAMES for p in ('translation','rotation','scale')}
    for owner,data in support.owners():
        if isinstance(data,bpy.types.Key):
            obj=next(o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.shape_keys==data)
            expected.add((obj.name,'weights'))
        elif data.type!='ARMATURE':expected.update((data.name,p) for p in ('translation','rotation','scale'))
    errors=[];counts={}
    for name,animation in animations.items():
        actual={(document['nodes'][c['target']['node']]['name'],c['target']['path']) for c in animation['channels']}
        if expected-actual:errors.append([name,'missing channels',sorted(expected-actual)])
        ends=[]
        for sampler in animation['samplers']:
            times=scalar_floats(document,binary,sampler['input']);values=accessor_values(document,binary,sampler['output'])
            if not np.isfinite(times).all() or not np.isfinite(values).all() or abs(times[0])>1e-6 or any(a>=b for a,b in zip(times,times[1:])):errors.append([name,'nonfinite output or invalid sampling times'])
            ends.append(times[-1])
        if abs(max(ends)-(clips[name]['frames']-1)/24)>1e-5:errors.append([name,'duration mismatch'])
        counts[name]=len(actual)
    check('glb_complete_finite_channels_and_durations',not errors,errors=errors,channels=counts)
    boundary=[];maximum=0.
    for clip in NEW_LENGTHS:
        for label,final in [('source',False),('target',True)]:
            other=clips[clip][label];frame=clips[clip][label+'_frame']
            a=glb_state(document,binary,animations[clip],final)
            b=glb_state(document,binary,animations[other],frame==clips[other]['frames'])
            for key in set(a)&set(b):
                index,kind=key
                if kind in ('translation','rotation') and (index,'scale') in a and (index,'scale') in b and max(abs(v) for v in a[index,'scale']+b[index,'scale'])<1e-6:continue
                error=max(abs(x-y) for x,y in zip(a[key],b[key]))
                if kind=='rotation':error=min(error,max(abs(x+y) for x,y in zip(a[key],b[key])))
                maximum=max(maximum,error)
                if error>TOL:boundary.append([clip,label,document['nodes'][index]['name'],kind,error])
    check('glb_new_state_endpoint_continuity',not boundary,maximum_error=maximum,errors=boundary)
    external=[entry['uri'] for kind in ('images','buffers') for entry in document.get(kind,[]) if entry.get('uri') and not entry['uri'].startswith('data:')]
    check('glb_all_resources_embedded',not external,external=external)
    nodes={}
    for node in document['nodes']:
        sid=node.get('extras',{}).get('merlin_screen_id')
        if sid:nodes.setdefault(sid,[]).append(node.get('name'))
    check('glb_three_screen_ids_exported',set(nodes)=={'left','right','camera'} and [len(nodes[k]) for k in ('left','right','camera')]==[31,31,1],nodes=nodes)
    report['glb_checked']=True;report['glb_sha256']=sha(path)
    report['measurements']['glb']={'bytes':size,'nodes':len(document['nodes']),'clips':len(animations)}


def main():
    global report,manifest,clips
    arguments=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    if '--baseline-snapshot' in arguments:
        destination=Path(arguments[arguments.index('--baseline-snapshot')+1]);destination.write_text(json.dumps(baseline_snapshot(),indent=2));return
    manifest=json.loads((OUT/'states.json').read_text());clips=manifest['clips']
    current_sha=sha(Path(bpy.data.filepath))
    report={'schema_version':1,'blend_file':Path(bpy.data.filepath).name,'blend_sha256':current_sha,
            'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'checks':[],'measurements':{},'glb_checked':False,
            'limitations':['Integer-frame geometry checks cover new body/left-screen motion; held full-face body poses use three samples per clip.',
                'Numerical validation complements visual review; no live camera/music/search execution is claimed.']}
    if '--glb-only' in arguments:
        previous=json.loads(SCENE_REPORT.read_text())
        if not previous.get('passed') or previous['blend_sha256']!=current_sha:raise ValueError('Saved scene differs from the passing scene-only report; run the full verifier.')
        report=previous
        functions=[validate_glb]
    else:functions=[validate_structure,validate_boundaries,validate_visibility,validate_screens,validate_preservation,validate_new_geometry]
    if '--glb' in arguments:functions.append(validate_glb)
    for fn in functions:
        print('State validation: '+fn.__name__,flush=True)
        try:fn()
        except Exception as error:check(fn.__name__+'_completed',False,error=type(error).__name__+': '+str(error))
    failures=[item['name'] for item in report['checks'] if not item['passed']]
    report['passed']=not failures;report['failed_checks']=failures
    report['completed_at_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    destination=TEMP/'merlin-states-validation-failed.json' if failures else FINAL_REPORT if report['glb_checked'] else SCENE_REPORT
    destination.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print('STATES_VALIDATION_COMPLETE',json.dumps({'passed':not failures,'checks':len(report['checks']),'report':str(destination),'failed':failures}),flush=True)
    if failures:raise RuntimeError('Screen/state verification failed: '+', '.join(failures))


if __name__=='__main__':main()
