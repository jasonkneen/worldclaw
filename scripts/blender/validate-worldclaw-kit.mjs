#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const prototypeKeys = [
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
];
const requiredAliases = [
  "palm",
  "tree",
  "pine",
  "rock",
  "boulder",
  "cactus",
  "hut",
  "house",
  "building",
  "bunker",
  "barn",
  "tower",
  "watchtower",
  "ship",
  "boat",
  "vehicle",
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
];
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPACTION_VERSION = 1;
const COMPACTION_POLICY = "prototype_variant_material_v1";
const MAX_COMPACT_NODES = 260;
const MAX_COMPACT_MESHES = 220;
const MAX_COMPACT_ACCESSORS = 660;
const MAX_COMPACT_BYTES = 2_000_000;

function projectPath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function projectRelative(path) {
  return relative(repoRoot, path).split("\\").join("/");
}

function parseArgs(argv) {
  const options = {
    manifest: resolve(repoRoot, "assets/worldclaw/asset-library.json"),
    publicManifest: resolve(repoRoot, "public/worldclaw/assets/asset-library.json"),
    glb: null,
    report: resolve(repoRoot, "public/worldclaw/assets/worldclaw-kit.report.json"),
    writeReport: false,
    skipEvidence: false,
    evidenceDir: null,
    coverage: resolve(repoRoot, "assets/worldclaw/reference-validation/paper_asset_coverage.json"),
    paperSuite: resolve(repoRoot, "assets/worldclaw/reference-validation/paper_prompt_suite.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest" || arg === "--public-manifest" || arg === "--glb" || arg === "--report" || arg === "--evidence-dir" || arg === "--coverage" || arg === "--paper-suite") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      const key = arg === "--public-manifest" ? "publicManifest" : arg === "--evidence-dir" ? "evidenceDir" : arg === "--paper-suite" ? "paperSuite" : arg.slice(2);
      options[key] = projectPath(value);
      index += 1;
    } else if (arg === "--write-report") {
      options.writeReport = true;
    } else if (arg === "--skip-evidence") {
      options.skipEvidence = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/blender/validate-worldclaw-kit.mjs " +
          "[--manifest path] [--public-manifest path] [--glb path] [--report path] " +
          "[--evidence-dir path] [--coverage path] [--paper-suite path] [--write-report] [--skip-evidence]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseGlb(buffer) {
  if (buffer.length < 20) throw new Error(`GLB is truncated (${buffer.length} bytes; expected at least 20)`);
  if (buffer.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`Bad GLB magic ${JSON.stringify(buffer.toString("ascii", 0, 4))}; expected "glTF"`);
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}; expected 2`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength !== buffer.length) {
    throw new Error(`GLB header length ${declaredLength} does not match file length ${buffer.length}`);
  }
  const chunks = [];
  let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error(`Truncated GLB chunk header at byte ${offset}`);
    const byteLength = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + byteLength;
    if (end > buffer.length) throw new Error(`GLB chunk at byte ${offset} overruns the file by ${end - buffer.length} bytes`);
    if (byteLength % 4 !== 0) throw new Error(`GLB chunk at byte ${offset} has unaligned length ${byteLength}`);
    chunks.push({ type, data: buffer.subarray(start, end) });
    offset = end;
  }
  if (chunks.length < 2) throw new Error(`Expected JSON and BIN chunks; found ${chunks.length}`);
  if (chunks[0].type !== JSON_CHUNK) throw new Error("The first GLB chunk is not JSON");
  if (!chunks.some((chunk) => chunk.type === BIN_CHUNK)) throw new Error("GLB has no BIN chunk");
  let json;
  try {
    const paddedText = chunks[0].data.toString("utf8");
    let jsonEnd = paddedText.length;
    while (jsonEnd > 0) {
      const trailingCodePoint = paddedText.charCodeAt(jsonEnd - 1);
      if (trailingCodePoint !== 0 && trailingCodePoint !== 0x20) break;
      jsonEnd -= 1;
    }
    const text = paddedText.slice(0, jsonEnd);
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse GLB JSON chunk: ${error.message}`);
  }
  return { version, json, chunks };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const COMPONENT_BYTE_SIZES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const ACCESSOR_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorReader(gltf, binary, accessorIndex, label) {
  const accessor = gltf.accessors?.[accessorIndex];
  const view = gltf.bufferViews?.[accessor?.bufferView];
  if (!accessor || !view) throw new Error(`${label}: missing accessor ${accessorIndex} or its bufferView`);
  const componentBytes = COMPONENT_BYTE_SIZES[accessor.componentType];
  const components = ACCESSOR_COMPONENTS[accessor.type];
  if (!componentBytes || !components) throw new Error(`${label}: unsupported accessor encoding ${accessor.componentType}/${accessor.type}`);
  const itemBytes = componentBytes * components;
  const stride = view.byteStride ?? itemBytes;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const lastByte = offset + Math.max(0, accessor.count - 1) * stride + itemBytes;
  if (offset < 0 || stride < itemBytes || lastByte > binary.length) {
    throw new Error(`${label}: accessor ${accessorIndex} overruns BIN data or has invalid stride`);
  }
  function value(itemIndex, componentIndex) {
    const byteOffset = offset + itemIndex * stride + componentIndex * componentBytes;
    if (accessor.componentType === 5126) return binary.readFloatLE(byteOffset);
    if (accessor.componentType === 5125) return binary.readUInt32LE(byteOffset);
    if (accessor.componentType === 5123) return binary.readUInt16LE(byteOffset);
    return binary.readUInt8(byteOffset);
  }
  return { accessor, value };
}

function canonicalFloat32(value) {
  const result = Buffer.allocUnsafe(4);
  result.writeFloatLE(value === 0 ? 0 : value);
  return result;
}

function compactRootTopologySha256(gltf, binary, rootIndex, label) {
  const records = [];
  let triangleCount = 0;
  const seen = new Set();
  function visit(nodeIndex) {
    if (seen.has(nodeIndex)) throw new Error(`${label}: node cycle or shared descendant at ${nodeIndex}`);
    seen.add(nodeIndex);
    const node = gltf.nodes?.[nodeIndex];
    if (!node) throw new Error(`${label}: missing descendant ${nodeIndex}`);
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      for (let primitiveIndex = 0; primitiveIndex < (mesh?.primitives ?? []).length; primitiveIndex += 1) {
        const primitive = mesh.primitives[primitiveIndex];
        const primitiveLabel = `${label}/${node.name ?? nodeIndex}/primitive-${primitiveIndex}`;
        if ((primitive.mode ?? 4) !== 4 || primitive.indices === undefined) {
          throw new Error(`${primitiveLabel}: topology hash requires indexed TRIANGLES`);
        }
        const positions = accessorReader(gltf, binary, primitive.attributes?.POSITION, primitiveLabel);
        const indices = accessorReader(gltf, binary, primitive.indices, primitiveLabel);
        if (positions.accessor.componentType !== 5126 || positions.accessor.type !== "VEC3") {
          throw new Error(`${primitiveLabel}: topology hash requires float32 VEC3 POSITION`);
        }
        if (indices.accessor.type !== "SCALAR" || indices.accessor.count % 3 !== 0) {
          throw new Error(`${primitiveLabel}: topology hash requires triangle scalar indices`);
        }
        const materialName = gltf.materials?.[primitive.material]?.name;
        if (!materialName) throw new Error(`${primitiveLabel}: topology hash requires a named material`);
        const material = Buffer.from(materialName, "utf8");
        const prefix = Buffer.allocUnsafe(2 + material.length);
        prefix.writeUInt16LE(material.length, 0);
        material.copy(prefix, 2);
        for (let index = 0; index < indices.accessor.count; index += 3) {
          const corners = [];
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = indices.value(index + corner, 0);
            if (vertex >= positions.accessor.count) throw new Error(`${primitiveLabel}: index ${vertex} is out of range`);
            const x = positions.value(vertex, 0);
            const y = positions.value(vertex, 1);
            const z = positions.value(vertex, 2);
            // Invert Blender's glTF Y-up conversion: (x, y, z) -> (x, -z, y).
            corners.push(Buffer.concat([canonicalFloat32(x), canonicalFloat32(-z), canonicalFloat32(y)]));
          }
          const rotations = [
            Buffer.concat(corners),
            Buffer.concat([corners[1], corners[2], corners[0]]),
            Buffer.concat([corners[2], corners[0], corners[1]]),
          ].sort(Buffer.compare);
          records.push(Buffer.concat([prefix, rotations[0]]));
          triangleCount += 1;
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(rootIndex);
  records.sort(Buffer.compare);
  const digest = createHash("sha256");
  for (const record of records) digest.update(record);
  return { topologySha256: digest.digest("hex"), triangleCount };
}

function compactRootAttributeSha256(gltf, binary, rootIndex, label) {
  const records = [];
  let triangleCount = 0;
  const seen = new Set();
  function visit(nodeIndex) {
    if (seen.has(nodeIndex)) throw new Error(`${label}: node cycle or shared descendant at ${nodeIndex}`);
    seen.add(nodeIndex);
    const node = gltf.nodes?.[nodeIndex];
    if (!node) throw new Error(`${label}: missing descendant ${nodeIndex}`);
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      for (let primitiveIndex = 0; primitiveIndex < (mesh?.primitives ?? []).length; primitiveIndex += 1) {
        const primitive = mesh.primitives[primitiveIndex];
        const primitiveLabel = `${label}/${node.name ?? nodeIndex}/primitive-${primitiveIndex}`;
        if ((primitive.mode ?? 4) !== 4 || primitive.indices === undefined) {
          throw new Error(`${primitiveLabel}: attribute hash requires indexed TRIANGLES`);
        }
        const positions = accessorReader(gltf, binary, primitive.attributes?.POSITION, primitiveLabel);
        const normals = accessorReader(gltf, binary, primitive.attributes?.NORMAL, primitiveLabel);
        const indices = accessorReader(gltf, binary, primitive.indices, primitiveLabel);
        if (positions.accessor.componentType !== 5126 || positions.accessor.type !== "VEC3") {
          throw new Error(`${primitiveLabel}: attribute hash requires float32 VEC3 POSITION`);
        }
        if (normals.accessor.componentType !== 5126 || normals.accessor.type !== "VEC3") {
          throw new Error(`${primitiveLabel}: attribute hash requires float32 VEC3 NORMAL`);
        }
        const materialName = gltf.materials?.[primitive.material]?.name;
        if (!materialName) throw new Error(`${primitiveLabel}: attribute hash requires a named material`);
        const material = Buffer.from(materialName, "utf8");
        const prefix = Buffer.allocUnsafe(2 + material.length);
        prefix.writeUInt16LE(material.length, 0);
        material.copy(prefix, 2);
        for (let index = 0; index < indices.accessor.count; index += 3) {
          const corners = [];
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = indices.value(index + corner, 0);
            if (vertex >= positions.accessor.count || vertex >= normals.accessor.count) {
              throw new Error(`${primitiveLabel}: index ${vertex} is out of range`);
            }
            corners.push(Buffer.concat([
              canonicalFloat32(positions.value(vertex, 0)),
              canonicalFloat32(positions.value(vertex, 1)),
              canonicalFloat32(positions.value(vertex, 2)),
              canonicalFloat32(normals.value(vertex, 0)),
              canonicalFloat32(normals.value(vertex, 1)),
              canonicalFloat32(normals.value(vertex, 2)),
            ]));
          }
          const rotations = [
            Buffer.concat(corners),
            Buffer.concat([corners[1], corners[2], corners[0]]),
            Buffer.concat([corners[2], corners[0], corners[1]]),
          ].sort(Buffer.compare);
          records.push(Buffer.concat([prefix, rotations[0]]));
          triangleCount += 1;
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(rootIndex);
  records.sort(Buffer.compare);
  const digest = createHash("sha256");
  for (const record of records) digest.update(record);
  return { sha256: digest.digest("hex"), triangleCount };
}

function parsePng(buffer, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33) throw new Error(`${label}: PNG is truncated (${buffer.length} bytes)`);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error(`${label}: bad PNG signature`);
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label}: first PNG chunk must be a 13-byte IHDR`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  if (!(width > 0 && height > 0)) throw new Error(`${label}: invalid PNG dimensions ${width}x${height}`);
  if (bitDepth !== 8) throw new Error(`${label}: expected 8-bit PNG, got ${bitDepth}-bit`);
  if (![2, 6].includes(colorType)) throw new Error(`${label}: expected RGB/RGBA PNG, got color type ${colorType}`);
  return { width, height, bitDepth, colorType };
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx,
    (2 * (xy + wz)) * sx,
    (2 * (xz - wy)) * sx,
    0,
    (2 * (xy - wz)) * sy,
    (1 - 2 * (xx + zz)) * sy,
    (2 * (yz + wx)) * sy,
    0,
    (2 * (xz + wy)) * sz,
    (2 * (yz - wx)) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function emptyBounds() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function includePoint(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function includeAccessorBounds(bounds, minimum, maximum, matrix) {
  for (const x of [minimum[0], maximum[0]]) {
    for (const y of [minimum[1], maximum[1]]) {
      for (const z of [minimum[2], maximum[2]]) includePoint(bounds, transformPoint(matrix, [x, y, z]));
    }
  }
}

function roundVector(vector) {
  return vector.map((value) => Number(value.toFixed(6)));
}

function triangleCount(primitive, gltf, errors, label) {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const count = gltf.accessors?.[accessorIndex]?.count;
  if (!Number.isInteger(count)) {
    errors.push(`${label}: primitive has no usable index/POSITION accessor count`);
    return 0;
  }
  const mode = primitive.mode ?? 4;
  if (mode === 4) {
    if (count % 3 !== 0) errors.push(`${label}: TRIANGLES accessor count ${count} is not divisible by 3`);
    return Math.floor(count / 3);
  }
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  errors.push(`${label}: unsupported primitive mode ${mode}; expected triangles, strip, or fan`);
  return 0;
}

function prototypeStats(gltf, rootIndex, errors, key) {
  const bounds = emptyBounds();
  const meshes = new Set();
  const materials = new Set();
  let vertices = 0;
  let triangles = 0;
  const activePath = new Set();

  function visit(nodeIndex, parentMatrix) {
    if (activePath.has(nodeIndex)) {
      errors.push(`${key}: cycle detected at node index ${nodeIndex}`);
      return;
    }
    const node = gltf.nodes?.[nodeIndex];
    if (!node) {
      errors.push(`${key}: missing child node index ${nodeIndex}`);
      return;
    }
    activePath.add(nodeIndex);
    const world = multiplyMatrices(parentMatrix, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      if (!mesh) {
        errors.push(`${key}: node ${node.name ?? nodeIndex} references missing mesh ${node.mesh}`);
      } else {
        meshes.add(node.mesh);
        for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives ?? []).length; primitiveIndex += 1) {
          const primitive = mesh.primitives[primitiveIndex];
          const label = `${key}/${node.name ?? nodeIndex}/primitive-${primitiveIndex}`;
          const positionIndex = primitive.attributes?.POSITION;
          const position = gltf.accessors?.[positionIndex];
          if (!position || !Array.isArray(position.min) || !Array.isArray(position.max)) {
            errors.push(`${label}: POSITION accessor is missing min/max bounds`);
          } else {
            includeAccessorBounds(bounds, position.min, position.max, world);
            vertices += position.count ?? 0;
          }
          if (primitive.attributes?.NORMAL === undefined) errors.push(`${label}: exported normals are missing`);
          if (primitive.material === undefined || !gltf.materials?.[primitive.material]) {
            errors.push(`${label}: export material is missing or invalid`);
          } else {
            materials.add(primitive.material);
          }
          triangles += triangleCount(primitive, gltf, errors, label);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
    activePath.delete(nodeIndex);
  }

  visit(rootIndex, identityMatrix());
  if (!Number.isFinite(bounds.min[0])) errors.push(`${key}: prototype contains no bounded mesh primitive`);
  const size = bounds.min.map((value, axis) => bounds.max[axis] - value);
  return {
    node: gltf.nodes[rootIndex]?.name,
    boundsYUpMeters: { min: roundVector(bounds.min), max: roundVector(bounds.max), size: roundVector(size) },
    meshCount: meshes.size,
    materialCount: materials.size,
    materialNames: [...materials].map((index) => gltf.materials?.[index]?.name).filter(Boolean).sort(),
    vertexCount: vertices,
    triangleCount: triangles,
  };
}

function validateCollider(collider, label, errors) {
  const value = collider ?? {};
  if (!["box", "capsule", "sphere"].includes(value.type)) errors.push(`${label}: collider.type is unsupported`);
  if (!Array.isArray(value.centerMeters) || value.centerMeters.length !== 3 || value.centerMeters.some((item) => !Number.isFinite(item))) {
    errors.push(`${label}: collider.centerMeters must be three finite numbers`);
  }
  if (value.type === "box" && (!Array.isArray(value.sizeMeters) || value.sizeMeters.length !== 3 || value.sizeMeters.some((item) => !(item > 0)))) {
    errors.push(`${label}: box collider.sizeMeters must contain three positive numbers`);
  }
  if (["capsule", "sphere"].includes(value.type) && !(value.radiusMeters > 0)) errors.push(`${label}: collider.radiusMeters must be positive`);
  if (value.type === "capsule" && !(value.heightMeters > 0)) errors.push(`${label}: collider.heightMeters must be positive`);
}

function validateColliderEnclosesBounds(collider, bounds, label, errors, tolerance = 0.05) {
  if (!collider || !bounds || !Array.isArray(collider.centerMeters)) return;
  if (collider.type === "box" && Array.isArray(collider.sizeMeters)) {
    const colliderMin = collider.centerMeters.map((value, axis) => value - collider.sizeMeters[axis] / 2);
    const colliderMax = collider.centerMeters.map((value, axis) => value + collider.sizeMeters[axis] / 2);
    // Colliders intentionally approximate vertical visual ornament (rail caps,
    // foliage, flames), but they must cover the authored ground footprint.
    for (const axis of [0, 2]) {
      if (colliderMin[axis] > bounds.min[axis] + tolerance || colliderMax[axis] < bounds.max[axis] - tolerance) {
        const axisLabel = ["x", "y", "z"][axis];
        errors.push(`${label}: box collider ${axisLabel} extent ${colliderMin[axis]}..${colliderMax[axis]}m does not enclose exported ${axisLabel} bounds ${bounds.min[axis]}..${bounds.max[axis]}m`);
      }
    }
    return;
  }
  if (collider.type === "sphere" && collider.radiusMeters > 0) {
    let farthestFootprintSquared = 0;
    for (const x of [bounds.min[0], bounds.max[0]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        farthestFootprintSquared = Math.max(
          farthestFootprintSquared,
          (x - collider.centerMeters[0]) ** 2 + (z - collider.centerMeters[2]) ** 2,
        );
      }
    }
    if (Math.sqrt(farthestFootprintSquared) > collider.radiusMeters + tolerance) {
      errors.push(`${label}: sphere collider radius ${collider.radiusMeters}m does not enclose exported ground footprint; required radial extent is ${Math.sqrt(farthestFootprintSquared).toFixed(3)}m`);
    }
  }
}

function requireLedgerPrefixes(ledger, prefixes, label, errors) {
  const names = ledger?.componentNames ?? [];
  for (const prefix of prefixes) {
    if (!names.some((name) => name.startsWith(prefix))) {
      errors.push(`${label}: authoring component ledger is missing required geometry prefix ${prefix}`);
    }
  }
}

function requireLedgerPrefixCount(ledger, prefix, minimum, label, errors) {
  const count = (ledger?.componentNames ?? []).filter((name) => name.startsWith(prefix)).length;
  if (count < minimum) {
    errors.push(`${label}: authoring component ledger prefix ${prefix} occurs ${count} times; expected at least ${minimum}`);
  }
}

function requireCompactRootContract(gltf, binary, rootIndex, root, stats, ledger, compactRootReport, label, errors) {
  if (!ledger) {
    errors.push(`${label}: build report has no authoring component ledger for ${root?.name ?? "unknown root"}`);
    return;
  }
  if (root.extras?.worldclawCompactionVersion !== COMPACTION_VERSION) errors.push(`${label}: compaction version extra is missing or stale`);
  if (root.extras?.worldclawCompactionPolicy !== COMPACTION_POLICY) errors.push(`${label}: compaction policy extra is missing or stale`);
  if (root.extras?.worldclawSourceMeshCount !== ledger.sourceMeshCount) errors.push(`${label}: source mesh count extra does not match the component ledger`);
  if (root.extras?.worldclawMergedMeshCount !== stats.meshCount) errors.push(`${label}: merged mesh count extra does not match exported descendants`);
  if (root.extras?.worldclawComponentLedgerSha256 !== ledger.componentsSha256) errors.push(`${label}: component ledger SHA extra does not match the report`);
  if (root.extras?.worldclawTopologySha256 !== ledger.geometryFingerprint?.topologySha256) errors.push(`${label}: topology SHA extra does not match the report`);
  if (root.extras?.worldclawSourceShadingSha256 !== ledger.shadingFingerprint?.sha256) errors.push(`${label}: shading SHA extra does not match the report`);
  const components = ledger.components ?? [];
  const componentPayload = Buffer.from(canonicalJson(components), "utf8");
  const componentSha256 = createHash("sha256").update(componentPayload).digest("hex");
  if (componentSha256 !== ledger.componentsSha256) errors.push(`${label}: component ledger SHA cannot be reproduced from its components`);
  if (components.length !== ledger.sourceMeshCount) errors.push(`${label}: component ledger has ${components.length} entries but sourceMeshCount is ${ledger.sourceMeshCount}`);
  const componentNames = components.map((component) => component.name);
  if (JSON.stringify(componentNames) !== JSON.stringify(ledger.componentNames)) errors.push(`${label}: componentNames is stale relative to the hashed component records`);
  const componentMaterials = [...new Set(components.map((component) => component.material))].sort();
  if (JSON.stringify(componentMaterials) !== JSON.stringify(ledger.materialNames)) errors.push(`${label}: component material names are stale relative to the hashed component records`);
  const componentVertices = components.reduce((sum, component) => sum + (component.vertexCount ?? 0), 0);
  const componentTriangles = components.reduce((sum, component) => sum + (component.triangleCount ?? 0), 0);
  if (componentVertices !== ledger.sourceVertexCount) errors.push(`${label}: component vertex ledger does not sum to sourceVertexCount`);
  if (componentTriangles !== ledger.sourceTriangleCount) errors.push(`${label}: component triangle ledger does not sum to sourceTriangleCount`);
  try {
    const topology = compactRootTopologySha256(gltf, binary, rootIndex, label);
    if (topology.topologySha256 !== ledger.geometryFingerprint?.topologySha256) {
      errors.push(`${label}: independently decoded compact topology SHA differs from the authoring ledger`);
    }
    if (topology.triangleCount !== ledger.geometryFingerprint?.triangleCount) {
      errors.push(`${label}: independently decoded compact topology has ${topology.triangleCount} triangles; ledger has ${ledger.geometryFingerprint?.triangleCount}`);
    }
  } catch (error) {
    errors.push(`${label}: cannot independently hash compact topology: ${error.message}`);
  }
  const exportedAttributeFingerprint = compactRootReport?.exportedAttributeFingerprint;
  try {
    const attributes = compactRootAttributeSha256(gltf, binary, rootIndex, label);
    if (!exportedAttributeFingerprint?.sha256) {
      errors.push(`${label}: compaction report is missing the exported attribute fingerprint`);
    } else if (attributes.sha256 !== exportedAttributeFingerprint.sha256) {
      errors.push(`${label}: compact POSITION/NORMAL/material/winding hash differs from the detailed-export fingerprint`);
    }
    if (root.extras?.worldclawExportedAttributeSha256 !== exportedAttributeFingerprint?.sha256) {
      errors.push(`${label}: root exported-attribute SHA extra does not match the compaction report`);
    }
  } catch (error) {
    errors.push(`${label}: cannot independently hash compact export attributes: ${error.message}`);
  }
  if (ledger.sourceTriangleCount !== stats.triangleCount) errors.push(`${label}: authoring ledger has ${ledger.sourceTriangleCount} triangles but compact export has ${stats.triangleCount}`);
  if (JSON.stringify(ledger.materialNames) !== JSON.stringify(stats.materialNames)) errors.push(`${label}: compact material set differs from the authoring component ledger`);
  if (stats.meshCount !== stats.materialCount) errors.push(`${label}: compact root must have exactly one mesh per used material; got ${stats.meshCount} meshes and ${stats.materialCount} materials`);
}

function normalizedVariantVocabulary(variant) {
  const recipe = variant?.constructionRecipe ?? {};
  return [
    ...(variant?.appearanceTerms ?? []),
    ...(variant?.materialIds ?? []),
    recipe.wallAssembly,
    ...(recipe.openingAssemblies ?? []),
    recipe.doorAssembly,
    recipe.roofAssembly,
    recipe.gateAssembly,
    recipe.botanicalAssembly,
    recipe.bridgeAssembly,
    recipe.creatureAssembly,
    recipe.industrialAssembly,
    recipe.communicationsAssembly,
    recipe.earthworkAssembly,
    recipe.propAssembly,
    recipe.weatheringProfile,
    ...(recipe.systems ?? []),
    ...(recipe.geometryGuarantees ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .replaceAll("_", " ")
    .toLocaleLowerCase();
}

function requireVocabularyPatterns(variant, requirements, label, errors) {
  const vocabulary = normalizedVariantVocabulary(variant);
  for (const [requirement, pattern] of Object.entries(requirements)) {
    if (!pattern.test(vocabulary)) {
      errors.push(`${label}: authored vocabulary does not satisfy ${requirement} (${pattern})`);
    }
  }
}

function requireMaterialNames(stats, names, label, errors) {
  for (const name of names) {
    if (!stats.materialNames.includes(name)) {
      errors.push(`${label}: authored geometry does not use required material ${name}`);
    }
  }
}

function validateManifest(manifest, errors) {
  if (manifest.version !== 1) errors.push(`manifest.version must be 1, got ${JSON.stringify(manifest.version)}`);
  const library = manifest.library ?? {};
  if (library.uri !== "/worldclaw/assets/worldclaw-kit.glb") errors.push(`library.uri must be /worldclaw/assets/worldclaw-kit.glb`);
  if (library.format !== "glb") errors.push(`library.format must be glb`);
  if (library.sourceUpAxis !== "Z" || library.runtimeUpAxis !== "Y") errors.push(`library axes must be source Z and runtime Y`);
  if (library.metersPerUnit !== 1) errors.push(`library.metersPerUnit must be 1`);
  if (!Number.isInteger(library.fileBudgetBytes) || library.fileBudgetBytes <= 0) errors.push(`library.fileBudgetBytes must be a positive integer`);
  if (!Number.isInteger(library.maxTriangles) || library.maxTriangles <= 0) errors.push(`library.maxTriangles must be a positive integer`);
  const scalePolicy = library.instanceScalePolicy ?? {};
  if (scalePolicy.assetHeightAtScaleOne !== "targetHeightMeters") errors.push(`instanceScalePolicy.assetHeightAtScaleOne must be targetHeightMeters`);
  if (scalePolicy.runtimeScaleFormula !== "placedObject.scale / legacyBaseScaleByKind[object.kind]") errors.push(`instanceScalePolicy.runtimeScaleFormula is stale`);
  for (const alias of requiredAliases) {
    if (!(scalePolicy.legacyBaseScaleByKind?.[alias] > 0)) errors.push(`instanceScalePolicy.legacyBaseScaleByKind.${alias} must be positive`);
  }
  if (scalePolicy.legacyBaseScaleByKind?.pagoda !== 2.8) errors.push(`instanceScalePolicy legacy pagoda scale must remain 2.8`);
  if (scalePolicy.legacyBaseScaleByKind?.torii !== 2.2) errors.push(`instanceScalePolicy legacy torii scale must remain 2.2`);
  if (scalePolicy.legacyBaseScaleByKind?.bridge !== 3.5) errors.push(`instanceScalePolicy legacy bridge scale must remain 3.5`);
  const capabilities = manifest.capabilities ?? {};
  if (capabilities.version !== 1) errors.push(`capabilities.version must be 1`);
  const selection = capabilities.appearanceSelection ?? {};
  if (selection.normalization !== "lowercase_ascii_tokens_v1") errors.push(`capabilities.appearanceSelection.normalization is unsupported`);
  if (selection.unmatchedBehavior !== "use_default_variant") errors.push(`capabilities.appearanceSelection must fall back to the default variant`);
  const materialVocabulary = capabilities.materialVocabulary ?? {};
  if (Object.keys(materialVocabulary).length < 12 || Object.keys(materialVocabulary).length > 64) {
    errors.push(`materialVocabulary must remain bounded to 12..64 entries; got ${Object.keys(materialVocabulary).length}`);
  }
  for (const [materialId, material] of Object.entries(materialVocabulary)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(materialId)) errors.push(`materialVocabulary key ${JSON.stringify(materialId)} is not a stable snake_case id`);
    if (!material?.blenderMaterial?.startsWith("MAT-")) errors.push(`materialVocabulary.${materialId}.blenderMaterial must start with MAT-`);
    if (!material?.family) errors.push(`materialVocabulary.${materialId}.family is required`);
    if (!Array.isArray(material?.constructionRoles) || material.constructionRoles.length === 0) errors.push(`materialVocabulary.${materialId}.constructionRoles must be non-empty`);
    if (!Array.isArray(material?.appearanceTerms) || material.appearanceTerms.length === 0) errors.push(`materialVocabulary.${materialId}.appearanceTerms must be non-empty`);
  }
  const construction = capabilities.constructionVocabulary ?? {};
  const requiredConstructionGroups = [
    "wallAssemblies", "openingAssemblies", "doorAssemblies", "roofAssemblies",
    "weatheringProfiles", "botanicalAssemblies", "bridgeAssemblies",
    "creatureAssemblies", "industrialAssemblies", "communicationsAssemblies",
    "earthworkAssemblies", "propAssemblies",
  ];
  for (const group of requiredConstructionGroups) {
    if (!construction[group] || Object.keys(construction[group]).length === 0) errors.push(`constructionVocabulary.${group} must be non-empty`);
  }
  const references = capabilities.researchReferences ?? [];
  if (references.length < 5) errors.push(`capabilities.researchReferences must contain at least five primary references`);
  const referenceIds = new Set();
  for (const reference of references) {
    if (!reference?.id || referenceIds.has(reference.id)) errors.push(`researchReferences ids must be present and unique; got ${JSON.stringify(reference?.id)}`);
    referenceIds.add(reference?.id);
    if (!/^https:\/\//u.test(reference?.url ?? "")) errors.push(`researchReferences.${reference?.id ?? "unknown"}.url must be HTTPS`);
    if (!Array.isArray(reference?.usedFor) || reference.usedFor.length === 0) errors.push(`researchReferences.${reference?.id ?? "unknown"}.usedFor must be non-empty`);
  }
  const evidence = manifest.evidence ?? {};
  if (evidence.renderSource !== "exported_glb_roundtrip") errors.push(`evidence.renderSource must be exported_glb_roundtrip`);
  if (evidence.projection !== "orthographic") errors.push(`evidence.projection must be orthographic`);
  if (!Array.isArray(evidence.turnaroundViews) || evidence.turnaroundViews.join("|") !== "front|front_three_quarter|side|rear") {
    errors.push(`evidence.turnaroundViews must be front, front_three_quarter, side, rear`);
  }
  if (evidence.contactSheetUri !== "/worldclaw/assets/dossiers/worldclaw-kit-contact-sheet.png") {
    errors.push(`evidence.contactSheetUri is not the published contact sheet URI`);
  }
  const actualKeys = Object.keys(manifest.prototypes ?? {});
  if (actualKeys.join("|") !== prototypeKeys.join("|")) {
    errors.push(`prototype keys/order must be ${prototypeKeys.join(", ")}; got ${actualKeys.join(", ")}`);
  }
  for (const key of prototypeKeys) {
    const spec = manifest.prototypes?.[key];
    if (!spec) continue;
    if (spec.node !== `ASSET_${key}`) errors.push(`${key}: node must be ASSET_${key}`);
    if (spec.generator !== key) errors.push(`${key}: generator must be ${key}`);
    if (spec.source !== "blender_procedural") errors.push(`${key}: source must be blender_procedural`);
    if (!(spec.targetHeightMeters > 0)) errors.push(`${key}: targetHeightMeters must be positive`);
    validateCollider(spec.collider, key, errors);
    if (["pagoda", "torii"].includes(key) && spec.collider?.type === "box") {
      const bottom = spec.collider.centerMeters[1] - spec.collider.sizeMeters[1] / 2;
      const top = spec.collider.centerMeters[1] + spec.collider.sizeMeters[1] / 2;
      if (Math.abs(bottom) > 1e-6 || Math.abs(top - spec.targetHeightMeters) > 1e-6) {
        errors.push(`${key}: landmark collider must span grounded height 0..${spec.targetHeightMeters}m; got ${bottom}..${top}m`);
      }
    }
    const variants = spec.variants ?? [];
    if (variants.length === 0) errors.push(`${key}: variants must contain at least one authored variant`);
    const variantIds = new Set();
    for (const variant of variants) {
      if (!variant?.id || variantIds.has(variant.id)) errors.push(`${key}: variant ids must be present and unique`);
      variantIds.add(variant?.id);
      const isDefaultNode = variant?.node === spec.node;
      if (!isDefaultNode && !variant?.node?.startsWith(`ASSET_${key}_`)) errors.push(`${key}/${variant?.id}: alternate node must start with ASSET_${key}_`);
      if (variant?.status !== "authored") errors.push(`${key}/${variant?.id}: status must be authored`);
      if (!Array.isArray(variant?.appearanceTerms) || variant.appearanceTerms.length < 2) errors.push(`${key}/${variant?.id}: appearanceTerms must contain at least two terms`);
      if (!Array.isArray(variant?.materialIds) || variant.materialIds.length === 0) errors.push(`${key}/${variant?.id}: materialIds must be non-empty`);
      for (const materialId of variant?.materialIds ?? []) {
        if (!materialVocabulary[materialId]) errors.push(`${key}/${variant?.id}: unknown materialId ${materialId}`);
      }
      if (!variant?.constructionRecipe || typeof variant.constructionRecipe !== "object") errors.push(`${key}/${variant?.id}: constructionRecipe is required`);
      if (!isDefaultNode) {
        if (!(variant.targetHeightMeters > 0)) errors.push(`${key}/${variant?.id}: alternate node requires positive targetHeightMeters`);
        validateCollider(variant.collider, `${key}/${variant?.id}`, errors);
        if (!variant.evidence?.turnaroundUri?.startsWith("/worldclaw/assets/dossiers/")) errors.push(`${key}/${variant?.id}: alternate node requires published turnaround evidence`);
      }
      const recipe = variant?.constructionRecipe ?? {};
      if (recipe.wallAssembly && !construction.wallAssemblies?.[recipe.wallAssembly]) errors.push(`${key}/${variant?.id}: unknown wallAssembly ${JSON.stringify(recipe.wallAssembly)}`);
      if (recipe.openingAssemblies && (!Array.isArray(recipe.openingAssemblies) || recipe.openingAssemblies.some((id) => !construction.openingAssemblies?.[id]))) errors.push(`${key}/${variant?.id}: openingAssemblies contain an unknown id`);
      if (recipe.doorAssembly && !construction.doorAssemblies?.[recipe.doorAssembly]) errors.push(`${key}/${variant?.id}: unknown doorAssembly ${JSON.stringify(recipe.doorAssembly)}`);
      if (recipe.roofAssembly && !construction.roofAssemblies?.[recipe.roofAssembly]) errors.push(`${key}/${variant?.id}: unknown roofAssembly ${JSON.stringify(recipe.roofAssembly)}`);
      if (recipe.weatheringProfile && !construction.weatheringProfiles?.[recipe.weatheringProfile]) errors.push(`${key}/${variant?.id}: unknown weatheringProfile ${JSON.stringify(recipe.weatheringProfile)}`);
      if (recipe.gateAssembly && !construction.gateAssemblies?.[recipe.gateAssembly]) errors.push(`${key}/${variant?.id}: unknown gateAssembly ${JSON.stringify(recipe.gateAssembly)}`);
      if (recipe.botanicalAssembly && !construction.botanicalAssemblies?.[recipe.botanicalAssembly]) errors.push(`${key}/${variant?.id}: unknown botanicalAssembly ${JSON.stringify(recipe.botanicalAssembly)}`);
      if (recipe.bridgeAssembly && !construction.bridgeAssemblies?.[recipe.bridgeAssembly]) errors.push(`${key}/${variant?.id}: unknown bridgeAssembly ${JSON.stringify(recipe.bridgeAssembly)}`);
      if (recipe.creatureAssembly && !construction.creatureAssemblies?.[recipe.creatureAssembly]) errors.push(`${key}/${variant?.id}: unknown creatureAssembly ${JSON.stringify(recipe.creatureAssembly)}`);
      if (recipe.industrialAssembly && !construction.industrialAssemblies?.[recipe.industrialAssembly]) errors.push(`${key}/${variant?.id}: unknown industrialAssembly ${JSON.stringify(recipe.industrialAssembly)}`);
      if (recipe.communicationsAssembly && !construction.communicationsAssemblies?.[recipe.communicationsAssembly]) errors.push(`${key}/${variant?.id}: unknown communicationsAssembly ${JSON.stringify(recipe.communicationsAssembly)}`);
      if (recipe.earthworkAssembly && !construction.earthworkAssemblies?.[recipe.earthworkAssembly]) errors.push(`${key}/${variant?.id}: unknown earthworkAssembly ${JSON.stringify(recipe.earthworkAssembly)}`);
      if (recipe.propAssembly && !construction.propAssemblies?.[recipe.propAssembly]) errors.push(`${key}/${variant?.id}: unknown propAssembly ${JSON.stringify(recipe.propAssembly)}`);
      const provenance = variant?.provenance;
      if (provenance) {
        if (!Array.isArray(provenance.paperPages) || provenance.paperPages.some((page) => !Number.isInteger(page))) errors.push(`${key}/${variant?.id}: provenance.paperPages must contain integer PDF pages`);
        for (const referenceId of provenance.researchReferenceIds ?? []) {
          if (!referenceIds.has(referenceId)) errors.push(`${key}/${variant?.id}: provenance references unknown research id ${referenceId}`);
        }
      }
    }
    if (!variantIds.has(spec.defaultVariant)) errors.push(`${key}: defaultVariant ${JSON.stringify(spec.defaultVariant)} does not name an authored variant`);
    const defaultVariant = variants.find((variant) => variant.id === spec.defaultVariant);
    if (key !== "building" && defaultVariant?.node !== spec.node) errors.push(`${key}: defaultVariant must use prototype root ${spec.node}`);
    if (spec.evidence?.turnaroundUri !== `/worldclaw/assets/dossiers/${key}-turnaround.png`) errors.push(`${key}: evidence.turnaroundUri is incorrect`);
    if (spec.evidence?.contactSheetUri !== evidence.contactSheetUri) errors.push(`${key}: evidence.contactSheetUri must match the library contact sheet`);
    if (["hut", "building", "watchtower"].includes(key)) {
      const recipe = variants.find((variant) => variant.id === spec.defaultVariant)?.constructionRecipe ?? {};
      if (!construction.wallAssemblies?.[recipe.wallAssembly]) errors.push(`${key}: unknown wallAssembly ${JSON.stringify(recipe.wallAssembly)}`);
      if (!Array.isArray(recipe.openingAssemblies) || recipe.openingAssemblies.some((id) => !construction.openingAssemblies?.[id])) errors.push(`${key}: openingAssemblies contain an unknown id`);
      if (!construction.doorAssemblies?.[recipe.doorAssembly]) errors.push(`${key}: unknown doorAssembly ${JSON.stringify(recipe.doorAssembly)}`);
      if (!construction.roofAssemblies?.[recipe.roofAssembly]) errors.push(`${key}: unknown roofAssembly ${JSON.stringify(recipe.roofAssembly)}`);
      if (!construction.weatheringProfiles?.[recipe.weatheringProfile]) errors.push(`${key}: unknown weatheringProfile ${JSON.stringify(recipe.weatheringProfile)}`);
    }
  }
  const requiredTreeVariants = {
    tree_bamboo_cluster: {
      node: "ASSET_tree_bamboo_cluster",
      targetHeightMeters: 7.5,
      turnaroundUri: "/worldclaw/assets/dossiers/bamboo-cluster-turnaround.png",
      botanicalAssembly: "bamboo_clumping_culm_node_leaf_spray",
    },
    tree_cherry_blossom: {
      node: "ASSET_tree_cherry_blossom",
      targetHeightMeters: 7,
      turnaroundUri: "/worldclaw/assets/dossiers/cherry-blossom-turnaround.png",
      botanicalAssembly: "cherry_bifurcated_branch_blossom_cloud",
    },
  };
  for (const [id, expected] of Object.entries(requiredTreeVariants)) {
    const variant = manifest.prototypes?.tree?.variants?.find((item) => item.id === id);
    if (!variant) {
      errors.push(`tree: required authored variant ${id} is missing`);
      continue;
    }
    if (variant.node !== expected.node) errors.push(`tree/${id}: node must be ${expected.node}`);
    if (variant.targetHeightMeters !== expected.targetHeightMeters) errors.push(`tree/${id}: targetHeightMeters must be ${expected.targetHeightMeters}`);
    if (variant.evidence?.turnaroundUri !== expected.turnaroundUri) errors.push(`tree/${id}: turnaroundUri must be ${expected.turnaroundUri}`);
    if (variant.constructionRecipe?.botanicalAssembly !== expected.botanicalAssembly) errors.push(`tree/${id}: botanicalAssembly must be ${expected.botanicalAssembly}`);
  }
  const building = manifest.prototypes?.building;
  if (building) {
    if (building.defaultVariant !== "building_timber_frame_white_tile") {
      errors.push(`building.defaultVariant must be building_timber_frame_white_tile so generic or truncated Japanese-town labels fail toward the authored construction variant`);
    }
    const variant = building.variants?.find((item) => item.id === "building_timber_frame_white_tile");
    if (!variant) {
      errors.push(`building: required authored variant building_timber_frame_white_tile is missing`);
    } else {
      if (variant.node !== "ASSET_building_timber_frame_white_tile") errors.push(`building/building_timber_frame_white_tile node must be ASSET_building_timber_frame_white_tile`);
      for (const materialId of ["timber_structural_dark", "white_lime_plaster", "charcoal_roof_tile", "charcoal_tile_edge"]) {
        if (!variant.materialIds?.includes(materialId)) errors.push(`building/building_timber_frame_white_tile materialIds must include ${materialId}`);
      }
      if (materialVocabulary.timber_structural_dark?.family !== "timber") errors.push(`materialVocabulary.timber_structural_dark.family must be timber`);
      if (materialVocabulary.white_lime_plaster?.family !== "plaster") errors.push(`materialVocabulary.white_lime_plaster.family must be plaster`);
      if (materialVocabulary.charcoal_roof_tile?.family !== "fired roof tile") errors.push(`materialVocabulary.charcoal_roof_tile.family must be fired roof tile`);
      if (variant.constructionRecipe?.wallAssembly !== "japanese_post_beam_white_lime_infill") errors.push(`building/building_timber_frame_white_tile wallAssembly must be japanese_post_beam_white_lime_infill`);
      if (!variant.constructionRecipe?.openingAssemblies?.includes("japanese_recessed_timber_lattice")) errors.push(`building/building_timber_frame_white_tile openingAssemblies must include japanese_recessed_timber_lattice`);
      if (variant.constructionRecipe?.doorAssembly !== "japanese_recessed_board_panel_door") errors.push(`building/building_timber_frame_white_tile doorAssembly must be japanese_recessed_board_panel_door`);
      if (variant.constructionRecipe?.roofAssembly !== "dark_tile_gable_deep_eave") errors.push(`building/building_timber_frame_white_tile roofAssembly must be dark_tile_gable_deep_eave`);
      requireVocabularyPatterns(variant, {
        "exposed timber frame": /timber frame|structural timber|timber structural/u,
        "plaster infill": /plaster|lime infill/u,
        "constructed door": /door assembly|door/u,
        "constructed window": /opening assembl|window|glazing|lattice/u,
        "overlapping fired roof tile": /overlapping[^.]{0,48}(?:roof )?tiles?|roof tile|charcoal tile|kawara/u,
      }, "building/building_timber_frame_white_tile", errors);
    }
  }
  const pagoda = manifest.prototypes?.pagoda;
  if (pagoda) {
    const variant = pagoda.variants?.find((item) => item.id === "pagoda_three_tier_dark_tile");
    if (!variant) {
      errors.push(`pagoda: required authored variant pagoda_three_tier_dark_tile is missing`);
    } else {
      for (const materialId of ["timber_structural_dark", "white_lime_plaster", "blue_gray_slate", "cleft_slate_edge"]) {
        if (!variant.materialIds?.includes(materialId)) errors.push(`pagoda/pagoda_three_tier_dark_tile materialIds must include ${materialId}`);
      }
      if (variant.materialIds?.includes("charcoal_roof_tile") || variant.materialIds?.includes("charcoal_tile_edge")) {
        errors.push(`pagoda/pagoda_three_tier_dark_tile must declare natural slate rather than fired charcoal roof-tile materials`);
      }
      if (materialVocabulary.blue_gray_slate?.family !== "slate") errors.push(`materialVocabulary.blue_gray_slate.family must be slate`);
      if (materialVocabulary.cleft_slate_edge?.family !== "slate") errors.push(`materialVocabulary.cleft_slate_edge.family must be slate`);
      if (variant.constructionRecipe?.roofAssembly !== "pagoda_tiered_natural_slate_eaves") errors.push(`pagoda/pagoda_three_tier_dark_tile roofAssembly must be pagoda_tiered_natural_slate_eaves`);
      requireVocabularyPatterns(variant, {
        "natural slate": /natural slate/u,
        "overlapping natural slate courses": /overlapping natural slate/u,
        "tiered pagoda roof": /three separate deep hip roofs|deep diminishing hip roofs/u,
      }, "pagoda/pagoda_three_tier_dark_tile", errors);
    }
  }
  const bridge = manifest.prototypes?.bridge;
  if (bridge) {
    if (bridge.node !== "ASSET_bridge") errors.push(`bridge.node must be ASSET_bridge`);
    if (bridge.targetHeightMeters !== 2.4) errors.push(`bridge.targetHeightMeters must be 2.4`);
    if (bridge.defaultVariant !== "bridge_japanese_timber_beam") errors.push(`bridge.defaultVariant must be bridge_japanese_timber_beam`);
    if (bridge.collider?.type !== "box") errors.push(`bridge.collider.type must be box`);
    if (JSON.stringify(bridge.collider?.centerMeters) !== JSON.stringify([0, 1.1, 0])) errors.push(`bridge.collider.centerMeters must be [0,1.1,0]`);
    if (JSON.stringify(bridge.collider?.sizeMeters) !== JSON.stringify([16, 2.2, 3.4])) errors.push(`bridge.collider.sizeMeters must be [16,2.2,3.4]`);
    const variant = bridge.variants?.find((item) => item.id === "bridge_japanese_timber_beam");
    if (!variant) {
      errors.push(`bridge: required authored variant bridge_japanese_timber_beam is missing`);
    } else {
      if (variant.node !== "ASSET_bridge") errors.push(`bridge/bridge_japanese_timber_beam node must be ASSET_bridge`);
      if (variant.constructionRecipe?.bridgeAssembly !== "japanese_timber_stringer_deck_rail_stone_support") {
        errors.push(`bridge/bridge_japanese_timber_beam bridgeAssembly must be japanese_timber_stringer_deck_rail_stone_support`);
      }
      if (variant.constructionRecipe?.authoredDimensions?.usableCrossingAxis !== "+X") {
        errors.push(`bridge/bridge_japanese_timber_beam usableCrossingAxis must be +X`);
      }
    }
  }
  const directPaperPrototypes = {
    dragon: { variant: "dragon_massive_coiled_wyvern", assembly: ["creatureAssembly", "dragon_coiled_wyvern_winged"], pages: [34] },
    windmill: { variant: "windmill_masonry_four_sail", assembly: ["propAssembly", "windmill_masonry_tower_four_sail"], pages: [32] },
    mine: { variant: "mine_headframe_hoist", assembly: ["industrialAssembly", "mine_headframe_sheave_hoist_rail"], pages: [37] },
    crystal: { variant: "crystal_gemstone_cluster", assembly: ["earthworkAssembly", "gemstone_matrix_faceted_cluster"], pages: [37] },
    antenna: { variant: "antenna_lattice_communications_array", assembly: ["communicationsAssembly", "lattice_mast_parabolic_dish_feed"], pages: [15, 16] },
    satellite: { variant: "satellite_ground_station_dish", assembly: ["communicationsAssembly", "ground_station_pedestal_yoke_reflector"], pages: [16] },
    dock: { variant: "dock_timber_pile_jetty", assembly: ["propAssembly", "timber_pile_dock_stringer_deck"], pages: [13, 38] },
    tent: { variant: "tent_canvas_adventure_camp", assembly: ["propAssembly", "canvas_ridge_tent_rope_stay"], pages: [34] },
    well: { variant: "well_stone_crank_shelter", assembly: ["propAssembly", "stone_well_crank_roof"], pages: [33] },
    statue: { variant: "statue_volcanic_ritual_monument", assembly: ["propAssembly", "volcanic_ritual_monolith_horned"], pages: [36] },
    fence: { variant: "fence_timber_braced_gate", assembly: ["propAssembly", "timber_fence_braced_gate"], pages: [14, 15, 35] },
    campfire: { variant: "campfire_stone_ring_tripod", assembly: ["propAssembly", "campfire_stone_ring_tripod"], pages: [14, 34, 36] },
    crate: { variant: "crate_supply_stack", assembly: ["propAssembly", "supply_crate_slat_cleat_stack"], pages: [13, 14, 15, 35, 37, 38] },
    market: { variant: "market_timber_canvas_stall", assembly: ["propAssembly", "market_stall_post_beam_awning"], pages: [14, 35, 38] },
  };
  for (const [key, contract] of Object.entries(directPaperPrototypes)) {
    const spec = manifest.prototypes?.[key];
    const variant = spec?.variants?.find((item) => item.id === contract.variant);
    if (!variant) {
      errors.push(`${key}: required paper-suite variant ${contract.variant} is missing`);
      continue;
    }
    if (spec.node !== `ASSET_${key}` || variant.node !== spec.node) errors.push(`${key}: paper-suite default must use direct semantic root ASSET_${key}`);
    if (spec.defaultVariant !== contract.variant) errors.push(`${key}: defaultVariant must be ${contract.variant}`);
    if (contract.assembly && variant.constructionRecipe?.[contract.assembly[0]] !== contract.assembly[1]) errors.push(`${key}/${contract.variant}: ${contract.assembly[0]} must be ${contract.assembly[1]}`);
    for (const page of contract.pages) {
      if (!variant.provenance?.paperPages?.includes(page)) errors.push(`${key}/${contract.variant}: provenance must include paper PDF page ${page}`);
    }
  }
  const authoredBuildingVariants = {
    building_hobbit_round_door: ["earthworkAssembly", "hobbit_turf_mound_round_opening_facade", 38],
    building_futuristic_facility: ["communicationsAssembly", "futuristic_facility_modular_command_shell", 16],
    building_fortified_bunker: ["industrialAssembly", "fortified_bunker_battered_shell_gun_ring", 15],
  };
  for (const [id, [field, assembly, page]] of Object.entries(authoredBuildingVariants)) {
    const variant = manifest.prototypes?.building?.variants?.find((item) => item.id === id);
    if (!variant) errors.push(`building: required authored paper-suite variant ${id} is missing`);
    else {
      if (variant.node !== `ASSET_${id}`) errors.push(`building/${id}: node must be ASSET_${id}`);
      if (variant.constructionRecipe?.[field] !== assembly) errors.push(`building/${id}: ${field} must be ${assembly}`);
      if (!variant.provenance?.paperPages?.includes(page)) errors.push(`building/${id}: provenance must include paper PDF page ${page}`);
    }
  }
  const excavator = manifest.prototypes?.tank?.variants?.find((item) => item.id === "tank_tracked_excavator");
  if (!excavator) errors.push(`tank: required authored vehicle variant tank_tracked_excavator is missing`);
  else if (excavator.constructionRecipe?.industrialAssembly !== "tracked_excavator_hydraulic_boom_bucket") errors.push(`tank/tank_tracked_excavator: industrialAssembly is stale`);
  for (const alias of requiredAliases) {
    if (!(alias in (manifest.aliases ?? {}))) errors.push(`aliases.${alias} is required`);
  }
  if (manifest.aliases?.house !== "building") errors.push(`aliases.house must target building so construction-aware house variants remain selectable`);
  if (manifest.aliases?.pagoda !== "pagoda") errors.push(`aliases.pagoda must target pagoda`);
  if (manifest.aliases?.torii !== "torii") errors.push(`aliases.torii must target torii`);
  if (manifest.aliases?.bridge !== "bridge") errors.push(`aliases.bridge must target bridge`);
  for (const direct of ["dragon", "windmill", "mine", "crystal", "antenna", "satellite", "dock", "tent", "well", "statue", "fence", "campfire", "crate", "market"]) {
    if (manifest.aliases?.[direct] !== direct) errors.push(`aliases.${direct} must target the direct semantic ${direct} prototype`);
  }
  if (manifest.aliases?.vehicle !== "tank") errors.push(`aliases.vehicle must remain tank so the authored tracked-excavator vehicle variant is selectable without a second vehicle prototype`);
  if (manifest.aliases?.bunker !== "building") errors.push(`aliases.bunker must remain building so the authored fortified-bunker variant is selectable`);
  for (const [alias, target] of Object.entries(manifest.aliases ?? {})) {
    if (!prototypeKeys.includes(target)) errors.push(`aliases.${alias} targets missing prototype ${JSON.stringify(target)}`);
  }
}

function validatePaperCoverage(coverage, suite, manifest, errors) {
  if (coverage?.version !== 1) errors.push(`paper coverage version must be 1`);
  if (coverage?.policy?.primitiveFallbackAllowed !== false) errors.push(`paper coverage must forbid primitive fallback in accepted captures`);
  const suiteEntries = (suite?.cases ?? []).flatMap((item) =>
    (item.objectFamilies ?? []).map((family) => ({ family, caseId: item.id })),
  );
  const uniqueSuiteFamilies = new Set(suiteEntries.map((item) => item.family));
  const rows = coverage?.familyCoverage ?? [];
  const byFamily = new Map();
  for (const row of rows) {
    if (!row?.family || byFamily.has(row.family)) errors.push(`paper coverage family rows must be unique; got ${JSON.stringify(row?.family)}`);
    byFamily.set(row?.family, row);
    if (!coverage.policy?.statuses?.includes(row?.status)) errors.push(`paper coverage ${row?.family}: unknown status ${JSON.stringify(row?.status)}`);
    for (const node of row?.nodes ?? []) {
      const known = Object.values(manifest.prototypes ?? {}).some(
        (spec) => spec.node === node || spec.variants?.some((variant) => variant.node === node),
      );
      if (!known) errors.push(`paper coverage ${row.family}: unknown authored node ${node}`);
    }
    for (const kind of row?.runtimeKinds ?? []) {
      if (!(kind in (manifest.aliases ?? {}))) errors.push(`paper coverage ${row.family}: runtime kind ${kind} has no manifest alias`);
    }
    if (row?.status === "unsupported_ontology" && (row.nodes?.length || row.runtimeKinds?.length)) {
      errors.push(`paper coverage ${row.family}: unsupported_ontology must not pretend to have runtime nodes or kinds`);
    }
  }
  for (const family of uniqueSuiteFamilies) {
    if (!byFamily.has(family)) errors.push(`paper coverage is missing suite objectFamily ${JSON.stringify(family)}`);
  }
  for (const family of byFamily.keys()) {
    if (!uniqueSuiteFamilies.has(family)) errors.push(`paper coverage contains non-suite family ${JSON.stringify(family)}`);
  }
  if (coverage?.summary?.uniqueFamilies !== uniqueSuiteFamilies.size) errors.push(`paper coverage summary.uniqueFamilies must be ${uniqueSuiteFamilies.size}`);
  if (coverage?.summary?.suiteEntries !== suiteEntries.length) errors.push(`paper coverage summary.suiteEntries must be ${suiteEntries.length}`);
  const unsupported = rows.filter((row) => row.status === "unsupported_ontology").map((row) => row.family).sort();
  if (JSON.stringify(unsupported) !== JSON.stringify([...(coverage?.summary?.unsupportedFamilies ?? [])].sort())) errors.push(`paper coverage summary.unsupportedFamilies is stale`);
  return {
    sourceSuite: coverage?.sourceSuite,
    suiteCaseCount: suite?.cases?.length ?? 0,
    suiteEntryCount: suiteEntries.length,
    uniqueFamilyCount: uniqueSuiteFamilies.size,
    authoredOrTerrainFamilyCount: rows.length - unsupported.length,
    unsupportedFamilies: unsupported,
  };
}

function validateGltf(gltf, binary, manifest, glbBytes, report, errors) {
  if (gltf.asset?.version !== "2.0") errors.push(`glTF asset.version must be 2.0, got ${JSON.stringify(gltf.asset?.version)}`);
  if (!Array.isArray(gltf.scenes) || !Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes)) errors.push(`glTF must contain scenes, nodes, and meshes arrays`);
  if ((gltf.animations?.length ?? 0) !== 0) errors.push(`Static library unexpectedly contains ${gltf.animations.length} animation(s)`);
  if ((gltf.skins?.length ?? 0) !== 0) errors.push(`Static library unexpectedly contains ${gltf.skins.length} skin(s)`);
  const nameToIndices = new Map();
  for (let index = 0; index < (gltf.nodes ?? []).length; index += 1) {
    const node = gltf.nodes[index];
    const indices = nameToIndices.get(node.name) ?? [];
    indices.push(index);
    nameToIndices.set(node.name, indices);
    if (node.mesh !== undefined && !node.name?.startsWith("GEO-")) errors.push(`Mesh node ${node.name ?? index} lacks GEO- prefix`);
  }
  for (const [name, indices] of nameToIndices) {
    if (name && indices.length > 1) errors.push(`Duplicate glTF node name ${name} at indices ${indices.join(", ")}`);
  }
  for (let index = 0; index < (gltf.meshes ?? []).length; index += 1) {
    if (!gltf.meshes[index].name?.startsWith("GEO-")) errors.push(`glTF mesh ${gltf.meshes[index].name ?? index} lacks GEO- prefix`);
  }
  for (let index = 0; index < (gltf.materials ?? []).length; index += 1) {
    if (!gltf.materials[index].name?.startsWith("MAT-")) errors.push(`glTF material ${gltf.materials[index].name ?? index} lacks MAT- prefix`);
  }
  if (glbBytes > manifest.library.fileBudgetBytes) {
    errors.push(`GLB budget exceeded: ${glbBytes} bytes > ${manifest.library.fileBudgetBytes} bytes`);
  }
  if (glbBytes > MAX_COMPACT_BYTES) errors.push(`Compacted GLB exceeds ${MAX_COMPACT_BYTES} bytes: ${glbBytes}`);
  if ((gltf.nodes?.length ?? 0) > MAX_COMPACT_NODES) errors.push(`Compacted GLB has ${gltf.nodes?.length ?? 0} nodes; limit is ${MAX_COMPACT_NODES}`);
  if ((gltf.meshes?.length ?? 0) > MAX_COMPACT_MESHES) errors.push(`Compacted GLB has ${gltf.meshes?.length ?? 0} meshes; limit is ${MAX_COMPACT_MESHES}`);
  if ((gltf.accessors?.length ?? 0) > MAX_COMPACT_ACCESSORS) errors.push(`Compacted GLB has ${gltf.accessors?.length ?? 0} accessors; limit is ${MAX_COMPACT_ACCESSORS}`);
  if ((gltf.bufferViews?.length ?? 0) > MAX_COMPACT_ACCESSORS) errors.push(`Compacted GLB has ${gltf.bufferViews?.length ?? 0} bufferViews; limit is ${MAX_COMPACT_ACCESSORS}`);
  const ledgers = report?.compaction?.componentLedgers ?? {};
  if (report?.compaction?.version !== COMPACTION_VERSION) errors.push(`Build report compaction.version must be ${COMPACTION_VERSION}`);
  if (report?.compaction?.policy !== COMPACTION_POLICY) errors.push(`Build report compaction.policy must be ${COMPACTION_POLICY}`);
  if (Object.keys(ledgers).length !== 34) errors.push(`Build report must contain 34 authoring component ledgers; got ${Object.keys(ledgers).length}`);
  const prototypes = {};
  const variants = {};
  for (const key of prototypeKeys) {
    const spec = manifest.prototypes[key];
    const nodeName = spec.node;
    const indices = nameToIndices.get(nodeName) ?? [];
    if (indices.length !== 1) {
      errors.push(`${key}: required root ${nodeName} occurs ${indices.length} times`);
      continue;
    }
    const root = gltf.nodes[indices[0]];
    if (root.mesh !== undefined) errors.push(`${key}: ${nodeName} must be a parent node, not a mesh`);
    if (root.extras?.assetKey !== key) errors.push(`${key}: ${nodeName} extras.assetKey must be ${key}`);
    if (root.extras?.source !== "blender_procedural") errors.push(`${key}: ${nodeName} extras.source is missing`);
    if (root.extras?.defaultVariant !== spec.defaultVariant) errors.push(`${key}: ${nodeName} extras.defaultVariant is missing or stale`);
    const geometryVariant = spec.variants.find((variant) => variant.node === spec.node);
    if (root.extras?.geometryVariantId !== geometryVariant?.id) errors.push(`${key}: ${nodeName} extras.geometryVariantId must identify its authored geometry variant ${geometryVariant?.id}`);
    const stats = prototypeStats(gltf, indices[0], errors, key);
    const ledger = ledgers[nodeName];
    requireCompactRootContract(gltf, binary, indices[0], root, stats, ledger, report?.compaction?.roots?.[nodeName], key, errors);
    for (const childIndex of root.children ?? []) {
      const child = gltf.nodes?.[childIndex];
      if (child?.extras?.worldclawMergedByMaterial !== true) errors.push(`${key}: compact child ${child?.name ?? childIndex} lacks worldclawMergedByMaterial`);
      if (!child?.extras?.worldclawMaterial?.startsWith("MAT-")) errors.push(`${key}: compact child ${child?.name ?? childIndex} lacks a stable MAT material extra`);
    }
    const target = spec.targetHeightMeters;
    const height = stats.boundsYUpMeters.size[1];
    const tolerance = Math.max(0.01, target * 0.005);
    if (Math.abs(height - target) > tolerance) errors.push(`${key}: exported height ${height}m differs from ${target}m target (tolerance ${tolerance}m)`);
    if (Math.abs(stats.boundsYUpMeters.min[1]) > 0.01) errors.push(`${key}: exported ground is y=${stats.boundsYUpMeters.min[1]}m, expected 0m`);
    if ((ledger?.sourceMeshCount ?? 0) < (key === "rock" ? 3 : 5)) errors.push(`${key}: authoring ledger has only ${ledger?.sourceMeshCount ?? 0} meshes; silhouette/detail floor is ${key === "rock" ? 3 : 5}`);
    if ([
      "pagoda", "torii", "bridge", "dragon", "windmill", "mine", "crystal",
      "antenna", "satellite", "dock", "tent", "well", "statue", "fence",
      "campfire", "crate", "market",
    ].includes(key)) {
      validateColliderEnclosesBounds(spec.collider, stats.boundsYUpMeters, key, errors);
    }
    if (key === "pagoda") {
      requireLedgerPrefixes(ledger, [
        "GEO-pagoda_lower_bracket_", "GEO-pagoda_lower_slate_roof",
        "GEO-pagoda_middle_slate_roof", "GEO-pagoda_upper_slate_roof",
        "GEO-pagoda_lower_slate_course_", "GEO-pagoda_middle_slate_course_",
        "GEO-pagoda_upper_slate_course_", "GEO-pagoda_finial_",
      ], key, errors);
      requireMaterialNames(stats, ["MAT-slate_blue_gray", "MAT-slate_cleft_edge"], key, errors);
      if (stats.materialNames.includes("MAT-tile_charcoal") || stats.materialNames.includes("MAT-tile_charcoal_edge")) {
        errors.push(`pagoda: exported descendant geometry still uses fired charcoal tile instead of the required natural slate family`);
      }
    }
    if (key === "torii") {
      requireLedgerPrefixes(ledger, [
        "GEO-torii_post_left", "GEO-torii_nuki_through_beam", "GEO-torii_shimaki", "GEO-torii_kasagi_",
      ], key, errors);
    }
    if (key === "bridge") {
      const [span, structuralHeight, width] = stats.boundsYUpMeters.size;
      if (Math.abs(span - 16) > 0.03) errors.push(`bridge: exported +X span ${span}m must be 16.0m (+/-0.03m)`);
      if (Math.abs(structuralHeight - 2.4) > 0.02) errors.push(`bridge: exported structural height ${structuralHeight}m must be 2.4m (+/-0.02m)`);
      if (Math.abs(width - 3.4) > 0.03) errors.push(`bridge: exported width ${width}m must be 3.4m (+/-0.03m)`);
      if ((ledger?.sourceMeshCount ?? 0) < 65) errors.push(`bridge: authoring ledger has only ${ledger?.sourceMeshCount ?? 0} meshes; authored bridge detail floor is 65`);
      if (stats.triangleCount > 1500) errors.push(`bridge: ${stats.triangleCount} triangles exceeds the 1500-triangle prototype allowance`);
      requireLedgerPrefixes(ledger, [
        "GEO-bridge_abutment_", "GEO-bridge_pier_", "GEO-bridge_stringer_",
        "GEO-bridge_cross_beam_", "GEO-bridge_deck_course_", "GEO-bridge_rail_post_",
        "GEO-bridge_top_rail_", "GEO-bridge_diagonal_brace_", "GEO-bridge_end_finial_",
      ], key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_abutment_", 2, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_pier_", 2, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_stringer_", 4, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_cross_beam_", 5, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_deck_course_", 20, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_rail_post_", 12, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_top_rail_", 6, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-bridge_diagonal_brace_", 10, key, errors);
    }
    const paperGeometryContracts = {
      dragon: ["GEO-dragon_body_segment_", "GEO-dragon_head", "GEO-dragon_wing_bone_", "GEO-dragon_wing_membrane_", "GEO-dragon_leg_"],
      windmill: ["GEO-windmill_masonry_tower", "GEO-windmill_hub", "GEO-windmill_sail_spar_", "GEO-windmill_sail_canvas_"],
      mine: ["GEO-mine_headframe_leg_", "GEO-mine_sheave_", "GEO-mine_hoist_shed", "GEO-mine_shaft_void", "GEO-mine_ore_cart"],
      crystal: ["GEO-crystal_matrix_", "GEO-crystal_shaft_", "GEO-crystal_point_", "GEO-crystal_core_"],
      antenna: ["GEO-antenna_lattice_leg_", "GEO-antenna_lattice_brace_", "GEO-antenna_primary_dish", "GEO-antenna_primary_feed"],
      satellite: ["GEO-satellite_pedestal", "GEO-satellite_azimuth_yoke", "GEO-satellite_parabolic_reflector", "GEO-satellite_feed_truss_"],
      dock: ["GEO-dock_deck_course_", "GEO-dock_stringer_", "GEO-dock_pile_", "GEO-dock_bollard_"],
      tent: ["GEO-tent_canvas_shell", "GEO-tent_ridge_pole_", "GEO-tent_guy_", "GEO-tent_entry_flap_"],
      well: ["GEO-well_stone_course_", "GEO-well_post_", "GEO-well_crank", "GEO-well_bucket", "GEO-well_roof"],
      statue: ["GEO-statue_monolith", "GEO-statue_demon_mask", "GEO-statue_horn_", "GEO-statue_lava_channel_"],
      fence: ["GEO-fence_post_", "GEO-fence_rail_", "GEO-fence_brace_", "GEO-fence_gate_leaf"],
      campfire: ["GEO-campfire_ring_stone_", "GEO-campfire_log_", "GEO-campfire_flame_", "GEO-campfire_kettle"],
      crate: ["GEO-crate_body_", "GEO-crate_band_", "GEO-crate_diagonal_", "GEO-crate_corner_"],
      market: ["GEO-market_post_", "GEO-market_awning_stripe_", "GEO-market_counter", "GEO-market_basket_"],
    };
    if (paperGeometryContracts[key]) requireLedgerPrefixes(ledger, paperGeometryContracts[key], key, errors);
    if (key === "dragon") {
      requireLedgerPrefixCount(ledger, "GEO-dragon_body_segment_", 7, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-dragon_wing_membrane_", 2, key, errors);
      requireLedgerPrefixCount(ledger, "GEO-dragon_leg_", 8, key, errors);
    }
    if (key === "windmill") requireLedgerPrefixCount(ledger, "GEO-windmill_sail_canvas_", 4, key, errors);
    if (key === "crystal") requireLedgerPrefixCount(ledger, "GEO-crystal_shaft_", 6, key, errors);
    prototypes[key] = { targetHeightMeters: target, ...stats };
  }
  for (const key of prototypeKeys) {
    const spec = manifest.prototypes[key];
    for (const variant of spec.variants) {
      if (variant.node === spec.node) continue;
      const label = `${key}/${variant.id}`;
      const indices = nameToIndices.get(variant.node) ?? [];
      if (indices.length !== 1) {
        errors.push(`${label}: required alternate root ${variant.node} occurs ${indices.length} times`);
        continue;
      }
      const root = gltf.nodes[indices[0]];
      if (root.mesh !== undefined) errors.push(`${label}: ${variant.node} must be a parent node, not a mesh`);
      if (root.extras?.assetKey !== key) errors.push(`${label}: ${variant.node} extras.assetKey must be ${key}`);
      if (root.extras?.source !== "blender_procedural") errors.push(`${label}: ${variant.node} extras.source is missing`);
      if (root.extras?.variantId !== variant.id) errors.push(`${label}: ${variant.node} extras.variantId is missing or stale`);
      const stats = prototypeStats(gltf, indices[0], errors, label);
      const ledger = ledgers[variant.node];
      requireCompactRootContract(gltf, binary, indices[0], root, stats, ledger, report?.compaction?.roots?.[variant.node], label, errors);
      for (const childIndex of root.children ?? []) {
        const child = gltf.nodes?.[childIndex];
        if (child?.extras?.worldclawMergedByMaterial !== true) errors.push(`${label}: compact child ${child?.name ?? childIndex} lacks worldclawMergedByMaterial`);
        if (!child?.extras?.worldclawMaterial?.startsWith("MAT-")) errors.push(`${label}: compact child ${child?.name ?? childIndex} lacks a stable MAT material extra`);
      }
      const target = variant.targetHeightMeters ?? spec.targetHeightMeters;
      const height = stats.boundsYUpMeters.size[1];
      const tolerance = Math.max(0.01, target * 0.005);
      if (Math.abs(height - target) > tolerance) errors.push(`${label}: exported height ${height}m differs from ${target}m target (tolerance ${tolerance}m)`);
      if (Math.abs(stats.boundsYUpMeters.min[1]) > 0.01) errors.push(`${label}: exported ground is y=${stats.boundsYUpMeters.min[1]}m, expected 0m`);
      const componentFloorByVariant = {
        building_hobbit_round_door: 50,
        building_futuristic_facility: 32,
        building_fortified_bunker: 20,
        tank_tracked_excavator: 24,
      };
      const detailFloor = componentFloorByVariant[variant.id] ?? (variant.id.startsWith("tree_") ? 30 : 40);
      if ((ledger?.sourceMeshCount ?? 0) < detailFloor) errors.push(`${label}: authoring ledger has only ${ledger?.sourceMeshCount ?? 0} meshes; alternate authored detail floor is ${detailFloor}`);
      if (["building_hobbit_round_door", "building_futuristic_facility", "building_fortified_bunker", "tank_tracked_excavator"].includes(variant.id)) {
        validateColliderEnclosesBounds(variant.collider, stats.boundsYUpMeters, label, errors);
      }
      if (variant.id === "building_timber_frame_white_tile") {
        requireLedgerPrefixes(ledger, [
          "GEO-building_timber_front_infill_panel_", "GEO-building_timber_entry_leaf",
          "GEO-building_timber_front_window_0_reveal_", "GEO-building_timber_tile_deck_",
          "GEO-building_timber_tile_course_", "GEO-building_timber_tile_ridge",
          "GEO-building_timber_truss_front_",
        ], label, errors);
        requireMaterialNames(stats, [
          "MAT-wood_dark_trim", "MAT-plaster_lime_white", "MAT-tile_charcoal",
          "MAT-tile_charcoal_edge", "MAT-wood_warm", "MAT-glass_blue",
        ], label, errors);
      }
      if (variant.id === "tree_bamboo_cluster") {
        requireLedgerPrefixes(ledger, [
          "GEO-tree_bamboo_culm_", "GEO-tree_bamboo_node_", "GEO-tree_bamboo_branch_",
          "GEO-tree_bamboo_leaf_", "GEO-tree_bamboo_young_shoot_",
        ], label, errors);
        requireLedgerPrefixCount(ledger, "GEO-tree_bamboo_culm_", 6, label, errors);
        requireLedgerPrefixCount(ledger, "GEO-tree_bamboo_node_", 30, label, errors);
        requireLedgerPrefixCount(ledger, "GEO-tree_bamboo_leaf_", 36, label, errors);
      }
      if (variant.id === "tree_cherry_blossom") {
        requireLedgerPrefixes(ledger, [
          "GEO-tree_cherry_trunk_", "GEO-tree_cherry_scaffold_", "GEO-tree_cherry_twig_",
          "GEO-tree_cherry_blossom_mass_", "GEO-tree_cherry_blossom_rosette_",
        ], label, errors);
        requireLedgerPrefixCount(ledger, "GEO-tree_cherry_scaffold_", 9, label, errors);
        requireLedgerPrefixCount(ledger, "GEO-tree_cherry_blossom_mass_", 16, label, errors);
        requireLedgerPrefixCount(ledger, "GEO-tree_cherry_blossom_rosette_", 8, label, errors);
      }
      if (variant.id === "building_hobbit_round_door") {
        requireLedgerPrefixes(ledger, [
          "GEO-building_hobbit_earth_mound", "GEO-building_hobbit_facade_panel_",
          "GEO-building_hobbit_round_door_leaf", "GEO-building_hobbit_door_arch_",
          "GEO-building_hobbit_window_arch_", "GEO-building_hobbit_chimney",
        ], label, errors);
      }
      if (variant.id === "building_futuristic_facility") {
        requireLedgerPrefixes(ledger, [
          "GEO-building_future_main_shell", "GEO-building_future_red_spine",
          "GEO-building_future_entry_leaf_", "GEO-building_future_service_module_",
          "GEO-building_future_roof_dish", "GEO-building_future_conduit_",
        ], label, errors);
      }
      if (variant.id === "building_fortified_bunker") {
        requireLedgerPrefixes(ledger, [
          "GEO-bunker_battered_shell", "GEO-bunker_entry_recess", "GEO-bunker_firing_slot_",
          "GEO-bunker_parapet_", "GEO-bunker_gun_ring", "GEO-bunker_gun_barrel",
        ], label, errors);
      }
      if (variant.id === "tank_tracked_excavator") {
        requireLedgerPrefixes(ledger, [
          "GEO-vehicle_excavator_track_", "GEO-vehicle_excavator_slew_ring",
          "GEO-vehicle_excavator_cab", "GEO-vehicle_excavator_boom",
          "GEO-vehicle_excavator_stick", "GEO-vehicle_excavator_bucket",
        ], label, errors);
      }
      variants[label] = { targetHeightMeters: target, collider: variant.collider, ...stats };
    }
  }
  let triangleCount = 0;
  let vertexCount = 0;
  for (let meshIndex = 0; meshIndex < (gltf.meshes ?? []).length; meshIndex += 1) {
    const mesh = gltf.meshes[meshIndex];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives ?? []).length; primitiveIndex += 1) {
      const primitive = mesh.primitives[primitiveIndex];
      const label = `mesh-${meshIndex}/primitive-${primitiveIndex}`;
      const attributeNames = Object.keys(primitive.attributes ?? {}).sort();
      if (attributeNames.join("|") !== "NORMAL|POSITION") errors.push(`${label}: compact primitive attributes must be exactly POSITION and NORMAL; got ${attributeNames.join(", ")}`);
      if (primitive.indices === undefined) errors.push(`${label}: compact primitive must be indexed`);
      const indexAccessor = gltf.accessors?.[primitive.indices];
      if (![5123, 5125].includes(indexAccessor?.componentType)) errors.push(`${label}: compact primitive index componentType must be UNSIGNED_SHORT or UNSIGNED_INT`);
      triangleCount += triangleCountForGlobal(primitive, gltf, errors, label);
      vertexCount += gltf.accessors?.[primitive.attributes?.POSITION]?.count ?? 0;
    }
  }
  if (triangleCount > manifest.library.maxTriangles) errors.push(`Triangle budget exceeded: ${triangleCount} > ${manifest.library.maxTriangles}`);
  if ((report?.compaction?.sourceMeshCount ?? 0) < 100) errors.push(`Authoring ledger has only ${report?.compaction?.sourceMeshCount ?? 0} meshes; expected at least 100 layered components`);
  if ((gltf.materials?.length ?? 0) < 12) errors.push(`Library has only ${gltf.materials?.length ?? 0} materials; expected at least 12 material layers`);
  if (triangleCount < 2500) errors.push(`Library has only ${triangleCount} triangles; expected at least 2500 for presentation silhouettes`);
  const exportedMaterialNames = new Set((gltf.materials ?? []).map((material) => material.name));
  const vocabulary = manifest.capabilities.materialVocabulary;
  for (const key of prototypeKeys) {
    for (const variant of manifest.prototypes[key].variants) {
      for (const materialId of variant.materialIds) {
        const blenderMaterial = vocabulary[materialId]?.blenderMaterial;
        if (blenderMaterial && !exportedMaterialNames.has(blenderMaterial)) {
          errors.push(`${key}/${variant.id}: referenced material ${materialId} (${blenderMaterial}) is absent from the GLB`);
        }
      }
    }
  }
  return {
    nodes: gltf.nodes?.length ?? 0,
    meshes: gltf.meshes?.length ?? 0,
    materials: gltf.materials?.length ?? 0,
    vertices: vertexCount,
    triangles: triangleCount,
    prototypes,
    variants,
  };
}

function validateEvidence(manifest, errors, evidenceDir = null) {
  const files = [];
  const expected = prototypeKeys.map((key) => ({
    kind: "turnaround",
    prototype: key,
    uri: manifest.prototypes[key].evidence.turnaroundUri,
    width: 1600,
    height: 650,
  }));
  for (const key of prototypeKeys) {
    const spec = manifest.prototypes[key];
    for (const variant of spec.variants) {
      if (variant.node === spec.node || !variant.evidence?.turnaroundUri) continue;
      expected.push({
        kind: "variant_turnaround",
        prototype: key,
        variantId: variant.id,
        uri: variant.evidence.turnaroundUri,
        width: 1600,
        height: 650,
      });
    }
  }
  expected.push({
    kind: "contact_sheet",
    prototype: null,
    uri: manifest.evidence.contactSheetUri,
    width: 1920,
    height: 1080,
  });
  for (const item of expected) {
    const path = evidenceDir ? join(evidenceDir, basename(item.uri)) : join(repoRoot, "public", item.uri.replace(/^\/+/, ""));
    if (!existsSync(path)) {
      errors.push(`Evidence file is missing: ${projectRelative(path)} (declared by ${item.uri})`);
      continue;
    }
    const buffer = readFileSync(path);
    try {
      const png = parsePng(buffer, projectRelative(path));
      if (png.width !== item.width || png.height !== item.height) {
        errors.push(`${projectRelative(path)} is ${png.width}x${png.height}; expected ${item.width}x${item.height}`);
      }
      files.push({
        kind: item.kind,
        prototype: item.prototype,
        ...(item.variantId ? { variantId: item.variantId } : {}),
        uri: item.uri,
        path: projectRelative(path),
        byteLength: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        width: png.width,
        height: png.height,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return {
    status: errors.length === 0 ? "passed" : "failed",
    renderSource: manifest.evidence.renderSource,
    expectedFileCount: expected.length,
    validatedFileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
    files,
  };
}

function triangleCountForGlobal(primitive, gltf, errors, label) {
  return triangleCount(primitive, gltf, errors, label);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.manifest)) throw new Error(`Manifest not found: ${options.manifest}`);
  const sourceManifestBytes = readFileSync(options.manifest);
  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  const errors = [];
  validateManifest(manifest, errors);
  if (!existsSync(options.coverage)) throw new Error(`Paper coverage matrix not found: ${options.coverage}`);
  if (!existsSync(options.paperSuite)) throw new Error(`Paper prompt suite not found: ${options.paperSuite}`);
  const coverage = validatePaperCoverage(
    JSON.parse(readFileSync(options.coverage, "utf8")),
    JSON.parse(readFileSync(options.paperSuite, "utf8")),
    manifest,
    errors,
  );
  if (errors.length) {
    throw new Error(`WorldClaw manifest validation failed with ${errors.length} issue(s):\n- ${errors.join("\n- ")}`);
  }
  if (!existsSync(options.publicManifest)) throw new Error(`Published manifest not found: ${options.publicManifest}`);
  const publishedManifestBytes = readFileSync(options.publicManifest);
  let publishedManifest;
  try {
    publishedManifest = JSON.parse(publishedManifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot parse published manifest ${options.publicManifest}: ${error.message}`);
  }
  if (JSON.stringify(publishedManifest) !== JSON.stringify(manifest)) {
    throw new Error(
      `Published manifest ${projectRelative(options.publicManifest)} is stale; rebuild it from ${projectRelative(options.manifest)}`,
    );
  }
  if (!publishedManifestBytes.equals(sourceManifestBytes)) {
    throw new Error(
      `Published manifest ${projectRelative(options.publicManifest)} is semantically current but not byte-identical to ${projectRelative(options.manifest)}; rebuild the public contract`,
    );
  }
  options.glb ??= join(repoRoot, "public", manifest.library?.uri?.replace(/^\/+/, "") ?? "");
  if (!existsSync(options.glb)) throw new Error(`GLB not found: ${options.glb}`);
  const report = existsSync(options.report) ? JSON.parse(readFileSync(options.report, "utf8")) : { version: 1 };
  const buffer = readFileSync(options.glb);
  const parsed = parseGlb(buffer);
  const binary = parsed.chunks.find((chunk) => chunk.type === BIN_CHUNK)?.data;
  const counts = validateGltf(parsed.json, binary, manifest, buffer.length, report, errors);
  const evidence = options.skipEvidence
    ? { status: "skipped", reason: "--skip-evidence", renderSource: manifest.evidence.renderSource, files: [] }
    : validateEvidence(manifest, errors, options.evidenceDir);
  if (errors.length) {
    throw new Error(`WorldClaw asset validation failed with ${errors.length} issue(s):\n- ${errors.join("\n- ")}`);
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const budget = {
    bytesUsed: buffer.length,
    bytesLimit: manifest.library.fileBudgetBytes,
    byteUtilization: Number((buffer.length / manifest.library.fileBudgetBytes).toFixed(6)),
    trianglesUsed: counts.triangles,
    trianglesLimit: manifest.library.maxTriangles,
    triangleUtilization: Number((counts.triangles / manifest.library.maxTriangles).toFixed(6)),
    scorecardInitialAssetPayloadLimitBytes: 8_000_000,
    scorecardInitialAssetPayloadUtilization: Number((buffer.length / 8_000_000).toFixed(6)),
    scorecardDesktopVisibleTriangleLimit: 1_500_000,
    scorecardDesktopTriangleUtilizationIfEveryUniqueRootVisible: Number((counts.triangles / 1_500_000).toFixed(6)),
    scorecardMobileVisibleTriangleLimit: 500_000,
    scorecardMobileTriangleUtilizationIfEveryUniqueRootVisible: Number((counts.triangles / 500_000).toFixed(6)),
  };
  if (options.writeReport) {
    const validatedReport = {
      ...report,
      status: "validated",
      artifact: { path: projectRelative(options.glb), byteLength: buffer.length, sha256 },
      publishedManifest: {
        path: projectRelative(options.publicManifest),
        byteLength: publishedManifestBytes.length,
        sha256: createHash("sha256").update(publishedManifestBytes).digest("hex"),
      },
      validation: {
        status: "passed",
        validator: projectRelative(scriptPath),
        glbVersion: parsed.version,
        runtimeUpAxis: "Y",
        counts: {
          nodeCount: counts.nodes,
          meshCount: counts.meshes,
          materialCount: counts.materials,
          vertexCount: counts.vertices,
          triangleCount: counts.triangles,
        },
        budget,
        prototypes: counts.prototypes,
        variants: counts.variants,
        evidence,
        capabilityContract: {
          schemaVersion: manifest.capabilities.version,
          authoredVariantCount: prototypeKeys.reduce((sum, key) => sum + manifest.prototypes[key].variants.length, 0),
          materialVocabularyCount: Object.keys(manifest.capabilities.materialVocabulary).length,
          constructionVocabularyCounts: Object.fromEntries(
            Object.entries(manifest.capabilities.constructionVocabulary).map(([key, value]) => [key, Object.keys(value).length]),
          ),
          manifestParity: "source_equals_published",
        },
        paperCoverage: coverage,
      },
    };
    writeFileSync(options.report, `${JSON.stringify(validatedReport, null, 2)}\n`);
  }
  console.log(
    `WORLDCLAW_VALIDATE_OK glb=${projectRelative(options.glb)} bytes=${buffer.length} ` +
      `nodes=${counts.nodes} meshes=${counts.meshes} materials=${counts.materials} ` +
      `vertices=${counts.vertices} triangles=${counts.triangles} sha256=${sha256}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`WORLDCLAW_VALIDATE_ERROR\n${error.stack ?? error.message}`);
  process.exitCode = 1;
}
