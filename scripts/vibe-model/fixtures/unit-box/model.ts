import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";

export function createModel() {
  const root = new Group();
  root.name = "ASSET_crate";
  const material = new MeshStandardMaterial({
    color: "#8a6a3a",
    roughness: 0.82,
    metalness: 0.04,
  });
  const mesh = new Mesh(new BoxGeometry(0.7, 0.7, 0.7), material);
  mesh.position.y = 0.35;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return {
    root,
    dispose() {
      material.dispose();
      mesh.geometry.dispose();
    },
  };
}
