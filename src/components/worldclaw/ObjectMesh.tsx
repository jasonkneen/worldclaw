import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";
import type { PlacedObject, ViewMode } from "~/lib/worldclaw/types";
import { BlenderAssetMesh } from "./BlenderAssetMesh";

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 65% 55%)`;
}

function useMat(
  color: string,
  viewMode: ViewMode,
  id: string,
  roughness = 0.75,
  metalness = 0.05,
) {
  return useMemo(() => {
    if (viewMode === "instance") {
      return new THREE.MeshBasicMaterial({
        color: hashColor(id),
        toneMapped: false,
        fog: false,
      });
    }
    if (viewMode === "normal") {
      return new THREE.MeshNormalMaterial();
    }
    if (viewMode === "depth") {
      return new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      });
    }
    return new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
    });
  }, [color, viewMode, id, roughness, metalness]);
}

function Group({
  obj,
  children,
}: {
  obj: PlacedObject;
  children: React.ReactNode;
}) {
  return (
    <group
      position={obj.position}
      rotation={obj.rotation as unknown as [number, number, number]}
      scale={obj.scale}
      userData={{ objectId: obj.id }}
    >
      {children}
    </group>
  );
}

interface ObjectMeshProps {
  obj: PlacedObject;
  viewMode: ViewMode;
  selected: boolean;
  onSelect: (id: string) => void;
  forcePrimitive?: boolean;
}

/** Public object renderer: compiled Blender asset first, primitive fallback. */
export function ObjectMesh(props: ObjectMeshProps) {
  const fallback = <PrimitiveObjectMesh {...props} />;
  const asset = props.obj.browserAsset;
  if (props.forcePrimitive || !asset) return fallback;

  return (
    <Suspense fallback={fallback}>
      <BlenderAssetMesh {...props} asset={asset} fallback={fallback} />
    </Suspense>
  );
}

function PrimitiveObjectMesh({
  obj,
  viewMode,
  selected,
  onSelect,
}: ObjectMeshProps) {
  const primary = useMat(obj.color, viewMode, obj.id);
  const secondaryBase = useMat(
    obj.secondaryColor ?? obj.color,
    viewMode,
    obj.id + "_s",
    0.8,
    0.02,
  );
  const secondary = viewMode === "instance" ? primary : secondaryBase;
  useEffect(
    () => () => {
      primary.dispose();
      secondaryBase.dispose();
    },
    [primary, secondaryBase],
  );
  // Emissive luminance must clear the bloom threshold (0.85 in linear HDR,
  // pre-tonemap) for glowing props to actually bloom: crystal #66aaff has
  // linear luminance ~0.39 and fire #ff6622 ~0.31, hence the ~3x intensities.
  const emissiveMat = useMemo(() => {
    if (viewMode !== "lit") return null;
    if (obj.kind === "crystal") {
      return new THREE.MeshStandardMaterial({
        color: obj.color,
        emissive: obj.color,
        emissiveIntensity: 3.0,
        roughness: 0.25,
        metalness: 0.4,
      });
    }
    if (obj.kind === "campfire") {
      return new THREE.MeshStandardMaterial({
        color: "#ffa055",
        emissive: "#ff6622",
        emissiveIntensity: 3.6,
      });
    }
    return null;
  }, [obj.kind, obj.color, viewMode]);

  useEffect(() => {
    if (!emissiveMat) return;
    return () => emissiveMat.dispose();
  }, [emissiveMat]);

  const handleClick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onSelect(obj.id);
  };

  const sel = selected ? 1.04 : 1;

  switch (obj.kind) {
    case "hut":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.45, 0]}
            scale={sel}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.7, 0.85, 0.9, 12]} />
          </mesh>
          <mesh
            position={[0, 1.1, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <coneGeometry args={[1.05, 0.85, 12]} />
          </mesh>
        </Group>
      );
    case "house":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.55, 0]}
            scale={sel}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[1.4, 1.1, 1.1]} />
          </mesh>
          <mesh
            position={[0, 1.3, 0]}
            rotation={[0, Math.PI / 4, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <coneGeometry args={[1.1, 0.7, 4]} />
          </mesh>
        </Group>
      );
    case "tower":
    case "watchtower":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 1.1, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.35, 0.45, 2.2, 12]} />
          </mesh>
          <mesh
            position={[0, 2.3, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <boxGeometry args={[1.1, 0.35, 1.1]} />
          </mesh>
        </Group>
      );
    case "building":
    case "bunker":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.9, 0]}
            scale={sel}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[1.8, 1.8, 1.4]} />
          </mesh>
          <mesh
            position={[0, 1.95, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <boxGeometry args={[1.9, 0.15, 1.5]} />
          </mesh>
        </Group>
      );
    case "barn":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.7, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[2.2, 1.4, 1.4]} />
          </mesh>
          <mesh
            position={[0, 1.6, 0]}
            rotation={[0, 0, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <boxGeometry args={[2.3, 0.5, 1.5]} />
          </mesh>
        </Group>
      );
    case "market":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.55, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[1.6, 0.2, 1.2]} />
          </mesh>
          <mesh
            position={[0, 1.0, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <coneGeometry args={[1.2, 0.7, 4]} />
          </mesh>
        </Group>
      );
    case "pagoda":
      return (
        <Group obj={obj}>
          {[0, 0.7, 1.35].map((y, i) => (
            <group key={i}>
              <mesh
                position={[0, y + 0.25, 0]}
                scale={sel * (1 - i * 0.12)}
                castShadow
                onClick={handleClick}
                material={primary}
              >
                <boxGeometry args={[1.2, 0.5, 1.2]} />
              </mesh>
              <mesh
                position={[0, y + 0.55, 0]}
                scale={sel * (1 - i * 0.1)}
                castShadow
                onClick={handleClick}
                material={secondary}
              >
                <coneGeometry args={[1.1, 0.35, 4]} />
              </mesh>
            </group>
          ))}
        </Group>
      );
    case "torii":
      return (
        <Group obj={obj}>
          <mesh
            position={[-0.7, 1.0, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[0.15, 2.0, 0.15]} />
          </mesh>
          <mesh
            position={[0.7, 1.0, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[0.15, 2.0, 0.15]} />
          </mesh>
          <mesh
            position={[0, 2.0, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[2.0, 0.18, 0.25]} />
          </mesh>
          <mesh
            position={[0, 2.25, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[2.3, 0.12, 0.3]} />
          </mesh>
        </Group>
      );
    case "dock":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.15, 0]}
            scale={sel}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[3.5, 0.15, 1.2]} />
          </mesh>
          {[-1.4, 0, 1.4].map((x) => (
            <mesh
              key={x}
              position={[x, -0.35, 0.4]}
              scale={sel}
              castShadow
              material={secondary}
            >
              <cylinderGeometry args={[0.08, 0.1, 0.9, 6]} />
            </mesh>
          ))}
        </Group>
      );
    case "ship":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.35, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[2.8, 0.5, 1.0]} />
          </mesh>
          <mesh
            position={[0.9, 0.35, 0]}
            scale={sel}
            castShadow
            material={primary}
          >
            <coneGeometry args={[0.5, 0.9, 4]} />
          </mesh>
          <mesh
            position={[0, 1.3, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <boxGeometry args={[0.08, 1.6, 0.08]} />
          </mesh>
          <mesh
            position={[0.15, 1.3, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <boxGeometry args={[0.9, 1.1, 0.05]} />
          </mesh>
        </Group>
      );
    case "boat":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.15, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[1.4, 0.3, 0.55]} />
          </mesh>
        </Group>
      );
    case "palm":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.9, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <cylinderGeometry args={[0.08, 0.14, 1.8, 10]} />
          </mesh>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh
              key={i}
              position={[
                Math.cos((i / 5) * Math.PI * 2) * 0.55,
                1.85,
                Math.sin((i / 5) * Math.PI * 2) * 0.55,
              ]}
              rotation={[0.6, (i / 5) * Math.PI * 2, 0]}
              scale={sel}
              castShadow
              material={primary}
            >
              <boxGeometry args={[0.15, 0.08, 1.1]} />
            </mesh>
          ))}
        </Group>
      );
    case "pine":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.4, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <cylinderGeometry args={[0.1, 0.14, 0.8, 10]} />
          </mesh>
          {[0.9, 1.4, 1.85].map((y, i) => (
            <mesh
              key={y}
              position={[0, y, 0]}
              scale={sel}
              castShadow
              onClick={handleClick}
              material={primary}
            >
              <coneGeometry args={[0.85 - i * 0.18, 0.75, 11]} />
            </mesh>
          ))}
        </Group>
      );
    case "tree":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.45, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <cylinderGeometry args={[0.1, 0.14, 0.9, 10]} />
          </mesh>
          <mesh
            position={[0, 1.25, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <sphereGeometry args={[0.7, 16, 12]} />
          </mesh>
        </Group>
      );
    case "cactus":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.7, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.18, 0.22, 1.4, 12]} />
          </mesh>
          <mesh
            position={[0.35, 0.85, 0]}
            rotation={[0, 0, Math.PI / 2]}
            scale={sel}
            castShadow
            material={primary}
          >
            <cylinderGeometry args={[0.1, 0.12, 0.55, 10]} />
          </mesh>
        </Group>
      );
    case "rock":
    case "boulder":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.35, 0]}
            scale={[sel * (obj.kind === "boulder" ? 1.3 : 1), sel, sel * 1.1]}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <dodecahedronGeometry args={[0.45, 0]} />
          </mesh>
        </Group>
      );
    case "vehicle":
    case "tank":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.35, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[1.6, 0.45, 0.9]} />
          </mesh>
          <mesh
            position={[0, 0.7, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <boxGeometry args={[0.8, 0.35, 0.7]} />
          </mesh>
          {obj.kind === "tank" && (
            <mesh
              position={[0.6, 0.7, 0]}
              rotation={[0, 0, Math.PI / 2]}
              scale={sel}
              castShadow
              material={secondary}
            >
              <cylinderGeometry args={[0.06, 0.06, 1.0, 6]} />
            </mesh>
          )}
        </Group>
      );
    case "antenna":
    case "satellite":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 1.2, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.06, 0.1, 2.4, 10]} />
          </mesh>
          <mesh
            position={[0, 2.3, 0]}
            rotation={[Math.PI / 5, 0, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <cylinderGeometry args={[0.45, 0.45, 0.08, 24]} />
          </mesh>
        </Group>
      );
    case "windmill":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 1.2, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.4, 0.55, 2.4, 12]} />
          </mesh>
          <mesh
            position={[0, 2.5, 0.35]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <boxGeometry args={[2.2, 0.18, 0.12]} />
          </mesh>
          <mesh
            position={[0, 2.5, 0.35]}
            rotation={[0, 0, Math.PI / 2]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <boxGeometry args={[2.2, 0.18, 0.12]} />
          </mesh>
        </Group>
      );
    case "bridge":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.35, 0]}
            scale={sel}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[4.5, 0.2, 1.2]} />
          </mesh>
          {[-1.8, 1.8].map((x) => (
            <mesh
              key={x}
              position={[x, 0.0, 0]}
              scale={sel}
              castShadow
              material={secondary}
            >
              <boxGeometry args={[0.25, 0.7, 1.3]} />
            </mesh>
          ))}
        </Group>
      );
    case "statue":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.2, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <cylinderGeometry args={[0.4, 0.45, 0.25, 12]} />
          </mesh>
          <mesh
            position={[0, 0.9, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <capsuleGeometry args={[0.25, 0.9, 8, 16]} />
          </mesh>
        </Group>
      );
    case "crystal":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.55, 0]}
            rotation={[0, 0, 0.15]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={emissiveMat ?? primary}
          >
            <octahedronGeometry args={[0.45, 0]} />
          </mesh>
        </Group>
      );
    case "mine":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.5, 0]}
            rotation={[Math.PI / 2, 0, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.7, 0.85, 1.4, 14]} />
          </mesh>
          <mesh
            position={[0, 0.15, 0.9]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <boxGeometry args={[1.2, 0.3, 0.8]} />
          </mesh>
        </Group>
      );
    case "tent":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.55, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <coneGeometry args={[0.9, 1.1, 4]} />
          </mesh>
        </Group>
      );
    case "campfire":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.1, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <cylinderGeometry args={[0.45, 0.5, 0.15, 12]} />
          </mesh>
          <mesh
            position={[0, 0.35, 0]}
            scale={sel}
            material={emissiveMat ?? primary}
          >
            <coneGeometry args={[0.25, 0.5, 8]} />
          </mesh>
        </Group>
      );
    case "well":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.35, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <cylinderGeometry args={[0.45, 0.5, 0.7, 14]} />
          </mesh>
          <mesh
            position={[0, 0.9, 0]}
            scale={sel}
            castShadow
            material={secondary}
          >
            <torusGeometry args={[0.48, 0.06, 10, 20]} />
          </mesh>
        </Group>
      );
    case "fence":
      return (
        <Group obj={obj}>
          {[-0.6, 0.6].map((x) => (
            <mesh
              key={x}
              position={[x, 0.4, 0]}
              scale={sel}
              castShadow
              material={primary}
            >
              <boxGeometry args={[0.08, 0.8, 0.08]} />
            </mesh>
          ))}
          <mesh
            position={[0, 0.55, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={secondary}
          >
            <boxGeometry args={[1.4, 0.08, 0.06]} />
          </mesh>
        </Group>
      );
    case "crate":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.25, 0]}
            scale={sel}
            castShadow
            receiveShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[0.5, 0.5, 0.5]} />
          </mesh>
        </Group>
      );
    case "dragon":
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.6, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <capsuleGeometry args={[0.4, 1.6, 8, 16]} />
          </mesh>
          <mesh
            position={[0, 1.1, 0.7]}
            scale={sel}
            castShadow
            material={primary}
          >
            <sphereGeometry args={[0.35, 16, 12]} />
          </mesh>
        </Group>
      );
    default:
      return (
        <Group obj={obj}>
          <mesh
            position={[0, 0.3, 0]}
            scale={sel}
            castShadow
            onClick={handleClick}
            material={primary}
          >
            <boxGeometry args={[0.6, 0.6, 0.6]} />
          </mesh>
        </Group>
      );
  }
}
