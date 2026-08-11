import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sky, Stars, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { useWorldClaw } from "~/lib/worldclaw/store";
import { sampleHeight } from "~/lib/worldclaw/terrain";
import { ObjectMesh } from "./ObjectMesh";
import { TerrainMesh, WaterPlane } from "./TerrainMesh";
import type { WorldScene as WorldSceneType } from "~/lib/worldclaw/types";

function WalkController({
  enabled,
  world,
}: {
  enabled: boolean;
  world: WorldSceneType | null;
}) {
  const { camera } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);
  const pitch = useRef(0.12);
  const pos = useRef(new THREE.Vector3(0, 4, 18));
  const primed = useRef(false);

  useEffect(() => {
    if (!enabled) {
      primed.current = false;
      return;
    }
    if (!primed.current) {
      const h = world
        ? sampleHeight(world.heightField, 0, 16)
        : 2;
      pos.current.set(0, Math.max(h + 1.7, 2), 16);
      yaw.current = 0;
      pitch.current = 0.1;
      primed.current = true;
    }

    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      // prevent page scroll on space
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [enabled, world]);

  useFrame((_, rawDelta) => {
    if (!enabled) return;
    const delta = Math.min(rawDelta, 0.05);
    const speed =
      (keys.current["ShiftLeft"] || keys.current["ShiftRight"] ? 24 : 12) *
      delta;

    // A = left, D = right (local)
    const forward = new THREE.Vector3(
      -Math.sin(yaw.current),
      0,
      -Math.cos(yaw.current),
    );
    const right = new THREE.Vector3(
      Math.cos(yaw.current),
      0,
      -Math.sin(yaw.current),
    );

    if (keys.current["KeyW"] || keys.current["ArrowUp"])
      pos.current.addScaledVector(forward, speed);
    if (keys.current["KeyS"] || keys.current["ArrowDown"])
      pos.current.addScaledVector(forward, -speed);
    if (keys.current["KeyA"] || keys.current["ArrowLeft"])
      pos.current.addScaledVector(right, -speed);
    if (keys.current["KeyD"] || keys.current["ArrowRight"])
      pos.current.addScaledVector(right, speed);

    // Fly boost with Q/E still available
    if (keys.current["KeyQ"]) pos.current.y += speed;
    if (keys.current["KeyE"]) pos.current.y -= speed;

    // Snap to terrain when not flying
    if (world && !keys.current["KeyQ"] && !keys.current["KeyE"]) {
      const th = sampleHeight(
        world.heightField,
        pos.current.x,
        pos.current.z,
      );
      const targetY = Math.max(th + 1.65, 0.5);
      pos.current.y += (targetY - pos.current.y) * Math.min(1, 10 * delta);
    }

    pos.current.y = Math.max(0.5, Math.min(45, pos.current.y));
    const half = (world?.heightField.worldSize ?? 100) * 0.48;
    pos.current.x = Math.max(-half, Math.min(half, pos.current.x));
    pos.current.z = Math.max(-half, Math.min(half, pos.current.z));

    if (keys.current["KeyJ"]) yaw.current += 1.5 * delta;
    if (keys.current["KeyL"]) yaw.current -= 1.5 * delta;
    if (keys.current["KeyI"])
      pitch.current = Math.min(1.2, pitch.current + 1.1 * delta);
    if (keys.current["KeyK"])
      pitch.current = Math.max(-1.2, pitch.current - 1.1 * delta);

    camera.position.copy(pos.current);
    const look = new THREE.Vector3(
      pos.current.x - Math.sin(yaw.current) * Math.cos(pitch.current),
      pos.current.y + Math.sin(pitch.current),
      pos.current.z - Math.cos(yaw.current) * Math.cos(pitch.current),
    );
    camera.lookAt(look);
  });

  return null;
}

function SceneContent({ world }: { world: WorldSceneType }) {
  const viewMode = useWorldClaw((s) => s.viewMode);
  const cameraMode = useWorldClaw((s) => s.cameraMode);
  const selectedObjectId = useWorldClaw((s) => s.selectedObjectId);
  const setSelectedObjectId = useWorldClaw((s) => s.setSelectedObjectId);
  const theme = world.plan.theme;

  const showWater =
    theme === "tropical" ||
    theme === "island" ||
    theme === "canyon" ||
    theme === "snow" ||
    world.plan.regions.some(
      (r) => r.category === "ocean" || r.category === "river",
    );

  const sunPos: [number, number, number] =
    theme === "volcanic"
      ? [20, 12, -10]
      : theme === "snow"
        ? [30, 40, 10]
        : theme === "desert"
          ? [40, 50, 5]
          : [25, 35, 15];

  return (
    <>
      <color
        attach="background"
        args={[
          theme === "volcanic"
            ? "#1a0a08"
            : theme === "snow"
              ? "#b8c8d8"
              : theme === "desert"
                ? "#c8b080"
                : theme === "tropical" || theme === "island"
                  ? "#6aa8d0"
                  : "#8ab0c8",
        ]}
      />
      {theme !== "volcanic" && (
        <Sky
          distance={450}
          sunPosition={sunPos}
          inclination={0.52}
          azimuth={0.25}
          mieCoefficient={theme === "desert" ? 0.008 : 0.005}
          rayleigh={theme === "snow" ? 0.6 : 1}
        />
      )}
      {theme === "volcanic" && (
        <Stars radius={80} depth={40} count={1200} factor={3} />
      )}

      <ambientLight
        intensity={
          theme === "volcanic" ? 0.25 : theme === "snow" ? 0.55 : 0.42
        }
      />
      <hemisphereLight
        args={[
          theme === "desert" ? "#ffe8c0" : "#c8e0f0",
          theme === "volcanic" ? "#2a1008" : "#3a4a30",
          0.35,
        ]}
      />
      <directionalLight
        castShadow
        position={sunPos}
        intensity={
          theme === "desert" ? 1.65 : theme === "volcanic" ? 0.95 : 1.3
        }
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={160}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        color={theme === "volcanic" ? "#ff8844" : "#fff5e6"}
      />
      {theme === "volcanic" && (
        <pointLight
          position={[0, 2, 0]}
          intensity={2.5}
          distance={40}
          color="#ff4400"
        />
      )}

      <fog
        attach="fog"
        args={[
          theme === "volcanic"
            ? "#1a0a08"
            : theme === "snow"
              ? "#c8d4e0"
              : theme === "desert"
                ? "#d4c090"
                : "#7aacc8",
          45,
          theme === "desert" ? 135 : 115,
        ]}
      />

      <TerrainMesh
        heightField={world.heightField}
        plan={world.plan}
        viewMode={viewMode}
      />

      {showWater && (
        <WaterPlane
          worldSize={world.heightField.worldSize}
          y={theme === "canyon" ? -0.85 : -0.35}
          color={
            theme === "canyon"
              ? "#2a6a8a"
              : theme === "snow"
                ? "#6a90a8"
                : theme === "volcanic"
                  ? "#3a1808"
                  : "#1a5f8a"
          }
        />
      )}

      {world.objects.map((obj) => (
        <ObjectMesh
          key={obj.id}
          obj={obj}
          viewMode={viewMode}
          selected={selectedObjectId === obj.id}
          onSelect={setSelectedObjectId}
        />
      ))}

      {cameraMode === "orbit" && (
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={8}
          maxDistance={150}
          maxPolarAngle={Math.PI * 0.48}
          target={[0, 2, 0]}
        />
      )}
      <WalkController enabled={cameraMode === "walk"} world={world} />
    </>
  );
}

function EmptyScene() {
  return (
    <>
      <color attach="background" args={["#0c0c0e"]} />
      <ambientLight intensity={0.4} />
      <gridHelper args={[80, 40, "#2a2a30", "#1a1a20"]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#121214" />
      </mesh>
      <OrbitControls makeDefault enableDamping />
    </>
  );
}

export function WorldViewport() {
  const world = useWorldClaw((s) => s.world);
  const cameraMode = useWorldClaw((s) => s.cameraMode);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-sm text-fg-muted">
        Initializing viewport…
      </div>
    );
  }

  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      className="h-full w-full touch-none"
      onPointerMissed={() => useWorldClaw.getState().setSelectedObjectId(null)}
    >
      <PerspectiveCamera
        makeDefault
        position={cameraMode === "walk" ? [0, 4, 18] : [42, 34, 42]}
        fov={50}
        near={0.2}
        far={400}
      />
      {world ? <SceneContent world={world} /> : <EmptyScene />}
    </Canvas>
  );
}
