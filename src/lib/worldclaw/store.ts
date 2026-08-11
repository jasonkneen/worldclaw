import { create } from "zustand";
import { makeLogEntry, runWorldClawPipeline } from "./pipeline";
import type {
  AgentLogEntry,
  CameraMode,
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

  setPrompt: (p: string) => void;
  setViewMode: (m: ViewMode) => void;
  setCameraMode: (m: CameraMode) => void;
  setSelectedObjectId: (id: string | null) => void;
  setShowLayout: (v: boolean) => void;
  setShowRegions: (v: boolean) => void;
  setPanelOpen: (v: boolean) => void;
  generate: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
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

  setPrompt: (p) => set({ prompt: p }),
  setViewMode: (m) => set({ viewMode: m }),
  setCameraMode: (m) => set({ cameraMode: m }),
  setSelectedObjectId: (id) => set({ selectedObjectId: id }),
  setShowLayout: (v) => set({ showLayout: v }),
  setShowRegions: (v) => set({ showRegions: v }),
  setPanelOpen: (v) => set({ panelOpen: v }),

  cancel: () => {
    get().cancelFlag.cancelled = true;
  },

  reset: () =>
    set({
      stage: "idle",
      progress: 0,
      logs: [],
      world: null,
      error: null,
      running: false,
      selectedObjectId: null,
    }),

  generate: async () => {
    const prompt = get().prompt.trim();
    if (!prompt || get().running) return;

    const cancelFlag = { cancelled: false };
    set({
      running: true,
      error: null,
      logs: [],
      world: null,
      progress: 0,
      stage: "intent",
      cancelFlag,
      selectedObjectId: null,
      cameraMode: "orbit",
    });

    try {
      const world = await runWorldClawPipeline(
        prompt,
        (entry) => {
          set((s) => ({
            logs: [...s.logs, makeLogEntry(entry)],
          }));
        },
        (stage, progress) => set({ stage, progress }),
        cancelFlag,
      );
      set({
        world,
        running: false,
        stage: "done",
        progress: 1,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Generation failed";
      set({
        running: false,
        error: msg,
        stage: msg.includes("cancel") ? "idle" : "error",
      });
    }
  },
}));
