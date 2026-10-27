"""Pull two independent content cards, settle between them, dismiss either side.

The original meshes, UVs, rig, lighting and older actions are unchanged. Every
owner gets a portable companion, including explicit hidden fragment tracks.
"""
from math import sin, cos, pi
import bpy
from mathutils import Matrix, Vector
from animate_character import BONE_NAMES, _ramp, _smooth
from animate_casual import _pose, _set_pose, _limb, _rotation
from animate_transitions import (_sample, _apply, _capture, _context, _blend,
    _key, _new_action, _finish, _run, _clearance)
from animate_panel import panel_owners, _stepped_blend
from animate_left_panel import left_panel_owners, REFLECTION, _opposite
from transition_support import new_action, linear, FACE_OBJECTS
from expressive_face import conform_expression
import animate_panel as panel
import screen_state_support as support

SCALE=.68
INNER=1.48
CENTER=Vector((INNER+4.75*SCALE/2, .44, 2.65))
DUAL_GUIDE={
 'ReadyToBothPanels':dict(frames=288,source_activity='ReadyIdle',target_activity='BothPanelsIdle'),
 'BothPanelsIdle':dict(frames=96,loop=True,source_activity='BothPanelsIdle',target_activity='BothPanelsIdle'),
 'BothToLeftPanel':dict(frames=72,source_activity='BothPanelsIdle',target_activity='SeatedLeftPanelIdle',dismiss=['right']),
 'BothToRightPanel':dict(frames=72,source_activity='BothPanelsIdle',target_activity='SeatedRightPanelIdle',dismiss=['left']),
 'SeatedLeftPanelIdle':dict(frames=96,loop=True,source_activity='SeatedLeftPanelIdle',target_activity='SeatedLeftPanelIdle'),
 'SeatedRightPanelIdle':dict(frames=96,loop=True,source_activity='SeatedRightPanelIdle',target_activity='SeatedRightPanelIdle'),
 'SeatedLeftToReady':dict(frames=132,source_activity='SeatedLeftPanelIdle',target_activity='ReadyIdle',dismiss=['left']),
 'SeatedRightToReady':dict(frames=132,source_activity='SeatedRightPanelIdle',target_activity='ReadyIdle',dismiss=['right']),
 'BothPanelsToReady':dict(frames=132,source_activity='BothPanelsIdle',target_activity='ReadyIdle',dismiss=['left','right']),
}
for _g in DUAL_GUIDE.values():
 _g.setdefault('loop',False);_g.update(source_frame=1,target_frame=1)


def _reflect(rig,pose):
 _apply(rig,pose)
 target={}
 for name in BONE_NAMES:
  other=_opposite(name)
  deformation=rig.pose.bones[other].matrix@rig.data.bones[other].matrix_local.inverted()
  target[name]=REFLECTION@deformation@REFLECTION@rig.data.bones[name].matrix_local
 for name in BONE_NAMES:
  bone=rig.pose.bones[name];parent=bone.parent
  bone.matrix_basis=(bone.bone.matrix_local.inverted()@parent.bone.matrix_local@target[parent.name].inverted()@target[name]) if parent else bone.bone.matrix_local.inverted()@target[name]
 bpy.context.view_layer.update()
 return {name:(l,q,Vector((1,1,1))) for name,(l,q,s) in _capture(rig).items()}


def _seated(rig,context,amount=1.,phase=0.,tap=()):
 """Weight lowers over bent knees; heels settle forward and palms rest on knees."""
 rig.animation_data.action=None
 basis,inverse,_=context;p=_pose()
 p['root']=Vector((0, .025*amount, -.72*amount))
 p['rotation']['body']=[-5*amount+10*sin(pi*amount),.6*sin(phase)*amount,0]
 p['rotation']['head']=[4*amount,-.7*sin(phase)*amount,1.4*sin(phase)*amount]
 for side,sign in [('L',1),('R',-1)]:
  p['rotation']['upper_arm.'+side]=[-12*amount,-sign*9,0]
  p['rotation']['forearm.'+side]=[-20*amount,-sign*3,0]
 _set_pose(rig,p,basis,inverse)
 for side,sign in [('L',1),('R',-1)]:
  hip=rig.pose.bones['thigh.'+side].head.copy()
  target=Vector((sign*(.33+.10*amount),-.12-.64*amount,.25))
  pole=hip+Vector((sign*.22,-.36, .8*amount-.3))
  _limb(rig,'thigh.'+side,'shin.'+side,'foot.'+side,target,pole,Matrix.Identity(3),_rotation(x=-8*amount,z=sign*7*amount),basis)
 bpy.context.view_layer.update()
 for side,sign in [('L',1),('R',-1)]:
  shoulder=rig.pose.bones['upper_arm.'+side].head.copy()
  rest=rig.pose.bones['hand.'+side].head.copy()
  target=rest.lerp(Vector((sign*.63,-.35,.76)),amount)
  pole=shoulder+Vector((sign*.22,-.16,-.45))
  _limb(rig,'upper_arm.'+side,'forearm.'+side,'hand.'+side,target,pole,Matrix.Identity(3),_rotation(x=-42*amount,y=-sign*8),basis)
 bpy.context.view_layer.update();_clearance(rig,context)
 return _capture(rig)


def _tap(rig,context,seated,sides,weight):
 _apply(rig,seated)
 basis,_,_=context
 for which in sides:
  sign=1 if which=='right' else -1;side='L' if sign==1 else 'R'
  shoulder=rig.pose.bones['upper_arm.'+side].head.copy()
  hand=rig.pose.bones['hand.'+side].head.copy()
  # A small palm-led reach towards the inner bottom corner, away from the face.
  target=hand.lerp(Vector((sign*1.33,-.02,1.13)),weight)
  pole=shoulder+Vector((sign*.55,-.18,-.18))
  _limb(rig,'upper_arm.'+side,'forearm.'+side,'hand.'+side,target,pole,Matrix.Identity(3),_rotation(x=-35,y=-sign*32),basis)
 bpy.context.view_layer.update()
 rig.pose.bones['head'].rotation_euler.z += (.055 if sides==['right'] else -.055 if sides==['left'] else 0)*weight
 bpy.context.view_layer.update();return _capture(rig)


def _clone_ready(clip,frames):
 for owner,data in support.owners():
  if owner=='rig':continue
  source=support.action_for('ReadyIdle',owner)
  action=new_action(support.base.action_name(clip,owner))
  for old in source.fcurves:
   curve=action.fcurves.new(old.data_path,index=old.array_index)
   v=old.evaluate(1);curve.keyframe_points.add(2)
   curve.keyframe_points.foreach_set('co',[1,v,frames,v])
  linear(action)


def _panel_state(clip,side,frame):
 """Return the inset of each independently held card and its dismissal progress."""
 guide=DUAL_GUIDE[clip]
 if clip=='ReadyToBothPanels':
  a,b=(49,99) if side=='right' else (168,218)
  return (frame>=a, 4.45+(INNER-4.45)*_ramp(frame,a,b),None)
 present=side in ({'left'} if guide['source_activity']=='SeatedLeftPanelIdle' else {'right'} if guide['source_activity']=='SeatedRightPanelIdle' else {'left','right'})
 dismissed=side in guide.get('dismiss',[])
 return (present,INNER,(frame-31)/22 if dismissed and frame>30 else None)


def _panels(clip,frames):
 camera=bpy.context.scene.camera.rotation_euler.copy();rot=camera.to_matrix()
 for side,owners in [('right',panel_owners()),('left',left_panel_owners())]:
  sign=1 if side=='right' else -1
  for owner,obj in owners:
   action=new_action(support.base.action_name(clip,owner));obj.animation_data.action=action
   base=support.action_for('ReadyIdle',owner)
   for frame in range(1,frames+1):
    present,inner,shatter=_panel_state(clip,side,frame)
    local=Vector((*obj['panel_center_local'],0))
    center=Vector((sign*(inner+4.75*SCALE/2),CENTER.y,CENTER.z))
    obj.location=center+rot@(local*SCALE);obj.rotation_euler=camera;size=0.
    if present:
     if obj['panel_kind']=='card':size=SCALE if shatter is None else 0.
     elif shatter is not None and 0<=shatter<=1:
      u=shatter;progress=_smooth(u);index=obj['panel_index']
      radial=Vector((local.x/4.75,local.y/5.7,0));radial.normalize()
      obj.location+=rot@(radial*(.12*progress)+Vector((.015*sin(index*2.3),.015*cos(index),.015))*sin(pi*u))
      obj.rotation_euler.x+=.06*sin(index*1.7)*progress
      obj.rotation_euler.y+=.07*cos(index*2.1)*progress
      size=SCALE*(1-_smooth((u-.12)/.88))
    obj.scale=(size,)*3
    if size==0:
     # Canonical hidden transforms prevent unnecessary interpolation of helpers.
     for path in ('location','rotation_euler','scale'):
      vals=[base.fcurves.find(path,index=i).evaluate(1) for i in range(3)]
      setattr(obj,path,vals)
    for path in ('location','rotation_euler','scale'):obj.keyframe_insert(path,frame=frame)
   linear(action)


def _face(clip,frames):
 guide=DUAL_GUIDE[clip]
 for owner in FACE_OBJECTS:
  keys=bpy.data.objects[owner].data.shape_keys;action=support.action_for(clip,owner)
  for curve in list(action.fcurves):action.fcurves.remove(curve)
  rows=[]
  for f in range(1,frames+1):
   values={key.name:0. for key in list(keys.key_blocks)[1:]}
   blink=max(0,1-abs(f-(53 if guide['loop'] else 252 if clip=='ReadyToBothPanels' else 65))/3)
   if owner.startswith('Eye'):
    values.update(Blink=blink)
    if clip=='ReadyToBothPanels':
     values.update(GazeRight=.48*_ramp(f,10,25)*(1-_ramp(f,101,115)),GazeLeft=.48*_ramp(f,127,145)*(1-_ramp(f,220,238)))
     values['Focus']=.24*(_ramp(f,49,56)*(1-_ramp(f,90,99))+_ramp(f,168,175)*(1-_ramp(f,208,218)))
    elif guide.get('dismiss'):
     if guide['dismiss']==['left']:values['GazeLeft']=.45*_ramp(f,3,17)*(1-_ramp(f,34,60))
     if guide['dismiss']==['right']:values['GazeRight']=.45*_ramp(f,3,17)*(1-_ramp(f,34,60))
   else:values['SoftSmile']=.23
   rows.append(values)
  for key in list(keys.key_blocks)[1:]:
   curve=action.fcurves.new(key.path_from_id('value'));curve.keyframe_points.add(frames)
   curve.keyframe_points.foreach_set('co',[v for f,row in enumerate(rows,1) for v in (f,row[key.name])])
  linear(action)
 conform_expression(clip)


def _match_boundaries(clip):
 guide=DUAL_GUIDE[clip]
 for frame,source in [(1,guide['source_activity']),(guide['frames'],guide['target_activity'])]:
  if source==clip:continue
  for owner,_ in support.owners():
   action=support.action_for(clip,owner);reference=support.action_for(source,owner)
   for curve in action.fcurves:
    old=reference.fcurves.find(curve.data_path,index=curve.array_index)
    if old:
     point=curve.keyframe_points[0 if frame==1 else -1];point.co.y=old.evaluate(1)


def build_dual_screens(rig):
 context=_context(rig);ready=_sample(rig,'ReadyIdle',1);seated=_seated(rig,context)
 old_inner=panel.PANEL_LEFT;panel.PANEL_LEFT=INNER
 try:
  pull_start=panel._pull_pose(rig,58,context);pull_end=panel._pull_pose(rig,139,context)
  left_start=_reflect(rig,pull_start);left_end=_reflect(rig,pull_end)
  order=['BothPanelsIdle','SeatedLeftPanelIdle','SeatedRightPanelIdle']+[c for c in DUAL_GUIDE if not DUAL_GUIDE[c]['loop']]
  for clip in order:
   guide=DUAL_GUIDE[clip];frames=guide['frames'];action=_new_action(clip,guide)
   for f in range(1,frames+1):
    if guide['loop']:pose=_seated(rig,context,phase=2*pi*(f-1)/(frames-1))
    elif clip=='ReadyToBothPanels':
     if f<=34:
      run=_run(rig,0,3.55,f,34,context);pose=_blend(ready,run,_ramp(f,1,9))
     elif f<=48:pose=_blend(_run(rig,0,3.55,34,34,context),pull_start,_ramp(f,34,48))
     elif f<=99:pose=panel._pull_pose(rig,58+(f-49)*81/50,context)
     elif f<=112:
      run=_run(rig,INNER-.90,-3.55,1,41,context)
      pose=_blend(pull_end,run,_ramp(f,99,112))
     elif f<=153:pose=_run(rig,INNER-.90,-3.55,f-112,41,context)
     elif f<=167:pose=_blend(_run(rig,INNER-.90,-3.55,41,41,context),left_start,_ramp(f,153,167))
     elif f<=218:pose=_reflect(rig,panel._pull_pose(rig,58+(f-168)*81/50,context))
     elif f<=244:pose=_stepped_blend(rig,left_end,ready,f,218,244,context)
     else:
      amount=_ramp(f,244,282)
      pose=_blend(ready,_seated(rig,context,amount),_ramp(f,244,250))
    else:
     weight=_ramp(f,3,25)*(1-_ramp(f,34,65))
     pose=_tap(rig,context,seated,guide.get('dismiss',[]),weight)
     if guide['target_activity']=='ReadyIdle' and f>=67:
      amount=1-_ramp(f,68,111)
      pose=_blend(_seated(rig,context,amount),ready,_ramp(f,103,120))
      if f>=112:
       # A little welcome after standing, with feet already planted.
       _apply(rig,pose);wave=sin(pi*_ramp(f,112,129))**2
       rig.pose.bones['forearm.L'].rotation_euler.x-=.24*wave
       bpy.context.view_layer.update();pose=_capture(rig)
    if f==1:pose=ready if clip=='ReadyToBothPanels' else seated
    if f==frames:pose=ready if guide['target_activity']=='ReadyIdle' else seated
    _key(rig,action,f,pose,context,exact=f in (1,frames))
   _finish(action,guide);_clone_ready(clip,frames);_panels(clip,frames);_face(clip,frames)
  for clip in order:_match_boundaries(clip)
 finally:panel.PANEL_LEFT=old_inner
 return {clip:bpy.data.actions[clip] for clip in DUAL_GUIDE}
