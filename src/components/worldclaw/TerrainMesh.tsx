import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { TERRAIN_MATERIALS } from "~/lib/worldclaw/materials";
import { upsampleHeightField } from "~/lib/worldclaw/upsample";
import type { ScenePlan, HeightField, ViewMode } from "~/lib/worldclaw/types";

/** Vertex density target for the rendered terrain (per side). */
const MAX_RENDER_RES = 384;

function categoryColor(plan: ScenePlan, regionIndex: number, viewMode: ViewMode): THREE.Color {
  const cat = plan.regions[regionIndex]?.category ?? "grass";
  if (viewMode === "instance") {
    const hue = (regionIndex * 47) % 360;
    return new THREE.Color(`hsl(${hue} 58% 52%)`);
  }
  if (viewMode === "depth") {
    return new THREE.Color("#777777");
  }
  const hex = plan.regions[regionIndex]?.color ?? TERRAIN_MATERIALS[cat]?.albedo ?? "#4a7c3f";
  return new THREE.Color(hex);
}

/**
 * Reconstruct a small soft semantic mask from the categorical field.
 *
 * The authored height field keeps a compact primary-region id per cell for
 * gameplay.  Rendering that id directly creates hard Voronoi seams, so the
 * display mesh samples a fixed neighbourhood and blends region palettes near
 * boundaries.  The source field remains untouched and deterministic.
 */
function blendedRegionColor(
  palette: THREE.Color[],
  regionId: Uint8Array,
  resolution: number,
  ix: number,
  iy: number,
  target: THREE.Color,
) {
  const radius = 3;
  let red = 0;
  let green = 0;
  let blue = 0;
  let weightSum = 0;

  for (let oy = -radius; oy <= radius; oy += 3) {
    const sy = Math.max(0, Math.min(resolution - 1, iy + oy));
    for (let ox = -radius; ox <= radius; ox += 3) {
      const sx = Math.max(0, Math.min(resolution - 1, ix + ox));
      const distance = Math.hypot(ox, oy);
      const weight = distance === 0 ? 2.4 : 1 / (1 + distance * 0.55);
      const sample = palette[regionId[sy * resolution + sx] ?? 0] ?? palette[0];
      if (!sample) continue;
      red += sample.r * weight;
      green += sample.g * weight;
      blue += sample.b * weight;
      weightSum += weight;
    }
  }

  if (weightSum === 0) return target.set("#4a7c3f");
  return target.setRGB(red / weightSum, green / weightSum, blue / weightSum);
}

function hash01(ix: number, iy: number, seed: number) {
  const value = Math.sin(ix * 12.9898 + iy * 78.233 + seed * 0.000_071) * 43_758.5453;
  return value - Math.floor(value);
}

function terrainSlope(
  data: Float32Array,
  resolution: number,
  worldSize: number,
  ix: number,
  iy: number,
  h: number,
) {
  const hL = data[iy * resolution + Math.max(0, ix - 1)] ?? h;
  const hR = data[iy * resolution + Math.min(resolution - 1, ix + 1)] ?? h;
  const hD = data[Math.max(0, iy - 1) * resolution + ix] ?? h;
  const hU = data[Math.min(resolution - 1, iy + 1) * resolution + ix] ?? h;
  const cellSize = worldSize / (resolution - 1);
  return Math.min(1, Math.hypot(hR - hL, hU - hD) * (0.42 / (2 * cellSize)));
}

function shadeLitTerrainColor(
  color: THREE.Color,
  tmp: THREE.Color,
  h: number,
  slope: number,
  ix: number,
  iy: number,
  seed: number,
) {
  if (slope > 0.25) {
    tmp.set("#6a6560");
    color.lerp(tmp, Math.min(0.65, (slope - 0.25) * 1.4));
  }

  if (h > 4.5) {
    tmp.set("#eef2f6");
    color.lerp(tmp, Math.min(0.75, (h - 4.5) * 0.18));
  } else if (h > 3.2) {
    color.offsetHSL(0, -0.04, 0.06);
  }

  if (h > -0.2 && h < 0.55) {
    tmp.set("#c4b07a");
    color.lerp(tmp, 0.25);
  }
  if (h < 0) {
    tmp.set("#1a4a6e");
    color.lerp(tmp, Math.min(0.55, -h * 0.25));
  }

  color.offsetHSL(0, 0, -slope * 0.22);
  color.offsetHSL(0, 0, hash01(ix, iy, seed) * 0.06 - 0.03);
  return color;
}

export function TerrainMesh({
  heightField,
  plan,
  viewMode,
  seed = 0,
}: {
  heightField: HeightField;
  plan: ScenePlan;
  viewMode: ViewMode;
  seed?: number;
}) {
  // Upsample the authored field so the mesh renders at ~2× data density.
  // Heavy work is keyed on the field alone — switching view modes must not
  // re-run it.
  const renderField = useMemo(() => {
    const factor = Math.max(1, Math.floor((MAX_RENDER_RES - 1) / (heightField.resolution - 1)));
    const imageGuided = heightField.source === "image_guided";
    const microDetailScale = THREE.MathUtils.clamp(
      plan.visualContract?.terrainMicroDetailScale ?? (imageGuided ? 0.18 : 1),
      0,
      1,
    );
    const upsampled = upsampleHeightField(heightField, factor, seed, 0.06 * microDetailScale);

    // Catmull-Rom can overshoot at a sharp coast even when every authored
    // ocean sample is submerged. Clamp again against semantic ids at render
    // resolution. Copying protects the gameplay field when factor === 1.
    const data = upsampled.data.slice();
    const waterLevel = THREE.MathUtils.clamp(plan.visualContract?.waterLevelMeters ?? -0.35, -3, 1);
    const waterCeiling = waterLevel - 0.38;
    for (let index = 0; index < data.length; index++) {
      const category = plan.regions[upsampled.regionId[index] ?? 0]?.category;
      if (category === "ocean" || category === "river") {
        data[index] = Math.min(data[index] ?? waterCeiling, waterCeiling);
      }
    }
    return { ...upsampled, data };
  }, [heightField, plan, seed]);

  const geometry = useMemo(() => {
    const { resolution, worldSize, data } = renderField;
    const geo = new THREE.PlaneGeometry(worldSize, worldSize, resolution - 1, resolution - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % resolution;
      const iy = Math.floor(i / resolution);
      pos.setY(i, data[iy * resolution + ix] ?? 0);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }, [renderField]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  // Per-view-mode vertex colors are written into the shared geometry.
  useMemo(() => {
    const { resolution, worldSize, data, regionId } = renderField;
    const count = resolution * resolution;
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    const tmp = new THREE.Color();
    const regionPalette = plan.regions.map((_, index) => categoryColor(plan, index, viewMode));
    if (regionPalette.length === 0) {
      regionPalette.push(new THREE.Color("#4a7c3f"));
    }
    // Precompute min/max height for depth mode
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const h = data[i] ?? 0;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
    const hRange = Math.max(0.001, hMax - hMin);

    for (let i = 0; i < count; i++) {
      const ix = i % resolution;
      const iy = Math.floor(i / resolution);
      const h = data[iy * resolution + ix] ?? 0;

      const ri = regionId[iy * resolution + ix] ?? 0;
      if (viewMode === "lit") {
        blendedRegionColor(regionPalette, regionId, resolution, ix, iy, color);
      } else {
        color.copy(regionPalette[ri] ?? regionPalette[0]);
      }

      if (viewMode === "depth") {
        const t = (h - hMin) / hRange;
        color.setRGB(t, t, t);
      } else if (viewMode === "lit") {
        const slope = terrainSlope(data, resolution, worldSize, ix, iy, h);
        shadeLitTerrainColor(color, tmp, h, slope, ix, iy, seed);
      }

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }, [geometry, renderField, plan, seed, viewMode]);

  const terrainMaps = useMemo(() => {
    const { resolution, worldSize, data, regionId } = renderField;
    const count = resolution * resolution;
    const albedoBytes = new Uint8Array(count * 4);
    const roughnessBytes = new Uint8Array(count * 4);
    const normalBytes = new Uint8Array(count * 4);
    const palette = plan.regions.map((_, index) => categoryColor(plan, index, "lit"));
    if (palette.length === 0) palette.push(new THREE.Color("#4a7c3f"));

    const color = new THREE.Color();
    const tmp = new THREE.Color();
    const srgb = new THREE.Color();
    for (let index = 0; index < count; index++) {
      const ix = index % resolution;
      const iy = Math.floor(index / resolution);
      const h = data[index] ?? 0;
      const regionIndex = regionId[index] ?? 0;
      const category = plan.regions[regionIndex]?.category ?? "grass";
      const slope = terrainSlope(data, resolution, worldSize, ix, iy, h);

      blendedRegionColor(palette, regionId, resolution, ix, iy, color);
      shadeLitTerrainColor(color, tmp, h, slope, ix, iy, seed);
      srgb.copy(color).convertLinearToSRGB();
      albedoBytes[index * 4] = Math.round(THREE.MathUtils.clamp(srgb.r, 0, 1) * 255);
      albedoBytes[index * 4 + 1] = Math.round(THREE.MathUtils.clamp(srgb.g, 0, 1) * 255);
      albedoBytes[index * 4 + 2] = Math.round(THREE.MathUtils.clamp(srgb.b, 0, 1) * 255);
      albedoBytes[index * 4 + 3] = 255;

      const baseRoughness = TERRAIN_MATERIALS[category]?.roughness ?? 0.84;
      const roughness = THREE.MathUtils.clamp(
        baseRoughness + slope * 0.08 + (hash01(ix + 19, iy - 11, seed) - 0.5) * 0.12,
        0.35,
        1,
      );
      const roughByte = Math.round(roughness * 255);
      roughnessBytes[index * 4] = roughByte;
      roughnessBytes[index * 4 + 1] = roughByte;
      roughnessBytes[index * 4 + 2] = roughByte;
      roughnessBytes[index * 4 + 3] = 255;

      const baseDetailStrength =
        category === "rock" || category === "cliff" || category === "mountain"
          ? 0.52
          : category === "sand" || category === "desert"
            ? 0.28
            : category === "snow" || category === "ice"
              ? 0.14
              : 0.34;
      const microDetailScale = THREE.MathUtils.clamp(
        plan.visualContract?.terrainMicroDetailScale ??
          (heightField.source === "image_guided" ? 0.18 : 1),
        0,
        1,
      );
      const detailStrength = baseDetailStrength * microDetailScale;
      const dx = (hash01(ix + 1, iy, seed) - hash01(ix - 1, iy, seed)) * detailStrength;
      const dy = (hash01(ix, iy + 1, seed) - hash01(ix, iy - 1, seed)) * detailStrength;
      const invLength = 1 / Math.hypot(dx, dy, 1);
      normalBytes[index * 4] = Math.round((-dx * invLength * 0.5 + 0.5) * 255);
      normalBytes[index * 4 + 1] = Math.round((-dy * invLength * 0.5 + 0.5) * 255);
      normalBytes[index * 4 + 2] = Math.round((invLength * 0.5 + 0.5) * 255);
      normalBytes[index * 4 + 3] = 255;
    }

    const createTexture = (bytes: Uint8Array, colorSpace?: THREE.ColorSpace) => {
      const texture = new THREE.DataTexture(
        bytes,
        resolution,
        resolution,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      if (colorSpace) texture.colorSpace = colorSpace;
      texture.needsUpdate = true;
      return texture;
    };

    return {
      albedo: createTexture(albedoBytes, THREE.SRGBColorSpace),
      roughness: createTexture(roughnessBytes),
      normal: createTexture(normalBytes),
    };
  }, [heightField.source, plan, renderField, seed]);

  useEffect(
    () => () => {
      terrainMaps.albedo.dispose();
      terrainMaps.roughness.dispose();
      terrainMaps.normal.dispose();
    },
    [terrainMaps],
  );

  const material = useMemo(() => {
    if (viewMode === "normal") {
      return new THREE.MeshNormalMaterial({ flatShading: false });
    }
    if (viewMode === "depth") {
      return new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      });
    }
    if (viewMode === "instance") {
      return new THREE.MeshBasicMaterial({
        vertexColors: true,
        toneMapped: false,
        fog: false,
      });
    }
    return new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: terrainMaps.albedo,
      roughness: 1,
      roughnessMap: terrainMaps.roughness,
      normalMap: terrainMaps.normal,
      normalScale: new THREE.Vector2(
        heightField.source === "image_guided" ? 0.22 : 0.55,
        heightField.source === "image_guided" ? 0.22 : 0.55,
      ),
      metalness: 0.03,
      flatShading: false,
      envMapIntensity: 0.55,
    });
  }, [heightField.source, terrainMaps, viewMode]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      receiveShadow
      castShadow
      userData={{ terrain: true }}
    />
  );
}

/** Animated-looking water plane for ocean/river themes */
export function WaterPlane({
  worldSize,
  y = -0.4,
  color = "#1a5f8a",
  viewMode = "lit",
}: {
  worldSize: number;
  y?: number;
  color?: string;
  viewMode?: ViewMode;
}) {
  const material = useMemo(() => {
    if (viewMode === "normal") {
      return new THREE.MeshNormalMaterial();
    }
    if (viewMode === "depth") {
      return new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      });
    }
    if (viewMode === "instance") {
      return new THREE.MeshBasicMaterial({ color: "#1d8fa8" });
    }
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.2,
      metalness: 0.05,
      transparent: false,
      opacity: 1,
      ior: 1.33,
      envMapIntensity: 0.9,
      clearcoat: 0.75,
      clearcoatRoughness: 0.2,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
  }, [color, viewMode]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    // Draw after terrain. The opaque clear-coated surface hides the submerged
    // height mesh so ocean regions read as water, not blue-black terrain
    // spikes. No transmission: it would render the scene twice per frame.
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow renderOrder={10}>
      <planeGeometry args={[worldSize * 4, worldSize * 4, 64, 64]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
