#!/usr/bin/env python3
"""Build WorldClaw's deterministic, static Blender-to-glTF asset library.

Run with Blender, not the system Python:

  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --factory-startup --python scripts/blender/build-worldclaw-kit.py

All authoring is Z-up and measured in meters. The glTF exporter performs the
single Z-up to Y-up conversion expected by Three.js.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import struct
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence

import bpy
from mathutils import Vector


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO_ROOT / "assets/worldclaw/asset-library.json"
DEFAULT_OUTPUT = REPO_ROOT / "public/worldclaw/assets/worldclaw-kit.glb"
DEFAULT_REPORT = REPO_ROOT / "public/worldclaw/assets/worldclaw-kit.report.json"
DEFAULT_PUBLIC_MANIFEST = REPO_ROOT / "public/worldclaw/assets/asset-library.json"
ASSET_KEYS = (
    "palm",
    "tree",
    "pine",
    "rock",
    "cactus",
    "hut",
    "building",
    "watchtower",
    "ship",
    "tank",
    "pagoda",
    "torii",
    "bridge",
    "dragon",
    "windmill",
    "mine",
    "crystal",
    "antenna",
    "satellite",
    "dock",
    "tent",
    "well",
    "statue",
    "fence",
    "campfire",
    "crate",
    "market",
)
DETERMINISTIC_SEED = 20260811
MIN_EXPORT_BEVEL_METERS = 0.014
COMPACTION_VERSION = 1
COMPACTION_POLICY = "prototype_variant_material_v1"
MAX_COMPACT_NODES = 260
MAX_COMPACT_MESHES = 220
MAX_COMPACT_BYTES = 2_000_000


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--public-manifest", type=Path, default=DEFAULT_PUBLIC_MANIFEST)
    parser.add_argument("--detailed-output", type=Path)
    return parser.parse_args(argv)


def absolute(path: Path) -> Path:
    return path if path.is_absolute() else REPO_ROOT / path


def set_input(node: bpy.types.Node, name: str, value: Any) -> None:
    for socket in node.inputs:
        if socket.name == name:
            socket.default_value = value
            return
    raise RuntimeError(f"Principled BSDF input {name!r} is unavailable in Blender {bpy.app.version_string}")


def material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float,
    *,
    metallic: float = 0.0,
    double_sided: bool = False,
) -> bpy.types.Material:
    if not name.startswith("MAT-"):
        raise ValueError(f"Material name must start with MAT-: {name}")
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = color
    mat.use_backface_culling = not double_sided
    nodes = mat.node_tree.nodes
    for node in list(nodes):
        if node.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nodes.remove(node)
    bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    set_input(bsdf, "Base Color", color)
    set_input(bsdf, "Metallic", metallic)
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "IOR", 1.46)
    return mat


def build_materials() -> dict[str, bpy.types.Material]:
    # Layered but deliberately texture-free: every material is portable
    # Principled PBR and exports as a compact glTF factor set.
    return {
        "wood": material("MAT-wood_warm", (0.34, 0.14, 0.055, 1), 0.72),
        "wood_light": material("MAT-wood_sunlit", (0.58, 0.29, 0.095, 1), 0.67),
        "wood_dark": material("MAT-wood_dark_trim", (0.12, 0.045, 0.018, 1), 0.8),
        "leaf_palm": material("MAT-foliage_palm", (0.045, 0.42, 0.12, 1), 0.76, double_sided=True),
        "leaf_light": material("MAT-foliage_sunlit", (0.18, 0.62, 0.09, 1), 0.72, double_sided=True),
        "leaf_dark": material("MAT-foliage_shadow", (0.02, 0.20, 0.07, 1), 0.84, double_sided=True),
        "pine": material("MAT-foliage_pine", (0.025, 0.25, 0.12, 1), 0.83),
        "bamboo_culm": material("MAT-bamboo_culm_green", (0.22, 0.49, 0.095, 1), 0.72),
        "bamboo_leaf": material("MAT-bamboo_leaf_green", (0.035, 0.27, 0.055, 1), 0.82, double_sided=True),
        "cherry_bark": material("MAT-bark_cherry_mahogany", (0.245, 0.075, 0.052, 1), 0.83),
        "blossom_pale": material("MAT-blossom_cherry_pale", (0.93, 0.57, 0.66, 1), 0.79, double_sided=True),
        "blossom_pink": material("MAT-blossom_cherry_pink", (0.69, 0.22, 0.36, 1), 0.83, double_sided=True),
        "stone": material("MAT-stone_granite", (0.34, 0.35, 0.34, 1), 0.88),
        "stone_dark": material("MAT-stone_shadow", (0.16, 0.18, 0.18, 1), 0.91),
        "cactus": material("MAT-cactus_green", (0.075, 0.43, 0.19, 1), 0.77),
        "cactus_dark": material("MAT-cactus_rib", (0.025, 0.21, 0.09, 1), 0.86),
        "plaster": material("MAT-plaster_sand", (0.67, 0.49, 0.29, 1), 0.84),
        "plaster_white": material("MAT-plaster_lime_white", (0.79, 0.76, 0.66, 1), 0.89),
        "thatch": material("MAT-thatch_gold", (0.56, 0.31, 0.075, 1), 0.9),
        "thatch_dark": material("MAT-thatch_weathered_ridge", (0.31, 0.17, 0.045, 1), 0.94),
        "brick": material("MAT-brick_fired_red", (0.46, 0.115, 0.052, 1), 0.86),
        "brick_dark": material("MAT-brick_weathered", (0.25, 0.055, 0.027, 1), 0.91),
        "mortar": material("MAT-mortar_lime", (0.58, 0.54, 0.45, 1), 0.93),
        "slate": material("MAT-slate_blue_gray", (0.105, 0.145, 0.17, 1), 0.82),
        "slate_edge": material("MAT-slate_cleft_edge", (0.045, 0.065, 0.078, 1), 0.9),
        "tile": material("MAT-tile_charcoal", (0.055, 0.07, 0.075, 1), 0.84),
        "tile_edge": material("MAT-tile_charcoal_edge", (0.02, 0.028, 0.032, 1), 0.91),
        "limestone": material("MAT-stone_limestone_trim", (0.56, 0.49, 0.36, 1), 0.9),
        "concrete": material("MAT-concrete_warm", (0.46, 0.47, 0.43, 1), 0.81),
        "concrete_dark": material("MAT-concrete_dark_trim", (0.16, 0.18, 0.18, 1), 0.79),
        "glass": material("MAT-glass_blue", (0.035, 0.25, 0.38, 1), 0.2),
        "metal": material("MAT-metal_gunmetal", (0.32, 0.34, 0.33, 1), 0.38, metallic=1.0),
        "metal_dark": material("MAT-metal_track", (0.075, 0.085, 0.08, 1), 0.54, metallic=1.0),
        "paint_green": material("MAT-paint_olive", (0.18, 0.27, 0.12, 1), 0.44),
        "rust": material("MAT-rust_oxide", (0.43, 0.16, 0.055, 1), 0.83),
        "canvas": material("MAT-canvas_sail", (0.76, 0.68, 0.49, 1), 0.87, double_sided=True),
        "hull": material("MAT-hull_oxide_red", (0.36, 0.055, 0.035, 1), 0.57),
        "accent": material("MAT-metal_brass", (0.64, 0.39, 0.08, 1), 0.32, metallic=1.0),
        "vermilion": material("MAT-paint_vermilion", (0.62, 0.045, 0.018, 1), 0.58),
        "vermilion_dark": material("MAT-paint_vermilion_shadow", (0.28, 0.014, 0.008, 1), 0.7),
        "dragon_scale": material("MAT-dragon_scale_umber", (0.19, 0.055, 0.022, 1), 0.63),
        "dragon_belly": material("MAT-dragon_belly_ochre", (0.53, 0.22, 0.045, 1), 0.72),
        "dragon_membrane": material("MAT-dragon_wing_membrane", (0.43, 0.075, 0.045, 1), 0.78, double_sided=True),
        "crystal_cyan": material("MAT-crystal_cyan", (0.035, 0.52, 0.72, 1), 0.18, metallic=0.15),
        "crystal_violet": material("MAT-crystal_violet", (0.38, 0.08, 0.72, 1), 0.2, metallic=0.12),
        "crystal_core": material("MAT-crystal_pale_core", (0.47, 0.86, 0.9, 1), 0.12, metallic=0.08),
        "tech_red": material("MAT-tech_signal_red", (0.66, 0.035, 0.02, 1), 0.35, metallic=0.45),
        "tech_white": material("MAT-tech_ceramic_white", (0.67, 0.72, 0.72, 1), 0.42, metallic=0.18),
        "tech_cyan": material("MAT-tech_cyan_accent", (0.025, 0.58, 0.72, 1), 0.22, metallic=0.38),
        "canvas_red": material("MAT-canvas_red", (0.48, 0.055, 0.035, 1), 0.9, double_sided=True),
        "earth": material("MAT-earth_turf", (0.19, 0.28, 0.075, 1), 0.94),
        "earth_dark": material("MAT-earth_shadow", (0.09, 0.075, 0.035, 1), 0.97),
        "obsidian": material("MAT-obsidian", (0.025, 0.018, 0.032, 1), 0.25, metallic=0.18),
        "lava": material("MAT-lava_orange", (0.9, 0.12, 0.012, 1), 0.29, metallic=0.05),
    }


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def finish_mesh(
    obj: bpy.types.Object,
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    bevel: float = 0.0,
    smooth_all: bool = False,
    smooth_sides: bool = False,
) -> bpy.types.Object:
    if not name.startswith("GEO-"):
        raise ValueError(f"Mesh object name must start with GEO-: {name}")
    obj.name = name
    obj.data.name = f"{name}-mesh"
    if smooth_all:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    elif smooth_sides:
        # Cylindrical primitives are created along local Z. Keep their caps
        # planar while smoothing the low-poly side silhouette.
        for polygon in obj.data.polygons:
            polygon.use_smooth = abs(polygon.normal.z) < 0.5
    activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bevel >= MIN_EXPORT_BEVEL_METERS:
        modifier = obj.modifiers.new("BEVEL-export", "BEVEL")
        modifier.width = bevel
        # One deliberate chamfer segment keeps the silhouettes readable while
        # leaving triangle budget for joinery, courses, and opening depth.
        modifier.segments = 1
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(55)
        if hasattr(modifier, "harden_normals"):
            modifier.harden_normals = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.parent = root
    obj["assetKey"] = root.get("assetKey", root.name.removeprefix("ASSET_"))
    return obj


def add_box(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    location: Sequence[float],
    dimensions: Sequence[float],
    *,
    rotation: Sequence[float] = (0.0, 0.0, 0.0),
    bevel: float = 0.04,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.dimensions = dimensions
    return finish_mesh(obj, name, root, mat, bevel=bevel)


def add_beam(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    start: Sequence[float],
    end: Sequence[float],
    thickness: float,
    *,
    bevel: float = 0.025,
) -> bpy.types.Object:
    p0, p1 = Vector(start), Vector(end)
    delta = p1 - p0
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(p0 + p1) / 2)
    obj = bpy.context.active_object
    obj.dimensions = (thickness, thickness, delta.length)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    return finish_mesh(obj, name, root, mat, bevel=bevel)


def add_tapered(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    start: Sequence[float],
    end: Sequence[float],
    radius_start: float,
    radius_end: float,
    *,
    vertices: int = 8,
    bevel: float = 0.0,
) -> bpy.types.Object:
    p0, p1 = Vector(start), Vector(end)
    delta = p1 - p0
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_start,
        radius2=radius_end,
        depth=delta.length,
        end_fill_type="NGON",
        location=(p0 + p1) / 2,
    )
    obj = bpy.context.active_object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    return finish_mesh(obj, name, root, mat, bevel=bevel, smooth_sides=True)


def add_ico(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    location: Sequence[float],
    dimensions: Sequence[float],
    *,
    subdivisions: int = 1,
    smooth: bool = False,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.active_object
    obj.dimensions = dimensions
    return finish_mesh(obj, name, root, mat, smooth_all=smooth)


def add_mesh(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    vertices: Iterable[Sequence[float]],
    faces: Iterable[Sequence[int]],
    *,
    smooth: bool = False,
    bevel: float = 0.0,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}-mesh")
    mesh.from_pydata(list(vertices), [], list(faces))
    mesh.validate(verbose=False)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish_mesh(obj, name, root, mat, bevel=bevel, smooth_all=smooth)


def add_cylinder(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    location: Sequence[float],
    radius: float,
    depth: float,
    *,
    vertices: int = 10,
    rotation: Sequence[float] = (0.0, 0.0, 0.0),
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        end_fill_type="NGON",
        location=location,
        rotation=rotation,
    )
    return finish_mesh(bpy.context.active_object, name, root, mat, bevel=bevel, smooth_sides=True)


def add_prism(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    points: Sequence[Sequence[float]],
    depth: float,
    *,
    axis: str = "y",
    bevel: float = 0.0,
) -> bpy.types.Object:
    """Extrude a closed 2D polygon along X or Y with deterministic face order."""
    half = depth / 2
    if axis == "y":
        vertices = [(x, -half, z) for x, z in points] + [(x, half, z) for x, z in points]
    elif axis == "x":
        vertices = [(-half, y, z) for y, z in points] + [(half, y, z) for y, z in points]
    else:
        raise ValueError(f"Unsupported prism axis {axis!r}")
    count = len(points)
    faces: list[tuple[int, ...]] = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return add_mesh(name, root, mat, vertices, faces, bevel=bevel)


def add_ring_segments(
    prefix: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    center: Sequence[float],
    radius: float,
    tube: float,
    *,
    segments: int = 12,
    plane: str = "xz",
) -> None:
    """Build an inexpensive structural ring from overlapping tapered members."""
    origin = Vector(center)
    for index in range(segments):
        a0 = math.tau * index / segments
        a1 = math.tau * (index + 1) / segments
        if plane == "xz":
            p0 = origin + Vector((math.cos(a0) * radius, 0, math.sin(a0) * radius))
            p1 = origin + Vector((math.cos(a1) * radius, 0, math.sin(a1) * radius))
        elif plane == "yz":
            p0 = origin + Vector((0, math.cos(a0) * radius, math.sin(a0) * radius))
            p1 = origin + Vector((0, math.cos(a1) * radius, math.sin(a1) * radius))
        else:
            raise ValueError(f"Unsupported ring plane {plane!r}")
        add_beam(f"{prefix}_{index:02d}", root, mat, p0, p1, tube, bevel=0.0)


def add_dish(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    center: Sequence[float],
    radius: float,
    depth: float,
    *,
    normal: Sequence[float] = (0.0, -0.9, 0.44),
    segments: int = 12,
) -> bpy.types.Object:
    """Create a shallow double-sided parabolic reflector with a readable rim."""
    origin = Vector(center)
    facing = Vector(normal).normalized()
    axis_u = Vector((1, 0, 0))
    if abs(axis_u.dot(facing)) > 0.92:
        axis_u = Vector((0, 1, 0))
    axis_u = (axis_u - facing * axis_u.dot(facing)).normalized()
    axis_v = facing.cross(axis_u).normalized()
    vertices: list[tuple[float, float, float]] = [tuple(origin)]
    for ring_radius, ring_depth in ((radius * 0.52, depth * 0.27), (radius, depth)):
        for index in range(segments):
            angle = math.tau * index / segments
            point = origin + axis_u * (math.cos(angle) * ring_radius) + axis_v * (math.sin(angle) * ring_radius) + facing * ring_depth
            vertices.append(tuple(point))
    faces: list[tuple[int, ...]] = []
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((0, 1 + index, 1 + nxt))
        faces.append((1 + index, 1 + segments + index, 1 + segments + nxt, 1 + nxt))
    faces.extend(tuple(reversed(face)) for face in tuple(faces))
    return add_mesh(name, root, mat, vertices, faces)


def add_gable_roof(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    width: float,
    depth: float,
    eave_z: float,
    ridge_z: float,
) -> bpy.types.Object:
    x, y = width / 2, depth / 2
    vertices = [
        (-x, -y, eave_z),
        (x, -y, eave_z),
        (0, -y, ridge_z),
        (-x, y, eave_z),
        (x, y, eave_z),
        (0, y, ridge_z),
    ]
    faces = [(0, 1, 2), (5, 4, 3), (0, 2, 5, 3), (2, 1, 4, 5), (0, 3, 4, 1)]
    return add_mesh(name, root, mat, vertices, faces, bevel=0.035)


def add_hip_roof_shell(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    width: float,
    depth: float,
    top_width: float,
    top_depth: float,
    eave_z: float,
    ridge_z: float,
    thickness: float,
) -> bpy.types.Object:
    """Create a closed, low-poly hipped roof shell with a flat upper curb."""
    outer = (
        (-width / 2, -depth / 2),
        (width / 2, -depth / 2),
        (width / 2, depth / 2),
        (-width / 2, depth / 2),
    )
    inner = (
        (-top_width / 2, -top_depth / 2),
        (top_width / 2, -top_depth / 2),
        (top_width / 2, top_depth / 2),
        (-top_width / 2, top_depth / 2),
    )
    vertices = [
        *((x, y, eave_z) for x, y in outer),
        *((x, y, eave_z - thickness) for x, y in outer),
        *((x, y, ridge_z) for x, y in inner),
        *((x, y, ridge_z - thickness) for x, y in inner),
    ]
    faces: list[tuple[int, ...]] = []
    for index in range(4):
        nxt = (index + 1) % 4
        faces.extend(
            (
                (index, nxt, 8 + nxt, 8 + index),
                (4 + index, 12 + index, 12 + nxt, 4 + nxt),
                (4 + index, 4 + nxt, nxt, index),
                (12 + index, 8 + index, 8 + nxt, 12 + nxt),
            )
        )
    faces.extend(((8, 9, 10, 11), (15, 14, 13, 12)))
    return add_mesh(name, root, mat, vertices, faces, bevel=0.0)


def add_hip_roof_details(
    prefix: str,
    root: bpy.types.Object,
    field_material: bpy.types.Material,
    edge_material: bpy.types.Material,
    *,
    width: float,
    depth: float,
    top_width: float,
    top_depth: float,
    eave_z: float,
    ridge_z: float,
) -> None:
    """Add bounded course bands, fascia, and lifted corner tips to a hip roof."""
    for course, t in enumerate((0.12, 0.36, 0.62)):
        half_width = (width / 2) * (1 - t) + (top_width / 2) * t
        half_depth = (depth / 2) * (1 - t) + (top_depth / 2) * t
        z = eave_z + (ridge_z - eave_z) * t + 0.055
        band = 0.115
        for side, y in (("front", -half_depth), ("rear", half_depth)):
            add_box(
                f"{prefix}_course_{course}_{side}", root,
                edge_material if course == 0 else field_material,
                (0, y, z), (half_width * 2 + 0.18, band, 0.08), bevel=0.0,
            )
        for side, x in (("west", -half_width), ("east", half_width)):
            add_box(
                f"{prefix}_course_{course}_{side}", root,
                edge_material if course == 0 else field_material,
                (x, 0, z), (band, half_depth * 2 + 0.18, 0.08), bevel=0.0,
            )
    add_box(f"{prefix}_fascia_front", root, edge_material, (0, -depth / 2, eave_z - 0.055), (width + 0.2, 0.15, 0.15), bevel=0.024)
    add_box(f"{prefix}_fascia_rear", root, edge_material, (0, depth / 2, eave_z - 0.055), (width + 0.2, 0.15, 0.15), bevel=0.024)
    add_box(f"{prefix}_fascia_west", root, edge_material, (-width / 2, 0, eave_z - 0.055), (0.15, depth + 0.2, 0.15), bevel=0.024)
    add_box(f"{prefix}_fascia_east", root, edge_material, (width / 2, 0, eave_z - 0.055), (0.15, depth + 0.2, 0.15), bevel=0.024)
    for index, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        add_beam(
            f"{prefix}_corner_tip_{index}", root, edge_material,
            (sx * width * 0.46, sy * depth * 0.46, eave_z),
            (sx * width * 0.535, sy * depth * 0.535, eave_z + 0.24),
            0.13, bevel=0.018,
        )


def add_wall_panels_y(
    prefix: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    x_min: float,
    x_max: float,
    z_min: float,
    z_max: float,
    y: float,
    thickness: float,
    openings: Sequence[Sequence[float]],
) -> None:
    """Tile a Y-facing wall around true rectangular openings."""
    bands = sorted({z_min, z_max, *(float(value) for opening in openings for value in opening[2:4])})
    panel_index = 0
    for lower, upper in zip(bands, bands[1:]):
        if upper - lower <= 1e-6:
            continue
        midpoint = (lower + upper) / 2
        blocked = sorted(
            (max(x_min, float(opening[0])), min(x_max, float(opening[1])))
            for opening in openings
            if float(opening[2]) < midpoint < float(opening[3])
        )
        cursor = x_min
        for block_min, block_max in blocked:
            if block_min > cursor + 1e-6:
                add_box(
                    f"{prefix}_panel_{panel_index:02d}", root, mat,
                    ((cursor + block_min) / 2, y, midpoint),
                    (block_min - cursor, thickness, upper - lower), bevel=0.0,
                )
                panel_index += 1
            cursor = max(cursor, block_max)
        if cursor < x_max - 1e-6:
            add_box(
                f"{prefix}_panel_{panel_index:02d}", root, mat,
                ((cursor + x_max) / 2, y, midpoint),
                (x_max - cursor, thickness, upper - lower), bevel=0.0,
            )
            panel_index += 1


def add_wall_panels_x(
    prefix: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    y_min: float,
    y_max: float,
    z_min: float,
    z_max: float,
    x: float,
    thickness: float,
    openings: Sequence[Sequence[float]],
) -> None:
    """Tile an X-facing wall around true rectangular openings."""
    bands = sorted({z_min, z_max, *(float(value) for opening in openings for value in opening[2:4])})
    panel_index = 0
    for lower, upper in zip(bands, bands[1:]):
        if upper - lower <= 1e-6:
            continue
        midpoint = (lower + upper) / 2
        blocked = sorted(
            (max(y_min, float(opening[0])), min(y_max, float(opening[1])))
            for opening in openings
            if float(opening[2]) < midpoint < float(opening[3])
        )
        cursor = y_min
        for block_min, block_max in blocked:
            if block_min > cursor + 1e-6:
                add_box(
                    f"{prefix}_panel_{panel_index:02d}", root, mat,
                    (x, (cursor + block_min) / 2, midpoint),
                    (thickness, block_min - cursor, upper - lower), bevel=0.0,
                )
                panel_index += 1
            cursor = max(cursor, block_max)
        if cursor < y_max - 1e-6:
            add_box(
                f"{prefix}_panel_{panel_index:02d}", root, mat,
                (x, (cursor + y_max) / 2, midpoint),
                (thickness, y_max - cursor, upper - lower), bevel=0.0,
            )
            panel_index += 1


def add_pitched_roof_planes(
    prefix: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    width: float,
    depth: float,
    eave_z: float,
    pitch_degrees: float,
    thickness: float,
    bevel: float = 0.025,
) -> tuple[float, float]:
    """Build two overlapping roof planes and return (ridge_z, slope_length)."""
    half_span = width / 2
    pitch = math.radians(pitch_degrees)
    rise = half_span * math.tan(pitch)
    ridge_z = eave_z + rise
    slope_length = math.hypot(half_span, rise)
    for side, sign in (("left", -1), ("right", 1)):
        add_box(
            f"{prefix}_{side}_coat",
            root,
            mat,
            (sign * half_span / 2, 0, (eave_z + ridge_z) / 2),
            (slope_length + 0.1, depth, thickness),
            rotation=(0, sign * pitch, 0),
            bevel=bevel,
        )
    return ridge_z, slope_length


def add_roof_courses(
    prefix: str,
    root: bpy.types.Object,
    mats: Sequence[bpy.types.Material],
    *,
    width: float,
    depth: float,
    eave_z: float,
    pitch_degrees: float,
    plane_thickness: float,
    course_count: int,
    course_depth: float,
    course_bevel: float | None = None,
) -> None:
    """Add visible lapped courses along each roof slope without texture maps."""
    half_span = width / 2
    pitch = math.radians(pitch_degrees)
    rise = half_span * math.tan(pitch)
    slope_length = math.hypot(half_span, rise)
    run = slope_length / course_count
    normal_lift = plane_thickness / 2 + course_depth / 2
    for side, sign in (("left", -1), ("right", 1)):
        for index in range(course_count):
            t = (index + 0.42) / course_count
            x = sign * half_span * (1 - t)
            z = eave_z + rise * t + normal_lift
            add_box(
                f"{prefix}_{side}_{index:02d}",
                root,
                mats[index % len(mats)],
                (x, 0, z),
                (run * 1.16, depth + 0.025, course_depth),
                rotation=(0, sign * pitch, 0),
                bevel=min(0.012, course_depth * 0.24) if course_bevel is None else course_bevel,
            )


def add_gable_end(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    *,
    width: float,
    face_y: float,
    thickness: float,
    eave_z: float,
    ridge_z: float,
) -> bpy.types.Object:
    half = width / 2
    y0, y1 = face_y - thickness / 2, face_y + thickness / 2
    vertices = (
        (-half, y0, eave_z), (half, y0, eave_z), (0, y0, ridge_z),
        (-half, y1, eave_z), (half, y1, eave_z), (0, y1, ridge_z),
    )
    faces = ((0, 2, 1), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5))
    return add_mesh(name, root, mat, vertices, faces, bevel=0.018)


def add_front_window_assembly(
    prefix: str,
    root: bpy.types.Object,
    m: dict[str, bpy.types.Material],
    *,
    x: float,
    face_y: float,
    z: float,
    width: float,
    height: float,
    frame_material: str,
    sill_material: str,
) -> None:
    """Create a recessed opening with a visible reveal, jambs, lintel, sill, and muntins."""
    frame = m[frame_material]
    sill = m[sill_material]
    add_box(f"{prefix}_reveal", root, m["stone_dark"], (x, face_y + 0.035, z), (width + 0.2, 0.12, height + 0.2), bevel=0.018)
    add_box(f"{prefix}_glass", root, m["glass"], (x, face_y - 0.035, z), (width, 0.045, height), bevel=0.018)
    for side, x_offset in (("left", -(width / 2 + 0.085)), ("right", width / 2 + 0.085)):
        add_box(f"{prefix}_jamb_{side}", root, frame, (x + x_offset, face_y - 0.075, z), (0.13, 0.16, height + 0.24), bevel=0.014)
    add_box(f"{prefix}_lintel", root, frame, (x, face_y - 0.075, z + height / 2 + 0.09), (width + 0.38, 0.17, 0.17), bevel=0.015)
    add_box(f"{prefix}_sill", root, sill, (x, face_y - 0.11, z - height / 2 - 0.09), (width + 0.34, 0.26, 0.14), bevel=0.018)
    add_box(f"{prefix}_mullion", root, frame, (x, face_y - 0.082, z), (0.055, 0.08, height), bevel=0.008)
    add_box(f"{prefix}_transom", root, frame, (x, face_y - 0.082, z), (width, 0.08, 0.055), bevel=0.008)


def add_front_panel_door(
    prefix: str,
    root: bpy.types.Object,
    m: dict[str, bpy.types.Material],
    *,
    face_y: float,
    z_bottom: float,
    width: float,
    height: float,
    x: float = 0,
) -> None:
    """Create an inset ledged-and-braced door with a structural frame and lintel."""
    center_z = z_bottom + height / 2
    add_box(f"{prefix}_recess", root, m["wood_dark"], (x, face_y + 0.035, center_z), (width + 0.24, 0.14, height + 0.2), bevel=0.02)
    add_box(f"{prefix}_leaf", root, m["wood"], (x, face_y - 0.035, center_z), (width, 0.075, height), bevel=0.025)
    for index in range(4):
        px = x - width * 0.36 + index * width * 0.24
        add_box(f"{prefix}_board_{index}", root, m["wood_light"], (px, face_y - 0.083, center_z), (0.055, 0.035, height * 0.91), bevel=0.008)
    for label, dz in (("lower", -height * 0.28), ("middle", 0), ("upper", height * 0.28)):
        add_box(f"{prefix}_ledge_{label}", root, m["wood_dark"], (x, face_y - 0.105, center_z + dz), (width * 0.82, 0.055, 0.09), bevel=0.012)
    add_beam(
        f"{prefix}_brace",
        root,
        m["wood_dark"],
        (x - width * 0.34, face_y - 0.12, z_bottom + height * 0.18),
        (x + width * 0.34, face_y - 0.12, z_bottom + height * 0.82),
        0.075,
        bevel=0.01,
    )
    for side, dx in (("left", -(width / 2 + 0.09)), ("right", width / 2 + 0.09)):
        add_box(f"{prefix}_frame_{side}", root, m["wood_dark"], (x + dx, face_y - 0.095, center_z), (0.14, 0.19, height + 0.25), bevel=0.016)
    add_box(f"{prefix}_lintel", root, m["wood_dark"], (x, face_y - 0.095, z_bottom + height + 0.1), (width + 0.42, 0.2, 0.18), bevel=0.016)


def add_frond(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    origin: Sequence[float],
    angle: float,
    length: float,
    droop: float,
) -> bpy.types.Object:
    ox, oy, oz = origin
    direction = Vector((math.cos(angle), math.sin(angle), 0))
    side = Vector((-direction.y, direction.x, 0))
    vertices: list[tuple[float, float, float]] = []
    segments = 5
    for index in range(segments + 1):
        t = index / segments
        distance = 0.08 + length * t
        center = Vector((ox, oy, oz)) + direction * distance
        center.z -= droop * (t**1.55)
        center.z += 0.08 * math.sin(math.pi * t)
        half_width = 0.045 + 0.31 * (math.sin(math.pi * min(t, 0.98)) ** 0.7)
        left, right = center + side * half_width, center - side * half_width
        vertices.extend((tuple(left), tuple(right)))
    faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(segments)]
    return add_mesh(name, root, mat, vertices, faces)


def add_lance_leaf(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    base: Sequence[float],
    tip: Sequence[float],
    width: float,
    *,
    roll: float = 0.0,
) -> bpy.types.Object:
    """Add one pointed, export-cheap bamboo leaf with a readable mid-width."""
    p0, p1 = Vector(base), Vector(tip)
    axis = (p1 - p0).normalized()
    reference = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((0, 1, 0))
    side = axis.cross(reference).normalized()
    side = side * math.cos(roll) + axis.cross(side) * math.sin(roll)
    shoulder = p0.lerp(p1, 0.46) + Vector((0, 0, width * 0.08))
    vertices = (tuple(p0), tuple(shoulder + side * width), tuple(p1), tuple(shoulder - side * width))
    return add_mesh(name, root, mat, vertices, ((0, 1, 2, 3),))


def add_blossom_rosette(
    name: str,
    root: bpy.types.Object,
    mat: bpy.types.Material,
    center: Sequence[float],
    normal: Sequence[float],
    radius: float,
    *,
    phase: float = 0.0,
) -> bpy.types.Object:
    """Create a five-petal cherry rosette as one double-sided ten-triangle mesh."""
    origin = Vector(center)
    facing = Vector(normal).normalized()
    reference = Vector((0, 0, 1)) if abs(facing.z) < 0.9 else Vector((0, 1, 0))
    axis_u = facing.cross(reference).normalized()
    axis_v = facing.cross(axis_u).normalized()
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int, int]] = []
    for petal in range(5):
        angle = phase + math.tau * petal / 5
        direction = axis_u * math.cos(angle) + axis_v * math.sin(angle)
        tangent = -axis_u * math.sin(angle) + axis_v * math.cos(angle)
        inner = origin + direction * radius * 0.08
        shoulder = origin + direction * radius * 0.56 + facing * radius * 0.07
        tip = origin + direction * radius + facing * radius * 0.025
        offset = len(vertices)
        vertices.extend(
            (
                tuple(inner),
                tuple(shoulder + tangent * radius * 0.27),
                tuple(tip),
                tuple(shoulder - tangent * radius * 0.27),
            )
        )
        faces.append((offset, offset + 1, offset + 2, offset + 3))
    return add_mesh(name, root, mat, vertices, faces)


def asset_root(key: str, spec: dict[str, Any]) -> bpy.types.Object:
    name = spec["node"]
    if name != f"ASSET_{key}":
        raise ValueError(f"Prototype {key} node must be ASSET_{key}, got {name}")
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.5
    root["assetKey"] = key
    root["generator"] = spec["generator"]
    root["source"] = spec["source"]
    root["targetHeightMeters"] = float(spec["targetHeightMeters"])
    root["defaultVariant"] = spec["defaultVariant"]
    # The runtime fallback may intentionally target an alternate authored root.
    # Root extras must still describe the geometry actually parented here.
    authored = next(variant for variant in spec["variants"] if variant["node"] == name)
    root["geometryVariantId"] = authored["id"]
    root["appearanceTerms"] = "|".join(authored["appearanceTerms"])
    root["materialIds"] = "|".join(authored["materialIds"])
    provenance = authored.get("provenance", {})
    root["paperPages"] = "|".join(str(page) for page in provenance.get("paperPages", []))
    root["researchReferenceIds"] = "|".join(provenance.get("researchReferenceIds", []))
    bpy.context.collection.objects.link(root)
    return root


def variant_root(key: str, spec: dict[str, Any], variant: dict[str, Any]) -> bpy.types.Object:
    name = variant["node"]
    if not name.startswith(f"ASSET_{key}_"):
        raise ValueError(f"Variant {key}/{variant['id']} node must start with ASSET_{key}_, got {name}")
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.5
    root["assetKey"] = key
    root["generator"] = spec["generator"]
    root["source"] = spec["source"]
    root["targetHeightMeters"] = float(variant.get("targetHeightMeters", spec["targetHeightMeters"]))
    root["variantId"] = variant["id"]
    root["appearanceTerms"] = "|".join(variant["appearanceTerms"])
    root["materialIds"] = "|".join(variant["materialIds"])
    provenance = variant.get("provenance", {})
    root["paperPages"] = "|".join(str(page) for page in provenance.get("paperPages", []))
    root["researchReferenceIds"] = "|".join(provenance.get("researchReferenceIds", []))
    bpy.context.collection.objects.link(root)
    return root


def build_palm(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    segments = [
        ((0, 0, -0.04), (0.10, 0.03, 2.15), 0.38, 0.31),
        ((0.08, 0.02, 2.03), (-0.08, 0.10, 4.15), 0.33, 0.25),
        ((-0.07, 0.09, 4.03), (0.13, 0.05, 5.92), 0.27, 0.19),
        ((0.12, 0.05, 5.82), (0.17, 0.08, 6.55), 0.21, 0.16),
    ]
    for index, (start, end, r0, r1) in enumerate(segments):
        add_tapered(
            f"GEO-palm_trunk_{index}", root, m["wood_light" if index % 2 == 0 else "wood"], start, end, r0, r1,
            vertices=9, bevel=0.025,
        )
    for index, location in enumerate(((-0.15, -0.06, 6.45), (0.24, -0.10, 6.39), (0.08, 0.22, 6.42))):
        add_ico(f"GEO-palm_coconut_{index}", root, m["wood_dark"], location, (0.34, 0.34, 0.38), smooth=True)
    for index in range(9):
        angle = math.radians(index * 40 + (10 if index % 2 else 0))
        add_frond(
            f"GEO-palm_frond_{index}", root,
            m["leaf_light" if index % 3 == 0 else "leaf_palm"],
            (0.16, 0.08, 6.52), angle, 2.15 + 0.16 * (index % 3), 0.72 + 0.11 * (index % 2),
        )
    add_tapered("GEO-palm_crown_spear", root, m["leaf_light"], (0.16, 0.08, 6.42), (0.27, 0.09, 7.55), 0.12, 0.018, vertices=7)


def build_tree(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    add_tapered("GEO-tree_trunk_lower", root, m["wood"], (0, 0, -0.05), (0.05, 0, 3.8), 0.52, 0.31, vertices=9, bevel=0.025)
    add_tapered("GEO-tree_trunk_upper", root, m["wood_light"], (0.04, 0, 3.55), (-0.08, 0.04, 5.25), 0.34, 0.15, vertices=8)
    branches = [
        ((0, 0, 3.1), (-1.45, 0.20, 4.55), 0.22, 0.09),
        ((0.03, 0, 3.45), (1.50, -0.12, 4.75), 0.23, 0.08),
        ((0, 0.02, 4.0), (-0.75, -1.05, 5.20), 0.18, 0.07),
        ((-0.02, 0.03, 4.15), (0.78, 1.10, 5.35), 0.18, 0.07),
    ]
    for index, (start, end, r0, r1) in enumerate(branches):
        add_tapered(f"GEO-tree_branch_{index}", root, m["wood"], start, end, r0, r1, vertices=7)
    crowns = [
        ((0, 0, 5.55), (2.55, 2.25, 2.15), "leaf_palm"),
        ((-1.35, 0.25, 5.35), (1.85, 1.65, 1.65), "leaf_dark"),
        ((1.35, -0.1, 5.45), (1.9, 1.7, 1.72), "leaf_light"),
        ((-0.55, -1.0, 5.65), (1.7, 1.55, 1.58), "leaf_palm"),
        ((0.62, 1.03, 5.75), (1.72, 1.5, 1.55), "leaf_dark"),
        ((0.08, 0.12, 6.35), (1.72, 1.55, 1.62), "leaf_light"),
    ]
    for index, (location, size, material_key) in enumerate(crowns):
        add_ico(f"GEO-tree_crown_{index}", root, m[material_key], location, size, subdivisions=1)


def build_tree_bamboo_cluster(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Build a clumping bamboo stand with explicit internodes, nodes, and leaf sprays."""
    culms = (
        ((-0.68, -0.28), 6.45, (-0.10, 0.10), 0.145, 0.088),
        ((-0.12, 0.18), 7.35, (0.16, -0.05), 0.155, 0.082),
        ((0.55, -0.22), 6.85, (-0.08, 0.13), 0.14, 0.078),
        ((-0.48, 0.56), 5.82, (0.14, -0.08), 0.13, 0.072),
        ((0.50, 0.52), 5.48, (-0.09, -0.13), 0.125, 0.068),
        ((0.03, -0.66), 6.12, (0.09, 0.14), 0.135, 0.074),
    )
    for culm_index, (base_xy, height, lean_xy, radius_bottom, radius_top) in enumerate(culms):
        start = Vector((base_xy[0], base_xy[1], -0.04))
        end = Vector((base_xy[0] + lean_xy[0], base_xy[1] + lean_xy[1], height))
        add_tapered(
            f"GEO-tree_bamboo_culm_{culm_index}", root, m["bamboo_culm"],
            start, end, radius_bottom, radius_top, vertices=7,
        )
        axis = (end - start).normalized()
        for node_index, t in enumerate((0.18, 0.34, 0.50, 0.66, 0.82)):
            center = start.lerp(end, t)
            radius = (radius_bottom * (1 - t) + radius_top * t) * 1.17
            add_tapered(
                f"GEO-tree_bamboo_node_{culm_index}_{node_index}", root, m["bamboo_culm"],
                center - axis * 0.037, center + axis * 0.037, radius, radius * 0.98, vertices=7,
            )

        branch_levels = (0.57, 0.71, 0.85)
        for branch_index, t in enumerate(branch_levels):
            angle = culm_index * 2.17 + branch_index * 1.41 + 0.22
            branch_start = start.lerp(end, t)
            branch_end = branch_start + Vector((math.cos(angle), math.sin(angle), 0.38))
            add_tapered(
                f"GEO-tree_bamboo_branch_{culm_index}_{branch_index}", root, m["bamboo_culm"],
                branch_start, branch_end, 0.047, 0.018, vertices=5,
            )
            for leaf_index, leaf_t in enumerate((0.30, 0.46, 0.62, 0.77, 0.90)):
                leaf_base = branch_start.lerp(branch_end, leaf_t)
                side_sign = -1 if leaf_index % 2 == 0 else 1
                leaf_angle = angle + side_sign * (0.50 + 0.07 * (leaf_index % 3))
                leaf_length = 0.62 + 0.08 * ((culm_index + leaf_index) % 3)
                leaf_tip = leaf_base + Vector(
                    (
                        math.cos(leaf_angle) * leaf_length,
                        math.sin(leaf_angle) * leaf_length,
                        0.13 + 0.035 * (leaf_index % 3),
                    )
                )
                add_lance_leaf(
                    f"GEO-tree_bamboo_leaf_{culm_index}_{branch_index}_{leaf_index}",
                    root, m["bamboo_leaf"], leaf_base, leaf_tip,
                    0.13 + 0.014 * ((culm_index + leaf_index) % 2),
                    roll=0.24 * (leaf_index - 1.5),
                )

    for shoot_index, (location, height) in enumerate((((0.82, -0.64), 1.38), ((-0.82, -0.56), 1.02))):
        add_tapered(
            f"GEO-tree_bamboo_young_shoot_{shoot_index}", root, m["bamboo_culm"],
            (location[0], location[1], -0.025), (location[0] + 0.035, location[1], height),
            0.115, 0.018, vertices=7,
        )


def build_tree_cherry_blossom(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Build a broad flowering cherry with visible scaffold branches and blossom clusters."""
    add_tapered(
        "GEO-tree_cherry_trunk_lower", root, m["cherry_bark"],
        (0, 0, -0.05), (0.04, 0.01, 2.62), 0.49, 0.34, vertices=9, bevel=0.02,
    )
    scaffold = (
        ((0.02, 0, 2.20), (-0.66, 0.08, 4.22), 0.35, 0.16),
        ((0.03, 0, 2.28), (0.76, -0.08, 4.12), 0.34, 0.15),
        ((0.03, 0.02, 2.72), (0.08, 0.28, 4.84), 0.28, 0.13),
        ((-0.55, 0.07, 3.76), (-2.17, 0.27, 5.08), 0.18, 0.075),
        ((-2.05, 0.26, 5.00), (-2.94, 0.44, 5.60), 0.082, 0.032),
        ((0.64, -0.07, 3.66), (2.18, -0.23, 4.91), 0.18, 0.073),
        ((2.06, -0.22, 4.84), (2.96, -0.36, 5.52), 0.08, 0.03),
        ((0.02, 0.20, 4.18), (-0.86, -1.25, 5.43), 0.14, 0.052),
        ((0.10, 0.22, 4.24), (0.92, 1.32, 5.51), 0.14, 0.052),
    )
    for index, (start, end, radius_start, radius_end) in enumerate(scaffold):
        add_tapered(
            f"GEO-tree_cherry_scaffold_{index}", root,
            m["cherry_bark" if index < 7 else "wood_dark"],
            start, end, radius_start, radius_end, vertices=7 if index < 3 else 6,
        )
    twigs = (
        ((-1.60, 0.22, 4.68), (-2.22, -0.58, 5.52)),
        ((-2.18, 0.30, 5.04), (-2.30, 1.05, 5.75)),
        ((1.62, -0.18, 4.58), (2.25, 0.62, 5.42)),
        ((2.15, -0.24, 4.88), (2.35, -1.02, 5.60)),
        ((-0.45, -0.58, 4.86), (-0.10, -1.72, 5.52)),
        ((0.46, 0.65, 4.90), (0.18, 1.78, 5.62)),
    )
    for index, (start, end) in enumerate(twigs):
        add_tapered(
            f"GEO-tree_cherry_twig_{index}", root, m["wood_dark"],
            start, end, 0.055, 0.018, vertices=5,
        )

    blossom_masses = (
        ((0.10, 0.05, 6.42), (2.02, 1.62, 1.58), "blossom_pale"),
        ((-1.18, 0.16, 6.12), (1.86, 1.58, 1.47), "blossom_pale"),
        ((1.30, -0.10, 6.08), (1.88, 1.58, 1.46), "blossom_pink"),
        ((-2.47, 0.28, 5.72), (1.52, 1.36, 1.28), "blossom_pink"),
        ((2.49, -0.22, 5.66), (1.56, 1.34, 1.30), "blossom_pale"),
        ((-0.74, -1.08, 5.78), (1.58, 1.42, 1.34), "blossom_pink"),
        ((0.78, 1.10, 5.84), (1.62, 1.40, 1.38), "blossom_pale"),
        ((-1.88, -0.62, 5.42), (1.36, 1.24, 1.18), "blossom_pale"),
        ((1.90, 0.58, 5.40), (1.38, 1.24, 1.20), "blossom_pink"),
        ((-0.10, -1.62, 5.47), (1.40, 1.22, 1.22), "blossom_pale"),
        ((0.16, 1.62, 5.55), (1.42, 1.22, 1.24), "blossom_pink"),
        ((-2.63, 0.88, 5.50), (1.14, 1.04, 1.08), "blossom_pale"),
        ((2.66, -0.84, 5.46), (1.16, 1.02, 1.06), "blossom_pink"),
        ((-1.45, 0.94, 6.13), (1.28, 1.12, 1.14), "blossom_pink"),
        ((1.54, -0.92, 6.08), (1.30, 1.12, 1.16), "blossom_pale"),
        ((0.05, 0.18, 7.02), (1.18, 1.08, 0.78), "blossom_pale"),
    )
    for index, (location, dimensions, material_key) in enumerate(blossom_masses):
        add_ico(
            f"GEO-tree_cherry_blossom_mass_{index}", root, m[material_key],
            location, dimensions, subdivisions=1,
        )

    rosettes = (
        ((-3.02, 0.45, 5.67), (-0.86, -0.44, 0.22), 0.31),
        ((3.04, -0.35, 5.59), (0.86, -0.44, 0.22), 0.31),
        ((-2.12, -1.06, 5.46), (-0.58, -0.78, 0.20), 0.28),
        ((2.12, 1.02, 5.45), (0.58, 0.78, 0.20), 0.28),
        ((-0.30, -1.92, 5.48), (-0.16, -0.96, 0.22), 0.29),
        ((0.28, 1.94, 5.59), (0.16, 0.96, 0.22), 0.29),
        ((-1.22, 0.44, 6.92), (-0.28, -0.42, 0.86), 0.27),
        ((1.26, -0.40, 6.84), (0.28, -0.42, 0.86), 0.27),
    )
    for index, (center, normal, radius) in enumerate(rosettes):
        add_blossom_rosette(
            f"GEO-tree_cherry_blossom_rosette_{index}", root,
            m["blossom_pale" if index % 3 else "blossom_pink"],
            center, normal, radius, phase=0.21 * index,
        )


def build_pine(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    add_tapered("GEO-pine_trunk", root, m["wood_dark"], (0, 0, -0.05), (0, 0, 8.55), 0.42, 0.12, vertices=8, bevel=0.02)
    layers = [
        (1.25, 4.75, 2.25, "pine"),
        (2.55, 5.85, 1.92, "leaf_dark"),
        (3.75, 6.75, 1.58, "pine"),
        (4.85, 7.55, 1.22, "leaf_dark"),
        (5.82, 8.25, 0.88, "pine"),
        (6.65, 8.83, 0.52, "leaf_dark"),
    ]
    for index, (bottom, top, radius, material_key) in enumerate(layers):
        add_tapered(
            f"GEO-pine_bough_layer_{index}", root, m[material_key],
            (0, 0, bottom), (0, 0, top), radius, 0.045, vertices=10,
        )


def build_rock(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    main = add_ico("GEO-rock_mass", root, m["stone"], (0, 0, 0.78), (2.45, 1.82, 1.58), subdivisions=2)
    for vertex in main.data.vertices:
        coordinate = vertex.co
        factor = 1.0 + 0.075 * math.sin(coordinate.x * 4.3 + coordinate.y * 2.1 + coordinate.z * 3.7)
        coordinate.x *= factor
        coordinate.y *= 1.0 + 0.055 * math.sin(coordinate.z * 5.1)
        coordinate.z *= 1.0 + 0.035 * math.cos(coordinate.x * 3.9)
    main.data.update()
    add_ico("GEO-rock_shard_left", root, m["stone_dark"], (-0.9, 0.25, 0.37), (0.8, 0.7, 0.72), subdivisions=1)
    add_ico("GEO-rock_shard_right", root, m["stone"], (0.85, -0.18, 0.3), (0.68, 0.56, 0.58), subdivisions=1)


def build_cactus(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    add_tapered("GEO-cactus_body", root, m["cactus"], (0, 0, -0.03), (0, 0, 3.2), 0.42, 0.32, vertices=10, bevel=0.05)
    add_ico("GEO-cactus_cap", root, m["cactus"], (0, 0, 3.17), (0.65, 0.65, 0.68), smooth=True)
    arm_specs = [
        ((-0.25, 0, 1.3), (-1.05, 0.02, 1.32), 0.25, 0.22),
        ((-1.04, 0.02, 1.28), (-1.04, 0.02, 2.32), 0.24, 0.19),
        ((0.28, 0.02, 1.72), (0.93, 0.08, 1.74), 0.23, 0.2),
        ((0.92, 0.08, 1.71), (0.92, 0.08, 2.56), 0.22, 0.17),
    ]
    for index, (start, end, r0, r1) in enumerate(arm_specs):
        add_tapered(f"GEO-cactus_arm_{index}", root, m["cactus"], start, end, r0, r1, vertices=9, bevel=0.04)
    add_ico("GEO-cactus_elbow_left", root, m["cactus_dark"], (-1.04, 0.02, 1.33), (0.48, 0.48, 0.48), smooth=True)
    add_ico("GEO-cactus_elbow_right", root, m["cactus_dark"], (0.92, 0.08, 1.74), (0.44, 0.44, 0.44), smooth=True)
    add_ico("GEO-cactus_cap_left", root, m["cactus"], (-1.04, 0.02, 2.31), (0.39, 0.39, 0.44), smooth=True)
    add_ico("GEO-cactus_cap_right", root, m["cactus"], (0.92, 0.08, 2.55), (0.36, 0.36, 0.42), smooth=True)


def build_hut(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    add_box("GEO-hut_foundation_rubble", root, m["stone_dark"], (0, 0, 0.13), (4.55, 3.72, 0.26), bevel=0.08)
    add_box("GEO-hut_stone_plinth", root, m["stone"], (0, 0, 0.39), (4.18, 3.36, 0.38), bevel=0.07)
    add_box("GEO-hut_timber_sill_plate", root, m["wood_dark"], (0, 0, 0.61), (3.72, 2.96, 0.18), bevel=0.025)

    wall_bottom, wall_top = 0.62, 2.78
    wall_height = wall_top - wall_bottom
    # The front infill is split around real openings: no hidden monolithic wall
    # sits behind the door or windows. Timbers overlap the lime infill at joins.
    def front_panel(label: str, x0: float, x1: float, z0: float, z1: float) -> None:
        add_box(
            f"GEO-hut_infill_front_{label}", root, m["plaster"],
            ((x0 + x1) / 2, -1.405, (z0 + z1) / 2), (x1 - x0, 0.19, z1 - z0), bevel=0.035,
        )

    front_panel("outer_left", -1.78, -1.53, wall_bottom, wall_top)
    front_panel("window_left_below", -1.53, -0.91, wall_bottom, 1.18)
    front_panel("window_left_above", -1.53, -0.91, 1.92, wall_top)
    front_panel("pier_left", -0.91, -0.49, wall_bottom, wall_top)
    front_panel("door_head", -0.49, 0.49, 2.48, wall_top)
    front_panel("pier_right", 0.49, 0.91, wall_bottom, wall_top)
    front_panel("window_right_below", 0.91, 1.53, wall_bottom, 1.18)
    front_panel("window_right_above", 0.91, 1.53, 1.92, wall_top)
    front_panel("outer_right", 1.53, 1.78, wall_bottom, wall_top)
    add_box("GEO-hut_infill_rear", root, m["plaster"], (0, 1.405, 1.7), (3.42, 0.19, wall_height), bevel=0.045)
    for side, x in (("west", -1.705), ("east", 1.705)):
        add_box(f"GEO-hut_infill_{side}", root, m["plaster"], (x, 0, 1.7), (0.19, 2.63, wall_height), bevel=0.045)

    corners = ((-1.78, -1.48), (1.78, -1.48), (-1.78, 1.48), (1.78, 1.48))
    for index, (x, y) in enumerate(corners):
        add_box(f"GEO-hut_corner_post_{index}", root, m["wood_dark"], (x, y, 1.7), (0.21, 0.21, 2.36), bevel=0.025)
    for index, x in enumerate((-0.91, -0.49, 0.49, 0.91)):
        add_box(f"GEO-hut_front_stud_{index}", root, m["wood_dark"], (x, -1.49, 1.7), (0.13, 0.18, 2.27), bevel=0.018)
    for side, x in (("west", -1.78), ("east", 1.78)):
        add_box(f"GEO-hut_side_midpost_{side}", root, m["wood_dark"], (x, 0, 1.7), (0.19, 0.19, 2.35), bevel=0.022)
    add_box("GEO-hut_front_top_plate", root, m["wood_dark"], (0, -1.49, wall_top), (3.7, 0.21, 0.2), bevel=0.025)
    add_box("GEO-hut_rear_top_plate", root, m["wood_dark"], (0, 1.49, wall_top), (3.7, 0.21, 0.2), bevel=0.025)
    for side, x in (("west", -1.78), ("east", 1.78)):
        add_box(f"GEO-hut_top_plate_{side}", root, m["wood_dark"], (x, 0, wall_top), (0.21, 3.15, 0.2), bevel=0.025)

    add_front_panel_door("GEO-hut_door", root, m, face_y=-1.49, z_bottom=0.64, width=0.92, height=1.78)
    for label, x in (("left", -1.22), ("right", 1.22)):
        add_front_window_assembly(
            f"GEO-hut_window_{label}", root, m, x=x, face_y=-1.49, z=1.55,
            width=0.58, height=0.64, frame_material="wood_dark", sill_material="wood_light",
        )

    pitch = 48.0
    ridge_z, _ = add_pitched_roof_planes(
        "GEO-hut_thatch", root, m["thatch"], width=4.78, depth=4.18,
        eave_z=2.82, pitch_degrees=pitch, thickness=0.34, bevel=0.055,
    )
    add_roof_courses(
        "GEO-hut_thatch_bundle", root, (m["thatch"], m["thatch_dark"]), width=4.78, depth=4.2,
        eave_z=2.82, pitch_degrees=pitch, plane_thickness=0.34, course_count=6, course_depth=0.075,
    )
    add_tapered("GEO-hut_flush_ridge", root, m["thatch_dark"], (0, -2.15, ridge_z + 0.12), (0, 2.15, ridge_z + 0.12), 0.2, 0.2, vertices=9, bevel=0.015)
    for end, y in (("front", -2.14), ("rear", 2.14)):
        add_beam(f"GEO-hut_truss_{end}_left", root, m["wood_dark"], (-2.34, y, 2.74), (0, y, ridge_z - 0.08), 0.105, bevel=0.015)
        add_beam(f"GEO-hut_truss_{end}_right", root, m["wood_dark"], (2.34, y, 2.74), (0, y, ridge_z - 0.08), 0.105, bevel=0.015)
        add_beam(f"GEO-hut_truss_{end}_tie", root, m["wood_dark"], (-1.95, y, 2.77), (1.95, y, 2.77), 0.105, bevel=0.015)
    for index, (z, depth, width) in enumerate(((0.13, 0.62, 1.62), (0.26, 0.58, 1.34), (0.39, 0.54, 1.08))):
        add_box(f"GEO-hut_step_{index}", root, m["limestone"], (0, -1.9 - index * 0.2, z / 2), (width, depth, z), bevel=0.05)


def build_building(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    add_box("GEO-building_footing", root, m["stone_dark"], (0, 0, 0.16), (5.68, 4.58, 0.32), bevel=0.09)
    add_box("GEO-building_limestone_plinth", root, m["limestone"], (0, 0, 0.43), (5.38, 4.3, 0.34), bevel=0.055)
    add_box("GEO-building_cavity_wall", root, m["brick"], (0, 0, 3.16), (5.18, 4.08, 5.48), bevel=0.055)
    face_y = -2.07
    for floor, z in enumerate((1.73, 3.92)):
        columns = (-1.48, 1.48) if floor == 0 else (-1.48, 0, 1.48)
        for column, x in enumerate(columns):
            add_front_window_assembly(
                f"GEO-building_window_{floor}_{column}", root, m, x=x, face_y=face_y, z=z,
                width=0.75, height=1.02, frame_material="brick_dark", sill_material="limestone",
            )
    add_front_panel_door("GEO-building_entry", root, m, face_y=face_y, z_bottom=0.62, width=1.02, height=1.86)
    add_box("GEO-building_entry_stone_lintel", root, m["limestone"], (0, face_y - 0.12, 2.58), (1.58, 0.27, 0.23), bevel=0.025)
    add_box("GEO-building_entry_canopy", root, m["slate_edge"], (0, -2.55, 2.74), (2.05, 1.08, 0.16), rotation=(math.radians(-7), 0, 0), bevel=0.035)
    for index, x in enumerate((-0.82, 0.82)):
        add_tapered(f"GEO-building_canopy_column_{index}", root, m["metal"], (x, -2.77, 0.35), (x, -2.77, 2.65), 0.055, 0.055, vertices=7)

    # Limestone quoins bond the visible corners; alternating depth suggests
    # long-and-short masonry without spending texture memory.
    for corner, (x, y) in enumerate(((-2.63, -2.07), (2.63, -2.07), (-2.63, 2.07), (2.63, 2.07))):
        for course in range(8):
            long_axis_x = course % 2 == 0
            add_box(
                f"GEO-building_quoin_{corner}_{course}", root, m["limestone"],
                (x, y, 0.78 + course * 0.62),
                ((0.48 if long_axis_x else 0.3), (0.3 if long_axis_x else 0.48), 0.25),
                bevel=0.025,
            )
    for course in range(7):
        add_box(
            f"GEO-building_mortar_course_{course}", root, m["mortar"],
            (0, face_y - 0.035, 0.92 + course * 0.69), (4.55, 0.045, 0.035), bevel=0.006,
        )

    for side, x in (("west", -2.62), ("east", 2.62)):
        for floor, z in enumerate((1.72, 3.92)):
            for column, y in enumerate((-0.72, 0.78)):
                add_box(f"GEO-building_{side}_reveal_{floor}_{column}", root, m["stone_dark"], (x, y, z), (0.11, 0.82, 1.1), bevel=0.025)
                add_box(f"GEO-building_{side}_glass_{floor}_{column}", root, m["glass"], (x + (-0.055 if x < 0 else 0.055), y, z), (0.045, 0.66, 0.88), bevel=0.02)
                add_box(f"GEO-building_{side}_lintel_{floor}_{column}", root, m["limestone"], (x + (-0.09 if x < 0 else 0.09), y, z + 0.59), (0.2, 1.04, 0.18), bevel=0.018)
                add_box(f"GEO-building_{side}_sill_{floor}_{column}", root, m["limestone"], (x + (-0.11 if x < 0 else 0.11), y, z - 0.58), (0.26, 1.0, 0.14), bevel=0.018)

    pitch = 38.0
    ridge_z, _ = add_pitched_roof_planes(
        "GEO-building_slate", root, m["slate"], width=5.82, depth=4.78,
        eave_z=5.93, pitch_degrees=pitch, thickness=0.18, bevel=0.025,
    )
    add_gable_end("GEO-building_front_gable", root, m["brick"], width=5.02, face_y=-2.03, thickness=0.16, eave_z=5.83, ridge_z=ridge_z - 0.06)
    add_gable_end("GEO-building_rear_gable", root, m["brick_dark"], width=5.02, face_y=2.03, thickness=0.16, eave_z=5.83, ridge_z=ridge_z - 0.06)
    add_roof_courses(
        "GEO-building_slate_course", root, (m["slate"], m["slate_edge"]), width=5.82, depth=4.8,
        eave_z=5.93, pitch_degrees=pitch, plane_thickness=0.18, course_count=7, course_depth=0.05,
    )
    add_tapered("GEO-building_slate_ridge", root, m["slate_edge"], (0, -2.43, ridge_z + 0.08), (0, 2.43, ridge_z + 0.08), 0.11, 0.11, vertices=8, bevel=0.012)
    add_box("GEO-building_chimney_stack", root, m["brick_dark"], (1.62, 0.72, 7.62), (0.67, 0.58, 2.1), bevel=0.035)
    add_box("GEO-building_chimney_flashing", root, m["metal_dark"], (1.62, 0.72, 6.72), (0.9, 0.82, 0.15), bevel=0.025)
    add_box("GEO-building_chimney_cap", root, m["limestone"], (1.62, 0.72, 8.72), (0.82, 0.72, 0.16), bevel=0.035)


def add_japanese_window_y(
    prefix: str,
    root: bpy.types.Object,
    m: dict[str, bpy.types.Material],
    *,
    x: float,
    face_y: float,
    outward: float,
    z: float,
    width: float,
    height: float,
) -> None:
    """Build a framed lattice window behind a true Y-facing wall opening."""
    frame_y = face_y + outward * 0.09
    glass_y = face_y - outward * 0.13
    reveal_y = (frame_y + glass_y) / 2
    reveal_depth = abs(frame_y - glass_y) + 0.12
    jamb_x = width / 2 + 0.065
    add_box(f"{prefix}_glass", root, m["glass"], (x, glass_y, z), (width, 0.045, height), bevel=0.0)
    for side, dx in (("left", -jamb_x), ("right", jamb_x)):
        add_box(f"{prefix}_reveal_{side}", root, m["wood"], (x + dx, reveal_y, z), (0.12, reveal_depth, height + 0.18), bevel=0.0)
    add_box(f"{prefix}_header", root, m["wood_dark"], (x, reveal_y, z + height / 2 + 0.085), (width + 0.36, reveal_depth, 0.16), bevel=0.016)
    add_box(f"{prefix}_sill", root, m["wood_light"], (x, frame_y + outward * 0.035, z - height / 2 - 0.075), (width + 0.32, 0.28, 0.14), bevel=0.018)
    lattice_y = glass_y + outward * 0.03
    for index, dx in enumerate((-width / 4, 0, width / 4)):
        add_box(f"{prefix}_lattice_v_{index}", root, m["wood_dark"], (x + dx, lattice_y, z), (0.042, 0.055, height), bevel=0.0)
    for index, dz in enumerate((-height / 4, 0, height / 4)):
        add_box(f"{prefix}_lattice_h_{index}", root, m["wood_dark"], (x, lattice_y, z + dz), (width, 0.055, 0.042), bevel=0.0)


def add_japanese_window_x(
    prefix: str,
    root: bpy.types.Object,
    m: dict[str, bpy.types.Material],
    *,
    y: float,
    face_x: float,
    outward: float,
    z: float,
    width: float,
    height: float,
) -> None:
    """Build a framed lattice window behind a true X-facing wall opening."""
    frame_x = face_x + outward * 0.09
    glass_x = face_x - outward * 0.13
    reveal_x = (frame_x + glass_x) / 2
    reveal_depth = abs(frame_x - glass_x) + 0.12
    jamb_y = width / 2 + 0.065
    add_box(f"{prefix}_glass", root, m["glass"], (glass_x, y, z), (0.045, width, height), bevel=0.0)
    for side, dy in (("left", -jamb_y), ("right", jamb_y)):
        add_box(f"{prefix}_reveal_{side}", root, m["wood"], (reveal_x, y + dy, z), (reveal_depth, 0.12, height + 0.18), bevel=0.0)
    add_box(f"{prefix}_header", root, m["wood_dark"], (reveal_x, y, z + height / 2 + 0.085), (reveal_depth, width + 0.36, 0.16), bevel=0.016)
    add_box(f"{prefix}_sill", root, m["wood_light"], (frame_x + outward * 0.035, y, z - height / 2 - 0.075), (0.28, width + 0.32, 0.14), bevel=0.018)
    lattice_x = glass_x + outward * 0.03
    for index, dy in enumerate((-width / 4, 0, width / 4)):
        add_box(f"{prefix}_lattice_v_{index}", root, m["wood_dark"], (lattice_x, y + dy, z), (0.055, 0.042, height), bevel=0.0)
    for index, dz in enumerate((-height / 4, 0, height / 4)):
        add_box(f"{prefix}_lattice_h_{index}", root, m["wood_dark"], (lattice_x, y, z + dz), (0.055, width, 0.042), bevel=0.0)


def add_japanese_panel_door(
    prefix: str,
    root: bpy.types.Object,
    m: dict[str, bpy.types.Material],
    *,
    x: float,
    face_y: float,
    z_bottom: float,
    width: float,
    height: float,
) -> None:
    """Build a recessed panel door behind a clear wall aperture."""
    center_z = z_bottom + height / 2
    leaf_y = face_y + 0.14
    frame_y = face_y - 0.09
    reveal_y = (leaf_y + frame_y) / 2
    depth = leaf_y - frame_y + 0.1
    add_box(f"{prefix}_leaf", root, m["wood"], (x, leaf_y, center_z), (width, 0.09, height), bevel=0.026)
    for side, dx in (("left", -(width / 2 + 0.075)), ("right", width / 2 + 0.075)):
        add_box(f"{prefix}_jamb_{side}", root, m["wood_dark"], (x + dx, reveal_y, center_z), (0.15, depth, height + 0.22), bevel=0.018)
    add_box(f"{prefix}_lintel", root, m["wood_dark"], (x, reveal_y, z_bottom + height + 0.105), (width + 0.46, depth, 0.2), bevel=0.018)
    add_box(f"{prefix}_threshold", root, m["stone"], (x, face_y - 0.08, z_bottom + 0.055), (width + 0.3, 0.42, 0.11), bevel=0.025)
    for index, dx in enumerate((-width * 0.26, 0, width * 0.26)):
        add_box(f"{prefix}_stile_{index}", root, m["wood_dark"], (x + dx, leaf_y - 0.06, center_z), (0.06, 0.045, height * 0.9), bevel=0.0)
    for index, dz in enumerate((-height * 0.28, 0, height * 0.28)):
        add_box(f"{prefix}_rail_{index}", root, m["wood_dark"], (x, leaf_y - 0.06, center_z + dz), (width * 0.88, 0.045, 0.075), bevel=0.0)
    add_ico(f"{prefix}_pull", root, m["accent"], (x + width * 0.28, leaf_y - 0.1, center_z), (0.09, 0.055, 0.09), smooth=True)


def build_building_timber_frame_white_tile(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Two-storey expressed frame house with real apertures and layered tile roof."""
    add_box("GEO-building_timber_footing", root, m["stone_dark"], (0, 0, 0.17), (6.0, 4.75, 0.34), bevel=0.09)
    add_box("GEO-building_timber_stone_plinth", root, m["stone"], (0, 0, 0.45), (5.62, 4.38, 0.34), bevel=0.065)
    wall_bottom, wall_top = 0.62, 5.34
    front_y, rear_y = -2.0, 2.0
    west_x, east_x = -2.58, 2.58
    front_openings = (
        (-2.08, -1.22, 1.28, 2.34),
        (-0.56, 0.56, 0.64, 2.66),
        (1.22, 2.08, 1.28, 2.34),
        (-2.02, -1.28, 3.58, 4.62),
        (-0.37, 0.37, 3.58, 4.62),
        (1.28, 2.02, 3.58, 4.62),
    )
    rear_openings = (
        (-1.92, -1.08, 1.3, 2.32),
        (1.08, 1.92, 1.3, 2.32),
        (-0.42, 0.42, 3.58, 4.62),
    )
    side_openings = (
        (-1.25, -0.39, 1.3, 2.32),
        (0.39, 1.25, 1.3, 2.32),
        (-0.43, 0.43, 3.58, 4.62),
    )
    add_wall_panels_y(
        "GEO-building_timber_front_infill", root, m["plaster_white"],
        x_min=-2.48, x_max=2.48, z_min=wall_bottom, z_max=wall_top,
        y=front_y + 0.08, thickness=0.22, openings=front_openings,
    )
    add_wall_panels_y(
        "GEO-building_timber_rear_infill", root, m["plaster_white"],
        x_min=-2.48, x_max=2.48, z_min=wall_bottom, z_max=wall_top,
        y=rear_y - 0.08, thickness=0.22, openings=rear_openings,
    )
    add_wall_panels_x(
        "GEO-building_timber_west_infill", root, m["plaster_white"],
        y_min=-1.9, y_max=1.9, z_min=wall_bottom, z_max=wall_top,
        x=west_x + 0.08, thickness=0.22, openings=side_openings,
    )
    add_wall_panels_x(
        "GEO-building_timber_east_infill", root, m["plaster_white"],
        y_min=-1.9, y_max=1.9, z_min=wall_bottom, z_max=wall_top,
        x=east_x - 0.08, thickness=0.22, openings=side_openings,
    )

    for index, (x, y) in enumerate(((-2.58, -2.0), (2.58, -2.0), (-2.58, 2.0), (2.58, 2.0))):
        add_box(f"GEO-building_timber_corner_post_{index}", root, m["wood_dark"], (x, y, 2.98), (0.24, 0.24, 4.95), bevel=0.026)
    for face, y in (("front", -2.08), ("rear", 2.08)):
        for level, z in enumerate((0.67, 2.92, 5.28)):
            add_box(f"GEO-building_timber_{face}_plate_{level}", root, m["wood_dark"], (0, y, z), (5.28, 0.22, 0.2), bevel=0.024)
    for face, x in (("west", -2.66), ("east", 2.66)):
        for level, z in enumerate((0.67, 2.92, 5.28)):
            add_box(f"GEO-building_timber_{face}_plate_{level}", root, m["wood_dark"], (x, 0, z), (0.22, 4.18, 0.2), bevel=0.024)
    for index, x in enumerate((-1.15, -0.64, 0.64, 1.15)):
        add_box(f"GEO-building_timber_front_post_{index}", root, m["wood_dark"], (x, -2.09, 2.98), (0.15, 0.2, 4.72), bevel=0.018)
    for index, x in enumerate((-1.05, 0, 1.05)):
        add_box(f"GEO-building_timber_rear_post_{index}", root, m["wood_dark"], (x, 2.09, 2.98), (0.15, 0.2, 4.72), bevel=0.018)
    for side, x in (("west", -2.67), ("east", 2.67)):
        for index, y in enumerate((-0.34, 0.34)):
            add_box(f"GEO-building_timber_{side}_post_{index}", root, m["wood_dark"], (x, y, 2.98), (0.2, 0.15, 4.72), bevel=0.018)
    for side, sign in (("left", -1), ("right", 1)):
        add_beam(
            f"GEO-building_timber_front_brace_{side}", root, m["wood_dark"],
            (sign * 2.42, -2.11, 3.02), (sign * 1.48, -2.11, 5.22), 0.11, bevel=0.014,
        )
        add_beam(
            f"GEO-building_timber_rear_brace_{side}", root, m["wood_dark"],
            (sign * 2.42, 2.11, 3.02), (sign * 1.48, 2.11, 5.22), 0.11, bevel=0.014,
        )

    add_japanese_panel_door(
        "GEO-building_timber_entry", root, m, x=0, face_y=front_y,
        z_bottom=0.64, width=1.12, height=2.02,
    )
    for index, (x, z, width, height) in enumerate((
        (-1.65, 1.81, 0.86, 1.06), (1.65, 1.81, 0.86, 1.06),
        (-1.65, 4.1, 0.74, 1.04), (0, 4.1, 0.74, 1.04), (1.65, 4.1, 0.74, 1.04),
    )):
        add_japanese_window_y(f"GEO-building_timber_front_window_{index}", root, m, x=x, face_y=front_y, outward=-1, z=z, width=width, height=height)
    for index, (x, z, width, height) in enumerate((
        (-1.5, 1.81, 0.84, 1.02), (1.5, 1.81, 0.84, 1.02), (0, 4.1, 0.84, 1.04),
    )):
        add_japanese_window_y(f"GEO-building_timber_rear_window_{index}", root, m, x=x, face_y=rear_y, outward=1, z=z, width=width, height=height)
    for side, face_x, outward in (("west", west_x, -1), ("east", east_x, 1)):
        for index, (y, z, width, height) in enumerate(((-0.82, 1.81, 0.86, 1.02), (0.82, 1.81, 0.86, 1.02), (0, 4.1, 0.86, 1.04))):
            add_japanese_window_x(f"GEO-building_timber_{side}_window_{index}", root, m, y=y, face_x=face_x, outward=outward, z=z, width=width, height=height)

    for index, (z, width, depth) in enumerate(((0.09, 1.72, 0.7), (0.2, 1.48, 0.62), (0.32, 1.22, 0.54))):
        add_box(f"GEO-building_timber_entry_step_{index}", root, m["stone"], (0, -2.34 - index * 0.12, z / 2), (width, depth, z), bevel=0.045)

    pitch = 37.0
    ridge_z, _ = add_pitched_roof_planes(
        "GEO-building_timber_tile_deck", root, m["tile"], width=6.28, depth=5.28,
        eave_z=5.5, pitch_degrees=pitch, thickness=0.18, bevel=0.024,
    )
    add_gable_end("GEO-building_timber_front_gable_infill", root, m["plaster_white"], width=5.03, face_y=-1.98, thickness=0.18, eave_z=5.3, ridge_z=ridge_z - 0.09)
    add_gable_end("GEO-building_timber_rear_gable_infill", root, m["plaster_white"], width=5.03, face_y=1.98, thickness=0.18, eave_z=5.3, ridge_z=ridge_z - 0.09)
    add_roof_courses(
        "GEO-building_timber_tile_course", root, (m["tile"], m["tile_edge"]), width=6.28, depth=5.3,
        eave_z=5.5, pitch_degrees=pitch, plane_thickness=0.18, course_count=8, course_depth=0.052, course_bevel=0.0,
    )
    add_tapered("GEO-building_timber_tile_ridge", root, m["tile_edge"], (0, -2.72, ridge_z + 0.09), (0, 2.72, ridge_z + 0.09), 0.13, 0.13, vertices=9, bevel=0.012)
    for end, y in (("front", -2.68), ("rear", 2.68)):
        add_beam(f"GEO-building_timber_truss_{end}_left", root, m["wood_dark"], (-3.0, y, 5.38), (0, y, ridge_z - 0.1), 0.12, bevel=0.016)
        add_beam(f"GEO-building_timber_truss_{end}_right", root, m["wood_dark"], (3.0, y, 5.38), (0, y, ridge_z - 0.1), 0.12, bevel=0.016)
        add_beam(f"GEO-building_timber_truss_{end}_tie", root, m["wood_dark"], (-2.47, y, 5.35), (2.47, y, 5.35), 0.12, bevel=0.016)
    add_box("GEO-building_timber_eave_front", root, m["tile_edge"], (0, -2.72, 5.46), (6.36, 0.16, 0.15), bevel=0.022)
    add_box("GEO-building_timber_eave_rear", root, m["tile_edge"], (0, 2.72, 5.46), (6.36, 0.16, 0.15), bevel=0.022)


def add_pagoda_stage(
    root: bpy.types.Object,
    m: dict[str, bpy.types.Material],
    *,
    label: str,
    z_bottom: float,
    z_top: float,
    wall_width: float,
    wall_depth: float,
    roof_width: float,
    roof_depth: float,
    roof_ridge_z: float,
) -> None:
    wall_height = z_top - z_bottom
    center_z = (z_bottom + z_top) / 2
    panel_depth = 0.18
    door_width = wall_width * 0.26
    side_width = (wall_width - door_width) / 2
    add_box(f"GEO-pagoda_{label}_front_infill_left", root, m["plaster_white"], (-(door_width + side_width) / 2, -wall_depth / 2, center_z), (side_width - 0.12, panel_depth, wall_height - 0.18), bevel=0.0)
    add_box(f"GEO-pagoda_{label}_front_infill_right", root, m["plaster_white"], ((door_width + side_width) / 2, -wall_depth / 2, center_z), (side_width - 0.12, panel_depth, wall_height - 0.18), bevel=0.0)
    add_box(f"GEO-pagoda_{label}_rear_infill", root, m["plaster_white"], (0, wall_depth / 2, center_z), (wall_width - 0.24, panel_depth, wall_height - 0.18), bevel=0.0)
    add_box(f"GEO-pagoda_{label}_west_infill", root, m["plaster_white"], (-wall_width / 2, 0, center_z), (panel_depth, wall_depth - 0.24, wall_height - 0.18), bevel=0.0)
    add_box(f"GEO-pagoda_{label}_east_infill", root, m["plaster_white"], (wall_width / 2, 0, center_z), (panel_depth, wall_depth - 0.24, wall_height - 0.18), bevel=0.0)
    for index, (x, y) in enumerate(((-wall_width / 2, -wall_depth / 2), (wall_width / 2, -wall_depth / 2), (-wall_width / 2, wall_depth / 2), (wall_width / 2, wall_depth / 2))):
        add_box(f"GEO-pagoda_{label}_corner_post_{index}", root, m["wood_dark"], (x, y, center_z), (0.24, 0.24, wall_height + 0.12), bevel=0.026)
    for face, y in (("front", -wall_depth / 2 - 0.03), ("rear", wall_depth / 2 + 0.03)):
        add_box(f"GEO-pagoda_{label}_{face}_sill", root, m["wood_dark"], (0, y, z_bottom + 0.08), (wall_width + 0.2, 0.21, 0.18), bevel=0.022)
        add_box(f"GEO-pagoda_{label}_{face}_top_plate", root, m["wood_dark"], (0, y, z_top - 0.06), (wall_width + 0.25, 0.23, 0.2), bevel=0.022)
    for face, x in (("west", -wall_width / 2 - 0.03), ("east", wall_width / 2 + 0.03)):
        add_box(f"GEO-pagoda_{label}_{face}_sill", root, m["wood_dark"], (x, 0, z_bottom + 0.08), (0.21, wall_depth + 0.2, 0.18), bevel=0.022)
        add_box(f"GEO-pagoda_{label}_{face}_top_plate", root, m["wood_dark"], (x, 0, z_top - 0.06), (0.23, wall_depth + 0.25, 0.2), bevel=0.022)
    add_box(f"GEO-pagoda_{label}_door_recess", root, m["vermilion_dark"], (0, -wall_depth / 2 - 0.02, center_z - 0.04), (door_width, 0.17, wall_height * 0.78), bevel=0.024)
    for index, x in enumerate((-door_width * 0.26, 0, door_width * 0.26)):
        add_box(f"GEO-pagoda_{label}_door_stile_{index}", root, m["vermilion"], (x, -wall_depth / 2 - 0.12, center_z - 0.04), (0.06, 0.06, wall_height * 0.7), bevel=0.0)
    bracket_z = z_top + 0.04
    positions = (-0.34, 0, 0.34)
    for index, t in enumerate(positions):
        add_box(f"GEO-pagoda_{label}_bracket_front_{index}", root, m["vermilion"], (t * wall_width, -wall_depth / 2 - 0.27, bracket_z), (0.34, 0.62, 0.2), bevel=0.0)
        add_box(f"GEO-pagoda_{label}_bracket_rear_{index}", root, m["vermilion_dark"], (t * wall_width, wall_depth / 2 + 0.27, bracket_z), (0.34, 0.62, 0.2), bevel=0.0)
        add_box(f"GEO-pagoda_{label}_bracket_west_{index}", root, m["vermilion_dark"], (-wall_width / 2 - 0.27, t * wall_depth, bracket_z), (0.62, 0.34, 0.2), bevel=0.0)
        add_box(f"GEO-pagoda_{label}_bracket_east_{index}", root, m["vermilion"], (wall_width / 2 + 0.27, t * wall_depth, bracket_z), (0.62, 0.34, 0.2), bevel=0.0)
    roof_eave_z = z_top + 0.18
    add_hip_roof_shell(
        f"GEO-pagoda_{label}_slate_roof", root, m["slate"], width=roof_width, depth=roof_depth,
        top_width=wall_width * 0.58, top_depth=wall_depth * 0.58,
        eave_z=roof_eave_z, ridge_z=roof_ridge_z, thickness=0.2,
    )
    add_hip_roof_details(
        f"GEO-pagoda_{label}_slate", root, m["slate"], m["slate_edge"], width=roof_width, depth=roof_depth,
        top_width=wall_width * 0.58, top_depth=wall_depth * 0.58,
        eave_z=roof_eave_z, ridge_z=roof_ridge_z,
    )


def build_pagoda(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    add_box("GEO-pagoda_rubble_footing", root, m["stone_dark"], (0, 0, 0.16), (6.4, 6.4, 0.32), bevel=0.09)
    add_box("GEO-pagoda_stone_podium", root, m["stone"], (0, 0, 0.43), (5.92, 5.92, 0.34), bevel=0.07)
    for index, (z, size) in enumerate(((0.12, 6.72), (0.27, 6.42), (0.43, 6.12))):
        add_box(f"GEO-pagoda_podium_course_{index}", root, m["stone" if index else "stone_dark"], (0, 0, z / 2), (size, size, z), bevel=0.045)
    add_pagoda_stage(root, m, label="lower", z_bottom=0.58, z_top=3.15, wall_width=4.75, wall_depth=4.75, roof_width=7.2, roof_depth=7.2, roof_ridge_z=4.38)
    add_pagoda_stage(root, m, label="middle", z_bottom=4.06, z_top=6.05, wall_width=3.8, wall_depth=3.8, roof_width=5.9, roof_depth=5.9, roof_ridge_z=7.1)
    add_pagoda_stage(root, m, label="upper", z_bottom=6.84, z_top=8.42, wall_width=3.0, wall_depth=3.0, roof_width=4.75, roof_depth=4.75, roof_ridge_z=9.28)
    add_tapered("GEO-pagoda_finial_shaft", root, m["accent"], (0, 0, 9.14), (0, 0, 13.42), 0.12, 0.075, vertices=10, bevel=0.012)
    for index in range(7):
        z = 9.62 + index * 0.43
        radius = 0.43 - index * 0.038
        add_tapered(f"GEO-pagoda_finial_ring_{index}", root, m["accent"], (0, 0, z), (0, 0, z + 0.1), radius, radius * 0.94, vertices=12, bevel=0.0)
    add_tapered("GEO-pagoda_finial_canopy", root, m["slate_edge"], (0, 0, 12.72), (0, 0, 12.96), 0.56, 0.18, vertices=12, bevel=0.0)
    add_tapered("GEO-pagoda_finial_flame", root, m["accent"], (0, 0, 13.2), (0, 0, 13.88), 0.18, 0.02, vertices=9, bevel=0.0)


def build_torii(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    for index, x in enumerate((-2.18, 2.18)):
        add_box(f"GEO-torii_stone_pad_{index}", root, m["stone_dark"], (x, 0, 0.13), (0.94, 0.94, 0.26), bevel=0.09)
        add_tapered(f"GEO-torii_stone_base_{index}", root, m["stone"], (x, 0, 0.2), (x, 0, 0.58), 0.42, 0.34, vertices=10, bevel=0.025)
    add_tapered("GEO-torii_post_left", root, m["vermilion"], (-2.18, 0, 0.42), (-2.02, 0, 4.36), 0.31, 0.235, vertices=12, bevel=0.026)
    add_tapered("GEO-torii_post_right", root, m["vermilion"], (2.18, 0, 0.42), (2.02, 0, 4.36), 0.31, 0.235, vertices=12, bevel=0.026)
    add_box("GEO-torii_nuki_through_beam", root, m["vermilion"], (0, 0, 3.52), (5.18, 0.34, 0.3), bevel=0.045)
    add_box("GEO-torii_nuki_shadow", root, m["vermilion_dark"], (0, 0.06, 3.37), (4.48, 0.18, 0.13), bevel=0.022)
    for index, x in enumerate((-2.08, 2.08)):
        add_box(f"GEO-torii_nuki_wedge_{index}", root, m["vermilion_dark"], (x, 0, 3.33), (0.4, 0.44, 0.18), rotation=(0, math.radians(8 if x < 0 else -8), 0), bevel=0.026)
    add_box("GEO-torii_shimaki", root, m["vermilion"], (0, 0, 4.34), (5.72, 0.48, 0.3), bevel=0.055)
    add_beam("GEO-torii_kasagi_center", root, m["tile_edge"], (-2.5, 0, 4.68), (2.5, 0, 4.68), 0.34, bevel=0.045)
    add_beam("GEO-torii_kasagi_left_tip", root, m["tile_edge"], (-2.5, 0, 4.68), (-3.12, 0, 4.96), 0.34, bevel=0.045)
    add_beam("GEO-torii_kasagi_right_tip", root, m["tile_edge"], (2.5, 0, 4.68), (3.12, 0, 4.96), 0.34, bevel=0.045)
    add_beam("GEO-torii_kasagi_red_center", root, m["vermilion_dark"], (-2.48, 0, 4.49), (2.48, 0, 4.49), 0.18, bevel=0.028)
    add_box("GEO-torii_central_plaque", root, m["vermilion_dark"], (0, -0.22, 3.98), (0.72, 0.16, 0.64), bevel=0.055)
    add_box("GEO-torii_plaque_inset", root, m["accent"], (0, -0.315, 3.98), (0.51, 0.04, 0.43), bevel=0.025)


def build_bridge(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Build a grounded Japanese-compatible timber beam bridge along local +X."""

    def add_battered_support(
        name: str,
        x: float,
        bottom_length: float,
        top_length: float,
        bottom_width: float,
        top_width: float,
        height: float,
        mat: bpy.types.Material,
    ) -> None:
        bottom_x, top_x = bottom_length / 2, top_length / 2
        bottom_y, top_y = bottom_width / 2, top_width / 2
        add_mesh(
            name,
            root,
            mat,
            (
                (x - bottom_x, -bottom_y, 0), (x + bottom_x, -bottom_y, 0),
                (x + bottom_x, bottom_y, 0), (x - bottom_x, bottom_y, 0),
                (x - top_x, -top_y, height), (x + top_x, -top_y, height),
                (x + top_x, top_y, height), (x - top_x, top_y, height),
            ),
            (
                (0, 3, 2, 1), (4, 5, 6, 7),
                (0, 1, 5, 4), (1, 2, 6, 5),
                (2, 3, 7, 6), (3, 0, 4, 7),
            ),
        )

    # Stone supports make the structural load path legible and establish the
    # exact 16.0 m exported span without introducing a hidden collision slab.
    for side, x in (("west", -7.55), ("east", 7.55)):
        add_battered_support(
            f"GEO-bridge_abutment_{side}", x, 0.9, 0.72, 3.4, 3.14, 0.72, m["stone"],
        )
        add_box(
            f"GEO-bridge_abutment_cap_{side}", root, m["stone_dark"],
            (x, 0, 0.79), (0.9, 3.28, 0.16), bevel=0.01,
        )
    for index, x in enumerate((-2.7, 2.7)):
        add_battered_support(
            f"GEO-bridge_pier_{index}", x, 0.62, 0.48, 2.66, 2.34, 0.78, m["stone"],
        )

    # Four redundant longitudinal stringers carry the crossing direction;
    # cross beams and fascia visibly lock the deck into one lateral assembly.
    for index, y in enumerate((-1.12, -0.38, 0.38, 1.12)):
        add_box(
            f"GEO-bridge_stringer_{index}", root, m["wood_dark"],
            (0, y, 0.95), (15.42, 0.24, 0.34), bevel=0.01,
        )
    for index, x in enumerate((-6.6, -3.3, 0, 3.3, 6.6)):
        add_box(
            f"GEO-bridge_cross_beam_{index}", root, m["wood"],
            (x, 0, 1.07), (0.26, 3.24, 0.2), bevel=0.01,
        )
    for side, y in (("south", -1.59), ("north", 1.59)):
        add_box(
            f"GEO-bridge_fascia_{side}", root, m["wood_dark"],
            (0, y, 1.16), (15.62, 0.18, 0.22), bevel=0.01,
        )
    for side, x in (("west", -7.74), ("east", 7.74)):
        add_box(
            f"GEO-bridge_end_threshold_{side}", root, m["wood_dark"],
            (x, 0, 1.16), (0.28, 3.4, 0.2), bevel=0.01,
        )

    # Transverse, individually replaceable deck courses preserve board rhythm
    # at map distance; their 4 cm gaps remain visible in the GLB roundtrip.
    for index in range(20):
        x = -7.6 + index * 0.8
        deck_mat = m["wood"] if index % 5 == 2 else m["wood_light"]
        add_box(
            f"GEO-bridge_deck_course_{index:02d}", root, deck_mat,
            (x, 0, 1.18), (0.76, 3.4, 0.16), bevel=0.01,
        )

    post_xs = (-7.25, -4.35, -1.45, 1.45, 4.35, 7.25)

    def rail_height(x: float) -> float:
        absolute_x = abs(x)
        if absolute_x <= 2.44:
            return 2.28
        return 2.28 - (absolute_x - 2.44) / (7.32 - 2.44) * 0.14

    for side, y in (("south", -1.59), ("north", 1.59)):
        add_box(
            f"GEO-bridge_lower_rail_{side}", root, m["wood_dark"],
            (0, y, 1.61), (14.62, 0.14, 0.14), bevel=0.01,
        )
        for index, x in enumerate(post_xs):
            top_z = rail_height(x) + 0.035
            add_box(
                f"GEO-bridge_rail_post_{side}_{index}", root, m["wood_dark"],
                (x, y, (1.2 + top_z) / 2), (0.18, 0.18, top_z - 1.2), bevel=0.01,
            )
        rail_points = (
            (-7.32, y, 2.14), (-2.44, y, 2.28),
            (2.44, y, 2.28), (7.32, y, 2.14),
        )
        for index in range(3):
            add_beam(
                f"GEO-bridge_top_rail_{side}_{index}", root, m["wood_dark"],
                rail_points[index], rail_points[index + 1], 0.18, bevel=0.01,
            )
        for index, (x0, x1) in enumerate(zip(post_xs, post_xs[1:])):
            if index % 2 == 0:
                start, end = (x0 + 0.16, y, 1.48), (x1 - 0.16, y, 2.07)
            else:
                start, end = (x0 + 0.16, y, 2.07), (x1 - 0.16, y, 1.48)
            add_beam(
                f"GEO-bridge_diagonal_brace_{side}_{index}", root, m["wood"],
                start, end, 0.115, bevel=0.01,
            )
        for index, x in enumerate((post_xs[0], post_xs[-1])):
            add_tapered(
                f"GEO-bridge_end_finial_{side}_{index}", root, m["wood"],
                (x, y, 2.18), (x, y, 2.4), 0.11, 0.035, vertices=4,
            )


def build_watchtower(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    for index, (x, y) in enumerate(((-1.62, -1.35), (1.62, -1.35), (-1.62, 1.35), (1.62, 1.35))):
        add_box(f"GEO-watchtower_stone_footing_{index}", root, m["stone"], (x, y, 0.18), (0.62, 0.62, 0.36), bevel=0.09)
    corners = ((-1.35, -1.12), (1.35, -1.12), (-1.35, 1.12), (1.35, 1.12))
    for index, (x, y) in enumerate(corners):
        add_tapered(f"GEO-watchtower_leg_{index}", root, m["wood_dark"], (x * 1.16, y * 1.16, -0.05), (x, y, 6.6), 0.17, 0.13, vertices=7, bevel=0.018)
    brace_faces = [
        ((-1.5, -1.28, 0.7), (1.4, -1.16, 5.8)),
        ((1.5, -1.28, 0.7), (-1.4, -1.16, 5.8)),
        ((-1.5, 1.28, 0.7), (1.4, 1.16, 5.8)),
        ((1.5, 1.28, 0.7), (-1.4, 1.16, 5.8)),
        ((-1.53, -1.15, 0.85), (-1.39, 1.12, 5.7)),
        ((-1.53, 1.15, 0.85), (-1.39, -1.12, 5.7)),
        ((1.53, -1.15, 0.85), (1.39, 1.12, 5.7)),
        ((1.53, 1.15, 0.85), (1.39, -1.12, 5.7)),
    ]
    for index, (start, end) in enumerate(brace_faces):
        add_beam(f"GEO-watchtower_brace_{index}", root, m["wood"], start, end, 0.11, bevel=0.018)
    add_box("GEO-watchtower_platform", root, m["wood_light"], (0, 0, 6.45), (3.55, 3.08, 0.26), bevel=0.06)
    add_box("GEO-watchtower_cabin_cladding", root, m["wood"], (0, 0.08, 7.42), (2.85, 2.42, 1.72), bevel=0.055)
    for index, (x, y) in enumerate(((-1.39, -1.17), (1.39, -1.17), (-1.39, 1.25), (1.39, 1.25))):
        add_box(f"GEO-watchtower_cabin_corner_{index}", root, m["wood_dark"], (x, y, 7.42), (0.16, 0.16, 1.88), bevel=0.018)
    add_box("GEO-watchtower_cabin_sill", root, m["wood_dark"], (0, 0.08, 6.57), (3.0, 2.55, 0.16), bevel=0.022)
    add_box("GEO-watchtower_cabin_top_plate", root, m["wood_dark"], (0, 0.08, 8.27), (3.0, 2.55, 0.16), bevel=0.022)
    for index, x in enumerate((-0.76, 0, 0.76)):
        add_front_window_assembly(
            f"GEO-watchtower_window_{index}", root, m, x=x, face_y=-1.19, z=7.55,
            width=0.46, height=0.58, frame_material="wood_dark", sill_material="wood_light",
        )
    add_front_panel_door("GEO-watchtower_door", root, m, face_y=1.3, z_bottom=6.58, width=0.72, height=1.36)
    tower_pitch = 36.0
    tower_ridge_z, _ = add_pitched_roof_planes(
        "GEO-watchtower_slate", root, m["slate"], width=3.52, depth=3.18,
        eave_z=8.34, pitch_degrees=tower_pitch, thickness=0.16, bevel=0.022,
    )
    add_roof_courses(
        "GEO-watchtower_slate_course", root, (m["slate"], m["slate_edge"]), width=3.52, depth=3.2,
        eave_z=8.34, pitch_degrees=tower_pitch, plane_thickness=0.16, course_count=5, course_depth=0.045,
    )
    add_tapered("GEO-watchtower_roof_ridge", root, m["slate_edge"], (0, -1.64, tower_ridge_z + 0.07), (0, 1.64, tower_ridge_z + 0.07), 0.085, 0.085, vertices=8)
    for end, y in (("front", -1.61), ("rear", 1.61)):
        add_beam(f"GEO-watchtower_truss_{end}_left", root, m["wood_dark"], (-1.65, y, 8.28), (0, y, tower_ridge_z - 0.05), 0.085, bevel=0.012)
        add_beam(f"GEO-watchtower_truss_{end}_right", root, m["wood_dark"], (1.65, y, 8.28), (0, y, tower_ridge_z - 0.05), 0.085, bevel=0.012)
    rail_points = ((-1.6, -1.36), (1.6, -1.36), (-1.6, 1.36), (1.6, 1.36))
    for index, (x, y) in enumerate(rail_points):
        add_tapered(f"GEO-watchtower_rail_post_{index}", root, m["metal"], (x, y, 6.55), (x, y, 7.16), 0.04, 0.04, vertices=6)
    for index, z in enumerate((1.0, 1.65, 2.3, 2.95, 3.6, 4.25, 4.9, 5.55, 6.2)):
        add_tapered(f"GEO-watchtower_ladder_rung_{index}", root, m["metal"], (-0.42, -1.55, z), (0.42, -1.55, z), 0.04, 0.04, vertices=6)
    add_tapered("GEO-watchtower_ladder_left", root, m["metal"], (-0.48, -1.55, 0.35), (-0.48, -1.55, 6.55), 0.055, 0.055, vertices=7)
    add_tapered("GEO-watchtower_ladder_right", root, m["metal"], (0.48, -1.55, 0.35), (0.48, -1.55, 6.55), 0.055, 0.055, vertices=7)
    add_tapered("GEO-watchtower_antenna", root, m["metal"], (0.68, 0.45, 9.05), (0.68, 0.45, 10.35), 0.035, 0.012, vertices=7)


def build_ship(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    sections = [
        (-4.25, 0.16, 1.05, 0.62),
        (-2.6, 1.35, 1.30, 0.08),
        (-0.5, 1.72, 1.42, -0.02),
        (2.35, 1.35, 1.38, 0.20),
        (4.5, 0.12, 1.55, 0.82),
    ]
    vertices: list[tuple[float, float, float]] = []
    for x, width, top, bottom in sections:
        vertices.extend(((x, -width, top), (x, width, top), (x, width * 0.34, bottom), (x, -width * 0.34, bottom)))
    faces: list[tuple[int, ...]] = []
    for index in range(len(sections) - 1):
        a, b = index * 4, (index + 1) * 4
        faces.extend(
            (
                (a, b, b + 3, a + 3),
                (a + 1, a + 2, b + 2, b + 1),
                (a + 3, b + 3, b + 2, a + 2),
                (a, a + 1, b + 1, b),
            )
        )
    faces.extend(((0, 3, 2, 1), (16, 17, 18, 19)))
    add_mesh("GEO-ship_hull", root, m["hull"], vertices, faces, bevel=0.045)
    add_box("GEO-ship_deck", root, m["wood_light"], (-0.15, 0, 1.38), (6.7, 2.48, 0.18), bevel=0.08)
    add_box("GEO-ship_cabin", root, m["wood"], (-2.05, 0, 2.0), (1.85, 1.9, 1.15), bevel=0.1)
    add_box("GEO-ship_cabin_roof", root, m["wood_dark"], (-2.05, 0, 2.65), (2.2, 2.16, 0.18), bevel=0.06)
    for index, y in enumerate((-0.96, 0.96)):
        add_box(f"GEO-ship_cabin_window_{index}", root, m["glass"], (-2.05, y, 2.13), (0.78, 0.08, 0.5), bevel=0.03)
    add_tapered("GEO-ship_mast", root, m["wood_dark"], (0.25, 0, 1.25), (0.25, 0, 6.45), 0.12, 0.075, vertices=9, bevel=0.018)
    add_tapered("GEO-ship_boom", root, m["wood"], (0.25, 0, 2.35), (-3.3, 0, 2.35), 0.09, 0.055, vertices=8)
    add_mesh(
        "GEO-ship_main_sail", root, m["canvas"],
        ((0.15, 0.02, 6.1), (0.15, 0.02, 2.55), (-3.05, 0.02, 2.55)), ((0, 1, 2),),
    )
    add_mesh(
        "GEO-ship_jib_sail", root, m["canvas"],
        ((0.38, 0.02, 5.55), (0.38, 0.02, 2.55), (3.78, 0.02, 2.0)), ((0, 1, 2),),
    )
    add_tapered("GEO-ship_forestay", root, m["metal_dark"], (0.27, 0, 6.34), (4.13, 0, 1.58), 0.018, 0.018, vertices=5)
    for side, y in (("port", -1.35), ("starboard", 1.35)):
        add_tapered(f"GEO-ship_rail_{side}", root, m["metal"], (-3.0, y, 1.68), (3.25, y, 1.68), 0.035, 0.035, vertices=6)
        for index, x in enumerate((-2.8, -1.4, 0, 1.4, 2.8)):
            add_tapered(f"GEO-ship_rail_post_{side}_{index}", root, m["metal"], (x, y, 1.38), (x, y, 1.72), 0.025, 0.025, vertices=6)
    add_tapered("GEO-ship_bowsprit", root, m["wood_dark"], (3.7, 0, 1.55), (5.12, 0, 1.82), 0.08, 0.035, vertices=7)
    add_ico("GEO-ship_mast_cap", root, m["accent"], (0.25, 0, 6.48), (0.18, 0.18, 0.18), smooth=True)


def build_tank(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    for side, y in (("left", -1.12), ("right", 1.12)):
        add_box(f"GEO-tank_track_{side}", root, m["metal_dark"], (0, y, 0.58), (4.75, 0.58, 1.08), bevel=0.19)
        for index, x in enumerate((-1.75, -0.86, 0, 0.86, 1.75)):
            add_tapered(
                f"GEO-tank_wheel_{side}_{index}", root, m["metal"],
                (x, y - 0.35, 0.58), (x, y + 0.35, 0.58), 0.37, 0.37, vertices=10, bevel=0.025,
            )
    add_box("GEO-tank_lower_hull", root, m["paint_green"], (0, 0, 1.08), (4.15, 2.12, 0.72), bevel=0.13)
    add_box("GEO-tank_upper_hull", root, m["paint_green"], (-0.25, 0, 1.55), (3.35, 1.82, 0.64), rotation=(0, math.radians(-4), 0), bevel=0.12)
    add_tapered("GEO-tank_turret", root, m["paint_green"], (-0.22, 0, 1.78), (-0.22, 0, 2.38), 0.98, 0.8, vertices=12, bevel=0.05)
    add_tapered("GEO-tank_barrel", root, m["metal_dark"], (0.45, 0, 2.16), (3.33, 0, 2.18), 0.13, 0.09, vertices=9, bevel=0.025)
    add_tapered("GEO-tank_muzzle", root, m["metal"], (3.15, 0, 2.18), (3.58, 0, 2.18), 0.17, 0.15, vertices=10, bevel=0.025)
    add_tapered("GEO-tank_hatch", root, m["metal"], (-0.4, 0, 2.36), (-0.4, 0, 2.58), 0.42, 0.37, vertices=10, bevel=0.035)
    add_box("GEO-tank_front_plate", root, m["rust"], (1.93, 0, 1.35), (0.22, 1.78, 0.62), rotation=(0, math.radians(-10), 0), bevel=0.06)
    add_tapered("GEO-tank_antenna", root, m["metal"], (-0.85, 0.48, 2.38), (-0.92, 0.5, 3.12), 0.025, 0.008, vertices=6)
    add_box("GEO-tank_rear_stowage", root, m["wood_dark"], (-1.75, 0, 1.62), (0.55, 1.38, 0.48), bevel=0.08)


def build_dragon(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Massive low-poly wyvern with a long coiled body and unmistakable wing span."""
    body_path = (
        (-5.2, 1.2, 0.7), (-3.8, 0.15, 0.95), (-2.0, -0.7, 1.15),
        (0.0, -0.55, 1.5), (1.8, 0.0, 1.8), (3.0, -0.15, 2.65),
        (3.75, -0.05, 3.65), (4.35, -0.15, 4.4),
    )
    radii = (0.18, 0.34, 0.62, 0.93, 0.82, 0.57, 0.42, 0.29)
    for index, (start, end) in enumerate(zip(body_path, body_path[1:])):
        add_tapered(
            f"GEO-dragon_body_segment_{index:02d}", root,
            m["dragon_scale" if index % 2 == 0 else "dragon_belly"],
            start, end, radii[index], radii[index + 1], vertices=8,
        )
    add_ico("GEO-dragon_chest", root, m["dragon_scale"], (1.65, 0, 1.85), (2.35, 1.75, 1.85), subdivisions=1)
    add_ico("GEO-dragon_head", root, m["dragon_scale"], (4.62, -0.14, 4.54), (1.35, 0.98, 0.86), subdivisions=1)
    add_tapered("GEO-dragon_muzzle", root, m["dragon_belly"], (4.7, -0.14, 4.45), (5.62, -0.14, 4.36), 0.43, 0.22, vertices=7)
    for side, y in (("left", -0.33), ("right", 0.06)):
        add_ico(f"GEO-dragon_eye_{side}", root, m["accent"], (5.0, y, 4.72), (0.13, 0.09, 0.13), smooth=True)
    for side, y_sign in (("left", -1), ("right", 1)):
        add_tapered(
            f"GEO-dragon_horn_{side}", root, m["stone_dark"],
            (4.25, y_sign * 0.34 - 0.14, 4.8), (3.82, y_sign * 0.52 - 0.14, 5.38), 0.13, 0.015, vertices=6,
        )
        shoulder = Vector((1.55, y_sign * 0.68, 2.28))
        elbow = Vector((-0.05, y_sign * 2.5, 4.65))
        tip = Vector((-2.9, y_sign * 4.15, 2.55))
        add_tapered(f"GEO-dragon_wing_bone_{side}_0", root, m["dragon_scale"], shoulder, elbow, 0.18, 0.11, vertices=7)
        add_tapered(f"GEO-dragon_wing_bone_{side}_1", root, m["dragon_scale"], elbow, tip, 0.12, 0.035, vertices=7)
        trailing = Vector((-1.65, y_sign * 3.15, 1.48))
        add_tapered(f"GEO-dragon_wing_finger_{side}", root, m["dragon_scale"], elbow, trailing, 0.08, 0.025, vertices=6)
        add_mesh(
            f"GEO-dragon_wing_membrane_{side}", root, m["dragon_membrane"],
            (shoulder, elbow, tip, trailing, Vector((0.25, y_sign * 1.0, 1.6))),
            ((0, 1, 3, 4), (1, 2, 3), (4, 3, 1, 0)),
        )
        for leg_index, (hip, foot) in enumerate((
            ((1.1, y_sign * 0.58, 1.35), (0.25, y_sign * 1.25, 0.0)),
            ((2.1, y_sign * 0.55, 1.45), (2.65, y_sign * 1.12, 0.0)),
        )):
            knee = Vector(hip).lerp(Vector(foot), 0.5) + Vector((0.18 if leg_index else -0.2, y_sign * 0.15, 0.18))
            add_tapered(f"GEO-dragon_leg_{side}_{leg_index}_upper", root, m["dragon_scale"], hip, knee, 0.2, 0.14, vertices=7)
            add_tapered(f"GEO-dragon_leg_{side}_{leg_index}_lower", root, m["dragon_belly"], knee, foot, 0.14, 0.09, vertices=7)
            for claw in (-0.14, 0, 0.14):
                add_tapered(
                    f"GEO-dragon_claw_{side}_{leg_index}_{claw:+.2f}", root, m["stone_dark"],
                    (foot[0], foot[1] + claw, 0.08), (foot[0] + 0.32, foot[1] + claw, 0.015), 0.045, 0.008, vertices=5,
                )
    for index, (start, end) in enumerate(zip(body_path[1:6], body_path[2:7])):
        midpoint = Vector(start).lerp(Vector(end), 0.5)
        add_tapered(
            f"GEO-dragon_dorsal_spine_{index:02d}", root, m["stone_dark"],
            midpoint + Vector((0, 0, radii[index + 1] * 0.7)),
            midpoint + Vector((0, 0, radii[index + 1] * 1.35 + 0.26)), 0.11, 0.01, vertices=5,
        )


def build_windmill(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """European post mill silhouette with masonry base, timber cap, and four cloth sails."""
    add_tapered("GEO-windmill_masonry_tower", root, m["stone"], (0, 0, 0), (0, 0, 5.9), 2.05, 1.42, vertices=12, bevel=0.04)
    for z in (0.5, 1.45, 2.4, 3.35, 4.3, 5.25):
        add_cylinder(f"GEO-windmill_masonry_course_{z:.2f}", root, m["stone_dark"], (0, 0, z), 1.76 - z * 0.045, 0.08, vertices=12)
    add_box("GEO-windmill_door_recess", root, m["wood_dark"], (0, -1.84, 1.05), (0.88, 0.15, 1.65), bevel=0.025)
    for z in (2.65, 4.15):
        add_box(f"GEO-windmill_window_recess_{z:.2f}", root, m["glass"], (0, -1.55, z), (0.56, 0.11, 0.72), bevel=0.02)
        for x in (-0.31, 0.31):
            add_box(f"GEO-windmill_window_jamb_{z:.2f}_{x:+.2f}", root, m["limestone"], (x, -1.61, z), (0.12, 0.15, 0.88), bevel=0.02)
    add_tapered("GEO-windmill_cap", root, m["thatch_dark"], (0, 0, 5.7), (0, 0, 7.15), 1.65, 0.08, vertices=12)
    hub = Vector((0, -1.72, 5.42))
    add_cylinder("GEO-windmill_hub", root, m["metal_dark"], hub, 0.38, 0.55, vertices=10, rotation=(math.radians(90), 0, 0), bevel=0.025)
    for sail in range(4):
        angle = math.radians(45 + sail * 90)
        direction = Vector((math.cos(angle), 0, math.sin(angle)))
        side = Vector((-math.sin(angle), 0, math.cos(angle)))
        inner = hub + direction * 0.36
        outer = hub + direction * 4.25
        add_beam(f"GEO-windmill_sail_spar_{sail}", root, m["wood_dark"], inner, outer, 0.14, bevel=0.02)
        for rung in range(1, 7):
            center = hub + direction * (0.52 + rung * 0.54)
            width = 0.18 + rung * 0.07
            add_beam(f"GEO-windmill_sail_rung_{sail}_{rung}", root, m["wood"], center - side * width, center + side * width, 0.065, bevel=0.0)
        p0 = hub + direction * 0.62 - side * 0.2
        p1 = hub + direction * 0.62 + side * 0.2
        p2 = hub + direction * 4.05 + side * 0.6
        p3 = hub + direction * 4.05 - side * 0.6
        add_mesh(f"GEO-windmill_sail_canvas_{sail}", root, m["canvas"], (p0, p1, p2, p3), ((0, 1, 2, 3), (3, 2, 1, 0)))


def build_mine(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Mine headframe, ore skip, rail approach, and hoist shed as one reusable mine structure."""
    for side, y in (("front", -1.05), ("rear", 1.05)):
        for x in (-1.25, 1.25):
            add_beam(f"GEO-mine_headframe_leg_{side}_{x:+.2f}", root, m["metal_dark"], (x * 1.35, y * 1.35, 0), (x * 0.72, y * 0.72, 6.9), 0.28, bevel=0.025)
        add_beam(f"GEO-mine_headframe_cross_{side}_0", root, m["metal"], (-1.65, y * 1.33, 1.25), (1.65, y * 1.33, 1.25), 0.17)
        add_beam(f"GEO-mine_headframe_cross_{side}_1", root, m["metal"], (-1.2, y, 4.0), (1.2, y, 4.0), 0.17)
        add_beam(f"GEO-mine_headframe_brace_{side}_a", root, m["rust"], (-1.6, y * 1.3, 0.55), (1.05, y * 0.84, 4.05), 0.12, bevel=0.0)
        add_beam(f"GEO-mine_headframe_brace_{side}_b", root, m["rust"], (1.6, y * 1.3, 0.55), (-1.05, y * 0.84, 4.05), 0.12, bevel=0.0)
    for axis in (-0.68, 0.68):
        add_cylinder(f"GEO-mine_sheave_{axis:+.2f}", root, m["metal"], (axis, 0, 6.72), 0.72, 0.2, vertices=12, rotation=(math.radians(90), 0, 0), bevel=0.02)
        add_cylinder(f"GEO-mine_sheave_hub_{axis:+.2f}", root, m["accent"], (axis, 0, 6.72), 0.18, 0.36, vertices=8, rotation=(math.radians(90), 0, 0))
    add_box("GEO-mine_headframe_crown", root, m["metal_dark"], (0, 0, 7.15), (2.5, 1.9, 0.28), bevel=0.035)
    add_box("GEO-mine_hoist_shed", root, m["concrete_dark"], (-3.3, 0.35, 1.15), (2.65, 2.65, 2.3), bevel=0.08)
    add_gable_roof("GEO-mine_hoist_roof", root, m["rust"], width=3.05, depth=3.0, eave_z=2.24, ridge_z=3.1)
    add_cylinder("GEO-mine_hoist_drum", root, m["metal"], (-2.95, -1.15, 1.1), 0.65, 1.05, vertices=12, rotation=(math.radians(90), 0, 0))
    add_box("GEO-mine_shaft_collar", root, m["concrete"], (0, 0, 0.28), (2.6, 2.25, 0.56), bevel=0.1)
    add_box("GEO-mine_shaft_void", root, m["obsidian"], (0, 0, 0.58), (1.48, 1.15, 0.1), bevel=0.02)
    for side in (-0.52, 0.52):
        add_box(f"GEO-mine_rail_{side:+.2f}", root, m["metal_dark"], (3.4, side, 0.16), (6.8, 0.095, 0.12), bevel=0.0)
    add_box("GEO-mine_ore_cart", root, m["rust"], (3.05, 0, 0.67), (1.6, 1.12, 0.82), rotation=(0, math.radians(-5), 0), bevel=0.08)
    for x in (2.55, 3.55):
        for y in (-0.53, 0.53):
            add_cylinder(f"GEO-mine_cart_wheel_{x:.2f}_{y:+.2f}", root, m["metal_dark"], (x, y, 0.32), 0.24, 0.16, vertices=8, rotation=(math.radians(90), 0, 0))


def build_crystal(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Large gemstone seam cluster with faceted points and contrasting cores."""
    add_ico("GEO-crystal_matrix_main", root, m["stone_dark"], (0, 0, 0.36), (3.8, 3.0, 0.92), subdivisions=1)
    add_ico("GEO-crystal_matrix_side", root, m["stone"], (-1.35, 0.75, 0.42), (1.8, 1.35, 0.9), subdivisions=1)
    crystals = (
        ((0, 0, 0.28), (-0.18, 0.08, 3.75), 0.62, "crystal_cyan"),
        ((0.78, 0.22, 0.25), (1.5, 0.36, 2.82), 0.49, "crystal_core"),
        ((-0.76, -0.14, 0.28), (-1.34, -0.38, 2.55), 0.48, "crystal_violet"),
        ((1.16, -0.65, 0.22), (1.64, -1.0, 1.88), 0.36, "crystal_violet"),
        ((-1.28, 0.62, 0.22), (-1.63, 1.12, 1.66), 0.34, "crystal_cyan"),
        ((0.18, 0.92, 0.22), (0.3, 1.42, 2.05), 0.4, "crystal_core"),
    )
    for index, (start, end, radius, material_id) in enumerate(crystals):
        p0, p1 = Vector(start), Vector(end)
        shoulder = p0.lerp(p1, 0.78)
        add_tapered(f"GEO-crystal_shaft_{index:02d}", root, m[material_id], p0, shoulder, radius, radius * 0.82, vertices=6)
        add_tapered(f"GEO-crystal_point_{index:02d}", root, m[material_id], shoulder, p1, radius * 0.82, 0.015, vertices=6)
        add_tapered(f"GEO-crystal_core_{index:02d}", root, m["crystal_core"], p0.lerp(p1, 0.2), p0.lerp(p1, 0.65), radius * 0.12, radius * 0.08, vertices=6)


def build_antenna(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """High-tech communications mast with lattice load path and paired dishes."""
    add_box("GEO-antenna_foundation", root, m["concrete_dark"], (0, 0, 0.25), (3.8, 3.8, 0.5), bevel=0.12)
    legs = ((-1.18, -1.18), (1.18, -1.18), (1.18, 1.18), (-1.18, 1.18))
    for index, (x, y) in enumerate(legs):
        add_beam(f"GEO-antenna_lattice_leg_{index}", root, m["metal_dark"], (x, y, 0.4), (x * 0.24, y * 0.24, 8.9), 0.2, bevel=0.02)
    for level, z in enumerate((1.2, 2.7, 4.2, 5.7, 7.2, 8.65)):
        factor = 1 - z / 11.5
        extent = 1.18 * factor
        corners = ((-extent, -extent), (extent, -extent), (extent, extent), (-extent, extent))
        for index, ((x0, y0), (x1, y1)) in enumerate(zip(corners, corners[1:] + corners[:1])):
            add_beam(f"GEO-antenna_lattice_ring_{level}_{index}", root, m["metal"], (x0, y0, z), (x1, y1, z), 0.095, bevel=0.0)
        if level < 5:
            next_z = (1.2, 2.7, 4.2, 5.7, 7.2, 8.65)[level + 1]
            next_extent = 1.18 * (1 - next_z / 11.5)
            add_beam(f"GEO-antenna_lattice_brace_{level}_a", root, m["tech_red"], (-extent, -extent, z), (next_extent, -next_extent, next_z), 0.075, bevel=0.0)
            add_beam(f"GEO-antenna_lattice_brace_{level}_b", root, m["tech_red"], (extent, extent, z), (-next_extent, next_extent, next_z), 0.075, bevel=0.0)
    add_cylinder("GEO-antenna_central_mast", root, m["tech_white"], (0, 0, 7.55), 0.18, 5.0, vertices=10)
    add_dish("GEO-antenna_primary_dish", root, m["tech_white"], (0, -0.45, 7.1), 1.75, 0.42, normal=(0.08, -0.86, 0.5))
    add_beam("GEO-antenna_primary_feed_arm", root, m["metal_dark"], (0, -0.48, 7.12), (0.13, -1.45, 7.72), 0.08, bevel=0.0)
    add_ico("GEO-antenna_primary_feed", root, m["tech_cyan"], (0.13, -1.45, 7.72), (0.28, 0.28, 0.28), smooth=True)
    add_dish("GEO-antenna_secondary_dish", root, m["tech_red"], (0.72, 0.12, 4.65), 0.82, 0.2, normal=(0.72, -0.55, 0.42), segments=10)
    for side, x in (("left", -1.55), ("right", 1.55)):
        add_box(f"GEO-antenna_equipment_cabinet_{side}", root, m["tech_white"], (x, 0.9, 0.95), (0.72, 1.05, 1.45), bevel=0.08)
        add_box(f"GEO-antenna_equipment_panel_{side}", root, m["tech_cyan"], (x, 0.34, 1.05), (0.42, 0.04, 0.66), bevel=0.01)
    add_tapered("GEO-antenna_lightning_rod", root, m["accent"], (0, 0, 9.75), (0, 0, 10.8), 0.045, 0.006, vertices=6)


def build_satellite(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Ground radar/satellite terminal with steerable dish, pedestal, and service boxes."""
    add_cylinder("GEO-satellite_bunker_base", root, m["concrete_dark"], (0, 0, 0.38), 2.75, 0.76, vertices=12, bevel=0.08)
    add_cylinder("GEO-satellite_pedestal", root, m["metal_dark"], (0, 0, 2.05), 1.0, 3.1, vertices=12, bevel=0.07)
    add_box("GEO-satellite_azimuth_yoke", root, m["tech_red"], (0, 0, 3.48), (2.7, 0.64, 0.5), bevel=0.12)
    add_dish("GEO-satellite_parabolic_reflector", root, m["tech_white"], (0, 0, 4.1), 3.35, 0.7, normal=(0.05, -0.75, 0.66), segments=16)
    for x in (-1.2, 1.2):
        add_beam(f"GEO-satellite_feed_truss_{x:+.1f}", root, m["metal_dark"], (x, -0.2, 4.25), (0, -2.15, 5.82), 0.1, bevel=0.0)
    add_ico("GEO-satellite_feed_horn", root, m["tech_cyan"], (0, -2.15, 5.82), (0.5, 0.5, 0.5), smooth=True)
    for index, angle in enumerate((0, 120, 240)):
        radians = math.radians(angle)
        x, y = math.cos(radians) * 3.35, math.sin(radians) * 3.35
        add_box(f"GEO-satellite_service_box_{index}", root, m["tech_white"], (x, y, 0.75), (1.25, 0.82, 1.2), rotation=(0, 0, radians), bevel=0.07)
        add_box(f"GEO-satellite_service_light_{index}", root, m["tech_cyan"], (x - math.sin(radians) * 0.43, y + math.cos(radians) * 0.43, 0.92), (0.42, 0.035, 0.25), rotation=(0, 0, radians), bevel=0.0)


def build_vehicle(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Tracked hydraulic excavator with articulated boom, bucket, and readable cab."""
    for side, y in (("left", -0.82), ("right", 0.82)):
        add_box(f"GEO-vehicle_excavator_track_{side}", root, m["metal_dark"], (0, y, 0.48), (4.4, 0.56, 0.86), bevel=0.18)
        for index, x in enumerate((-1.55, -0.76, 0, 0.76, 1.55)):
            add_cylinder(f"GEO-vehicle_excavator_roadwheel_{side}_{index}", root, m["metal"], (x, y, 0.48), 0.3, 0.66, vertices=8, rotation=(math.radians(90), 0, 0))
    add_box("GEO-vehicle_excavator_carbody", root, m["metal"], (-0.1, 0, 1.05), (3.35, 1.65, 0.48), bevel=0.12)
    add_cylinder("GEO-vehicle_excavator_slew_ring", root, m["metal_dark"], (-0.45, 0, 1.38), 0.72, 0.26, vertices=10)
    add_box("GEO-vehicle_excavator_house", root, m["tech_red"], (-0.8, 0.22, 2.0), (2.1, 1.52, 1.35), bevel=0.14)
    add_prism("GEO-vehicle_excavator_cab", root, m["glass"], ((-0.25, 1.35), (1.2, 1.35), (1.05, 2.85), (0.0, 3.08), (-0.42, 2.45)), 1.35, axis="y", bevel=0.04)
    add_box("GEO-vehicle_excavator_cab_frame", root, m["metal_dark"], (0.05, -0.72, 2.18), (1.5, 0.12, 1.75), bevel=0.04)
    boom_points = ((0.62, 2.4, 2.55), (2.25, 2.35, 4.6), (4.25, 2.18, 4.05), (3.82, 1.72, 3.25), (1.96, 1.72, 3.73), (0.4, 1.75, 2.08))
    add_prism("GEO-vehicle_excavator_boom", root, m["tech_red"], tuple((x, z) for x, _, z in boom_points), 0.62, axis="y", bevel=0.06)
    add_beam("GEO-vehicle_excavator_stick", root, m["tech_red"], (4.0, 0, 3.85), (5.05, 0, 1.45), 0.42, bevel=0.06)
    add_beam("GEO-vehicle_excavator_boom_cylinder", root, m["tech_white"], (0.45, -0.48, 2.55), (3.15, -0.48, 4.0), 0.12, bevel=0.0)
    add_beam("GEO-vehicle_excavator_stick_cylinder", root, m["tech_white"], (2.85, -0.46, 3.95), (4.72, -0.46, 2.15), 0.1, bevel=0.0)
    add_prism("GEO-vehicle_excavator_bucket", root, m["rust"], ((4.72, 0.35), (5.55, 0.25), (6.0, 0.72), (5.45, 1.45), (4.92, 1.3)), 1.35, axis="y", bevel=0.06)
    for index, x in enumerate((5.5, 5.75, 6.0)):
        add_tapered(f"GEO-vehicle_excavator_bucket_tooth_{index}", root, m["metal_dark"], (x, -0.45 + index * 0.45, 0.43), (x + 0.35, -0.45 + index * 0.45, 0.18), 0.09, 0.02, vertices=5)


def build_dock(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Timber harbor jetty with replaceable plank courses, piles, braces, and bollards."""
    for course, x in enumerate(tuple(-5.7 + index * 0.6 for index in range(20))):
        add_box(f"GEO-dock_deck_course_{course:02d}", root, m["wood_light" if course % 3 else "wood"], (x, 0, 1.18), (0.54, 3.2, 0.18), bevel=0.018)
    for y in (-1.25, 1.25):
        add_box(f"GEO-dock_stringer_{y:+.2f}", root, m["wood_dark"], (0, y, 0.9), (12.0, 0.22, 0.28), bevel=0.02)
        for index, x in enumerate((-5.4, -3.2, -1.0, 1.2, 3.4, 5.5)):
            add_tapered(f"GEO-dock_pile_{y:+.2f}_{index}", root, m["wood_dark"], (x, y, 0), (x, y, 2.25), 0.19, 0.15, vertices=8)
            if index < 5:
                nxt = (-5.4, -3.2, -1.0, 1.2, 3.4, 5.5)[index + 1]
                add_beam(f"GEO-dock_brace_{y:+.2f}_{index}", root, m["wood"], (x, y, 0.28), (nxt, y, 1.0), 0.14, bevel=0.0)
    for index, x in enumerate((-5.25, -2.2, 1.0, 4.3)):
        add_tapered(f"GEO-dock_bollard_{index}", root, m["metal_dark"], (x, -1.05, 1.2), (x, -1.05, 1.82), 0.16, 0.12, vertices=8)
        add_cylinder(f"GEO-dock_bollard_cap_{index}", root, m["accent"], (x, -1.05, 1.86), 0.2, 0.09, vertices=8)


def build_tent(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Rope-stayed canvas ridge tent with separate flaps, poles, pegs, and bedroll."""
    add_prism("GEO-tent_canvas_shell", root, m["canvas"], ((-2.4, 0), (0, 3.1), (2.4, 0)), 3.6, axis="y")
    add_prism("GEO-tent_dark_inner", root, m["wood_dark"], ((-1.65, 0.08), (0, 2.48), (1.65, 0.08)), 0.08, axis="y")
    for side, y in (("front", -1.86), ("rear", 1.86)):
        add_tapered(f"GEO-tent_ridge_pole_{side}", root, m["wood_dark"], (0, y, 0), (0, y, 3.32), 0.09, 0.07, vertices=7)
        add_beam(f"GEO-tent_guy_left_{side}", root, m["metal_dark"], (0, y, 3.05), (-2.9, y, 0.04), 0.025, bevel=0.0)
        add_beam(f"GEO-tent_guy_right_{side}", root, m["metal_dark"], (0, y, 3.05), (2.9, y, 0.04), 0.025, bevel=0.0)
        for x in (-2.9, 2.9):
            add_tapered(f"GEO-tent_peg_{side}_{x:+.1f}", root, m["metal_dark"], (x, y, 0), (x, y, 0.28), 0.045, 0.035, vertices=6)
    add_beam("GEO-tent_ridge_beam", root, m["wood_dark"], (0, -1.9, 3.12), (0, 1.9, 3.12), 0.1, bevel=0.01)
    add_mesh("GEO-tent_entry_flap_left", root, m["canvas_red"], ((0, -1.91, 2.92), (-1.74, -1.91, 0.12), (-0.12, -2.5, 0.18)), ((0, 1, 2), (2, 1, 0)))
    add_mesh("GEO-tent_entry_flap_right", root, m["canvas_red"], ((0, -1.92, 2.92), (1.74, -1.92, 0.12), (0.12, -2.5, 0.18)), ((0, 2, 1), (1, 2, 0)))
    add_cylinder("GEO-tent_bedroll", root, m["tech_red"], (0.65, 0.62, 0.32), 0.32, 1.65, vertices=10, rotation=(0, math.radians(90), 0))


def build_well(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Stone-lined village well with timber crank, bucket, and pitched shelter roof."""
    for course, z in enumerate((0.22, 0.57, 0.92)):
        for index in range(12):
            angle = math.tau * (index + (course % 2) * 0.5) / 12
            add_box(
                f"GEO-well_stone_course_{course}_{index:02d}", root,
                m["stone" if (index + course) % 3 else "stone_dark"],
                (math.cos(angle) * 1.12, math.sin(angle) * 1.12, z),
                (0.58, 0.36, 0.32), rotation=(0, 0, angle), bevel=0.045,
            )
    add_cylinder("GEO-well_dark_opening", root, m["obsidian"], (0, 0, 1.11), 0.78, 0.08, vertices=12)
    for side, x in (("left", -1.42), ("right", 1.42)):
        add_tapered(f"GEO-well_post_{side}", root, m["wood_dark"], (x, 0, 0.3), (x, 0, 3.8), 0.17, 0.13, vertices=8)
    add_cylinder("GEO-well_crank", root, m["wood"], (0, 0, 2.55), 0.17, 3.25, vertices=8, rotation=(0, math.radians(90), 0))
    add_cylinder("GEO-well_rope_spool", root, m["thatch_dark"], (0, 0, 2.55), 0.38, 0.68, vertices=10, rotation=(0, math.radians(90), 0))
    add_beam("GEO-well_rope", root, m["thatch_dark"], (0, 0, 2.55), (0, 0, 1.18), 0.045, bevel=0.0)
    add_cylinder("GEO-well_bucket", root, m["metal_dark"], (0, 0, 1.36), 0.28, 0.42, vertices=8)
    add_gable_roof("GEO-well_roof", root, m["slate"], width=4.0, depth=3.1, eave_z=3.3, ridge_z=4.35)
    add_box("GEO-well_ridge", root, m["slate_edge"], (0, 0, 4.37), (0.18, 3.25, 0.18), bevel=0.025)


def build_statue(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Volcanic ritual monolith with horned crown, altar steps, and lava channels."""
    add_box("GEO-statue_altar_step_lower", root, m["obsidian"], (0, 0, 0.24), (4.8, 3.8, 0.48), bevel=0.12)
    add_box("GEO-statue_altar_step_upper", root, m["stone_dark"], (0, 0, 0.67), (3.65, 2.8, 0.4), bevel=0.1)
    add_tapered("GEO-statue_monolith", root, m["obsidian"], (0, 0, 0.76), (0, 0, 5.2), 1.18, 0.54, vertices=7, bevel=0.04)
    add_ico("GEO-statue_demon_mask", root, m["dragon_scale"], (0, -0.63, 3.78), (1.35, 0.62, 1.45), subdivisions=1)
    for side, x in (("left", -0.48), ("right", 0.48)):
        add_ico(f"GEO-statue_eye_{side}", root, m["lava"], (x, -0.98, 3.93), (0.2, 0.11, 0.22), smooth=True)
        add_tapered(f"GEO-statue_horn_{side}", root, m["obsidian"], (x, -0.15, 4.66), (x * 2.8, 0.12, 6.2), 0.26, 0.02, vertices=6)
    for index, x in enumerate((-1.15, 0, 1.15)):
        add_box(f"GEO-statue_lava_channel_{index}", root, m["lava"], (x, -1.95, 0.82), (0.22, 2.2, 0.08), bevel=0.01)
    for side, x in (("left", -2.25), ("right", 2.25)):
        add_tapered(f"GEO-statue_brazier_{side}", root, m["metal_dark"], (x, -1.45, 0.45), (x, -1.45, 1.38), 0.28, 0.42, vertices=8)
        for flame in range(3):
            add_tapered(f"GEO-statue_flame_{side}_{flame}", root, m["lava"], (x + (flame - 1) * 0.14, -1.45, 1.32), (x + (flame - 1) * 0.08, -1.45, 2.15 - abs(flame - 1) * 0.25), 0.16, 0.01, vertices=6)


def build_fence(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Long braced timber palisade module with gate opening and stone footings."""
    for index, x in enumerate((-4.8, -3.2, -1.6, 1.6, 3.2, 4.8)):
        add_box(f"GEO-fence_footing_{index}", root, m["stone"], (x, 0, 0.22), (0.72, 0.72, 0.44), bevel=0.08)
        add_tapered(f"GEO-fence_post_{index}", root, m["wood_dark"], (x, 0, 0.3), (x, 0, 2.65), 0.19, 0.15, vertices=7)
    for segment, (x0, x1) in enumerate(((-4.8, -3.2), (-3.2, -1.6), (1.6, 3.2), (3.2, 4.8))):
        for z in (0.85, 1.88):
            add_beam(f"GEO-fence_rail_{segment}_{z:.2f}", root, m["wood"], (x0, 0, z), (x1, 0, z), 0.16, bevel=0.02)
        add_beam(f"GEO-fence_brace_{segment}", root, m["wood_light"], (x0, 0.04, 0.62), (x1, 0.04, 2.15), 0.13, bevel=0.0)
    add_box("GEO-fence_gate_leaf", root, m["wood"], (0, 0.06, 1.35), (2.8, 0.16, 2.15), bevel=0.04)
    add_beam("GEO-fence_gate_brace", root, m["wood_dark"], (-1.2, -0.06, 0.5), (1.2, -0.06, 2.18), 0.14, bevel=0.0)
    add_box("GEO-fence_gate_latch", root, m["metal_dark"], (1.08, -0.16, 1.42), (0.42, 0.12, 0.13), bevel=0.02)


def build_campfire(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Stone-ring campfire with crossed logs, layered flame tongues, and hanging kettle."""
    for index in range(12):
        angle = math.tau * index / 12
        add_ico(f"GEO-campfire_ring_stone_{index:02d}", root, m["stone" if index % 3 else "stone_dark"], (math.cos(angle) * 0.95, math.sin(angle) * 0.95, 0.22), (0.62, 0.48, 0.4), subdivisions=1)
    for index, angle in enumerate((math.radians(35), math.radians(-35), math.radians(90))):
        direction = Vector((math.cos(angle), math.sin(angle), 0))
        add_tapered(f"GEO-campfire_log_{index}", root, m["wood_dark"], -direction * 0.72 + Vector((0, 0, 0.48)), direction * 0.72 + Vector((0, 0, 0.48)), 0.16, 0.16, vertices=8)
    for index, (x, y, height, radius) in enumerate(((-0.28, 0, 1.45, 0.32), (0.28, -0.08, 1.7, 0.35), (0, 0.18, 2.15, 0.42), (0.02, -0.02, 2.7, 0.26))):
        add_tapered(f"GEO-campfire_flame_{index}", root, m["lava" if index % 2 else "accent"], (x, y, 0.54), (x * 0.4, y * 0.4, height), radius, 0.01, vertices=6)
    for side, x in (("left", -1.45), ("right", 1.45)):
        add_tapered(f"GEO-campfire_tripod_{side}", root, m["metal_dark"], (x, 0, 0), (0, 0, 2.75), 0.05, 0.035, vertices=6)
    add_tapered("GEO-campfire_tripod_rear", root, m["metal_dark"], (0, 1.5, 0), (0, 0, 2.75), 0.05, 0.035, vertices=6)
    add_cylinder("GEO-campfire_kettle", root, m["metal_dark"], (0, 0, 1.45), 0.38, 0.55, vertices=10)


def build_crate(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Stacked supply crates with separate slats, diagonal cleats, and metal corners."""
    for crate_index, (cx, cy, cz, size) in enumerate(((-0.65, 0, 0.65, 1.3), (0.62, 0.22, 0.52, 1.02), (0.12, -0.18, 1.62, 0.9))):
        add_box(f"GEO-crate_body_{crate_index}", root, m["wood"], (cx, cy, cz), (size, size, size), bevel=0.035)
        for z in (cz - size * 0.38, cz + size * 0.38):
            add_box(f"GEO-crate_band_{crate_index}_{z:.2f}", root, m["wood_dark"], (cx, cy - size * 0.51, z), (size * 1.05, 0.09, size * 0.13), bevel=0.012)
        add_beam(f"GEO-crate_diagonal_{crate_index}", root, m["wood_light"], (cx - size * 0.38, cy - size * 0.56, cz - size * 0.32), (cx + size * 0.38, cy - size * 0.56, cz + size * 0.32), size * 0.1, bevel=0.01)
        for corner, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            add_box(f"GEO-crate_corner_{crate_index}_{corner}", root, m["metal_dark"], (cx + sx * size * 0.47, cy - size * 0.55, cz + sz * size * 0.42), (size * 0.1, 0.08, size * 0.18), bevel=0.008)


def build_market(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Timber market stall with striped awning, counter, shelves, and produce baskets."""
    for index, (x, y) in enumerate(((-2.2, -1.3), (2.2, -1.3), (-2.2, 1.3), (2.2, 1.3))):
        add_tapered(f"GEO-market_post_{index}", root, m["wood_dark"], (x, y, 0), (x, y, 3.45), 0.13, 0.11, vertices=7)
    for y in (-1.3, 1.3):
        add_beam(f"GEO-market_top_beam_{y:+.1f}", root, m["wood_dark"], (-2.2, y, 3.35), (2.2, y, 3.35), 0.16, bevel=0.02)
    add_box("GEO-market_counter", root, m["wood_light"], (0, -1.34, 1.25), (4.5, 0.72, 0.22), bevel=0.04)
    add_box("GEO-market_back_shelf", root, m["wood"], (0, 1.1, 1.55), (4.1, 0.52, 0.18), bevel=0.03)
    for stripe, x in enumerate(tuple(-2.1 + index * 0.7 for index in range(7))):
        add_box(f"GEO-market_awning_stripe_{stripe}", root, m["canvas_red" if stripe % 2 else "canvas"], (x, -0.2, 3.7), (0.66, 3.75, 0.09), rotation=(0, math.radians(-6 if stripe < 3 else 6), 0), bevel=0.0)
    for basket_index, x in enumerate((-1.45, 0, 1.45)):
        add_tapered(f"GEO-market_basket_{basket_index}", root, m["thatch"], (x, -1.58, 1.4), (x, -1.58, 1.82), 0.42, 0.34, vertices=10)
        for fruit in range(4):
            add_ico(f"GEO-market_produce_{basket_index}_{fruit}", root, m["vermilion" if (basket_index + fruit) % 2 else "leaf_light"], (x + (fruit % 2 - 0.5) * 0.32, -1.58 + (fruit // 2 - 0.5) * 0.2, 1.86), (0.23, 0.23, 0.23), smooth=True)


def build_bunker(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Low defensive bunker with battered walls, firing slots, parapet, and gun mount."""
    add_box("GEO-bunker_foundation", root, m["concrete_dark"], (0, 0, 0.3), (7.2, 5.2, 0.6), bevel=0.16)
    add_tapered("GEO-bunker_battered_shell", root, m["concrete"], (0, 0, 0.4), (0, 0, 3.25), 3.72, 3.05, vertices=8, bevel=0.08)
    add_box("GEO-bunker_roof_slab", root, m["concrete_dark"], (0, 0, 3.25), (6.55, 4.75, 0.5), bevel=0.14)
    add_box("GEO-bunker_entry_recess", root, m["obsidian"], (-2.7, 0, 1.55), (0.14, 1.45, 2.1), bevel=0.02)
    add_box("GEO-bunker_entry_door", root, m["metal_dark"], (-2.8, 0, 1.5), (0.12, 1.2, 1.85), bevel=0.03)
    for side, y in (("front", -2.18), ("rear", 2.18)):
        for x in (-1.65, 0, 1.65):
            add_box(f"GEO-bunker_firing_slot_{side}_{x:+.1f}", root, m["obsidian"], (x, y, 2.0), (0.92, 0.12, 0.28), bevel=0.02)
            add_box(f"GEO-bunker_slot_lintel_{side}_{x:+.1f}", root, m["concrete_dark"], (x, y, 2.27), (1.2, 0.2, 0.18), bevel=0.02)
    for index, (x, y) in enumerate(((-2.55, -1.72), (2.55, -1.72), (-2.55, 1.72), (2.55, 1.72))):
        add_box(f"GEO-bunker_parapet_{index}", root, m["concrete_dark"], (x, y, 3.72), (1.15, 0.48, 0.7), bevel=0.08)
    add_cylinder("GEO-bunker_gun_ring", root, m["metal_dark"], (0, 0, 3.72), 0.82, 0.32, vertices=12)
    add_box("GEO-bunker_gun_shield", root, m["tech_red"], (0.35, 0, 4.18), (1.2, 1.5, 0.7), bevel=0.1)
    add_tapered("GEO-bunker_gun_barrel", root, m["metal_dark"], (0.7, 0, 4.24), (3.35, 0, 4.3), 0.13, 0.07, vertices=8)


def build_building_hobbit_round_door(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Earth-sheltered round-door home with real recessed facade, stone arch, and turf mound."""
    add_ico("GEO-building_hobbit_earth_mound", root, m["earth"], (0.1, 0.85, 2.55), (8.8, 6.7, 5.15), subdivisions=2)
    add_box("GEO-building_hobbit_cut_face", root, m["earth_dark"], (0, -2.42, 2.15), (7.25, 0.22, 4.15), bevel=0.12)
    add_box("GEO-building_hobbit_stone_plinth", root, m["stone"], (0, -2.58, 0.35), (7.6, 0.5, 0.7), bevel=0.1)
    # Separate facade panels preserve a true central door opening and two window openings.
    for index, (x, width, height, z) in enumerate(((-3.0, 1.2, 3.25, 2.0), (-1.72, 0.9, 4.0, 2.35), (1.72, 0.9, 4.0, 2.35), (3.0, 1.2, 3.25, 2.0), (0, 1.45, 0.75, 4.48))):
        add_box(f"GEO-building_hobbit_facade_panel_{index}", root, m["limestone"], (x, -2.67, z), (width, 0.3, height), bevel=0.04)
    add_cylinder("GEO-building_hobbit_round_door_leaf", root, m["vermilion"], (0, -2.81, 2.22), 1.45, 0.22, vertices=20, rotation=(math.radians(90), 0, 0), bevel=0.025)
    add_ring_segments("GEO-building_hobbit_door_arch", root, m["stone_dark"], (0, -2.91, 2.22), 1.7, 0.27, segments=16, plane="xz")
    for index in range(8):
        angle = math.tau * index / 8
        add_beam(
            f"GEO-building_hobbit_door_spoke_{index:02d}", root, m["wood_dark"],
            (0, -2.95, 2.22), (math.cos(angle) * 1.18, -2.95, 2.22 + math.sin(angle) * 1.18), 0.07, bevel=0.0,
        )
    add_ico("GEO-building_hobbit_door_boss", root, m["accent"], (0, -3.04, 2.22), (0.27, 0.16, 0.27), smooth=True)
    for side, x in (("left", -2.45), ("right", 2.45)):
        add_cylinder(f"GEO-building_hobbit_window_{side}", root, m["glass"], (x, -2.84, 2.35), 0.72, 0.16, vertices=16, rotation=(math.radians(90), 0, 0))
        add_ring_segments(f"GEO-building_hobbit_window_arch_{side}", root, m["wood_dark"], (x, -2.94, 2.35), 0.87, 0.14, segments=12, plane="xz")
        add_beam(f"GEO-building_hobbit_window_mullion_{side}", root, m["wood_dark"], (x, -3.02, 1.7), (x, -3.02, 3.0), 0.08, bevel=0.0)
        add_beam(f"GEO-building_hobbit_window_transom_{side}", root, m["wood_dark"], (x - 0.65, -3.02, 2.35), (x + 0.65, -3.02, 2.35), 0.08, bevel=0.0)
    add_box("GEO-building_hobbit_entry_step", root, m["stone"], (0, -3.25, 0.18), (3.2, 1.2, 0.36), bevel=0.12)
    add_tapered("GEO-building_hobbit_chimney", root, m["stone_dark"], (2.45, 0.3, 3.7), (2.45, 0.3, 6.0), 0.48, 0.39, vertices=8)
    add_box("GEO-building_hobbit_chimney_cap", root, m["limestone"], (2.45, 0.3, 6.05), (1.1, 0.9, 0.24), bevel=0.05)


def build_building_futuristic_facility(root: bpy.types.Object, m: dict[str, bpy.types.Material]) -> None:
    """Angular high-tech command facility with service modules, vents, conduits, and radar."""
    add_box("GEO-building_future_foundation", root, m["concrete_dark"], (0, 0, 0.35), (9.2, 7.4, 0.7), bevel=0.16)
    add_prism("GEO-building_future_main_shell", root, m["tech_white"], ((-4.0, 0.6), (-3.55, 4.4), (-2.4, 5.4), (2.35, 5.4), (3.8, 4.25), (4.15, 0.6)), 5.6, axis="y", bevel=0.12)
    add_prism("GEO-building_future_red_spine", root, m["tech_red"], ((-0.75, 0.75), (-0.6, 6.2), (0.6, 6.2), (0.75, 0.75)), 5.9, axis="y", bevel=0.06)
    add_box("GEO-building_future_entry_recess", root, m["obsidian"], (0, -2.92, 1.65), (2.15, 0.18, 2.65), bevel=0.05)
    for side, x in (("left", -0.62), ("right", 0.62)):
        add_box(f"GEO-building_future_entry_leaf_{side}", root, m["metal_dark"], (x, -3.03, 1.58), (1.05, 0.12, 2.4), bevel=0.04)
        add_box(f"GEO-building_future_entry_light_{side}", root, m["tech_cyan"], (x, -3.11, 1.75), (0.42, 0.04, 1.1), bevel=0.01)
    for level, z in enumerate((2.45, 3.65)):
        for x in (-2.65, 2.65):
            add_box(f"GEO-building_future_window_{level}_{x:+.2f}", root, m["glass"], (x, -2.94, z), (1.25, 0.1, 0.72), bevel=0.04)
            add_box(f"GEO-building_future_window_brow_{level}_{x:+.2f}", root, m["metal_dark"], (x, -3.08, z + 0.46), (1.6, 0.32, 0.18), bevel=0.03)
    for side, x in (("left", -4.65), ("right", 4.65)):
        add_box(f"GEO-building_future_service_module_{side}", root, m["concrete"], (x, 0.55, 1.62), (1.55, 4.7, 2.65), bevel=0.14)
        for z in (0.95, 1.55, 2.15):
            add_box(f"GEO-building_future_service_vent_{side}_{z:.2f}", root, m["metal_dark"], (x, -1.84, z), (0.95, 0.08, 0.22), bevel=0.01)
    for index, x in enumerate((-3.25, -1.65, 1.65, 3.25)):
        add_cylinder(f"GEO-building_future_roof_vent_{index}", root, m["metal_dark"], (x, 0.65, 5.7), 0.28, 0.85 + (index % 2) * 0.25, vertices=10)
        add_cylinder(f"GEO-building_future_roof_vent_cap_{index}", root, m["tech_cyan"], (x, 0.65, 6.15 + (index % 2) * 0.12), 0.38, 0.12, vertices=10)
    add_dish("GEO-building_future_roof_dish", root, m["tech_white"], (0, 0.45, 6.55), 1.3, 0.32, normal=(0.18, -0.8, 0.57), segments=12)
    add_beam("GEO-building_future_roof_feed", root, m["metal_dark"], (0, 0.35, 6.62), (0.15, -0.72, 7.38), 0.07, bevel=0.0)
    add_ico("GEO-building_future_roof_feed_horn", root, m["tech_cyan"], (0.15, -0.72, 7.38), (0.25, 0.25, 0.25), smooth=True)
    for side, y in (("front", -3.34), ("rear", 3.34)):
        add_beam(f"GEO-building_future_conduit_{side}", root, m["tech_red"], (-4.2, y, 0.85), (4.2, y, 0.85), 0.13, bevel=0.02)


BUILDERS = {
    "palm": build_palm,
    "tree": build_tree,
    "pine": build_pine,
    "rock": build_rock,
    "cactus": build_cactus,
    "hut": build_hut,
    "building": build_building,
    "watchtower": build_watchtower,
    "ship": build_ship,
    "tank": build_tank,
    "pagoda": build_pagoda,
    "torii": build_torii,
    "bridge": build_bridge,
    "dragon": build_dragon,
    "windmill": build_windmill,
    "mine": build_mine,
    "crystal": build_crystal,
    "antenna": build_antenna,
    "satellite": build_satellite,
    "dock": build_dock,
    "tent": build_tent,
    "well": build_well,
    "statue": build_statue,
    "fence": build_fence,
    "campfire": build_campfire,
    "crate": build_crate,
    "market": build_market,
}

VARIANT_BUILDERS = {
    "building_timber_frame_white_tile": build_building_timber_frame_white_tile,
    "tree_bamboo_cluster": build_tree_bamboo_cluster,
    "tree_cherry_blossom": build_tree_cherry_blossom,
    "building_hobbit_round_door": build_building_hobbit_round_door,
    "building_futuristic_facility": build_building_futuristic_facility,
    "building_fortified_bunker": build_bunker,
    "tank_tracked_excavator": build_vehicle,
}


def mesh_children(root: bpy.types.Object) -> list[bpy.types.Object]:
    return sorted((child for child in root.children_recursive if child.type == "MESH"), key=lambda child: child.name)


def bounds_for(root: bpy.types.Object) -> dict[str, list[float]]:
    points = [vertex.co for obj in mesh_children(root) for vertex in obj.data.vertices]
    if not points:
        raise RuntimeError(f"{root.name} has no mesh geometry")
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
        "size": [round(maximum[i] - minimum[i], 6) for i in range(3)],
    }


def normalize_asset(root: bpy.types.Object, target_height: float) -> None:
    bounds = bounds_for(root)
    minimum_z, height = bounds["min"][2], bounds["size"][2]
    if height <= 0:
        raise RuntimeError(f"{root.name} has zero height")
    scale = target_height / height
    for obj in mesh_children(root):
        for vertex in obj.data.vertices:
            vertex.co.x *= scale
            vertex.co.y *= scale
            vertex.co.z = (vertex.co.z - minimum_z) * scale
        obj.data.update()


def stable_float(value: float, *, digits: int | None = None) -> bytes:
    """Canonical little-endian float32 used by all geometry fingerprints."""
    normalized = round(float(value), digits) if digits is not None else float(value)
    if normalized == 0:
        normalized = 0.0
    return struct.pack("<f", normalized)


def material_for(obj: bpy.types.Object) -> bpy.types.Material:
    materials = [slot.material for slot in obj.material_slots if slot.material]
    if len(materials) != 1:
        raise RuntimeError(f"{obj.name} must use exactly one material before compaction; got {len(materials)}")
    return materials[0]


def authored_shading_fingerprint(root: bpy.types.Object) -> dict[str, Any]:
    digest = hashlib.sha256()
    loop_count = 0
    for obj in sorted(mesh_children(root), key=lambda item: (material_for(item).name, item.name)):
        mesh = obj.data
        material_name = material_for(obj).name.encode("utf-8")
        digest.update(struct.pack("<H", len(material_name)))
        digest.update(material_name)
        corner_normals = mesh.corner_normals
        for polygon in mesh.polygons:
            digest.update(b"S" if polygon.use_smooth else b"F")
            for loop_index in polygon.loop_indices:
                loop_count += 1
                vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
                normal = corner_normals[loop_index].vector
                digest.update(stable_float(vertex.x))
                digest.update(stable_float(vertex.y))
                digest.update(stable_float(vertex.z))
                digest.update(stable_float(normal.x, digits=4))
                digest.update(stable_float(normal.y, digits=4))
                digest.update(stable_float(normal.z, digits=4))
    return {
        "algorithm": "sha256_material_polygon_smooth_corner_position_normal_float32_v1",
        "sha256": digest.hexdigest(),
        "normalQuantizationDigits": 4,
        "loopCount": loop_count,
    }


def geometry_fingerprint(root: bpy.types.Object) -> dict[str, Any]:
    """Hash root-local triangle corners, split normals, and their material.

    The authoring object names intentionally do not participate: this digest is
    required to remain identical after many detailed GEO components become one
    export mesh per material. Polygon and loop order do participate, making the
    digest sensitive to winding, topology, and shading drift.
    """
    topology_records: list[bytes] = []
    triangle_count = 0
    loop_count = 0
    for obj in sorted(mesh_children(root), key=lambda item: (material_for(item).name, item.name)):
        mesh = obj.data
        mesh.calc_loop_triangles()
        material_name = material_for(obj).name.encode("utf-8")
        corner_normals = mesh.corner_normals
        for triangle in mesh.loop_triangles:
            triangle_count += 1
            topology_corners: list[bytes] = []
            for loop_index in triangle.loops:
                loop_count += 1
                vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
                normal = corner_normals[loop_index].vector
                position = stable_float(vertex.x) + stable_float(vertex.y) + stable_float(vertex.z)
                topology_corners.append(position)
            # Canonical cyclic rotation keeps winding significant while making
            # the digest independent of Blender's loop start for the same face.
            topology_triangle = min(
                b"".join(topology_corners[index:] + topology_corners[:index]) for index in range(3)
            )
            prefix = struct.pack("<H", len(material_name)) + material_name
            topology_records.append(prefix + topology_triangle)
    topology_digest = hashlib.sha256()
    for record in sorted(topology_records):
        topology_digest.update(record)
    return {
        "algorithm": "sha256_sorted_material_wound_triangle_float32_v1",
        "topologySha256": topology_digest.hexdigest(),
        "triangleCount": triangle_count,
        "loopCount": loop_count,
    }


def component_ledger(root: bpy.types.Object, target_height: float) -> dict[str, Any]:
    meshes = mesh_children(root)
    prefix_counts: dict[str, int] = defaultdict(int)
    components: list[dict[str, Any]] = []
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        prefix = obj.name.rsplit("_", 1)[0] + "_" if obj.name.rsplit("_", 1)[-1].isdigit() else obj.name
        prefix_counts[prefix] += 1
        components.append(
            {
                "name": obj.name,
                "material": material_for(obj).name,
                "vertexCount": len(mesh.vertices),
                "polygonCount": len(mesh.polygons),
                "triangleCount": len(mesh.loop_triangles),
            }
        )
    component_payload = json.dumps(components, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "version": 1,
        "node": root.name,
        "targetHeightMeters": target_height,
        "boundsZUpMeters": bounds_for(root),
        "sourceMeshCount": len(meshes),
        "sourceVertexCount": sum(item["vertexCount"] for item in components),
        "sourceTriangleCount": sum(item["triangleCount"] for item in components),
        "materialNames": sorted({item["material"] for item in components}),
        "componentNames": [item["name"] for item in components],
        "componentPrefixCounts": dict(sorted(prefix_counts.items())),
        "components": components,
        "componentsSha256": hashlib.sha256(component_payload).hexdigest(),
        "geometryFingerprint": geometry_fingerprint(root),
        "shadingFingerprint": authored_shading_fingerprint(root),
    }


def safe_export_name(value: str) -> str:
    return "".join(char if char.isalnum() or char in "_-" else "_" for char in value)


def read_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    if len(data) < 28 or data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise RuntimeError(f"Detailed export is not a valid GLB 2 file: {path}")
    if struct.unpack_from("<I", data, 8)[0] != len(data):
        raise RuntimeError(f"Detailed GLB length header is stale: {path}")
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise RuntimeError(f"Detailed GLB first chunk is not JSON: {path}")
    json_start, json_end = 20, 20 + json_length
    gltf = json.loads(data[json_start:json_end].rstrip(b" \0").decode("utf-8"))
    bin_length, bin_type = struct.unpack_from("<II", data, json_end)
    if bin_type != 0x004E4942:
        raise RuntimeError(f"Detailed GLB second chunk is not BIN: {path}")
    binary = data[json_end + 8 : json_end + 8 + bin_length]
    return gltf, binary


def accessor_bytes(gltf: dict[str, Any], binary: bytes, accessor_index: int) -> bytes:
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    offset = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    component_sizes = {5121: 1, 5123: 2, 5125: 4, 5126: 4}
    type_sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    item_size = component_sizes[accessor["componentType"]] * type_sizes[accessor["type"]]
    byte_length = int(accessor["count"]) * item_size
    stride = int(view.get("byteStride", item_size))
    if stride == item_size:
        return bytes(binary[offset : offset + byte_length])
    return b"".join(
        binary[offset + index * stride : offset + index * stride + item_size]
        for index in range(int(accessor["count"]))
    )


def exported_attribute_fingerprint(
    gltf: dict[str, Any], binary: bytes, root_index: int, material_names: list[str]
) -> dict[str, Any]:
    """Hash Blender-exported positions, normals, winding, and materials."""
    records: list[bytes] = []
    triangle_count = 0

    def descendants(index: int) -> Iterable[int]:
        for child in gltf["nodes"][index].get("children", []):
            yield child
            yield from descendants(child)

    for node_index in descendants(root_index):
        mesh_index = gltf["nodes"][node_index].get("mesh")
        if mesh_index is None:
            continue
        for primitive in gltf["meshes"][mesh_index].get("primitives", []):
            position_accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
            normal_accessor = gltf["accessors"][primitive["attributes"]["NORMAL"]]
            index_accessor = gltf["accessors"][primitive["indices"]]
            if position_accessor["componentType"] != 5126 or position_accessor["type"] != "VEC3":
                raise RuntimeError("Export attribute fingerprint requires float VEC3 POSITION")
            if normal_accessor["componentType"] != 5126 or normal_accessor["type"] != "VEC3":
                raise RuntimeError("Export attribute fingerprint requires float VEC3 NORMAL")
            positions = struct.unpack(
                f"<{position_accessor['count'] * 3}f",
                accessor_bytes(gltf, binary, primitive["attributes"]["POSITION"]),
            )
            normals = struct.unpack(
                f"<{normal_accessor['count'] * 3}f",
                accessor_bytes(gltf, binary, primitive["attributes"]["NORMAL"]),
            )
            index_code = {5121: "B", 5123: "H", 5125: "I"}[index_accessor["componentType"]]
            indices = struct.unpack(
                f"<{index_accessor['count']}{index_code}",
                accessor_bytes(gltf, binary, primitive["indices"]),
            )
            material = material_names[int(primitive["material"])].encode("utf-8")
            prefix = struct.pack("<H", len(material)) + material
            for offset in range(0, len(indices), 3):
                corners: list[bytes] = []
                for vertex in indices[offset : offset + 3]:
                    corners.append(
                        b"".join(stable_float(value) for value in positions[vertex * 3 : vertex * 3 + 3])
                        + b"".join(stable_float(value) for value in normals[vertex * 3 : vertex * 3 + 3])
                    )
                rotations = [b"".join(corners[index:] + corners[:index]) for index in range(3)]
                records.append(prefix + min(rotations))
                triangle_count += 1
    digest = hashlib.sha256()
    for record in sorted(records):
        digest.update(record)
    return {
        "algorithm": "sha256_sorted_material_wound_triangle_position_normal_float32_yup_v1",
        "sha256": digest.hexdigest(),
        "triangleCount": triangle_count,
    }


def write_compact_glb(detailed_path: Path, output_path: Path, ledgers: dict[str, Any]) -> dict[str, Any]:
    """Repack Blender's exact glTF attributes as one mesh per root/material."""
    source, source_binary = read_glb(detailed_path)
    nodes = source["nodes"]
    materials = source["materials"]
    material_names = [item["name"] for item in materials]
    root_indices = [index for index, node in enumerate(nodes) if node.get("name", "").startswith("ASSET_")]
    if len(root_indices) != len(ledgers):
        raise RuntimeError(f"Detailed GLB has {len(root_indices)} ASSET roots; expected {len(ledgers)}")

    compact: dict[str, Any] = {
        "asset": source["asset"],
        "scene": 0,
        "scenes": [{"name": source["scenes"][source.get("scene", 0)].get("name", "Scene"), "nodes": []}],
        "nodes": [],
        "materials": materials,
        "meshes": [],
        "accessors": [],
        "bufferViews": [],
        "buffers": [{"byteLength": 0}],
    }
    binary = bytearray()

    def append_buffer_view(payload: bytes, target: int) -> int:
        while len(binary) % 4:
            binary.append(0)
        index = len(compact["bufferViews"])
        compact["bufferViews"].append(
            {"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload), "target": target}
        )
        binary.extend(payload)
        return index

    def append_accessor(payload: bytes, template: dict[str, Any], target: int, *, minimum=None, maximum=None) -> int:
        view = append_buffer_view(payload, target)
        accessor = {
            "bufferView": view,
            "componentType": template["componentType"],
            "count": template["count"],
            "type": template["type"],
        }
        if template.get("normalized"):
            accessor["normalized"] = True
        if minimum is not None:
            accessor["min"] = minimum
        if maximum is not None:
            accessor["max"] = maximum
        index = len(compact["accessors"])
        compact["accessors"].append(accessor)
        return index

    def descendants(index: int) -> list[int]:
        result: list[int] = []
        for child in nodes[index].get("children", []):
            result.append(child)
            result.extend(descendants(child))
        return result

    total_source_meshes = 0
    roots_report: dict[str, Any] = {}
    for root_index in root_indices:
        source_root = nodes[root_index]
        root_name = source_root["name"]
        ledger = ledgers.get(root_name)
        if not ledger:
            raise RuntimeError(f"Detailed GLB root {root_name} has no authoring component ledger")
        root_output_index = len(compact["nodes"])
        root_extras = dict(source_root.get("extras", {}))
        grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for node_index in descendants(root_index):
            mesh_index = nodes[node_index].get("mesh")
            if mesh_index is None:
                continue
            for primitive in source["meshes"][mesh_index].get("primitives", []):
                if set(primitive.get("attributes", {})) != {"POSITION", "NORMAL"} or "indices" not in primitive:
                    raise RuntimeError(f"{root_name}/{nodes[node_index].get('name')}: compactable primitive must be indexed POSITION+NORMAL only")
                grouped[int(primitive["material"])].append(primitive)
                total_source_meshes += 1
        attribute_fingerprint = exported_attribute_fingerprint(
            source, source_binary, root_index, material_names
        )

        root_extras.update(
            {
                "worldclawCompactionVersion": COMPACTION_VERSION,
                "worldclawCompactionPolicy": COMPACTION_POLICY,
                "worldclawSourceMeshCount": ledger["sourceMeshCount"],
                "worldclawMergedMeshCount": len(grouped),
                "worldclawComponentLedgerSha256": ledger["componentsSha256"],
                "worldclawTopologySha256": ledger["geometryFingerprint"]["topologySha256"],
                "worldclawSourceShadingSha256": ledger["shadingFingerprint"]["sha256"],
                "worldclawExportedAttributeSha256": attribute_fingerprint["sha256"],
            }
        )
        compact["nodes"].append({"name": root_name, "children": [], "extras": root_extras})
        compact["scenes"][0]["nodes"].append(root_output_index)

        merged_names: list[str] = []
        for material_index in sorted(grouped, key=lambda index: material_names[index]):
            primitives = grouped[material_index]
            positions = bytearray()
            normals = bytearray()
            indices: list[int] = []
            vertex_offset = 0
            bounds_min = [math.inf, math.inf, math.inf]
            bounds_max = [-math.inf, -math.inf, -math.inf]
            for primitive in primitives:
                position_accessor = source["accessors"][primitive["attributes"]["POSITION"]]
                normal_accessor = source["accessors"][primitive["attributes"]["NORMAL"]]
                index_accessor = source["accessors"][primitive["indices"]]
                if position_accessor["componentType"] != 5126 or position_accessor["type"] != "VEC3":
                    raise RuntimeError(f"{root_name}: POSITION must remain float VEC3")
                if normal_accessor["componentType"] != 5126 or normal_accessor["type"] != "VEC3":
                    raise RuntimeError(f"{root_name}: NORMAL must remain float VEC3")
                if index_accessor["componentType"] not in {5121, 5123, 5125}:
                    raise RuntimeError(f"{root_name}: unsupported source index type {index_accessor['componentType']}")
                positions.extend(accessor_bytes(source, source_binary, primitive["attributes"]["POSITION"]))
                normals.extend(accessor_bytes(source, source_binary, primitive["attributes"]["NORMAL"]))
                raw_indices = accessor_bytes(source, source_binary, primitive["indices"])
                code = {5121: "B", 5123: "H", 5125: "I"}[index_accessor["componentType"]]
                values = struct.unpack(f"<{index_accessor['count']}{code}", raw_indices)
                indices.extend(vertex_offset + value for value in values)
                vertex_offset += int(position_accessor["count"])
                for axis in range(3):
                    bounds_min[axis] = min(bounds_min[axis], float(position_accessor["min"][axis]))
                    bounds_max[axis] = max(bounds_max[axis], float(position_accessor["max"][axis]))

            component_type, index_code = (5123, "H") if vertex_offset <= 65535 else (5125, "I")
            index_payload = struct.pack(f"<{len(indices)}{index_code}", *indices)
            position_template = {"componentType": 5126, "count": vertex_offset, "type": "VEC3"}
            normal_template = {"componentType": 5126, "count": vertex_offset, "type": "VEC3"}
            index_template = {"componentType": component_type, "count": len(indices), "type": "SCALAR"}
            position_index = append_accessor(bytes(positions), position_template, 34962, minimum=bounds_min, maximum=bounds_max)
            normal_index = append_accessor(bytes(normals), normal_template, 34962)
            index_index = append_accessor(index_payload, index_template, 34963, minimum=[min(indices)], maximum=[max(indices)])
            merged_name = f"GEO-MERGED_{safe_export_name(root_name.removeprefix('ASSET_'))}_{safe_export_name(material_names[material_index].removeprefix('MAT-'))}"
            mesh_index = len(compact["meshes"])
            compact["meshes"].append(
                {
                    "name": f"{merged_name}-mesh",
                    "primitives": [
                        {
                            "attributes": {"POSITION": position_index, "NORMAL": normal_index},
                            "indices": index_index,
                            "material": material_index,
                        }
                    ],
                }
            )
            child_index = len(compact["nodes"])
            compact["nodes"].append(
                {
                    "name": merged_name,
                    "mesh": mesh_index,
                    "extras": {
                        "assetKey": root_extras["assetKey"],
                        "worldclawMergedByMaterial": True,
                        "worldclawMaterial": material_names[material_index],
                        "worldclawSourceMeshCount": len(primitives),
                    },
                }
            )
            compact["nodes"][root_output_index]["children"].append(child_index)
            merged_names.append(merged_name)
        roots_report[root_name] = {
            "sourceMeshCount": ledger["sourceMeshCount"],
            "mergedMeshCount": len(grouped),
            "meshReduction": ledger["sourceMeshCount"] - len(grouped),
            "materialNames": [material_names[index] for index in sorted(grouped, key=lambda index: material_names[index])],
            "mergedNodeNames": merged_names,
            "geometryFingerprint": ledger["geometryFingerprint"],
            "exportedAttributeFingerprint": attribute_fingerprint,
        }

    if total_source_meshes != sum(item["sourceMeshCount"] for item in ledgers.values()):
        raise RuntimeError(f"Detailed GLB contains {total_source_meshes} mesh primitives; authoring ledger has {sum(item['sourceMeshCount'] for item in ledgers.values())}")
    while len(binary) % 4:
        binary.append(0)
    compact["buffers"][0]["byteLength"] = len(binary)
    json_payload = json.dumps(compact, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_payload += b" " * ((-len(json_payload)) % 4)
    total_length = 12 + 8 + len(json_payload) + 8 + len(binary)
    output_path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<II", len(json_payload), 0x4E4F534A)
        + json_payload
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )
    return {
        "version": COMPACTION_VERSION,
        "policy": COMPACTION_POLICY,
        "sourceNodeCount": sum(item["sourceMeshCount"] + 1 for item in ledgers.values()),
        "sourceMeshCount": total_source_meshes,
        "mergedNodeCount": len(compact["nodes"]),
        "mergedMeshCount": len(compact["meshes"]),
        "exportedVertexCount": sum(
            compact["accessors"][primitive["attributes"]["POSITION"]]["count"]
            for mesh in compact["meshes"]
            for primitive in mesh["primitives"]
        ),
        "exportedTriangleCount": sum(
            compact["accessors"][primitive["indices"]]["count"] // 3
            for mesh in compact["meshes"]
            for primitive in mesh["primitives"]
        ),
        "nodeReduction": total_source_meshes - len(compact["meshes"]),
        "meshReduction": total_source_meshes - len(compact["meshes"]),
        "jsonChunkBytes": len(json_payload),
        "binaryChunkBytes": len(binary),
        "roots": roots_report,
    }


def triangles_for(obj: bpy.types.Object) -> int:
    return sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)


def prototype_stats(root: bpy.types.Object, target_height: float) -> dict[str, Any]:
    meshes = mesh_children(root)
    bounds = bounds_for(root)
    actual_height = bounds["size"][2]
    if abs(actual_height - target_height) > 0.001:
        raise RuntimeError(f"{root.name} height {actual_height:.6f}m != target {target_height:.6f}m")
    if abs(bounds["min"][2]) > 0.001:
        raise RuntimeError(f"{root.name} is not grounded at z=0 (min z={bounds['min'][2]:.6f})")
    materials = sorted({slot.material.name for obj in meshes for slot in obj.material_slots if slot.material})
    return {
        "node": root.name,
        "targetHeightMeters": target_height,
        "boundsZUpMeters": bounds,
        "meshCount": len(meshes),
        "materialCount": len(materials),
        "materials": materials,
        "vertexCount": sum(len(obj.data.vertices) for obj in meshes),
        "triangleCount": sum(triangles_for(obj) for obj in meshes),
    }


def validate_scene(
    roots: dict[str, bpy.types.Object],
    variant_roots: dict[str, bpy.types.Object],
    manifest: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    prototype_report: dict[str, Any] = {}
    variant_report: dict[str, Any] = {}
    object_names: set[str] = set()
    for obj in bpy.data.objects:
        if obj.name in object_names:
            raise RuntimeError(f"Duplicate object name: {obj.name}")
        object_names.add(obj.name)
        if obj.type == "MESH":
            if not obj.name.startswith("GEO-"):
                raise RuntimeError(f"Mesh object lacks GEO- prefix: {obj.name}")
            if obj.location.length > 1e-7 or any(abs(angle) > 1e-7 for angle in obj.rotation_euler) or any(abs(v - 1) > 1e-7 for v in obj.scale):
                raise RuntimeError(f"Mesh has unapplied transform: {obj.name}")
            if not obj.data.polygons:
                raise RuntimeError(f"Mesh has no faces: {obj.name}")
            if not obj.material_slots or obj.material_slots[0].material is None:
                raise RuntimeError(f"Mesh has no export material: {obj.name}")
    for mat in bpy.data.materials:
        if not mat.name.startswith("MAT-"):
            raise RuntimeError(f"Material lacks MAT- prefix: {mat.name}")
        node_types = {node.type for node in mat.node_tree.nodes}
        if node_types != {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            raise RuntimeError(f"Material {mat.name} is not Principled-only: {sorted(node_types)}")
    for key in ASSET_KEYS:
        target = float(manifest["prototypes"][key]["targetHeightMeters"])
        prototype_report[key] = prototype_stats(roots[key], target)
    for node, root in sorted(variant_roots.items()):
        variant_report[node] = prototype_stats(root, float(root["targetHeightMeters"]))
    total_triangles = sum(item["triangleCount"] for item in prototype_report.values()) + sum(
        item["triangleCount"] for item in variant_report.values()
    )
    if total_triangles > int(manifest["library"]["maxTriangles"]):
        breakdown = {
            **{key: item["triangleCount"] for key, item in prototype_report.items()},
            **{node: item["triangleCount"] for node, item in variant_report.items()},
        }
        raise RuntimeError(
            f"Scene triangle budget exceeded: {total_triangles} > {manifest['library']['maxTriangles']}; "
            f"breakdown={json.dumps(breakdown, sort_keys=True)}"
        )
    return prototype_report, variant_report


def decode_app_value(value: Any) -> str:
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def relative(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def capability_report(manifest: dict[str, Any]) -> dict[str, Any]:
    capabilities = manifest["capabilities"]
    construction = capabilities["constructionVocabulary"]
    prototypes: dict[str, Any] = {}
    for key in ASSET_KEYS:
        spec = manifest["prototypes"][key]
        prototypes[key] = {
            "defaultVariant": spec["defaultVariant"],
            "variants": [
                {
                    "id": variant["id"],
                    "node": variant["node"],
                    "status": variant["status"],
                    "appearanceTerms": variant["appearanceTerms"],
                    "materialIds": variant["materialIds"],
                    "constructionRecipe": variant["constructionRecipe"],
                    **({"targetHeightMeters": variant["targetHeightMeters"]} if "targetHeightMeters" in variant else {}),
                    **({"collider": variant["collider"]} if "collider" in variant else {}),
                    **({"evidence": variant["evidence"]} if "evidence" in variant else {}),
                    **({"provenance": variant["provenance"]} if "provenance" in variant else {}),
                }
                for variant in spec["variants"]
            ],
            "evidence": spec["evidence"],
        }
    return {
        "schemaVersion": capabilities["version"],
        "appearanceSelection": capabilities["appearanceSelection"],
        "materialVocabularyCount": len(capabilities["materialVocabulary"]),
        "materialIds": sorted(capabilities["materialVocabulary"]),
        "constructionVocabularyCounts": {
            key: len(value) for key, value in construction.items() if isinstance(value, dict)
        },
        "constructionIds": {
            key: sorted(value) for key, value in construction.items() if isinstance(value, dict)
        },
        "researchReferenceCount": len(capabilities["researchReferences"]),
        "researchReferences": capabilities["researchReferences"],
        "authoredVariantCount": sum(len(manifest["prototypes"][key]["variants"]) for key in ASSET_KEYS),
        "prototypes": prototypes,
    }


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(collection):
            collection.remove(datablock)
    scene = bpy.context.scene
    scene.name = "WorldClaw Asset Kit"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"


def main() -> None:
    args = parse_args()
    manifest_path, output_path, report_path, public_manifest_path = map(
        absolute, (args.manifest, args.output, args.report, args.public_manifest)
    )
    manifest_text = manifest_path.read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    if manifest.get("version") != 1:
        raise RuntimeError(f"Unsupported manifest version: {manifest.get('version')!r}")
    if tuple(manifest.get("prototypes", {}).keys()) != ASSET_KEYS:
        raise RuntimeError(f"Manifest prototypes must be ordered exactly as {ASSET_KEYS}")
    random.seed(DETERMINISTIC_SEED)
    reset_scene()
    materials = build_materials()
    roots: dict[str, bpy.types.Object] = {}
    variant_roots: dict[str, bpy.types.Object] = {}
    for key in ASSET_KEYS:
        spec = manifest["prototypes"][key]
        if spec.get("generator") != key or spec.get("source") != "blender_procedural":
            raise RuntimeError(f"Prototype contract mismatch for {key}")
        variants = spec.get("variants", [])
        if not variants or spec.get("defaultVariant") not in {variant.get("id") for variant in variants}:
            raise RuntimeError(f"Prototype {key} has no authored default variant")
        root = asset_root(key, spec)
        BUILDERS[key](root, materials)
        normalize_asset(root, float(spec["targetHeightMeters"]))
        roots[key] = root
        for variant in variants:
            if variant.get("node") == spec["node"]:
                continue
            if variant["node"] in variant_roots:
                raise RuntimeError(f"Duplicate authored variant node {variant['node']}")
            builder = VARIANT_BUILDERS.get(variant["id"])
            if builder is None:
                raise RuntimeError(f"No geometry builder for authored variant {key}/{variant['id']}")
            alternate = variant_root(key, spec, variant)
            builder(alternate, materials)
            normalize_asset(alternate, float(variant.get("targetHeightMeters", spec["targetHeightMeters"])))
            variant_roots[variant["node"]] = alternate
    prototype_report, variant_report = validate_scene(roots, variant_roots, manifest)
    ordered_roots = [roots[key] for key in ASSET_KEYS] + [variant_roots[node] for node in sorted(variant_roots)]
    component_ledgers = {
        root.name: component_ledger(root, float(root["targetHeightMeters"])) for root in ordered_roots
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    public_manifest_path.parent.mkdir(parents=True, exist_ok=True)
    # Publish the source contract byte-for-byte so deployed parity can be
    # proven directly, not only after parsing and re-serializing JSON.
    public_manifest_path.write_text(manifest_text, encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="worldclaw-detailed-export-") as temp_dir:
        detailed_path = Path(temp_dir) / "worldclaw-kit-detailed.glb"
        bpy.ops.export_scene.gltf(
            filepath=str(detailed_path),
            check_existing=False,
            export_format="GLB",
            export_apply=True,
            export_yup=True,
            export_normals=True,
            export_texcoords=False,
            export_tangents=False,
            export_materials="EXPORT",
            export_animations=False,
            export_skins=False,
            export_morph=False,
            export_cameras=False,
            export_lights=False,
            export_extras=True,
        )
        if args.detailed_output:
            detailed_output = absolute(args.detailed_output)
            detailed_output.parent.mkdir(parents=True, exist_ok=True)
            detailed_output.write_bytes(detailed_path.read_bytes())
        compaction_report = write_compact_glb(detailed_path, output_path, component_ledgers)
    if compaction_report["mergedNodeCount"] > MAX_COMPACT_NODES:
        raise RuntimeError(
            f"Compacted GLB has {compaction_report['mergedNodeCount']} nodes; limit is {MAX_COMPACT_NODES}"
        )
    if compaction_report["mergedMeshCount"] > MAX_COMPACT_MESHES:
        raise RuntimeError(
            f"Compacted GLB has {compaction_report['mergedMeshCount']} meshes; limit is {MAX_COMPACT_MESHES}"
        )
    artifact = output_path.read_bytes()
    if len(artifact) > MAX_COMPACT_BYTES:
        raise RuntimeError(f"Compacted GLB is {len(artifact)} bytes; web compaction limit is {MAX_COMPACT_BYTES}")
    all_meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    total_scene_triangles = sum(triangles_for(obj) for obj in all_meshes)
    report = {
        "version": 1,
        "status": "built",
        "generator": {
            "script": relative(Path(__file__).resolve()),
            "deterministicSeed": DETERMINISTIC_SEED,
            "blenderVersion": bpy.app.version_string,
            "blenderBuildHash": decode_app_value(bpy.app.build_hash),
        },
        "inputs": {
            "manifest": relative(manifest_path),
            "publishedManifest": relative(public_manifest_path),
        },
        "artifact": {
            "path": relative(output_path),
            "byteLength": len(artifact),
            "sha256": hashlib.sha256(artifact).hexdigest(),
        },
        "compaction": {
            **compaction_report,
            "componentLedgerVersion": 1,
            "componentLedgers": component_ledgers,
        },
        "capabilityContract": capability_report(manifest),
        "browserBudgetContext": {
            "scorecard": "docs/paper-superiority-scorecard.md",
            "initialAssetPayloadLimitBytes": 8_000_000,
            "desktopVisibleTriangleLimit": 1_500_000,
            "mobileVisibleTriangleLimit": 500_000,
            "libraryByteUtilizationOfInitialPayload": round(len(artifact) / 8_000_000, 6),
            "libraryTriangleUtilizationOfDesktopVisibleLimit": round(total_scene_triangles / 1_500_000, 6),
            "libraryTriangleUtilizationOfMobileVisibleLimit": round(total_scene_triangles / 500_000, 6),
            "note": "The library is one shared cacheable GLB and authored object batches are instanced by URI plus node. Scene-visible budgets remain runtime gates; this offline total is not multiplied into a capture unless every unique root is simultaneously visible.",
        },
        "evidence": {
            "status": "pending_render",
            "renderer": "scripts/blender/render-worldclaw-dossiers.py",
            "renderSource": manifest["evidence"]["renderSource"],
            "contactSheetUri": manifest["evidence"]["contactSheetUri"],
            "turnaroundViews": manifest["evidence"]["turnaroundViews"],
        },
        "authoringSceneZUp": {
            "metersPerUnit": 1,
            "groundZ": 0,
            "nodeCount": compaction_report["sourceNodeCount"],
            "meshCount": compaction_report["sourceMeshCount"],
            "materialCount": len(bpy.data.materials),
            "vertexCount": sum(
                item["sourceVertexCount"] for item in component_ledgers.values()
            ),
            "triangleCount": sum(
                item["sourceTriangleCount"] for item in component_ledgers.values()
            ),
            "prototypes": prototype_report,
            "variants": variant_report,
        },
        "sceneZUp": {
            "metersPerUnit": 1,
            "groundZ": 0,
            "nodeCount": compaction_report["mergedNodeCount"],
            "meshCount": compaction_report["mergedMeshCount"],
            "materialCount": len(bpy.data.materials),
            "vertexCount": compaction_report["exportedVertexCount"],
            "triangleCount": total_scene_triangles,
        },
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        "WORLDCLAW_BUILD_OK "
        f"output={relative(output_path)} bytes={len(artifact)} "
        f"nodes={report['sceneZUp']['nodeCount']} meshes={report['sceneZUp']['meshCount']} "
        f"materials={report['sceneZUp']['materialCount']} triangles={report['sceneZUp']['triangleCount']} "
        f"sha256={report['artifact']['sha256']}"
    )


if __name__ == "__main__":
    main()
