"""Check the actual Blender interaction scene and its portable GLB export.

Run with Blender's --python-exit-code 1 against merlin-interactions.blend.
The delivered report is written only after every check passes. Failed drafts
write their diagnostic report to /tmp and never overwrite a successful report.
No scene is saved. Numerical checks complement rendered visual review.
"""
from pathlib import Path
import datetime
import hashlib
import json
import math
import struct
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = Path(__file__).resolve().parent
ASSET_DIR = HERE.parent
sys.path.insert(0, str(HERE))
from verify_character import EXPECTED_BONES, finite, parse_glb, scalar_floats
from verify_room import (FLOOR_Z, FRAME_TOLERANCE, SURFACE_TOLERANCE,
                         WALL_LEFT, WALL_RIGHT, character_meshes, frame_geometry)
from verify_transitions import accessor_values, glb_state

ORIGINAL = ('Idle','Wave','Jump','WalkWhistle','WallToss','Nap','ReadyIdle',
            'ReadyToNap','NapToReady','ReadyToWallToss','WallTossToReady',
            'ReadyToWalkWhistle','WalkWhistleToReady')
NEW_LENGTHS = {'ReadyToPanel':180, 'PanelIdle':96, 'PanelToReady':144,
               'ReadyToFace':40, 'FullFaceIdle':96, 'FaceToReady':36}
ALL_CLIPS = ORIGINAL + tuple(NEW_LENGTHS)
ROUTES = ('NapToReady','ReadyToPanel','PanelToReady','ReadyToFace','FaceToReady')
PANEL_CLIPS = {'ReadyToPanel','PanelIdle','PanelToReady'}
FACE_CLIPS = {'ReadyToFace','FullFaceIdle','FaceToReady'}
TOLERANCE = 3e-5
REPORT_PATH = ASSET_DIR/'previews'/'interactions-validation.json'
report = {
    'schema_version':1,
    'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'blender_version':bpy.app.version_string,
    'blend_file':Path(bpy.data.filepath).name,
    'blend_sha256':hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest() if bpy.data.filepath else None,
    'glb_file':'merlin-interactions.glb',
    'checks':[], 'measurements':{},
    'tolerances':{'matrix_and_channel':TOLERANCE, 'surface_units':SURFACE_TOLERANCE,
                  'camera_fraction':FRAME_TOLERANCE},
    'limitations':['Numerical checks complement visual review of the rendered performances.',
                   'Checks cover authored integer frames and fixed route boundaries; arbitrary runtime blends are not proved.',
                   'No live application integration or real-time device-performance claim.'],
}


def check(name, passed, **details):
    report['checks'].append({'name':name,'passed':bool(passed),**details})


def controller():
    import interaction_support
    return interaction_support


def select(name, frame=1):
    controller().apply_activity(bpy.context.scene,name,frame)
    bpy.context.view_layer.update()


def frames_for(name):
    first,last=bpy.data.actions[name].frame_range
    return range(math.ceil(first),math.floor(last)+1)


def object_visibility(obj):
    return max(abs(v) for v in obj.scale)


def snapshot(name, frame):
    select(name,frame)
    result={}
    for owner,data in controller().owners():
        if isinstance(data,bpy.types.Key):
            result[owner]={'kind':'shape','values':{k.name:float(k.value) for k in list(data.key_blocks)[1:]}}
        elif data.type=='ARMATURE':
            result[owner]={'kind':'rig','bones':{b.name:[float(v) for row in data.matrix_world@b.matrix for v in row] for b in data.pose.bones}}
        else:
            result[owner]={'kind':'object','matrix':[float(v) for row in data.matrix_world for v in row],
                           'scale':[float(v) for v in data.scale]}
    return result


def differences(a,b):
    errors=[];maximum=0.
    if set(a)!=set(b):errors.append('owner set differs')
    for owner in set(a)&set(b):
        x,y=a[owner],b[owner]
        if x['kind']=='rig':
            for bone,values in x['bones'].items():
                error=max(abs(u-v) for u,v in zip(values,y['bones'][bone]))
                maximum=max(maximum,error)
                if error>TOLERANCE:errors.append(f'{owner}/{bone}: {error}')
        elif x['kind']=='shape':
            if set(x['values'])!=set(y['values']):errors.append(owner+': morph set differs')
            for key in set(x['values'])&set(y['values']):
                error=abs(x['values'][key]-y['values'][key]);maximum=max(maximum,error)
                if error>TOLERANCE:errors.append(f'{owner}/{key}: {error}')
        else:
            # The position/orientation of a zero-scale prop is not visible.
            hidden=max(abs(v) for v in x['scale']+y['scale'])<.001
            field='scale' if hidden else 'matrix'
            error=max(abs(u-v) for u,v in zip(x[field],y[field]));maximum=max(maximum,error)
            if error>TOLERANCE:errors.append(f'{owner}/{field}: {error}')
    return maximum,errors


def validate_structure():
    missing=set(ALL_CLIPS)-set(bpy.data.actions.keys())
    check('nineteen_individual_blender_clips',not missing,missing=sorted(missing))
    lengths={n:list(bpy.data.actions[n].frame_range) for n in NEW_LENGTHS if n in bpy.data.actions}
    check('new_clip_lengths',all(lengths.get(n)==[1.,float(end)] for n,end in NEW_LENGTHS.items()),actual=lengths)
    absent=[]
    for name in ALL_CLIPS:
        for owner,data in controller().owners():
            if controller().action_for(name,owner) is None:absent.append([name,owner])
    check('all_synchronized_owner_actions',not absent,missing=absent)
    rig=bpy.data.objects['MERLIN_Rig']
    check('original_fifteen_bones',set(rig.data.bones.keys())==set(EXPECTED_BONES))
    check('original_rig_scale',max(abs(v-1) for v in rig.scale)<1e-6,scale=list(rig.scale))
    scene=bpy.context.scene
    aspect=scene.render.resolution_x*scene.render.pixel_aspect_x/(scene.render.resolution_y*scene.render.pixel_aspect_y)
    check('four_by_three_at_twenty_four_fps',abs(aspect-4/3)<1e-6 and scene.render.fps/scene.render.fps_base==24,
          aspect=aspect,fps=scene.render.fps/scene.render.fps_base)


def validate_endpoints():
    endpoints={}
    for name in ROUTES:
        action=bpy.data.actions[name]
        source=str(action['source_activity']);target=str(action['target_activity'])
        start=float(action.get('source_frame',1));end=float(action.get('target_frame',1))
        own=frames_for(name)
        for label,a,b in [('source',snapshot(name,own.start),snapshot(source,start)),
                          ('target',snapshot(name,own.stop-1),snapshot(target,end))]:
            maximum,errors=differences(a,b)
            check(name+'_'+label+'_continuity',not errors,maximum_error=maximum,errors=errors)
        endpoints[name]={'source':[source,start],'target':[target,end]}
    for name in ('PanelIdle','FullFaceIdle'):
        fr=frames_for(name)
        maximum,errors=differences(snapshot(name,fr.start),snapshot(name,fr.stop-1))
        check(name+'_seamless_loop',not errors,maximum_error=maximum,errors=errors)
    report['measurements']['route_endpoints']=endpoints


def validate_geometry():
    meshes=character_meshes();rig=bpy.data.objects['MERLIN_Rig'];measurements={}
    for name in tuple(NEW_LENGTHS)+('NapToReady',):
        low={'z':math.inf};extent=[math.inf,-math.inf];outside=[];scale_error=0.;grounded_before_hop=[]
        for frame in frames_for(name):
            select(name,frame)
            current,walls,projected,behind=frame_geometry(bpy.context.scene,meshes)
            if current['z']<low['z']:low={**current,'frame':frame}
            extent=[min(extent[0],walls[0]),max(extent[1],walls[1])]
            if min(projected[:2]) < -FRAME_TOLERANCE or max(projected[2:])>1+FRAME_TOLERANCE or behind:outside.append(frame)
            scale_error=max(scale_error,max(abs(v-1) for bone in rig.pose.bones for v in bone.matrix.to_scale()))
            if name=='NapToReady' and frame<42:grounded_before_hop.append(current['z'])
        check(name+'_robot_floor_clearance',low['z']>=FLOOR_Z-SURFACE_TOLERANCE,lowest=low)
        check(name+'_robot_side_wall_clearance',extent[0]>=WALL_LEFT-SURFACE_TOLERANCE and extent[1]<=WALL_RIGHT+SURFACE_TOLERANCE,x_extent=extent)
        check(name+'_robot_in_camera',not outside,violating_frames=outside)
        check(name+'_no_bone_stretch',scale_error<2e-5,maximum_scale_error=scale_error)
        if grounded_before_hop:
            check('NapToReady_supported_before_hop',max(grounded_before_hop)<.06,maximum_lowest_vertex=max(grounded_before_hop))
        measurements[name]={'frames_checked':len(frames_for(name)),'minimum_z':low,'x_extent':extent}
    report['measurements']['robot_geometry']=measurements


def validate_helper_visibility():
    panel=[o for o in bpy.context.scene.objects if o.get('merlin_panel_owner')]
    display=[o for o in bpy.context.scene.objects if o.get('display_mode')]
    check('panel_and_fullscreen_geometry_present',bool(panel) and bool(display),panel_objects=len(panel),display_objects=len(display))
    errors=[];states={}
    owner_ids={data.as_pointer():owner for owner,data in controller().owners()}
    for name in ALL_CLIPS:
        unrelated=(panel if name not in PANEL_CLIPS else [])+(display if name not in FACE_CLIPS else [])
        # Zero scale curves prove invisibility over an entire unrelated clip
        # without re-evaluating the unchanged old locomotion frame by frame.
        for obj in unrelated:
            action=controller().action_for(name,owner_ids[obj.as_pointer()])
            curves=[fc for fc in action.fcurves if fc.data_path=='scale'] if action else []
            peak=max((abs(float(k.co.y)) for fc in curves for k in fc.keyframe_points),default=math.inf)
            interpolation_ok=all(k.interpolation in ('LINEAR','CONSTANT') for fc in curves for k in fc.keyframe_points)
            if len(curves)!=3 or peak>.001 or not interpolation_ok:errors.append([name,obj.name,'scale is not explicitly zero throughout'])
        if name in PANEL_CLIPS|FACE_CLIPS:
            select(name,frames_for(name).stop-1)
            states[name]={o.name:object_visibility(o) for o in panel+display}
    check('helpers_hidden_in_unrelated_clips',not errors,violations=errors)
    select('PanelToReady',NEW_LENGTHS['PanelToReady'])
    removed={o.name:object_visibility(o) for o in panel}
    check('dismissal_removes_entire_panel',all(v<.001 for v in removed.values()),final_scales=removed)
    select('FaceToReady',NEW_LENGTHS['FaceToReady'])
    hidden={o.name:object_visibility(o) for o in display}
    check('zoom_out_removes_display_helpers',all(v<.001 for v in hidden.values()),final_scales=hidden)
    select('PanelIdle',1)
    cards=[o for o in panel if o.get('panel_kind')=='card']
    check('panel_idle_has_one_whole_card',len(cards)==1 and object_visibility(cards[0])>.99
          and all(object_visibility(o)<.001 for o in panel if o not in cards))
    select('FullFaceIdle',1)
    bars=[o for o in display if o.name.startswith('Display mode • mouth bar')]
    check('full_face_has_seven_visible_mouth_bars',len(bars)==7 and all(object_visibility(o)>.99 for o in bars),bar_count=len(bars))
    report['measurements']['helper_endpoint_scales']=states


def validate_design_preservation():
    # Read prior/current portable geometry directly. Reopening a .blend library
    # into an active copy can crash Blender4.0.2; binary comparison is independent
    # of evaluated animation and does not mutate or reload the current scene.
    old,old_bin,_=parse_glb(ASSET_DIR/'merlin-transitions.glb')
    new,new_bin,_=parse_glb(ASSET_DIR/'merlin-interactions.glb')
    def points(document,binary,name):
        node=next(n for n in document['nodes'] if n.get('name')==name)
        values=[]
        for primitive in document['meshes'][node['mesh']]['primitives']:
            values.extend(accessor_values(document,binary,primitive['attributes']['POSITION']))
        # Material splitting can duplicate seam vertices; compare unique basis
        # coordinates independently of export order and primitive ordering.
        return np.unique(np.asarray(values),axis=0)
    errors={}
    for name in ('Head • integrated flush display','Body • rounded tapered torso'):
        a,b=points(old,old_bin,name),points(new,new_bin,name)
        errors[name]=float(np.max(np.abs(a-b))) if a.shape==b.shape else 1e10
    def binds(document,binary):
        skin=next(s for s in document['skins'] if {document['nodes'][j].get('name') for j in s['joints']}==set(EXPECTED_BONES))
        accessor=document['accessors'][skin['inverseBindMatrices']]
        view=document['bufferViews'][accessor['bufferView']]
        offset=view.get('byteOffset',0)+accessor.get('byteOffset',0)
        stride=view.get('byteStride',64)
        return {document['nodes'][joint]['name']:struct.unpack_from('<16f',binary,offset+i*stride)
                for i,joint in enumerate(skin['joints'])}
    old_binds,new_binds=binds(old,old_bin),binds(new,new_bin)
    errors['rest_skin_bind_matrices']=max(abs(a-b) for bone in EXPECTED_BONES for a,b in zip(old_binds[bone],new_binds[bone]))
    check('head_torso_and_rest_skeleton_preserved',all(e<1e-6 for e in errors.values()),maximum_errors=errors)
    ceramic=bpy.data.materials['01 • Cornflower / matte ceramic'].node_tree.nodes['Principled BSDF']
    color=list(ceramic.inputs['Base Color'].default_value[:3]);roughness=ceramic.inputs['Roughness'].default_value
    check('matte_cornflower_preserved',max(abs(a-b) for a,b in zip(color,(.052,.19,.52)))<1e-6 and abs(roughness-.72)<1e-6,color=color,roughness=roughness)
    glow=bpy.data.materials['08 • Display / cyan to ice gradient']
    face_names=['Eye • L','Eye • R']
    display_glow=[o for o in bpy.context.scene.objects if o.get('display_mode') and ('mouth bar' in o.name or 'Eye •' in o.name)]
    wrong=[o.name for o in [bpy.data.objects[n] for n in face_names]+display_glow if glow not in list(o.data.materials)]
    check('same_cyan_gradient_on_robot_eyes_and_full_face',not wrong,incorrect_objects=wrong)
    smile=bpy.data.materials['05 • Cyan / luminous smile']
    smiles=[bpy.data.objects['Face • luminous smile']]+[o for o in bpy.context.scene.objects if o.get('display_mode') and o.name.endswith('Face • luminous smile')]
    check('expanding_smile_preserves_robot_shader',all(smile in list(o.data.materials) for o in smiles))
    background=bpy.context.scene.world.node_tree.nodes['Background']
    check('original_room_brightness_preserved',max(abs(a-b) for a,b in zip(background.inputs['Color'].default_value[:3],(.022,.031,.058)))<1e-6
          and abs(background.inputs['Strength'].default_value-.18)<1e-6 and abs(bpy.context.scene.view_settings.exposure-.35)<1e-6
          and sum(o.type=='LIGHT' for o in bpy.context.scene.objects)==6)


def validate_glb():
    path=ASSET_DIR/'merlin-interactions.glb'
    check('interaction_glb_exists',path.is_file())
    if not path.is_file():return
    document,binary,size=parse_glb(path)
    report['glb_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
    animations={a['name']:a for a in document.get('animations',[])}
    check('glb_nineteen_individual_clips',set(animations)==set(ALL_CLIPS),missing=sorted(set(ALL_CLIPS)-set(animations)),unexpected=sorted(set(animations)-set(ALL_CLIPS)))
    errors=[];duration={};channels={}
    expected=set((n,p) for n in EXPECTED_BONES for p in ('translation','rotation','scale'))
    for owner,data in controller().owners():
        if isinstance(data,bpy.types.Key):
            mesh_obj=next((o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.shape_keys==data),None)
            if mesh_obj:expected.add((mesh_obj.name,'weights'))
        elif data.type!='ARMATURE':
            for p in ('translation','rotation','scale'):expected.add((data.name,p))
    for name,animation in animations.items():
        actual={(document['nodes'][c['target']['node']].get('name'),c['target']['path']) for c in animation['channels']}
        missing=expected-actual
        if missing:errors.append({'clip':name,'missing_channels':sorted(missing)})
        ends=[]
        for sampler in animation['samplers']:
            times=scalar_floats(document,binary,sampler['input'])
            if not finite(times) or abs(times[0])>1e-6 or any(a>=b for a,b in zip(times,times[1:])):errors.append({'clip':name,'error':'invalid timeline'})
            ends.append(times[-1])
        duration[name]=max(ends,default=0);channels[name]=len(actual)
        if name in bpy.data.actions:
            expected_time=(bpy.data.actions[name].frame_range[1]-1)/24
            if abs(duration[name]-expected_time)>1e-5:errors.append({'clip':name,'error':'duration differs from Blender'})
    check('glb_all_rig_morph_prop_channels_and_durations',not errors,errors=errors,durations_seconds=duration,channels=channels)
    external=[i['uri'] for kind in ('images','buffers') for i in document.get(kind,[]) if i.get('uri') and not i['uri'].startswith('data:')]
    check('glb_resources_embedded',not external,external_uris=external)
    boundary_errors=[];maximum=0
    for name in ROUTES:
        action=bpy.data.actions[name]
        for endpoint,final in (('source',False),('target',True)):
            other=str(action[endpoint+'_activity']);frame=float(action.get(endpoint+'_frame',1))
            if name not in animations or other not in animations:continue
            a=glb_state(document,binary,animations[name],final)
            other_end=bpy.data.actions[other].frame_range[1]
            b=glb_state(document,binary,animations[other],frame==other_end)
            for key in set(a)&set(b):
                index,path_name=key
                if path_name in ('translation','rotation') and (index,'scale') in a and (index,'scale') in b:
                    if max(abs(v) for v in a[index,'scale']+b[index,'scale'])<.001:continue
                error=max(abs(u-v) for u,v in zip(a[key],b[key]))
                if path_name=='rotation':error=min(error,max(abs(u+v) for u,v in zip(a[key],b[key])))
                maximum=max(maximum,error)
                if error>TOLERANCE:boundary_errors.append([name,endpoint,document['nodes'][index].get('name'),path_name,error])
    check('glb_five_route_endpoint_continuity',not boundary_errors,maximum_error=maximum,errors=boundary_errors)
    report['measurements']['glb']={'bytes':size,'clips':len(animations),'nodes':len(document.get('nodes',[])), 'meshes':len(document.get('meshes',[]))}


def main():
    for fn in (validate_structure,validate_endpoints,validate_geometry,
               validate_helper_visibility,validate_design_preservation,validate_glb):
        print('Interaction validation: '+fn.__name__,flush=True)
        try:fn()
        except Exception as error:check(fn.__name__+'_completed',False,error=type(error).__name__+': '+str(error))
    failures=[item['name'] for item in report['checks'] if not item['passed']]
    report['passed']=not failures;report['failed_checks']=failures
    report['completed_at_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    destination=REPORT_PATH if not failures else Path('/tmp/merlin-interactions-validation-failed.json')
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'passed':not failures,'checks':len(report['checks']),'report':str(destination),'failed_checks':failures}),flush=True)
    if failures:raise RuntimeError('MERLIN interaction checks failed: '+', '.join(failures))


if __name__=='__main__':main()
