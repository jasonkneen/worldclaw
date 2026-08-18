import { useEffect, useMemo, type ReactNode } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { browserAssetInstanceScale } from "~/lib/worldclaw/assets";
import type {
  BrowserAssetMetadata,
  PlacedObject,
  ViewMode,
} from "~/lib/worldclaw/types";

function stableObjectColor(id: string): THREE.Color {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return new THREE.Color(`hsl(${Math.abs(hash) % 360} 65% 55%)`);
}

function useDiagnosticMaterial(
  viewMode: ViewMode,
  objectId: string,
): THREE.Material | null {
  const material = useMemo(() => {
    if (viewMode === "instance") {
      return new THREE.MeshBasicMaterial({
        color: stableObjectColor(objectId),
        toneMapped: false,
        fog: false,
      });
    }
    if (viewMode === "depth") {
      return new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      });
    }
    if (viewMode === "normal") {
      return new THREE.MeshNormalMaterial();
    }
    return null;
  }, [objectId, viewMode]);

  useEffect(() => {
    if (!material) return;
    return () => material.dispose();
  }, [material]);

  return material;
}

export function BlenderAssetMesh({
  obj,
  asset,
  viewMode,
  selected,
  onSelect,
  fallback,
}: {
  obj: PlacedObject;
  asset: BrowserAssetMetadata;
  viewMode: ViewMode;
  selected: boolean;
  onSelect: (id: string) => void;
  fallback: ReactNode;
}) {
  // drei caches by URI, so every placed object shares one parsed GLB library.
  const gltf = useGLTF(asset.uri);
  const diagnosticMaterial = useDiagnosticMaterial(viewMode, obj.id);
  const instanceScale = browserAssetInstanceScale(obj);
  const prototype = useMemo(() => {
    const source = gltf.scene.getObjectByName(asset.node);
    if (!source) return null;

    // Clone exactly the named ASSET_* subtree. Geometry, textures, and PBR
    // materials stay shared with the cached library in lit mode.
    const clone = source.clone(true);
    clone.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (diagnosticMaterial) child.material = diagnosticMaterial;
    });
    return clone;
  }, [asset.node, diagnosticMaterial, gltf.scene]);

  if (!prototype) return fallback;

  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onSelect(obj.id);
  };

  return (
    <group
      position={obj.position}
      rotation={obj.rotation}
      scale={instanceScale}
      onClick={handleClick}
      userData={{
        objectId: obj.id,
        assetPrototype: asset.prototype,
        assetSource: asset.source,
        assetScale: instanceScale,
        authoredHeightMeters: asset.targetHeightMeters,
        renderedHeightMeters: asset.targetHeightMeters * instanceScale,
        collider: asset.collider,
      }}
    >
      <primitive
        object={prototype}
        scale={selected ? 1.04 : 1}
        dispose={null}
      />
    </group>
  );
}
