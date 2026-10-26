# MERLIN character — first design study

An original Blender model built from the owner's visual brief: a clean, cute robot with matte cornflower-blue surfaces, rounded head and body forms, a flush dark display, restrained cyan lighting, and a visible pool of light beneath its feet. Its matte/satin finish uses gentle diffuse shading and minimal reflections. The eyes grade from cyan-blue above to pale ice below. Two fine, muted-blue panel joins mark the rear head cap and curve around the chest. The proportions and simplified mitten hands are deliberately softer than the mechanical detail in the supplied references. This is a character asset; assistant-state behavior and application integration have not been implemented.

## Open and play

- Open **[merlin.blend](merlin.blend)** in Blender. The file contains the editable geometry, materials, a 15-bone rig, named actions, a camera, and the dark studio lighting.
- Press **Space** over the timeline to play the eight-second `Showcase`: a quiet idle, a hello wave, and a springy jump.
- Use the Dope Sheet's **Action Editor** with `MERLIN_Rig` selected to choose `Idle`, `Wave`, or `Jump`. Set the timeline end to the corresponding frame below when looping an individual action.
- Press **F12** for the portrait render. The saved scene uses Cycles and denoising. Metal GPU rendering is selected when available; choose CPU in Render Properties on other machines if needed.
- **[merlin.glb](merlin.glb)** includes the character, materials, skeleton, and three separate animation clips. The studio, camera, and lights are excluded.

| Action | Frames at 24 fps | Motion |
| --- | --- | --- |
| `Idle` | 1–96 | Gentle breath and head drift |
| `Wave` | 1–96 | Raised side wave, wrist swings, head tilt |
| `Jump` | 1–72 | Crouch, takeoff, airborne arc, soft landing |
| `Showcase` | 1–192 | Complete presentation, stored in Blender |

Every action returns to the same resting pose. The rigidly weighted shell pieces remain smooth during animation. Jump anticipation and landing compensate for the leg rotations to keep the feet at the ground plane.

## Rebuild and verify

Tested with Blender **4.0.2**. The scripts use Blender and the Python standard library; no third-party packages, add-ons, downloaded assets, or network access are required. The build script generates the display gradient texture. Run from the repository root:

```sh
blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/build_character.py

blender --background assets/merlin-character/merlin.blend --python-exit-code 1 \
  --python assets/merlin-character/scripts/verify_character.py
```

On macOS, Blender may be located at `/Applications/Blender.app/Contents/MacOS/Blender`. Append `-- --render` to the build command to render the hero PNG. Append `-- --preview` to render the 192-frame Eevee preview video. Rendered outputs are written to `assets/merlin-character/previews/`. Rebuilding replaces the generated `.blend` and `.glb`; save artistic edits separately before rebuilding.

To render the saved scene without rebuilding it:

```sh
blender --background --factory-startup assets/merlin-character/merlin.blend \
  --python assets/merlin-character/scripts/render_previews.py -- hero
```

Replace `hero` with `poses` for two stills of the wave and jump, `motion` for the eight-second video, or `all` to render every preview in one Blender session. Rendered previews are [hero](previews/merlin-hero.png), [wave](previews/merlin-wave.png), [jump](previews/merlin-jump.png), and [motion](previews/merlin-wave-jump.mp4).

The validation script checks geometry, rig bones, required actions, actual arm motion, jump height and return pose, embedded resources, glTF animation timestamps, and exclusion of the studio from the GLB. It writes [previews/validation.json](previews/validation.json).

## Materials and lighting

The eight character materials are matte cornflower-blue ceramic, a matte obsidian display, soft graphite joints, satin midnight trim, a luminous cyan smile, cyan sole lighting, the cyan-to-pale-ice eye gradient, and muted-blue panel joins. The blue shell and dark display are nonmetallic with no clear coat; broad, soft shading keeps their rounded shapes readable. A fine rear-cap join and a curved U-shaped chest join add restrained detail. The studio has a separate matte floor material.

The head is one continuous surface whose display, fine border, and ceramic regions share edges, keeping the screen flush. The eyes and smile are thin surface graphics that follow the display's curvature. The eye material uses one authored **64 × 256** gradient image, generated from linear color values encoded as sRGB, packed into the Blender file, and embedded in the GLB. The gradient feeds emission only to preserve its blue/cyan color. No textures are downloaded.

Large softboxes provide gentle lighting across the matte surfaces; the floor receives light from the emissive sole geometry and supplemental lights that follow the feet. The Cycles portrait is the reference for surface quality; the Eevee animation is a motion preview.

GLB preserves physically based material parameters and emission. Bloom, environment lighting, floor shading, and emitted-light spill require configuration in the eventual renderer. An unlit GLB viewer will not reproduce the studio render by itself. No application renderer or device performance target has been selected.

## Provenance

Created October 26, 2026 for MERLIN. Modeling, materials, the display gradient image, rigging, animation, and studio setup are authored in the accompanying Blender Python scripts. No meshes, HDRIs, textures, fonts, or animations were downloaded. Blender and its bundled glTF exporter are the production tools; they are not redistributed here.

The owner-supplied images were used as visual references and are not included in the repository. Their original sources and redistribution rights have not been established. The project's licensing decision remains open. This contribution date is factual and does not resolve the hackathon's October 26/27 building-period ambiguity documented in [HACKATHON.md](../../docs/HACKATHON.md).
