import { useEffect } from "react";
import { listPresets } from "~/lib/worldclaw/planning";
import { useWorldClaw } from "~/lib/worldclaw/store";
import { ControlPanel } from "./ControlPanel";
import { WorldViewport } from "./WorldScene";

export function AppShell() {
  const setPrompt = useWorldClaw((s) => s.setPrompt);
  const prompt = useWorldClaw((s) => s.prompt);
  const world = useWorldClaw((s) => s.world);
  const running = useWorldClaw((s) => s.running);
  const stage = useWorldClaw((s) => s.stage);

  useEffect(() => {
    if (!prompt) {
      const presets = listPresets();
      setPrompt(presets[0]?.prompt ?? "");
    }
  }, [prompt, setPrompt]);

  const planSrc = world?.inferenceMeta?.planSource;
  const terrSrc = world?.inferenceMeta?.terrainSource;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-bg">
      <WorldViewport />
      <ControlPanel />

      <div className="pointer-events-none absolute top-3 right-3 z-10 flex flex-col items-end gap-2">
        <div className="rounded-lg border border-border bg-surface/90 px-3 py-2 text-right backdrop-blur-sm">
          <p className="text-[10px] tracking-wide text-fg-subtle uppercase">
            WorldClaw · Agentic Open-World
          </p>
          <p className="text-xs text-fg-muted">
            {world
              ? `${planSrc === "llm" ? "grok-4.5 plan" : "template plan"} · ${terrSrc === "image_guided" ? "Imagine terrain" : "procedural terrain"}`
              : running
                ? `Stage: ${stage.replace(/_/g, " ")}`
                : "Enter a prompt — real LLM + Imagine inference"}
          </p>
        </div>
      </div>

      {!world && !running && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center px-6 sm:pl-[380px]">
          <div className="max-w-sm text-center">
            <h2 className="text-lg font-semibold tracking-tight text-fg">
              Open-world generation
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              Real inference: grok-4.5 intent/planning → Imagine semantic layout
              I_layout → image-guided height field → regional objects →
              contact refinement. Pick a paper example or write your own prompt.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
