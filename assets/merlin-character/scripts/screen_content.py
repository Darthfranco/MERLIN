"""Replace MERLIN's real screen textures from Blender-authored pixels or images.

Runtime contract: object/material ``merlin_screen_id`` is ``right``, ``left`` or
``camera``; authored Blender UV0 uses a bottom-left origin. The glTF exporter
flips V to its standard top-left convention. Texture node
``MERLIN Screen Content`` is exported as the front material's emissive
image. Browser canvas textures should use the glTF UV convention (flipY=false).
These helpers author content only; they never access a camera or private file
unless its local image path is explicitly supplied by the caller.
"""
from array import array
import math
from pathlib import Path

import bpy

TEXTURE_NODE = 'MERLIN Screen Content'
PANEL_SIZE = (4.75, 5.70)
SCREEN_IDS = ('right', 'left', 'camera')


def _id(screen_id):
    if screen_id not in SCREEN_IDS:
        raise ValueError('Unknown MERLIN screen: '+str(screen_id))
    return screen_id


def screen_materials(screen_id):
    """Find every material sharing the explicit stable content ID."""
    screen_id=_id(screen_id)
    return [m for m in bpy.data.materials if m.get('merlin_screen_id')==screen_id
            or m.name=='MERLIN_Screen_'+screen_id]


def _assign(screen_id,image):
    materials=screen_materials(screen_id)
    if not materials:
        raise ValueError('Build the '+screen_id+' screen before assigning content.')
    if image.colorspace_settings.name!='sRGB':image.colorspace_settings.name='sRGB'
    for material in materials:
        node=material.node_tree.nodes.get(TEXTURE_NODE) if material.use_nodes else None
        if node is None:raise ValueError('Screen material has no '+TEXTURE_NODE+' node: '+material.name)
        node.image=image
        material['merlin_screen_id']=screen_id
    return image


def set_screen_image(screen_id,path,pack=True):
    """Use an explicitly supplied local image, packed by default for GLB export."""
    screen_id=_id(screen_id)
    resolved=Path(path).expanduser().resolve()
    if not resolved.is_file():raise FileNotFoundError(str(resolved))
    image=bpy.data.images.load(str(resolved),check_existing=True)
    _assign(screen_id,image)
    if pack:image.pack()
    return image


def set_screen_pixels(screen_id,width,height,rgba,pack=True):
    """Set flat 0..1 sRGB RGBA pixels, rows ordered bottom to top.

    A browser canvas may render arbitrary text, charts, media or interactive UI
    into the same image slot. This Blender helper is the baked-asset equivalent.
    ``rgba`` must contain exactly width*height*4 finite channel values.
    """
    screen_id=_id(screen_id)
    if type(width) is not int or type(height) is not int or not 1<=width<=8192 or not 1<=height<=8192:
        raise ValueError('Screen dimensions must be integers between 1 and 8192.')
    values=array('f',rgba)
    if len(values)!=width*height*4:raise ValueError('RGBA buffer length does not match screen dimensions.')
    if any(not math.isfinite(v) or not 0<=v<=1 for v in values):raise ValueError('RGBA values must be finite and within 0..1.')
    if not screen_materials(screen_id):raise ValueError('Build the '+screen_id+' screen before assigning content.')
    name='MERLIN_Screen_'+screen_id+'_Content'
    node=screen_materials(screen_id)[0].node_tree.nodes.get(TEXTURE_NODE)
    current=node.image if node else None
    image=current if current and current.get('merlin_generated_screen_id')==screen_id else None
    replaced=None
    if image is None or list(image.size)!=[width,height]:
        replaced=image
        image=bpy.data.images.new(name,width=width,height=height,alpha=True)
        image['merlin_generated_screen_id']=screen_id
    if image.colorspace_settings.name!='sRGB':image.colorspace_settings.name='sRGB'
    image.pixels.foreach_set(values)
    image.update()
    _assign(screen_id,image)
    if pack:image.pack()
    if replaced and replaced.users==0:
        bpy.data.images.remove(replaced)
        image.name=name
    return image


def _placeholder(width=400,height=480):
    """A simple synthetic white UI card, with no household data or live claims."""
    pixels=array('f')
    for row in range(height):
        v=(row+.5)/height
        for col in range(width):
            u=(col+.5)/width
            color=(.985,.99,1.,1.)
            # Quiet cornflower accent and neutral placeholder lines/cards.
            if .10<u<.20 and .82<v<.90:color=(.22,.61,.91,1.)
            elif .25<u<.74 and .86<v<.88:color=(.17,.24,.34,1.)
            elif .25<u<.58 and .82<v<.835:color=(.67,.73,.80,1.)
            elif .10<u<.90 and .51<v<.72:color=(.93,.955,.98,1.)
            elif .10<u<.90 and .23<v<.44:color=(.945,.965,.985,1.)
            elif .10<u<.61 and .13<v<.15:color=(.70,.76,.83,1.)
            pixels.extend(color)
    return pixels


def ensure_screen_material(screen_id,placeholder=True):
    """Create a glTF-compatible front texture material without changing edges."""
    screen_id=_id(screen_id)
    material=bpy.data.materials.get('MERLIN_Screen_'+screen_id)
    if material is None:material=bpy.data.materials.new('MERLIN_Screen_'+screen_id)
    material.use_nodes=True
    material['merlin_screen_id']=screen_id
    material['merlin_screen_uv_origin']='top-left'
    material['merlin_blender_uv_origin']='bottom-left'
    material['merlin_screen_texture_channel']='emissive'
    shader=material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value=(0,0,0,1)
    shader.inputs['Roughness'].default_value=1.
    shader.inputs['Metallic'].default_value=0
    shader.inputs['Specular IOR Level'].default_value=0.
    shader.inputs['Emission Color'].default_value=(1,1,1,1)
    shader.inputs['Emission Strength'].default_value=1.
    texture=material.node_tree.nodes.get(TEXTURE_NODE)
    if texture is None:texture=material.node_tree.nodes.new('ShaderNodeTexImage');texture.name=TEXTURE_NODE
    texture.interpolation='Linear'
    texture.extension='EXTEND'
    # Display pixels emit their own color; room-light shadows must not obscure UI.
    for link in list(shader.inputs['Base Color'].links):material.node_tree.links.remove(link)
    material.node_tree.links.new(texture.outputs['Color'],shader.inputs['Emission Color'])
    if placeholder and texture.image is None:
        image=set_screen_pixels(screen_id,400,480,_placeholder())
        image['merlin_content_kind']='synthetic placeholder'
    return material


def configure_panel_screen(obj,screen_id):
    """Map a card/shard's front to its position in the complete panel image."""
    screen_id=_id(screen_id)
    if obj.type!='MESH':raise TypeError('A panel screen requires a mesh.')
    material=ensure_screen_material(screen_id)
    slot=next((i for i,m in enumerate(obj.data.materials) if m==material),None)
    if slot is None:obj.data.materials.append(material);slot=len(obj.data.materials)-1
    uv=obj.data.uv_layers.get('MERLIN Screen UV') or obj.data.uv_layers.new(name='MERLIN Screen UV')
    obj.data.uv_layers.active=uv
    uv.active_render=True
    center=obj.get('panel_center_local',(0.,0.))
    for polygon in obj.data.polygons:
        front=polygon.normal.z>.99
        polygon.material_index=slot if front else 0
        for loop_index in polygon.loop_indices:
            co=obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
            uv.data[loop_index].uv=((co.x+center[0])/PANEL_SIZE[0]+.5,
                                    (co.y+center[1])/PANEL_SIZE[1]+.5)
    obj['merlin_screen_id']=screen_id
    obj['merlin_screen_role']='fragment' if obj.get('panel_kind')=='fragment' else 'surface'
    obj['merlin_screen_size']=list(PANEL_SIZE)
    obj['merlin_screen_uv_origin']='top-left'
    obj['merlin_blender_uv_origin']='bottom-left'
    obj['merlin_screen_material']='MERLIN_Screen_'+screen_id
    obj['merlin_screen_front_material_index']=slot
    return material


def configure_panel_screens():
    """Make both physical cards programmable while retaining white side edges."""
    configured=[]
    for obj in bpy.data.objects:
        if obj.get('merlin_left_panel_owner'):
            configure_panel_screen(obj,'left');configured.append(obj.name)
        elif obj.get('merlin_panel_owner'):
            configure_panel_screen(obj,'right');configured.append(obj.name)
    return configured
