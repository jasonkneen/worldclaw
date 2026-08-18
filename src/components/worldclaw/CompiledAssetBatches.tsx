import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { browserAssetInstanceScale, groupBrowserAssetObjects } from "~/lib/worldclaw/assets";
import type { BrowserAssetPrototype, PlacedObject, ViewMode } from "~/lib/worldclaw/types";
import { ObjectMesh } from "./ObjectMesh";

interface CompiledAssetBatchesProps {
  objects: PlacedObject[];
  viewMode: ViewMode;
  selectedObjectId: string | null;
  onSelect: (id: string) => void;
}

interface PrototypeSubmeshBatch {
  key: string;
  prototype: BrowserAssetPrototype;
  geometry: THREE.BufferGeometry;
  sourceMaterial: THREE.Material | THREE.Material[];
  localMatrix: THREE.Matrix4;
  objects: PlacedObject[];
  submeshName: string;
  drawGroups: number;
  ownsGeometry: boolean;
}

function geometryMergeSignature(geometry: THREE.BufferGeometry): string {
  const attributes = Object.entries(geometry.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, attribute]) => {
      const gpuType = "gpuType" in attribute ? attribute.gpuType : "float";
      return `${name}:${attribute.itemSize}:${attribute.normalized}:${gpuType}`;
    })
    .join("|");
  return [
    geometry.index ? "indexed" : "plain",
    geometry.morphTargetsRelative ? "relative" : "absolute",
    Object.keys(geometry.morphAttributes).sort().join(","),
    attributes,
  ].join(";");
}

function stableObjectColor(id: string, target: THREE.Color): THREE.Color {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return target.set(`hsl(${Math.abs(hash) % 360} 65% 55%)`);
}

function PrimitiveFallbacks({
  objects,
  viewMode,
  selectedObjectId,
  onSelect,
}: CompiledAssetBatchesProps) {
  return objects.map((object) => (
    <ObjectMesh
      key={object.id}
      obj={object}
      viewMode={viewMode}
      selected={selectedObjectId === object.id}
      onSelect={onSelect}
      forcePrimitive
    />
  ));
}

function InstancedPrototypeSubmesh({
  definition,
  viewMode,
  selectedObjectId,
  onSelect,
  instanceMaterial,
  depthMaterial,
  normalMaterial,
}: {
  definition: PrototypeSubmeshBatch;
  viewMode: ViewMode;
  selectedObjectId: string | null;
  onSelect: (id: string) => void;
  instanceMaterial: THREE.MeshBasicMaterial;
  depthMaterial: THREE.MeshDepthMaterial;
  normalMaterial: THREE.MeshNormalMaterial;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const activeMaterial: THREE.Material | THREE.Material[] =
    viewMode === "lit"
      ? definition.sourceMaterial
      : viewMode === "instance"
        ? instanceMaterial
        : viewMode === "depth"
          ? depthMaterial
          : normalMaterial;

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const objectMatrix = new THREE.Matrix4();
    const instanceMatrix = new THREE.Matrix4();
    const color = new THREE.Color();

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < definition.objects.length; index++) {
      const object = definition.objects[index]!;
      const selectionScale = selectedObjectId === object.id ? 1.04 : 1;
      const assetScale = browserAssetInstanceScale(object) * selectionScale;
      position.fromArray(object.position);
      euler.fromArray([...object.rotation, "XYZ"]);
      quaternion.setFromEuler(euler);
      scale.setScalar(assetScale);
      objectMatrix.compose(position, quaternion, scale);
      instanceMatrix.multiplyMatrices(objectMatrix, definition.localMatrix);
      mesh.setMatrixAt(index, instanceMatrix);
      mesh.setColorAt(
        index,
        viewMode === "instance" ? stableObjectColor(object.id, color) : color.set(0xffffff),
      );
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }, [definition, selectedObjectId, viewMode]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[definition.geometry, definition.sourceMaterial, definition.objects.length]}
      material={activeMaterial}
      castShadow
      receiveShadow
      dispose={null}
      userData={{
        worldclawCompiledBatch: true,
        assetPrototype: definition.prototype,
        assetSource: "blender_procedural",
        submeshName: definition.submeshName,
        drawGroups: definition.drawGroups,
        instanceObjectIds: definition.objects.map((object) => object.id),
        instanceAssetScales: definition.objects.map(browserAssetInstanceScale),
        instanceRenderedHeightsMeters: definition.objects.map(
          (object) =>
            (object.browserAsset?.targetHeightMeters ?? 0) * browserAssetInstanceScale(object),
        ),
      }}
      onClick={(event) => {
        if (event.instanceId === undefined) return;
        const object = definition.objects[event.instanceId];
        if (!object) return;
        event.stopPropagation();
        onSelect(object.id);
      }}
    />
  );
}

function CompiledAssetLibrary({
  uri,
  objects,
  viewMode,
  selectedObjectId,
  onSelect,
}: CompiledAssetBatchesProps & { uri: string }) {
  // Exactly one parsed/cache entry per library URI, regardless of instance count.
  const gltf = useGLTF(uri);
  const diagnostics = useMemo(
    () => ({
      instance: new THREE.MeshBasicMaterial({
        color: "#ffffff",
        toneMapped: false,
        fog: false,
      }),
      depth: new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      }),
      normal: new THREE.MeshNormalMaterial(),
    }),
    [],
  );
  useEffect(
    () => () => {
      diagnostics.instance.dispose();
      diagnostics.depth.dispose();
      diagnostics.normal.dispose();
    },
    [diagnostics],
  );

  const { definitions, missingObjects } = useMemo(() => {
    const definitions: PrototypeSubmeshBatch[] = [];
    const missingObjects: PlacedObject[] = [];
    for (const batch of groupBrowserAssetObjects(objects)) {
      const { prototype, node: nodeName, objects: prototypeObjects } = batch;
      const root = gltf.scene.getObjectByName(nodeName);
      if (!root) {
        missingObjects.push(...prototypeObjects);
        continue;
      }

      root.updateWorldMatrix(true, true);
      const rootInverse = root.matrixWorld.clone().invert();
      const mergeCandidates = new Map<
        string,
        {
          material: THREE.Material;
          geometries: THREE.BufferGeometry[];
          names: string[];
        }
      >();
      let sourceMeshCount = 0;
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        sourceMeshCount++;
        child.updateWorldMatrix(true, false);
        const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, child.matrixWorld);

        if (Array.isArray(child.material)) {
          definitions.push({
            key: `${nodeName}:multi:${child.uuid}`,
            prototype,
            geometry: child.geometry,
            sourceMaterial: child.material,
            localMatrix,
            objects: prototypeObjects,
            submeshName: child.name || `submesh_${sourceMeshCount}`,
            drawGroups: Math.max(1, child.geometry.groups.length),
            ownsGeometry: false,
          });
          return;
        }

        // Bake the prototype-local transform once, then merge meshes that use
        // the same PBR material. Instances still apply only object transforms.
        const geometry = child.geometry.clone();
        geometry.applyMatrix4(localMatrix);
        const candidateKey = `${child.material.uuid}:${geometryMergeSignature(geometry)}`;
        const candidate = mergeCandidates.get(candidateKey) ?? {
          material: child.material,
          geometries: [] as THREE.BufferGeometry[],
          names: [] as string[],
        };
        candidate.geometries.push(geometry);
        candidate.names.push(child.name || `submesh_${sourceMeshCount}`);
        mergeCandidates.set(candidateKey, candidate);
      });

      for (const [candidateKey, candidate] of mergeCandidates) {
        const merged =
          candidate.geometries.length === 1
            ? candidate.geometries[0]!
            : mergeGeometries(candidate.geometries, false);
        if (merged) {
          if (candidate.geometries.length > 1) {
            for (const geometry of candidate.geometries) geometry.dispose();
          }
          definitions.push({
            key: `${nodeName}:material:${candidateKey}`,
            prototype,
            geometry: merged,
            sourceMaterial: candidate.material,
            localMatrix: new THREE.Matrix4(),
            objects: prototypeObjects,
            submeshName: candidate.names.join(" + "),
            drawGroups: 1,
            ownsGeometry: true,
          });
          continue;
        }

        // Compatibility signatures should prevent this, but retain every
        // mesh if a future loader attribute cannot be merged.
        candidate.geometries.forEach((geometry, index) => {
          definitions.push({
            key: `${nodeName}:unmerged:${candidateKey}:${index}`,
            prototype,
            geometry,
            sourceMaterial: candidate.material,
            localMatrix: new THREE.Matrix4(),
            objects: prototypeObjects,
            submeshName: candidate.names[index] ?? `submesh_${index}`,
            drawGroups: 1,
            ownsGeometry: true,
          });
        });
      }

      if (sourceMeshCount === 0) missingObjects.push(...prototypeObjects);
    }

    return { definitions, missingObjects };
  }, [gltf.scene, objects]);

  useEffect(
    () => () => {
      for (const definition of definitions) {
        if (definition.ownsGeometry) definition.geometry.dispose();
      }
    },
    [definitions],
  );

  return (
    <>
      {definitions.map((definition) => (
        <InstancedPrototypeSubmesh
          key={definition.key}
          definition={definition}
          viewMode={viewMode}
          selectedObjectId={selectedObjectId}
          onSelect={onSelect}
          instanceMaterial={diagnostics.instance}
          depthMaterial={diagnostics.depth}
          normalMaterial={diagnostics.normal}
        />
      ))}
      <PrimitiveFallbacks
        objects={missingObjects}
        viewMode={viewMode}
        selectedObjectId={selectedObjectId}
        onSelect={onSelect}
      />
    </>
  );
}

export function CompiledAssetBatches(props: CompiledAssetBatchesProps) {
  const libraries = useMemo(() => {
    const grouped = new Map<string, PlacedObject[]>();
    for (const object of props.objects) {
      const uri = object.browserAsset?.uri;
      if (!uri) continue;
      const list = grouped.get(uri) ?? [];
      list.push(object);
      grouped.set(uri, list);
    }
    return [...grouped.entries()];
  }, [props.objects]);

  return libraries.map(([uri, objects]) => (
    <CompiledAssetLibrary key={uri} {...props} uri={uri} objects={objects} />
  ));
}
