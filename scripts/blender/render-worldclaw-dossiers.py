#!/usr/bin/env python3
"""Render deterministic visual dossiers from the exported WorldClaw GLB.

The renderer intentionally imports the published GLB into a fresh Blender
process. Evidence therefore exercises the same Y-up artifact consumed by
Three.js instead of showing the richer authoring scene by accident.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

import bpy
from mathutils import Matrix, Vector


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GLB = REPO_ROOT / "public/worldclaw/assets/worldclaw-kit.glb"
DEFAULT_MANIFEST = REPO_ROOT / "assets/worldclaw/asset-library.json"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public/worldclaw/assets/dossiers"
DEFAULT_REPORT = REPO_ROOT / "public/worldclaw/assets/worldclaw-kit.report.json"
ASSET_KEYS = (
    "palm", "tree", "pine", "rock", "cactus", "hut", "building",
    "watchtower", "ship", "tank", "pagoda", "torii", "bridge",
    "dragon", "windmill", "mine", "crystal", "antenna", "satellite",
    "dock", "tent", "well", "statue", "fence", "campfire",
    "crate", "market",
)
CONTACT_VARIANT_LABELS = {
    "building_timber_frame_white_tile": "timber_tile_house",
    "tree_bamboo_cluster": "bamboo_cluster",
    "tree_cherry_blossom": "cherry_blossom",
    "building_hobbit_round_door": "hobbit_home",
    "building_futuristic_facility": "future_facility",
    "building_fortified_bunker": "fortified_bunker",
    "tank_tracked_excavator": "tracked_excavator",
}
VIEW_SPECS = (
    ("front", 0.0),
    ("front_three_quarter", math.radians(-42)),
    ("side", math.radians(-90)),
    ("rear", math.radians(180)),
)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--glb", type=Path, default=DEFAULT_GLB)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args(argv)


def absolute(path: Path) -> Path:
    return path if path.is_absolute() else REPO_ROOT / path


def relative(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            datablocks.remove(datablock)


def set_input(node: bpy.types.Node, name: str, value: Any) -> None:
    socket = next((socket for socket in node.inputs if socket.name == name), None)
    if socket is None:
        raise RuntimeError(f"Missing Principled input {name!r}")
    socket.default_value = value


def studio_material(name: str, color: Sequence[float], roughness: float) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(node for node in mat.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    set_input(bsdf, "Base Color", (*color, 1.0))
    set_input(bsdf, "Roughness", roughness)
    return mat


def descendants(root: bpy.types.Object) -> Iterable[bpy.types.Object]:
    yield root
    for child in root.children:
        yield from descendants(child)


def set_render_visibility(root: bpy.types.Object, visible: bool) -> None:
    for obj in descendants(root):
        obj.hide_render = not visible
        obj.hide_viewport = not visible


def world_bounds(root: bpy.types.Object) -> tuple[Vector, Vector]:
    points: list[Vector] = []
    for obj in descendants(root):
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
    if not points:
        raise RuntimeError(f"{root.name} has no mesh geometry")
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def combined_bounds(roots: Iterable[bpy.types.Object]) -> tuple[Vector, Vector]:
    bounds = [world_bounds(root) for root in roots]
    minimum = Vector(tuple(min(item[0][axis] for item in bounds) for axis in range(3)))
    maximum = Vector(tuple(max(item[1][axis] for item in bounds) for axis in range(3)))
    return minimum, maximum


def duplicate_tree(source: bpy.types.Object, parent: bpy.types.Object, suffix: str) -> bpy.types.Object:
    clone = source.copy()
    clone.data = source.data
    clone.name = f"DOSSIER_{suffix}_{source.name}"
    bpy.context.collection.objects.link(clone)
    clone.parent = parent
    clone.matrix_parent_inverse = Matrix.Identity(4)
    clone.matrix_basis = source.matrix_basis.copy()
    clone.hide_render = False
    clone.hide_viewport = False
    for child in source.children:
        duplicate_tree(child, clone, suffix)
    return clone


def wrapper_for(source: bpy.types.Object, name: str, location: Sequence[float], angle: float, scale: float = 1.0) -> bpy.types.Object:
    wrapper = bpy.data.objects.new(f"DOSSIER_WRAPPER_{name}", None)
    bpy.context.collection.objects.link(wrapper)
    wrapper.location = location
    wrapper.rotation_euler[2] = angle
    wrapper.scale = (scale, scale, scale)
    duplicate_tree(source, wrapper, name)
    return wrapper


def look_at(obj: bpy.types.Object, target: Sequence[float]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_area(name: str, location: Sequence[float], energy: float, size: float, color: Sequence[float]) -> bpy.types.Object:
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    look_at(obj, (0, 0, 2.4))
    return obj


def add_label(text: str, location: Sequence[float], camera: bpy.types.Object, scale: float) -> bpy.types.Object:
    curve = bpy.data.curves.new(f"DOSSIER_LABEL_{text}", "FONT")
    curve.body = text.replace("_", " ").upper()
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = scale
    curve.extrude = scale * 0.006
    obj = bpy.data.objects.new(f"DOSSIER_LABEL_{text}", curve)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (camera.location - obj.location).to_track_quat("Z", "Y").to_euler()
    curve.materials.append(bpy.data.materials["MAT-DOSSIER-label"])
    return obj


def delete_dossier_objects() -> None:
    for obj in list(bpy.data.objects):
        if obj.name.startswith("DOSSIER_"):
            bpy.data.objects.remove(obj, do_unlink=True)
    for curve in list(bpy.data.curves):
        if curve.name.startswith("DOSSIER_"):
            bpy.data.curves.remove(curve)


def configure_studio() -> tuple[bpy.types.Object, bpy.types.Object]:
    scene = bpy.context.scene
    scene.name = "WorldClaw GLB Dossier Studio"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 18
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    if hasattr(scene, "eevee") and hasattr(scene.eevee, "taa_render_samples"):
        scene.eevee.taa_render_samples = 32
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.65
    scene.world.color = (0.035, 0.045, 0.055)
    world_nodes = scene.world.node_tree.nodes if scene.world.use_nodes else None
    if world_nodes is not None:
        background = next((node for node in world_nodes if node.type == "BACKGROUND"), None)
        if background:
            background.inputs["Color"].default_value = (0.035, 0.045, 0.055, 1)
            background.inputs["Strength"].default_value = 0.46

    ground_mat = studio_material("MAT-DOSSIER-ground", (0.105, 0.115, 0.12), 0.88)
    label_mat = studio_material("MAT-DOSSIER-label", (0.74, 0.79, 0.78), 0.56)
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, -0.015))
    ground = bpy.context.active_object
    ground.name = "STUDIO_ground"
    ground.data.materials.append(ground_mat)

    camera_data = bpy.data.cameras.new("CAM-DOSSIER")
    camera_data.type = "ORTHO"
    camera_data.lens = 52
    camera = bpy.data.objects.new("CAM-DOSSIER", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    add_area("LIGHT-key", (-8.5, -10.5, 13.5), 1750, 6.0, (1.0, 0.82, 0.66))
    add_area("LIGHT-fill", (10.0, -4.0, 7.0), 1050, 7.0, (0.58, 0.72, 1.0))
    add_area("LIGHT-rim", (-5.5, 8.0, 10.5), 1450, 5.0, (0.78, 0.9, 1.0))
    return camera, label_mat


def render_turnaround(
    key: str,
    source: bpy.types.Object,
    camera: bpy.types.Object,
    output: Path,
    *,
    prototype: str | None = None,
    variant_id: str | None = None,
) -> dict[str, Any]:
    minimum, maximum = world_bounds(source)
    size = maximum - minimum
    footprint = max(size.x, size.y)
    wide_technical_layout = footprint > size.z * 4.0
    if wide_technical_layout:
        # A single row makes a 16 m bridge only a few dozen pixels tall. A
        # deterministic 2x2 technical grid keeps all four orthographic views
        # legible without changing the published 1600x650 evidence contract.
        placements = ((-8.5, 0, 3.15), (8.5, 0, 3.15), (-8.5, 0, 0), (8.5, 0, 0))
        wrappers = [
            wrapper_for(source, f"{key}_{view}", location, angle)
            for (view, angle), location in zip(VIEW_SPECS, placements, strict=True)
        ]
    else:
        spacing = max(footprint * 1.12, size.z * 0.64)
        centers = tuple((index - 1.5) * spacing for index in range(4))
        placements = tuple((x, 0, 0) for x in centers)
        wrappers = [
            wrapper_for(source, f"{key}_{view}", location, angle)
            for (view, angle), location in zip(VIEW_SPECS, placements, strict=True)
        ]
    bpy.context.view_layer.update()
    rendered_minimum, rendered_maximum = combined_bounds(wrappers)
    rendered_size = rendered_maximum - rendered_minimum
    rendered_center = (rendered_minimum + rendered_maximum) / 2
    camera.location = (rendered_center.x, rendered_minimum.y - max(18, rendered_size.y * 3.5), rendered_center.z + rendered_size.z * 0.12)
    look_at(camera, rendered_center)
    aspect = 1600 / 650
    # Blender defines ortho_scale as view width. Height therefore consumes
    # width * (resolution_y / resolution_x), so vertical fit multiplies by aspect.
    width_margin = 1.08 if wide_technical_layout else 1.16
    height_margin = 1.22 if wide_technical_layout else 1.4
    camera.data.ortho_scale = max(rendered_size.x * width_margin, rendered_size.z * aspect * height_margin)
    for (view, _), location in zip(VIEW_SPECS, placements, strict=True):
        add_label(
            view,
            (location[0], rendered_minimum.y - 0.18, location[2] + size.z * 0.04),
            camera,
            max(0.17, size.z * 0.035),
        )

    scene = bpy.context.scene
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 650
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    delete_dossier_objects()
    return {
        "prototype": prototype or key,
        **({"variantId": variant_id} if variant_id else {}),
        "path": relative(output),
        "uri": f"/worldclaw/assets/dossiers/{output.name}",
        "width": 1600,
        "height": 650,
        "views": [view for view, _ in VIEW_SPECS],
        "layout": "two_by_two_technical" if wide_technical_layout else "single_row",
        "targetHeightMeters": round(size.z, 4),
    }


def render_contact_sheet(sources: dict[str, bpy.types.Object], camera: bpy.types.Object, output: Path) -> dict[str, Any]:
    columns = 6
    rows = math.ceil(len(sources) / columns)
    display_height = 3.0
    wrappers: list[bpy.types.Object] = []
    entries = list(sources.items())

    def cell_position(index: int) -> tuple[float, float]:
        row, column = divmod(index, columns)
        row_count = min(columns, len(entries) - row * columns)
        return (column - (row_count - 1) / 2) * 4.8, (rows - 1 - row) * 4.55

    for index, (key, source) in enumerate(entries):
        minimum, maximum = world_bounds(source)
        height = maximum.z - minimum.z
        scale = display_height / height
        x, z = cell_position(index)
        wrappers.append(wrapper_for(source, f"contact_{key}", (x, 0, z), math.radians(-28), scale))

    bpy.context.view_layer.update()
    rendered_minimum, rendered_maximum = combined_bounds(wrappers)
    rendered_size = rendered_maximum - rendered_minimum
    rendered_center = (rendered_minimum + rendered_maximum) / 2
    camera.location = (rendered_center.x, rendered_minimum.y - 25, rendered_center.z + 0.8)
    look_at(camera, rendered_center)
    aspect = 1920 / 1080
    camera.data.ortho_scale = max(rendered_size.x * 1.12, rendered_size.z * aspect * 1.28)
    for index, (key, _) in enumerate(entries):
        x, z = cell_position(index)
        add_label(key, (x, rendered_minimum.y - 0.2, z + 0.12), camera, 0.22)

    scene = bpy.context.scene
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    delete_dossier_objects()
    return {
        "path": relative(output),
        "uri": f"/worldclaw/assets/dossiers/{output.name}",
        "width": 1920,
        "height": 1080,
        "layout": {"columns": columns, "rows": rows, "displayHeightMeters": display_height},
        "prototypes": list(ASSET_KEYS),
        "variantEntries": [key for key in sources if key not in ASSET_KEYS],
        "entries": list(sources),
    }


def main() -> None:
    args = parse_args()
    glb, manifest_path, output_dir, report_path = map(absolute, (args.glb, args.manifest, args.output_dir, args.report))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if tuple(manifest["prototypes"]) != ASSET_KEYS:
        raise RuntimeError("Manifest prototype order does not match renderer contract")
    if manifest["evidence"]["renderSource"] != "exported_glb_roundtrip":
        raise RuntimeError("Evidence renderSource must remain exported_glb_roundtrip")
    output_dir.mkdir(parents=True, exist_ok=True)
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(glb), import_pack_images=False, merge_vertices=False)
    for obj in tuple(bpy.data.objects):
        if obj.name.startswith("ASSET_"):
            set_render_visibility(obj, False)
    sources: dict[str, bpy.types.Object] = {}
    for key in ASSET_KEYS:
        node = manifest["prototypes"][key]["node"]
        source = bpy.data.objects.get(node)
        if source is None:
            raise RuntimeError(f"Imported GLB is missing {node}")
        sources[key] = source

    camera, _ = configure_studio()
    turnarounds = [
        render_turnaround(key, sources[key], camera, output_dir / f"{key}-turnaround.png")
        for key in ASSET_KEYS
    ]
    variant_sources: dict[str, bpy.types.Object] = {}
    for key in ASSET_KEYS:
        spec = manifest["prototypes"][key]
        for variant in spec["variants"]:
            if variant["node"] == spec["node"] or "evidence" not in variant:
                continue
            source = bpy.data.objects.get(variant["node"])
            if source is None:
                raise RuntimeError(f"Imported GLB is missing authored variant node {variant['node']}")
            variant_sources[CONTACT_VARIANT_LABELS.get(variant["id"], variant["id"])] = source
            output_name = Path(variant["evidence"]["turnaroundUri"]).name
            turnarounds.append(
                render_turnaround(
                    variant["id"], source, camera, output_dir / output_name,
                    prototype=key, variant_id=variant["id"],
                )
            )
    # Wide technical assets go last so their footprints cannot occlude compact
    # architecture and props in the earlier contact-sheet cells.
    contact_sources = {
        **{key: source for key, source in sources.items() if key not in {"bridge", "dock"}},
        **variant_sources,
        "bridge": sources["bridge"],
        "dock": sources["dock"],
    }
    contact_sheet = render_contact_sheet(
        contact_sources, camera, output_dir / "worldclaw-kit-contact-sheet.png",
    )
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {"version": 1}
    report["evidence"] = {
        "status": "rendered",
        "renderer": relative(Path(__file__).resolve()),
        "renderSource": "exported_glb_roundtrip",
        "engine": "BLENDER_EEVEE",
        "viewTransform": "AgX",
        "look": "AgX - Medium High Contrast",
        "projection": "orthographic",
        "turnarounds": turnarounds,
        "contactSheet": contact_sheet,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        "WORLDCLAW_DOSSIERS_OK "
        f"source={relative(glb)} turnarounds={len(turnarounds)} "
        f"contactSheet={contact_sheet['path']}"
    )


if __name__ == "__main__":
    main()
