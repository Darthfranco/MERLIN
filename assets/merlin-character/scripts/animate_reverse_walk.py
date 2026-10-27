"""A true right-to-left counterpart, with mirrored entry, gait and ready return."""
import bpy
from animate_transitions import _context,_sample,_new_action,_key,_finish
from animate_left_panel import _reflect_pose
from transition_support import new_action,linear
import screen_state_support as support

REVERSE_WALK={
 'ReadyToWalkWhistleReverse':'ReadyToWalkWhistle',
 'WalkWhistleReverse':'WalkWhistle',
 'WalkWhistleReverseToReady':'WalkWhistleToReady',
}

def build_reverse_walk(rig):
 context=_context(rig);ready=_sample(rig,'ReadyIdle',1);result={}
 for name,source in REVERSE_WALK.items():
  original=bpy.data.actions[source];frames=round(original.frame_range[1])
  first='ReadyIdle' if name.startswith('ReadyTo') else 'WalkWhistleReverse'
  last='ReadyIdle' if name.endswith('ToReady') else 'WalkWhistleReverse'
  guide=dict(frames=frames,loop=False,source_activity=first,target_activity=last,
             source_frame=192 if name.endswith('ToReady') else 1,target_frame=192 if name=='WalkWhistleReverse' else 1)
  action=_new_action(name,guide)
  for f in range(1,frames+1):
   pose=_reflect_pose(rig,source,f)
   if (name.startswith('ReadyTo') and f==1) or (name.endswith('ToReady') and f==frames):pose=ready
   _key(rig,action,f,pose,context,exact=True)
  result[name]=_finish(action,guide)
  for owner,data in support.owners():
   if owner=='rig':continue
   opposite='Eye • R' if owner=='Eye • L' else 'Eye • L' if owner=='Eye • R' else owner
   src=support.action_for(source,opposite)
   target=new_action(support.base.action_name(name,owner))
   for old in src.fcurves:
    path=old.data_path
    if owner.startswith('Eye'):
     path=path.replace('GazeLeft','__RIGHT__').replace('GazeRight','GazeLeft').replace('__RIGHT__','GazeRight')
    curve=target.fcurves.new(path,index=old.array_index);curve.keyframe_points.add(len(old.keyframe_points))
    curve.keyframe_points.foreach_set('co',[v for point in old.keyframe_points for v in (point.co.x,point.co.y)])
   linear(target)
 return result
