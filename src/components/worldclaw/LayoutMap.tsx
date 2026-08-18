import { useEffect, useMemo, useState } from "react";
import { REGION_LAYOUT_COLORS } from "~/lib/worldclaw/materials";
import { useWorldClaw } from "~/lib/worldclaw/store";

export function LayoutMap({
  size = 160,
  showProvenance = true,
}: {
  size?: number;
  showProvenance?: boolean;
}) {
  const world = useWorldClaw((s) => s.world);
  const [inferenceImageFailed, setInferenceImageFailed] = useState(false);

  // Prefer real Imagine I_layout image (paper §2.2)
  const inferenceUrl =
    world?.plan.layoutImageDataUrl ||
    world?.plan.layoutImageUrl ||
    world?.inferenceMeta?.layoutImageUrl;

  useEffect(() => setInferenceImageFailed(false), [inferenceUrl]);

  const semanticUrl = useMemo(() => {
    if (!world) return null;
    const res = Math.min(world.heightField.resolution, 128);
    const canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const img = ctx.createImageData(res, res);
    const hf = world.heightField;
    const step = hf.resolution / res;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const sx = Math.min(hf.resolution - 1, Math.floor(x * step));
        const sy = Math.min(hf.resolution - 1, Math.floor(y * step));
        const ri = hf.regionId[sy * hf.resolution + sx] ?? 0;
        const cat = world.plan.regions[ri]?.category ?? "grass";
        const hex = REGION_LAYOUT_COLORS[cat] ?? world.plan.regions[ri]?.color ?? "#888";
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const i = (y * res + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }, [world]);

  if (!world) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-border bg-surface-subtle text-[11px] text-fg-subtle"
        style={{ width: size, height: size }}
      >
        No layout
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {inferenceUrl && !inferenceImageFailed ? (
        <div>
          <p className="mb-1 text-[10px] tracking-wide text-fg-subtle uppercase">
            Authoritative X/Z map · {world.inferenceMeta?.terrainProvider ?? "generated reference"}
          </p>
          <img
            src={inferenceUrl}
            alt="Authoritative generated top-down layout map"
            width={size}
            height={size}
            className="h-auto max-w-full rounded-md border border-border object-cover"
            onError={() => setInferenceImageFailed(true)}
          />
        </div>
      ) : null}
      {inferenceUrl && inferenceImageFailed ? (
        <p className="border border-dashed border-border px-2 py-2 text-[9px] text-fg-subtle">
          Retained top-down reference could not be decoded.
        </p>
      ) : null}
      {semanticUrl ? (
        <div>
          <p className="mb-1 text-[10px] tracking-wide text-fg-subtle uppercase">
            Semantic extraction · {world.heightField.source}
          </p>
          <img
            src={semanticUrl}
            alt="Semantic layout map"
            width={size}
            height={size}
            className="h-auto max-w-full rounded-md border border-border object-cover"
            style={{ imageRendering: "pixelated" }}
          />
        </div>
      ) : null}
      {showProvenance && (
        <p className="text-[10px] text-fg-subtle">
          Terrain: {world.inferenceMeta?.terrainSource ?? world.terrainSpec.source} · Plan:{" "}
          {world.inferenceMeta?.planSource ?? world.plan.inferenceSource ?? "template"}
        </p>
      )}
    </div>
  );
}
