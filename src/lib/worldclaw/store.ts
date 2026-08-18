import { create } from "zustand";
import {
  mergeEnsembleEvidence,
  validateBenchmarkGenerationContract,
  type BenchmarkGenerationContract,
} from "./inference";
import { makeLogEntry, runWorldClawPipeline } from "./pipeline";
import {
  WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS,
  WORLDCLAW_GENERATION_FAILURE_MESSAGE_MAX_CHARS,
} from "./types";
import type {
  AgentLogEntry,
  CameraMode,
  EnsembleEvidence,
  FinalRenderValidation,
  GenerationFailureEvidence,
  PipelineStage,
  ViewMode,
  WorldScene,
} from "./types";

interface WorldClawState {
  prompt: string;
  stage: PipelineStage;
  progress: number;
  logs: AgentLogEntry[];
  world: WorldScene | null;
  error: string | null;
  running: boolean;
  viewMode: ViewMode;
  cameraMode: CameraMode;
  selectedObjectId: string | null;
  showLayout: boolean;
  showRegions: boolean;
  panelOpen: boolean;
  cancelFlag: { cancelled: boolean };
  abortController: AbortController | null;
  renderValidation: FinalRenderValidation | null;
  ensembleProgress: EnsembleEvidence | null;
  generationFailure: GenerationFailureEvidence | null;

  setPrompt: (p: string) => void;
  setViewMode: (m: ViewMode) => void;
  setCameraMode: (m: CameraMode) => void;
  setSelectedObjectId: (id: string | null) => void;
  setShowLayout: (v: boolean) => void;
  setShowRegions: (v: boolean) => void;
  setPanelOpen: (v: boolean) => void;
  setRenderValidation: (validation: FinalRenderValidation | null) => void;
  mergeWorldEnsemble: (worldId: string, evidence: EnsembleEvidence) => void;
  generate: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

declare global {
  interface Window {
    /** Injected before application startup only by the hash-bound paper benchmark harness. */
    __WORLDCLAW_BENCHMARK_GENERATION__?: BenchmarkGenerationContract;
  }
}

function activeBenchmarkContract(prompt: string): BenchmarkGenerationContract | undefined {
  if (typeof window === "undefined") return undefined;
  const input = window.__WORLDCLAW_BENCHMARK_GENERATION__;
  if (!input) return undefined;
  return validateBenchmarkGenerationContract(input, prompt);
}

export const useWorldClaw = create<WorldClawState>((set, get) => ({
  prompt: "",
  stage: "idle",
  progress: 0,
  logs: [],
  world: null,
  error: null,
  running: false,
  viewMode: "lit",
  cameraMode: "orbit",
  selectedObjectId: null,
  showLayout: false,
  showRegions: true,
  panelOpen: true,
  cancelFlag: { cancelled: false },
  abortController: null,
  renderValidation: null,
  ensembleProgress: null,
  generationFailure: null,

  setPrompt: (p) => set({ prompt: p }),
  setViewMode: (m) => set({ viewMode: m }),
  setCameraMode: (m) => set({ cameraMode: m }),
  setSelectedObjectId: (id) => set({ selectedObjectId: id }),
  setShowLayout: (v) => set({ showLayout: v }),
  setShowRegions: (v) => set({ showRegions: v }),
  setPanelOpen: (v) => set({ panelOpen: v }),
  mergeWorldEnsemble: (worldId, evidence) =>
    set((state) => {
      if (!state.world || state.world.id !== worldId) return state;
      return {
        world: {
          ...state.world,
          inferenceMeta: state.world.inferenceMeta
            ? {
                ...state.world.inferenceMeta,
                ensemble: mergeEnsembleEvidence(state.world.inferenceMeta.ensemble, evidence),
              }
            : state.world.inferenceMeta,
        },
      };
    }),
  setRenderValidation: (validation) =>
    set((state) => {
      if (!validation) return { renderValidation: null };
      const previousStatus = state.renderValidation?.status;
      if (previousStatus === validation.status) {
        return { renderValidation: validation };
      }
      const message =
        validation.status === "running"
          ? "Capturing registered map, isometric and oblique views for final build comparison…"
          : validation.status === "passed"
            ? `Final renderer agreement passed at ${Math.round((validation.judgement?.agreementScore ?? 0) * 100)}%`
            : validation.status === "failed"
              ? `Final renderer review recorded warnings at ${Math.round((validation.judgement?.agreementScore ?? 0) * 100)}%; world remains available`
              : validation.status === "unavailable"
                ? "Final renderer comparison unavailable for this run"
                : `Final renderer comparison error: ${validation.error ?? "unknown error"}`;
      return {
        renderValidation: validation,
        stage: validation.status === "running" ? "render_validate" : "done",
        progress: validation.status === "running" ? 0.98 : 1,
        logs: [
          ...state.logs,
          makeLogEntry({
            stage: validation.status === "running" ? "render_validate" : "done",
            agent: "FinalRenderJudge",
            message,
            level:
              validation.status === "passed"
                ? "success"
                : validation.status === "running"
                  ? "info"
                  : "warn",
          }),
        ],
      };
    }),

  cancel: () => {
    get().cancelFlag.cancelled = true;
    get().abortController?.abort();
    set({
      running: false,
      stage: "idle",
      progress: 0,
      error: null,
      abortController: null,
      renderValidation: null,
      ensembleProgress: null,
      generationFailure: null,
    });
  },

  reset: () => {
    get().cancelFlag.cancelled = true;
    get().abortController?.abort();
    set({
      stage: "idle",
      progress: 0,
      logs: [],
      world: null,
      error: null,
      running: false,
      selectedObjectId: null,
      abortController: null,
      renderValidation: null,
      ensembleProgress: null,
      generationFailure: null,
    });
  },

  generate: async () => {
    const prompt = get().prompt.trim();
    if (!prompt || get().running) return;

    let benchmarkContract: BenchmarkGenerationContract | undefined;
    try {
      benchmarkContract = activeBenchmarkContract(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        error: `Benchmark generation contract rejected before provider use: ${message}`,
        stage: "error",
        generationFailure: createGenerationFailureEvidence(
          message,
          "intent",
          0,
          get().ensembleProgress,
        ),
      });
      return;
    }

    const cancelFlag = { cancelled: false };
    const abortController = new AbortController();
    set({
      running: true,
      error: null,
      logs: [],
      world: null,
      progress: 0,
      stage: "intent",
      cancelFlag,
      abortController,
      renderValidation: null,
      ensembleProgress: null,
      generationFailure: null,
      selectedObjectId: null,
      cameraMode: "orbit",
    });

    try {
      const world = await runWorldClawPipeline(
        prompt,
        (entry) => {
          if (abortController.signal.aborted || get().abortController !== abortController) {
            return;
          }
          set((s) => ({
            logs: [...s.logs, makeLogEntry(entry)],
          }));
        },
        (stage, progress) => {
          if (abortController.signal.aborted || get().abortController !== abortController) {
            return;
          }
          set({ stage, progress });
        },
        cancelFlag,
        abortController.signal,
        (evidence) => {
          if (abortController.signal.aborted || get().abortController !== abortController) {
            return;
          }
          set({ ensembleProgress: evidence });
        },
        benchmarkContract
          ? {
              benchmarkContract,
              strictAssetResolution: true,
            }
          : {},
      );
      if (abortController.signal.aborted || get().abortController !== abortController) {
        return;
      }
      set({
        world,
        running: false,
        stage: "done",
        progress: 1,
        abortController: null,
        ensembleProgress: world.inferenceMeta?.ensemble ?? null,
        generationFailure: null,
      });
    } catch (e) {
      if (get().abortController !== abortController) return;
      const msg = e instanceof Error ? e.message : "Generation failed";
      const failedState = get();
      set({
        running: false,
        error: msg,
        stage: msg.includes("cancel") ? "idle" : "error",
        abortController: null,
        generationFailure: msg.includes("cancel")
          ? null
          : createGenerationFailureEvidence(
              msg,
              failedState.stage,
              failedState.progress,
              failedState.ensembleProgress,
            ),
      });
    }
  },
}));

export function createGenerationFailureEvidence(
  message: string,
  stage: PipelineStage,
  progress: number,
  ensemble: EnsembleEvidence | null,
): GenerationFailureEvidence {
  const providers = (Array.isArray(ensemble?.providers) ? ensemble.providers : []).slice(
    0,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.providers,
  );
  const artifacts = (Array.isArray(ensemble?.artifacts) ? ensemble.artifacts : []).slice(
    0,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.artifacts,
  );
  let imageArtifactCount = 0;
  let imageCharacters = 0;
  for (const artifact of artifacts) {
    const image = typeof artifact.imageDataUrl === "string" ? artifact.imageDataUrl : "";
    if (
      !image ||
      image.length > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageDataUrlCharacters ||
      imageArtifactCount >= WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageArtifacts ||
      imageCharacters + image.length >
        WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageDataUrlCharactersTotal
    ) {
      continue;
    }
    imageArtifactCount++;
    imageCharacters += image.length;
  }
  const maxIterations = Math.min(
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.iterations,
    Math.max(1, Math.round(ensemble?.maxIterations ?? 1)),
  );
  return {
    status: "failed",
    message: message
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, WORLDCLAW_GENERATION_FAILURE_MESSAGE_MAX_CHARS),
    stage,
    progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
    committee: {
      retained: providers.length > 0 || artifacts.length > 0,
      providerCount: providers.length,
      artifactCount: artifacts.length,
      imageArtifactCount,
      completedIterations: Math.min(
        maxIterations,
        Math.max(0, Math.round(ensemble?.completedIterations ?? 0)),
      ),
      maxIterations,
    },
  };
}
