import { useMemo } from "react";
import * as THREE from "three";
import { TERRAIN_MATERIALS } from "~/lib/worldclaw/materials";
import type { ScenePlan, HeightField, ViewMode } from "~/lib/worldclaw/types";

function categoryColor(
  plan: ScenePlan,
  regionIndex: number,
  viewMode: ViewMode,
): THREE.Color {
  const cat = plan.regions[regionIndex]?.category ?? "grass";
  if (viewMode === "instance") {
    const hue = (regionIndex * 47) % 360;
    return new THREE.Color(`hsl(${hue} 58% 52%)`);
  }
  if (viewMode === "depth") {
    return new THREE.Color("#777777");
  }
  const hex =
    plan.regions[regionIndex]?.color ??
    TERRAIN_MATERIALS[cat]?.albedo ??
    "#4a7c3f";
  return new THREE.Color(hex);
}

export function TerrainMesh({
  heightField,
  plan,
  viewMode,
}: {
  heightField: HeightField;
  plan: ScenePlan;
  viewMode: ViewMode;
}) {
  const { geometry, material } = useMemo(() => {
    const { resolution, worldSize, data, regionId } = heightField;
    const geo = new THREE.PlaneGeometry(
      worldSize,
      worldSize,
      resolution - 1,
      resolution - 1,
    );
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const color = new THREE.Color();
    const tmp = new THREE.Color();

    // Precompute min/max height for depth mode
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const h = data[i] ?? 0;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
    const hRange = Math.max(0.001, hMax - hMin);

    for (let i = 0; i < pos.count; i++) {
      const ix = i % resolution;
      const iy = Math.floor(i / resolution);
      const h = data[iy * resolution + ix] ?? 0;
      pos.setY(i, h);

      const ri = regionId[iy * resolution + ix] ?? 0;
      color.copy(categoryColor(plan, ri, viewMode));

      if (viewMode === "depth") {
        const t = (h - hMin) / hRange;
        color.setRGB(t, t, t);
      } else if (viewMode === "lit") {
        // Multi-sample slope darkening + micro detail
        const e = 1;
        const hL = data[iy * resolution + Math.max(0, ix - e)] ?? h;
        const hR =
          data[iy * resolution + Math.min(resolution - 1, ix + e)] ?? h;
        const hD = data[Math.max(0, iy - e) * resolution + ix] ?? h;
        const hU =
          data[Math.min(resolution - 1, iy + e) * resolution + ix] ?? h;
        const slope = Math.min(1, Math.hypot(hR - hL, hU - hD) * 0.28);

        // Blend toward rock on steep slopes
        if (slope > 0.25) {
          tmp.set("#6a6560");
          color.lerp(tmp, Math.min(0.65, (slope - 0.25) * 1.4));
        }

        // Height-based snow/highlight on peaks
        if (h > 4.5) {
          tmp.set("#eef2f6");
          color.lerp(tmp, Math.min(0.75, (h - 4.5) * 0.18));
        } else if (h > 3.2) {
          color.offsetHSL(0, -0.04, 0.06);
        }

        // Wet sand / shoreline darkening near water
        if (h > -0.2 && h < 0.55) {
          tmp.set("#c4b07a");
          color.lerp(tmp, 0.25);
        }
        if (h < 0) {
          tmp.set("#1a4a6e");
          color.lerp(tmp, Math.min(0.55, -h * 0.25));
        }

        // Ambient occlusion-ish from slope
        color.offsetHSL(0, 0, -slope * 0.22);

        // Subtle triplanar-style noise via hash of position
        const n =
          Math.sin(ix * 12.9898 + iy * 78.233) * 43758.5453;
        const grain = (n - Math.floor(n)) * 0.06 - 0.03;
        color.offsetHSL(0, 0, grain);
      }

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    pos.needsUpdate = true;
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    let mat: THREE.Material;
    if (viewMode === "normal") {
      mat = new THREE.MeshNormalMaterial({ flatShading: false });
    } else if (viewMode === "depth") {
      mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        flatShading: false,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        metalness: 0.03,
        flatShading: false,
        envMapIntensity: 0.35,
      });
    }

    return { geometry: geo, material: mat };
  }, [heightField, plan, viewMode]);

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
}: {
  worldSize: number;
  y?: number;
  color?: string;
}) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, y, 0]}
      receiveShadow
    >
      <planeGeometry args={[worldSize * 1.45, worldSize * 1.45, 64, 64]} />
      <meshPhysicalMaterial
        color={color}
        roughness={0.12}
        metalness={0.25}
        transmission={0.18}
        thickness={0.6}
        transparent
        opacity={0.92}
        ior={1.33}
        envMapIntensity={0.8}
      />
    </mesh>
  );
}
