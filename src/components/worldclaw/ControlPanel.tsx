import {
  Box,
  Eye,
  Footprints,
  Layers,
  Loader2,
  Map,
  Orbit,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listPresets } from "~/lib/worldclaw/planning";
import { browserAssetInstanceScale } from "~/lib/worldclaw/assets";
import { useWorldClaw } from "~/lib/worldclaw/store";
import {
  getWorldclawPlanningAvailability,
  WORLD_PROMPT_MAX_CHARS,
  type WorldclawPlanningAvailability,
} from "~/lib/worldclaw/inference";
import { Button } from "~/components/ui/button";
import { AgentConsole } from "./AgentConsole";
import { GenerationEvidence } from "./GenerationEvidence";
import { PipelineBar } from "./PipelineBar";
import { cn } from "~/lib/utils";
import type { CameraMode, ViewMode } from "~/lib/worldclaw/types";

const PRESETS = listPresets();
const PANEL_WIDTH_STORAGE_KEY = "worldclaw.control-panel-width";
const PANEL_MIN_WIDTH = 340;
const PANEL_MAX_WIDTH = 680;
const PANEL_DEFAULT_WIDTH = 380;

function panelMaxWidth() {
  if (typeof window === "undefined") return PANEL_MAX_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, window.innerWidth - 460));
}

function clampPanelWidth(width: number) {
  return Math.min(panelMaxWidth(), Math.max(PANEL_MIN_WIDTH, width));
}

const VIEW_MODES: { id: ViewMode; label: string; icon: typeof Eye }[] = [
  { id: "lit", label: "Lit", icon: Eye },
  { id: "instance", label: "Instance", icon: Box },
  { id: "depth", label: "Depth", icon: Layers },
  { id: "normal", label: "Normal", icon: Map },
];

export function ControlPanel() {
  const prompt = useWorldClaw((s) => s.prompt);
  const setPrompt = useWorldClaw((s) => s.setPrompt);
  const generate = useWorldClaw((s) => s.generate);
  const cancel = useWorldClaw((s) => s.cancel);
  const running = useWorldClaw((s) => s.running);
  const stage = useWorldClaw((s) => s.stage);
  const progress = useWorldClaw((s) => s.progress);
  const logs = useWorldClaw((s) => s.logs);
  const world = useWorldClaw((s) => s.world);
  const error = useWorldClaw((s) => s.error);
  const viewMode = useWorldClaw((s) => s.viewMode);
  const setViewMode = useWorldClaw((s) => s.setViewMode);
  const cameraMode = useWorldClaw((s) => s.cameraMode);
  const setCameraMode = useWorldClaw((s) => s.setCameraMode);
  const selectedObjectId = useWorldClaw((s) => s.selectedObjectId);
  const panelOpen = useWorldClaw((s) => s.panelOpen);
  const setPanelOpen = useWorldClaw((s) => s.setPanelOpen);
  const [narrow, setNarrow] = useState(false);
  const [planningAvailability, setPlanningAvailability] =
    useState<WorldclawPlanningAvailability | null>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const panelWidthRef = useRef(PANEL_DEFAULT_WIDTH);
  const resizeSession = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    previousUserSelect: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorldclawPlanningAvailability()
      .then((status) => {
        if (!cancelled) setPlanningAvailability(status);
      })
      .catch(() => {
        if (!cancelled) setPlanningAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => {
      setNarrow(mq.matches);
      if (mq.matches) setPanelOpen(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [setPanelOpen]);

  useEffect(() => {
    const stored = Number.parseFloat(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY) ?? "");
    const initialWidth = clampPanelWidth(Number.isFinite(stored) ? stored : PANEL_DEFAULT_WIDTH);
    panelWidthRef.current = initialWidth;
    setPanelWidth(initialWidth);

    const keepWidthInViewport = () => {
      const nextWidth = clampPanelWidth(panelWidthRef.current);
      panelWidthRef.current = nextWidth;
      setPanelWidth(nextWidth);
    };
    window.addEventListener("resize", keepWidthInViewport);
    return () => {
      window.removeEventListener("resize", keepWidthInViewport);
      const session = resizeSession.current;
      if (session) document.body.style.userSelect = session.previousUserSelect;
    };
  }, []);

  const updatePanelWidth = (width: number, persist = false) => {
    const nextWidth = clampPanelWidth(width);
    panelWidthRef.current = nextWidth;
    setPanelWidth(nextWidth);
    if (persist) {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
    }
  };

  const finishPanelResize = (target: HTMLElement, pointerId: number) => {
    const session = resizeSession.current;
    if (!session || session.pointerId !== pointerId) return;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    document.body.style.userSelect = session.previousUserSelect;
    resizeSession.current = null;
    updatePanelWidth(panelWidthRef.current, true);
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow || event.button !== 0) return;
    event.preventDefault();
    resizeSession.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidthRef.current,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizeSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    updatePanelWidth(session.startWidth + event.clientX - session.startX);
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth = panelWidthRef.current;
    if (event.key === "ArrowLeft") nextWidth -= 16;
    else if (event.key === "ArrowRight") nextWidth += 16;
    else if (event.key === "Home") nextWidth = PANEL_MIN_WIDTH;
    else if (event.key === "End") nextWidth = panelMaxWidth();
    else return;
    event.preventDefault();
    updatePanelWidth(nextWidth, true);
  };

  const selected = world?.objects.find((o) => o.id === selectedObjectId);
  const selectedRenderScale = selected
    ? selected.browserAsset
      ? browserAssetInstanceScale(selected)
      : selected.scale
    : null;
  const assetProvenance = useMemo(() => {
    let blenderPrototypeInstances = 0;
    let vibePrototypeInstances = 0;
    const libraryUris = new Set<string>();
    const prototypes = new Set<string>();
    for (const object of world?.objects ?? []) {
      if (!object.browserAsset) continue;
      if (object.browserAsset.source === "vibe_model") vibePrototypeInstances++;
      else blenderPrototypeInstances++;
      libraryUris.add(object.browserAsset.uri);
      prototypes.add(object.browserAsset.prototype);
    }
    return {
      blenderPrototypeInstances,
      vibePrototypeInstances,
      primitiveFallbackInstances:
        (world?.objects.length ?? 0) - blenderPrototypeInstances - vibePrototypeInstances,
      libraryUri: [...libraryUris][0],
      prototypeCount: prototypes.size,
    };
  }, [world]);

  if (!panelOpen) {
    return (
      <div className="absolute top-3 left-3 z-20 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="flex h-11 min-w-[44px] items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 text-sm text-fg backdrop-blur-sm"
        >
          <Sparkles className="h-4 w-4" />
          <span>WorldClaw</span>
        </button>
        {world && (
          <div className="flex gap-1 rounded-lg border border-border bg-surface/95 p-1 backdrop-blur-sm">
            {VIEW_MODES.map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setViewMode(m.id)}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-md",
                    viewMode === m.id ? "bg-surface-elevated text-fg" : "text-fg-muted",
                  )}
                  aria-label={m.label}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setCameraMode(cameraMode === "orbit" ? "walk" : "orbit")}
              className="flex h-10 w-10 items-center justify-center rounded-md text-fg-muted"
              aria-label="Toggle camera"
            >
              {cameraMode === "orbit" ? (
                <Orbit className="h-4 w-4" />
              ) : (
                <Footprints className="h-4 w-4" />
              )}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      className={cn(
        "absolute z-20 flex flex-col border-border bg-surface/95 backdrop-blur-md",
        narrow
          ? "inset-x-0 bottom-0 max-h-[70dvh] rounded-t-xl border-t"
          : "top-0 left-0 h-full border-r",
      )}
      style={narrow ? undefined : { width: panelWidth }}
    >
      {!narrow && (
        <div
          role="separator"
          aria-label="Resize controls panel"
          aria-orientation="vertical"
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={panelMaxWidth()}
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={0}
          className="group absolute top-0 -right-2 z-30 flex h-full w-4 cursor-col-resize touch-none items-center justify-center outline-none"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={(event) => finishPanelResize(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishPanelResize(event.currentTarget, event.pointerId)}
          onKeyDown={handleResizeKeyDown}
        >
          <span className="h-14 w-0.5 rounded-full bg-border-strong opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 group-active:bg-fg-muted group-active:opacity-100" />
        </div>
      )}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-elevated">
            <Sparkles className="h-3.5 w-3.5 text-fg" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-fg">WorldClaw</h1>
            <p className="text-[11px] text-fg-subtle">Agentic 3D open-world generation</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          className="flex h-10 w-10 items-center justify-center rounded-md text-fg-muted hover:bg-surface-subtle hover:text-fg"
          aria-label="Collapse panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-fg-muted" htmlFor="prompt">
            Open-ended world prompt
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            maxLength={WORLD_PROMPT_MAX_CHARS}
            placeholder="e.g. a tropical pirate island with docks and ships…"
            className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2.5 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:ring-1 focus:ring-ring focus:outline-none"
            disabled={running}
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => void generate()}
              disabled={running || !prompt.trim()}
            >
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Generate world
                </>
              )}
            </Button>
            {running && (
              <Button variant="secondary" onClick={cancel} aria-label="Cancel">
                <Square className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {planningAvailability?.mode === "template" && (
            <p
              role="status"
              className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted"
            >
              This server has no model keys, so Generate uses a local template and remaps every
              prompt onto a canned map. Restart the preview after loading{" "}
              <span className="font-medium text-fg">.xai_env</span> to plan new locations with
              Grok, Gemini, GPT, and Claude.
            </p>
          )}
          {planningAvailability?.mode === "committee" && (
            <p role="status" className="text-[11px] leading-relaxed text-fg-muted">
              Model committee ready:{" "}
              {planningAvailability.providers
                .filter((provider) => provider.configured)
                .map((provider) => provider.model)
                .join(" · ")}
              . Type any place and Generate — paper chips only fill the prompt.
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-fg-muted">Paper examples</span>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={running}
                onClick={() => setPrompt(p.prompt)}
                className="rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-[11px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <PipelineBar />

        <GenerationEvidence
          world={world}
          logs={logs}
          stage={stage}
          progress={progress}
          running={running}
        />

        {world && (
          <div className="space-y-3 rounded-lg border border-border bg-bg/50 p-3">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-fg-muted">Render mode</span>
              <div className="grid grid-cols-4 gap-1">
                {VIEW_MODES.map((m) => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setViewMode(m.id)}
                      className={cn(
                        "flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-md border px-1 py-2 text-[10px] transition-colors",
                        viewMode === m.id
                          ? "border-border-strong bg-surface-elevated text-fg"
                          : "border-transparent text-fg-subtle hover:bg-surface-subtle",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-fg-muted">Camera</span>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: "orbit" as CameraMode, label: "Orbit", icon: Orbit },
                    { id: "map" as CameraMode, label: "Map", icon: Map },
                    {
                      id: "walk" as CameraMode,
                      label: "Walk",
                      icon: Footprints,
                    },
                  ] as const
                ).map((m) => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setCameraMode(m.id)}
                      className={cn(
                        "flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition-colors",
                        cameraMode === m.id
                          ? "border-border-strong bg-surface-elevated text-fg"
                          : "border-transparent text-fg-subtle hover:bg-surface-subtle",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
              {cameraMode === "walk" && (
                <p className="text-[10px] leading-snug text-fg-subtle">
                  WASD move · Q/E fly · IJKL look · Shift sprint
                </p>
              )}
              {cameraMode === "map" && (
                <p className="text-[10px] leading-snug text-fg-subtle">
                  Registered north-up orthographic view · same X/Z convention as I_layout
                </p>
              )}
            </div>

            <div>
              <div className="min-w-0 space-y-1.5 text-[11px]">
                <p className="font-medium text-fg">{world.plan.sceneType}</p>
                <p className="text-fg-muted">
                  {world.plan.theme} · {world.plan.visualStyle}
                </p>
                <p className="text-fg-subtle">
                  {world.plan.regions.length} regions · {world.objects.length} placed objects
                </p>
                <p className="text-fg-subtle">
                  {assetProvenance.blenderPrototypeInstances} Blender GLB ·{" "}
                  {assetProvenance.vibePrototypeInstances} vibe ·{" "}
                  {assetProvenance.primitiveFallbackInstances} primitive
                </p>
                {assetProvenance.libraryUri && (
                  <p
                    className="truncate font-mono text-fg-subtle"
                    title={assetProvenance.libraryUri}
                  >
                    {assetProvenance.prototypeCount} prototypes ·{" "}
                    {assetProvenance.libraryUri.split("/").at(-1)}
                  </p>
                )}
                <p className="truncate font-mono text-fg-subtle">
                  seed 0x{world.seed.toString(16)}
                </p>
              </div>
            </div>

            {selected && (
              <div className="rounded-md border border-border bg-surface-elevated px-2.5 py-2 text-[11px]">
                <p className="font-medium text-fg">{selected.label}</p>
                <p className="text-fg-muted">
                  {selected.kind} · render scale {selectedRenderScale?.toFixed(2)} · contact{" "}
                  {(selected.contactScore * 100).toFixed(0)}%
                </p>
                {selected.browserAsset ? (
                  <>
                    <p className="text-fg-subtle">
                      {selected.browserAsset.source === "vibe_model"
                        ? "Vibe model"
                        : "Blender procedural"}{" "}
                      · {selected.browserAsset.prototype} · {selected.browserAsset.node}
                    </p>
                    <p className="text-fg-subtle">
                      {(
                        selected.browserAsset.targetHeightMeters * (selectedRenderScale ?? 1)
                      ).toFixed(1)}
                      m rendered height · {selected.browserAsset.collider.type} collider
                    </p>
                  </>
                ) : (
                  <p className="text-fg-subtle">
                    Primitive fallback · no compiled alias for {selected.kind}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {world && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-fg-muted">Regions R</span>
            <ul className="space-y-1">
              {world.plan.regions.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[11px]"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: r.color }}
                  />
                  <span className="truncate text-fg">{r.name}</span>
                  <span className="ml-auto shrink-0 text-fg-subtle">{r.category}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div
        className={cn(
          "shrink-0 border-t border-border",
          narrow ? "h-[120px]" : "h-[180px] sm:h-[200px]",
        )}
      >
        <AgentConsole />
      </div>
    </aside>
  );
}
