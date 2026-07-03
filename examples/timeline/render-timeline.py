#!/usr/bin/env python3
"""render-timeline.py — render an animated timeline with Blender (flat 2D or 3D).

Two looks, both driven by the same JSON so the data is shared:

  --mode flat   flat 2D timeline (ortho camera) — the axis draws, markers pop in.
  --mode 3d     3D timeline — glowing marker nodes on a line revealed by Geometry
                Nodes (Scene Time + a per-marker stagger attribute), a controlled
                3/4 camera with depth-of-field, volumetric fog, and raytraced floor
                reflections. A look you can't get from a 2D compositor.

An optional --bg image is composited behind the timeline. Video output is encoded
with system ffmpeg, so it also works on Blender builds compiled without FFmpeg.

INPUT JSON:
  {
    "title": "THE COLLAPSE — 1250 to 1175 BC",
    "durationSec": 5,
    "events": [
      {"date": "1250 BC", "label": "Drought begins", "axisU": 0.10, "emphasize": false},
      {"date": "1200 BC", "label": "Cities burn",    "axisU": 0.50, "emphasize": false},
      {"date": "1159 BC", "label": "Hekla 3 erupts", "axisU": 0.92, "emphasize": true}
    ]
  }
  (axisU = 0..1 position along the timeline; emphasize = highlighted "hero" marker.)

USAGE:
  python3 render-timeline.py example.json --mode 3d --out timeline.mp4
  python3 render-timeline.py example.json --mode flat --bg scene.jpg --res 1280x720

Requires Blender (default /Applications/Blender.app/..., override with --blender) + ffmpeg.
Serif is used for the title/dates and a clean sans for the labels; both resolve from
system fonts and can be overridden with --title-font / --label-font.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Fonts resolve from the system; the first that exists wins (override via CLI flags).
# Serif = title + dates, a clean sans = the small labels.
SERIF_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/System/Library/Fonts/Supplemental/Palatino.ttc",
    "/Library/Fonts/Georgia.ttf",
]
SANS_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/Library/Fonts/Arial.ttf",
]
# some display fonts lack an arrow glyph -> fall back to a word
TITLE_FIXUPS = {"→": " to ", "⟶": " to ", "->": " to "}


def sanitize_title(t):
    for bad, good in TITLE_FIXUPS.items():
        t = t.replace(bad, good)
    return " ".join(t.split())


def first_existing(paths):
    for p in paths:
        if p and Path(p).exists():
            return str(p)
    return None


def build_bpy(data):
    """Return the bpy program (a string) that builds + renders the timeline."""
    payload = json.dumps(data)
    # %r embeds the JSON as a Python string literal; the bpy re-parses it.
    return "DATA = json.loads(%r)\n" % payload + BPY_BODY


# The bpy program. Reads DATA (events/title/mode/bg/fonts/res/fps/frames_dir).
BPY_BODY = r'''
import bpy, math, os, json
from mathutils import Matrix

D = DATA
W, H = D["res"]
FPS = D["fps"]
FRAMES = D["frames"]           # total frames
mode = D["mode"]

# --- palette (chalk + gold default theme) --------------------------------------
# Chalk white = the "drawn" lines / marks / labels; gold = dates + emphasis/hero.
CHALK     = (0.961, 0.941, 0.898)   # #f5f0e5 drawn lines / markers / labels
GOLD      = (0.941, 0.816, 0.627)   # #F0D0A0 dates / title
GOLD_HI   = (1.000, 0.824, 0.498)   # #FFD27F emphasis / hero
GOLD_LT   = (1.000, 0.914, 0.761)   # #FFE9C2 light gold
CRIMSON   = (0.757, 0.188, 0.188)   # #C13030 (available; unused by default)
NAVY      = (0.039, 0.055, 0.090)   # #0a0e17 background
WHITE     = (0.95, 0.95, 0.96)
GLOW      = (1.000, 0.502, 0.188)   # #FF8030 warm glow

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = W, H
sc.render.fps = FPS
sc.frame_start, sc.frame_end = 1, FRAMES
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = os.path.join(D["frames_dir"], "frame_")

SERIF = bpy.data.fonts.load(D["serif"]) if D.get("serif") and os.path.exists(D["serif"]) else None
SANS = bpy.data.fonts.load(D["sans"]) if D.get("sans") and os.path.exists(D["sans"]) else None

def emit_mat(name, color, strength=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = (*color, 1.0)
    e.inputs["Strength"].default_value = strength
    nt.links.new(e.outputs["Emission"], out.inputs["Surface"])
    return m

def metal_mat(name, color, metallic, rough):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    return m

def quad(name, x0, y0, x1, y1, z, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)])
    me.update()
    ob = bpy.data.objects.new(name, me); ob.data.materials.append(mat)
    sc.collection.objects.link(ob); return ob

def disc(name, cx, cy, z, r, mat, segs=40):
    vs = [(cx + r * math.cos(2 * math.pi * i / segs), cy + r * math.sin(2 * math.pi * i / segs), z) for i in range(segs)]
    me = bpy.data.meshes.new(name); me.from_pydata(vs, [], [list(range(segs))]); me.update()
    ob = bpy.data.objects.new(name, me); ob.data.materials.append(mat)
    sc.collection.objects.link(ob); return ob

def cube(name, loc, size, mat):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    ob = bpy.context.active_object; ob.name = name
    ob.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    ob.data.materials.append(mat); return ob

def text(name, body, x, y, z, size, mat, font, rot=(0, 0, 0), align="CENTER"):
    cu = bpy.data.curves.new(name, type="FONT"); cu.body = body; cu.size = size
    cu.align_x = align; cu.align_y = "CENTER"
    if font: cu.font = font
    ob = bpy.data.objects.new(name, cu); ob.location = (x, y, z); ob.rotation_euler = rot
    ob.data.materials.append(mat); sc.collection.objects.link(ob); return ob

def key_strength(mat, seq):
    """Keyframe an emission material's Strength: seq = [(frame, value), ...]."""
    en = next(n for n in mat.node_tree.nodes if n.type == "EMISSION")
    s = en.inputs["Strength"]
    for f, v in seq:
        s.default_value = v; s.keyframe_insert("default_value", frame=f)

def bg_image_material(name, path, strength=0.7):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    e = nt.nodes.new("ShaderNodeEmission")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(path)
    tex.extension = "EXTEND"
    coord = nt.nodes.new("ShaderNodeTexCoord")
    # from_pydata meshes have NO UV map -> feed Generated coords or the image samples flat.
    nt.links.new(coord.outputs["Generated"], tex.inputs["Vector"])
    e.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Color"], e.inputs["Color"])
    nt.links.new(e.outputs["Emission"], out.inputs["Surface"])
    return m

events = D["events"]

# =============================== FLAT 2D ======================================
if mode == "flat":
    sc.view_settings.view_transform = "Standard"
    # camera: orthographic 16:9 canvas
    cd = bpy.data.cameras.new("Cam"); cd.type = "ORTHO"; cd.ortho_scale = 16.0
    cam = bpy.data.objects.new("Cam", cd); cam.location = (0, 0, 10)
    sc.collection.objects.link(cam); sc.camera = cam

    # background: photoreal image (clearly visible, lightly graded) OR navy gradient
    if D.get("bg") and os.path.exists(D["bg"]):
        quad("bg", -8.5, -4.8, 8.5, 4.8, -3.0, bg_image_material("bgimg", D["bg"], 0.85))
        # subtle full-frame darken (transparent scrim) so bright chalk/gold text stays legible
        scr = bpy.data.materials.new("scrim"); scr.use_nodes = True; scr.blend_method = "BLEND"
        snt = scr.node_tree; snt.nodes.clear()
        so = snt.nodes.new("ShaderNodeOutputMaterial")
        mix = snt.nodes.new("ShaderNodeMixShader"); mix.inputs["Fac"].default_value = 0.35
        tr = snt.nodes.new("ShaderNodeBsdfTransparent")
        em = snt.nodes.new("ShaderNodeEmission"); em.inputs["Color"].default_value = (0.02, 0.03, 0.06, 1); em.inputs["Strength"].default_value = 1.0
        snt.links.new(tr.outputs["BSDF"], mix.inputs[1]); snt.links.new(em.outputs["Emission"], mix.inputs[2])
        snt.links.new(mix.outputs["Shader"], so.inputs["Surface"])
        quad("scrim", -8.5, -4.8, 8.5, 4.8, -1.5, scr)
    else:
        bg = quad("bg", -8.2, -4.7, 8.2, 4.7, -2.0, bpy.data.materials.new("bg"))
        bg.data.materials[0].use_nodes = True
        nt = bg.data.materials[0].node_tree; nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission")
        ra = nt.nodes.new("ShaderNodeValToRGB"); sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        tx = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(tx.outputs["Generated"], sep.inputs["Vector"])
        nt.links.new(sep.outputs["Y"], ra.inputs["Fac"])
        nt.links.new(ra.outputs["Color"], em.inputs["Color"])
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
        cr = ra.color_ramp
        cr.elements[0].position = 0.0;  cr.elements[0].color = (*NAVY, 1)
        cr.elements[1].position = 1.0;  cr.elements[1].color = (0.07, 0.09, 0.14, 1)
        mid = cr.elements.new(0.5); mid.color = (0.015, 0.022, 0.04, 1)

    m_chalk = emit_mat("chalk", CHALK, 1.0)
    m_gold = emit_mat("gold", GOLD, 1.0)
    m_goldhi = emit_mat("goldhi", GOLD_HI, 1.0)

    if D.get("title"):
        ti = text("title", D["title"], 0, 3.45, 0.05, 0.60, m_gold, SERIF)
        ti.scale = (0, 0, 0); ti.keyframe_insert("scale", frame=1)
        ti.scale = (1, 1, 1); ti.keyframe_insert("scale", frame=9)

    # chalk-white axis draws left -> right
    axis = quad("axis", 0.0, -0.022, 12.0, 0.022, 0.0, m_chalk)
    axis.location = (-6.0, 0, 0)
    axis.scale = (0, 1, 1); axis.keyframe_insert("scale", frame=5)
    axis.scale = (1, 1, 1); axis.keyframe_insert("scale", frame=22)

    n = len(events)
    for i, ev in enumerate(events):
        u = float(ev.get("axisU", (i + 0.5) / max(n, 1)))
        x = -5.5 + u * 11.0
        emph = bool(ev.get("emphasize"))
        f0 = 22 + i * 12
        grp = bpy.data.objects.new("m%d" % i, None); grp.location = (x, 0, 0)
        sc.collection.objects.link(grp)
        dotm = m_goldhi if emph else m_chalk        # chalk marks, gold hero
        datem = m_goldhi if emph else m_gold        # gold dates
        parts = [
            disc("dot%d" % i, x, 0, 0.06, 0.15 if emph else 0.13, dotm),
            quad("con%d" % i, x - 0.02, 0.14, x + 0.02, 0.92, 0.04, dotm),
            text("dat%d" % i, ev.get("date", ""), x, -0.66, 0.06, 0.60 if emph else 0.50, datem, SERIF),
            text("lab%d" % i, ev.get("label", ""), x, 1.12, 0.06, 0.34, m_chalk, SANS),
        ]
        for p in parts:
            p.parent = grp; p.matrix_parent_inverse = Matrix.Translation((-x, 0, 0))
        grp.scale = (0, 0, 0); grp.keyframe_insert("scale", frame=f0)
        grp.scale = (1.1, 1.1, 1.1); grp.keyframe_insert("scale", frame=f0 + 8)
        grp.scale = (1, 1, 1); grp.keyframe_insert("scale", frame=f0 + 14)

# ============= 3D (Geometry-Nodes staggered reveal, controlled camera) =========
# The 2026-standard pattern: ONE normalized progress (Scene Time -> Map Range) drives a
# per-marker staggered reveal keyed off a baked `t0` attribute; markers are glowing NODES
# on a horizontal line (no vertical bars to occlude text); a controlled 3/4 camera keeps
# the whole timeline framed so every label stays readable.
else:
    sc.view_settings.view_transform = "AgX"
    for prop, val in [("taa_render_samples", 32), ("volumetric_start", 0.1),
                      ("volumetric_end", 60.0), ("volumetric_samples", 40), ("use_raytracing", True)]:
        try: setattr(sc.eevee, prop, val)
        except Exception: pass

    n = len(events)
    def u_of(i, ev): return float(ev.get("axisU", (i + 0.5) / max(n, 1)))
    # reversed so older dates sit on the render-LEFT (camera views from +Y, which mirrors X)
    def x_of(u): return 6.0 - u * 12.0
    RSTART, REND, SPREAD, WIN = 8, max(24, int(FRAMES * 0.55)), 0.62, 0.30
    def t0_of(i): return (i / max(n - 1, 1)) * SPREAD
    def frames_of(i):
        f_in = RSTART + t0_of(i) * (REND - RSTART)
        return int(round(f_in)), int(round(f_in + WIN * (REND - RSTART)))

    # floor for raytraced reflections of the glowing nodes/text
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, -2.4))
    fl = bpy.context.active_object; fl.name = "floor"; fl.scale = (60, 40, 1)
    fl.data.materials.append(metal_mat("floor", (0.012, 0.016, 0.024), 0.6, 0.16))

    # chalk axis line: dimensions baked into the MESH (origin at the left end) so the
    # scale-X draw animates without reverting to a raw cube.
    t = 0.03
    ax_me = bpy.data.meshes.new("axis")
    ax_me.from_pydata(
        [(0, -t, -t), (12, -t, -t), (12, t, -t), (0, t, -t),
         (0, -t, t), (12, -t, t), (12, t, t), (0, t, t)], [],
        [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 3, 7, 4)])
    ax_me.update()
    axis = bpy.data.objects.new("axis", ax_me); axis.location = (-6.0, 0, 0)
    axis.data.materials.append(emit_mat("axis", CHALK, 2.2))
    sc.collection.objects.link(axis)
    axis.scale = (0, 1, 1); axis.keyframe_insert("scale", frame=RSTART)
    axis.scale = (1, 1, 1); axis.keyframe_insert("scale", frame=REND)

    # --- Geometry Nodes: staggered reveal of the NON-hero marker nodes ---
    norm = [(i, ev) for i, ev in enumerate(events) if not ev.get("emphasize")]
    if norm:
        me = bpy.data.meshes.new("mk_pts")
        me.from_pydata([(x_of(u_of(i, ev)), 0, 0.20) for i, ev in norm], [], [])
        at = me.attributes.new("t0", "FLOAT", "POINT")
        for j, (i, ev) in enumerate(norm):
            at.data[j].value = t0_of(i)
        mk = bpy.data.objects.new("markers", me); sc.collection.objects.link(mk)
        gn = bpy.data.node_groups.new("MarkerReveal", "GeometryNodeTree")
        gn.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        gn.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        gi = gn.nodes.new("NodeGroupInput"); go = gn.nodes.new("NodeGroupOutput")
        st = gn.nodes.new("GeometryNodeInputSceneTime")
        prog = gn.nodes.new("ShaderNodeMapRange")
        prog.inputs["From Min"].default_value = RSTART; prog.inputs["From Max"].default_value = REND
        na = gn.nodes.new("GeometryNodeInputNamedAttribute"); na.data_type = "FLOAT"
        na.inputs["Name"].default_value = "t0"
        addw = gn.nodes.new("ShaderNodeMath"); addw.operation = "ADD"; addw.inputs[1].default_value = WIN
        rev = gn.nodes.new("ShaderNodeMapRange"); rev.interpolation_type = "SMOOTHERSTEP"
        sph = gn.nodes.new("GeometryNodeMeshUVSphere"); sph.inputs["Radius"].default_value = 0.16
        setm = gn.nodes.new("GeometryNodeSetMaterial"); setm.inputs["Material"].default_value = emit_mat("mk_chalk", CHALK, 2.4)
        iop = gn.nodes.new("GeometryNodeInstanceOnPoints"); scl = gn.nodes.new("GeometryNodeScaleInstances")
        Lg = gn.links.new
        Lg(st.outputs["Frame"], prog.inputs["Value"])
        Lg(na.outputs["Attribute"], rev.inputs["From Min"])
        Lg(na.outputs["Attribute"], addw.inputs[0]); Lg(addw.outputs["Value"], rev.inputs["From Max"])
        Lg(prog.outputs["Result"], rev.inputs["Value"])
        Lg(sph.outputs["Mesh"], setm.inputs["Geometry"])
        Lg(gi.outputs[0], iop.inputs["Points"]); Lg(setm.outputs["Geometry"], iop.inputs["Instance"])
        Lg(iop.outputs["Instances"], scl.inputs["Instances"]); Lg(rev.outputs["Result"], scl.inputs["Scale"])
        Lg(scl.outputs["Instances"], go.inputs[0])
        mk.modifiers.new("gn", "NODES").node_group = gn

    # --- per-event: hero node (native, gold) + native text above every node ---
    for i, ev in enumerate(events):
        x = x_of(u_of(i, ev)); emph = bool(ev.get("emphasize"))
        f_in, f_full = frames_of(i)
        if emph:  # hero node = gold sphere + gold ring, revealed at its stagger slot
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.24, location=(x, 0, 0.22))
            hs = bpy.context.active_object; hs.name = "hero"
            hs.data.materials.append(emit_mat("hero", GOLD_HI, 5.0))
            bpy.ops.mesh.primitive_torus_add(location=(x, 0, 0.05), major_radius=0.62, minor_radius=0.045)
            hr = bpy.context.active_object; hr.name = "hero_ring"; hr.rotation_euler = (math.radians(90), 0, 0)
            hr.data.materials.append(emit_mat("hero_r", GOLD_HI, 2.6))
            for o in (hs, hr):
                o.scale = (0, 0, 0); o.keyframe_insert("scale", frame=f_in)
                o.scale = (1.12, 1.12, 1.12); o.keyframe_insert("scale", frame=(f_in + f_full) // 2)
                o.scale = (1, 1, 1); o.keyframe_insert("scale", frame=f_full)
        # text ABOVE the node (nothing occludes it); stays lit — the framing camera keeps all readable
        dm = emit_mat("dt%d" % i, GOLD_HI if emph else GOLD, 0.0)
        lm = emit_mat("lb%d" % i, CHALK, 0.0)
        dsz = 1.05 if emph else 0.82
        dnum = text("date%d" % i, ev.get("date", ""), x, 0, 1.62, dsz, dm, SERIF, rot=(math.radians(90), 0, math.radians(180)))
        dlab = text("lab%d" % i, ev.get("label", ""), x, 0, 0.98, 0.40, lm, SANS, rot=(math.radians(90), 0, math.radians(180)))
        for t in (dnum, dlab):
            t.scale = (0, 0, 0); t.keyframe_insert("scale", frame=f_in)
            t.scale = (1, 1, 1); t.keyframe_insert("scale", frame=f_full)
        key_strength(dm, [(f_in, 0.0), (f_full, 7.5 if emph else 6.5), (FRAMES, 7.5 if emph else 6.5)])
        key_strength(lm, [(f_in, 0.0), (f_full, 3.0), (FRAMES, 3.0)])

    # photoreal backdrop behind the line (DOF-soft), or navy fallback
    if D.get("bg") and os.path.exists(D["bg"]):
        bpy.ops.mesh.primitive_plane_add(size=1, location=(0, -7.0, 2.2))
        bd = bpy.context.active_object; bd.name = "backdrop"
        bd.rotation_euler = (math.radians(90), 0, 0); bd.scale = (26, 15, 1)
        bd.data.materials.append(bg_image_material("bgimg", D["bg"], 0.85))
        fog_density, fog_col = 0.018, (0.10, 0.16, 0.30)
    else:
        fog_density, fog_col = 0.045, (0.10, 0.20, 0.38)

    # world: navy + cool volumetric fog (matches #0a0e17; complementary to warm gold)
    world = bpy.data.worlds.new("W"); sc.world = world; world.use_nodes = True
    wnt = world.node_tree; wnt.nodes.clear()
    wout = wnt.nodes.new("ShaderNodeOutputWorld")
    wbg = wnt.nodes.new("ShaderNodeBackground"); wbg.inputs["Color"].default_value = (0.006, 0.010, 0.020, 1.0)
    wvol = wnt.nodes.new("ShaderNodeVolumeScatter")
    wvol.inputs["Color"].default_value = (*fog_col, 1.0)
    wvol.inputs["Density"].default_value = fog_density
    wvol.inputs["Anisotropy"].default_value = 0.5
    wnt.links.new(wbg.outputs["Background"], wout.inputs["Surface"])
    wnt.links.new(wvol.outputs["Volume"], wout.inputs["Volume"])

    bpy.ops.object.light_add(type="AREA", location=(6, 6, 12))
    k = bpy.context.active_object; k.data.energy = 700; k.data.color = (0.5, 0.65, 1.0); k.data.size = 12
    bpy.ops.object.light_add(type="AREA", location=(-6, 4, 6))
    rl = bpy.context.active_object; rl.data.energy = 500; rl.data.color = (1.0, 0.68, 0.34); rl.data.size = 6

    # controlled camera: 3/4 front view that frames the WHOLE line, gentle push + DOF
    target = bpy.data.objects.new("target", None); target.location = (0, 0, 0.9)
    sc.collection.objects.link(target)
    cd = bpy.data.cameras.new("Cam"); cd.lens = 34
    cd.dof.use_dof = True; cd.dof.focus_object = target; cd.dof.aperture_fstop = 3.5
    cam = bpy.data.objects.new("Cam", cd); cam.location = (2.6, 14.0, 4.2)
    sc.collection.objects.link(cam); sc.camera = cam
    con = cam.constraints.new("TRACK_TO"); con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"; con.up_axis = "UP_Y"
    cam.location = (2.6, 14.0, 4.2); cam.keyframe_insert("location", frame=1)
    cam.location = (1.4, 10.6, 3.7); cam.keyframe_insert("location", frame=FRAMES)

bpy.ops.render.render(animation=True)
'''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("timeline", help="TimelineData JSON (events/title)")
    ap.add_argument("--mode", choices=["flat", "3d"], default="3d")
    ap.add_argument("--bg", default=None, help="optional photoreal background image")
    ap.add_argument("--out", default=None, help="output .mp4 (default: <timeline>-<mode>.mp4)")
    ap.add_argument("--res", default="1280x720", help="WxH (default 1280x720)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--title-font", default=None, help="serif font for title/dates (default: a system serif)")
    ap.add_argument("--label-font", default=None, help="sans font for labels (default: a system sans)")
    ap.add_argument("--blender", default="/Applications/Blender.app/Contents/MacOS/Blender")
    args = ap.parse_args()

    tl_path = Path(args.timeline).resolve()
    data = json.loads(tl_path.read_text())
    data["title"] = sanitize_title(data.get("title", ""))
    data["mode"] = args.mode
    data["bg"] = str(Path(args.bg).resolve()) if args.bg else None
    data["serif"] = args.title_font or first_existing(SERIF_CANDIDATES)
    data["sans"] = args.label_font or first_existing(SANS_CANDIDATES)
    w, h = (int(x) for x in args.res.lower().split("x"))
    data["res"] = [w, h]
    data["fps"] = args.fps
    dur = float(data.get("durationSec", 5))
    data["frames"] = max(1, int(round(dur * args.fps)))

    out = Path(args.out).resolve() if args.out else tl_path.with_name("%s-%s.mp4" % (tl_path.stem, args.mode))
    out.parent.mkdir(parents=True, exist_ok=True)
    frames_dir = tempfile.mkdtemp(prefix="btl-frames-")
    data["frames_dir"] = frames_dir

    bpy_path = Path(frames_dir) / "_build.py"
    bpy_path.write_text("import json\n" + build_bpy(data))

    print("[timeline] mode=%s res=%dx%d frames=%d -> %s" % (args.mode, w, h, data["frames"], out.name))
    r = subprocess.run([args.blender, "--background", "--python", str(bpy_path), "--python-exit-code", "1"],
                       capture_output=True, text=True)
    n_png = len(list(Path(frames_dir).glob("frame_*.png")))
    if n_png == 0:
        sys.stderr.write("Blender produced no frames.\n" + (r.stderr or "")[-1500:] + "\n")
        shutil.rmtree(frames_dir, ignore_errors=True)
        sys.exit(1)

    enc = subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(args.fps),
        "-pattern_type", "glob", "-i", os.path.join(frames_dir, "frame_*.png"),
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out),
    ], capture_output=True, text=True)
    shutil.rmtree(frames_dir, ignore_errors=True)
    if enc.returncode != 0:
        sys.stderr.write("ffmpeg encode failed:\n" + (enc.stderr or "")[-1000:] + "\n")
        sys.exit(1)
    print(json.dumps({"ok": True, "mode": args.mode, "frames": data["frames"], "out": str(out)}))


if __name__ == "__main__":
    main()
