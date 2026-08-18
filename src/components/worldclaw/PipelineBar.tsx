import { useWorldClaw } from "~/lib/worldclaw/store";
import type { PipelineStage } from "~/lib/worldclaw/types";
import { cn } from "~/lib/utils";

const STAGES: { id: PipelineStage; label: string }[] = [
  { id: "intent", label: "Intent" },
  { id: "planning", label: "Plan" },
  { id: "terrain_plan", label: "Terrain" },
  { id: "terrain_build", label: "Build" },
  { id: "regional_plan", label: "Regions" },
  { id: "object_gen", label: "Objects" },
  { id: "scene_refine", label: "Refine" },
  { id: "compose", label: "Compose" },
  { id: "render_validate", label: "Judge" },
];

const ORDER: PipelineStage[] = [
  "idle",
  "intent",
  "planning",
  "terrain_plan",
  "terrain_assets",
  "terrain_build",
  "terrain_refine",
  "regional_plan",
  "object_gen",
  "object_place",
  "scene_refine",
  "compose",
  "render_validate",
  "done",
];

function stageIndex(s: PipelineStage) {
  return ORDER.indexOf(s);
}

export function PipelineBar() {
  const stage = useWorldClaw((s) => s.stage);
  const progress = useWorldClaw((s) => s.progress);
  const running = useWorldClaw((s) => s.running);
  const renderValidation = useWorldClaw((s) => s.renderValidation);
  const activePipeline = running || renderValidation?.status === "running";
  const current = stageIndex(stage);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg-muted">
          Global-to-regional pipeline
        </span>
        <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-subtle">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(2, progress * 100)}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {STAGES.map((s) => {
          const idx = stageIndex(s.id);
          const active = activePipeline && current >= idx && current < idx + 2;
          const done = current > idx || stage === "done";
          return (
            <span
              key={s.id}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide",
                done && !active
                  ? "border-border text-fg-muted"
                  : active
                    ? "border-border-strong bg-surface-elevated text-fg"
                    : "border-transparent text-fg-subtle",
              )}
            >
              {s.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
