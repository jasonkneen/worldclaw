import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  FileCheck2,
  Gauge,
  Image as ImageIcon,
  Library,
  Map,
  Maximize2,
  ScanSearch,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { loadWorldClawAssetManifest, type WorldClawAssetManifest } from "~/lib/worldclaw/assets";
import { useWorldClaw } from "~/lib/worldclaw/store";
import {
  WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS,
  WORLDCLAW_GENERATION_FAILURE_MESSAGE_MAX_CHARS,
} from "~/lib/worldclaw/types";
import type {
  AgentLogEntry,
  EnsembleArtifact,
  EnsembleArtifactStatus,
  EnsembleEvidence,
  EnsembleProviderId,
  EnsembleProviderStatus,
  EnsembleStage,
  FinalRenderValidation,
  GenerationFailureEvidence,
  PipelineStage,
  VisualCameraReference,
  VisualContract,
  WorldScene,
} from "~/lib/worldclaw/types";
import { cn } from "~/lib/utils";
import { LayoutMap } from "./LayoutMap";

const BUILD_REPORT_URI = "/worldclaw/assets/worldclaw-kit.report.json";

const COMMITTEE_PROVIDERS: readonly EnsembleProviderId[] = ["xai", "gemini", "openai", "anthropic"];

const COMMITTEE_STAGES: readonly { id: EnsembleStage; label: string }[] = [
  { id: "planning", label: "Planning" },
  { id: "layout", label: "Layout" },
  { id: "multiview", label: "Multiview" },
  { id: "asset_variant", label: "Asset variant" },
  { id: "critique", label: "Critique" },
  { id: "final_judge", label: "Final judge" },
];

const EVIDENCE_STAGES: {
  label: string;
  stages: PipelineStage[];
  expected: string;
}[] = [
  {
    label: "Intent",
    stages: ["intent", "planning"],
    expected: "Prompt constraints and structured scene plan",
  },
  {
    label: "Terrain prior",
    stages: ["terrain_plan", "terrain_assets"],
    expected: "Top-down reference or procedural fallback decision",
  },
  {
    label: "Terrain field",
    stages: ["terrain_build", "terrain_refine"],
    expected: "Semantic height field and contact-ready terrain",
  },
  {
    label: "Regional plan",
    stages: ["regional_plan"],
    expected: "Per-region object requirements",
  },
  {
    label: "Object resolution",
    stages: ["object_gen", "object_place"],
    expected: "Requested kinds, compiled aliases, and placement",
  },
  {
    label: "Refinement",
    stages: ["scene_refine"],
    expected: "Terrain contact and collision reconciliation",
  },
  {
    label: "Composition",
    stages: ["compose", "render_validate", "done"],
    expected: "Final world, provenance, and browser-ready assets",
  },
];

interface AssetBuildReport {
  version?: number;
  status?: string;
  generator?: {
    script?: string;
    deterministicSeed?: number;
    blenderVersion?: string;
    blenderBuildHash?: string;
  };
  artifact?: {
    path?: string;
    byteLength?: number;
    sha256?: string;
  };
  publishedManifest?: {
    path?: string;
    byteLength?: number;
    sha256?: string;
  };
  validation?: {
    status?: string;
    validator?: string;
    glbVersion?: number;
    runtimeUpAxis?: string;
    counts?: {
      nodeCount?: number;
      meshCount?: number;
      materialCount?: number;
      vertexCount?: number;
      triangleCount?: number;
    };
    budget?: {
      bytesUsed?: number;
      bytesLimit?: number;
      byteUtilization?: number;
      trianglesUsed?: number;
      trianglesLimit?: number;
      triangleUtilization?: number;
    };
  };
}

interface AssetEvidenceState {
  loading: boolean;
  manifest?: WorldClawAssetManifest;
  report?: AssetBuildReport;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBuildReport(value: unknown): AssetBuildReport {
  if (!isRecord(value)) throw new Error("Build report is not an object");
  return value as AssetBuildReport;
}

function formatInteger(value?: number): string {
  return value === undefined ? "—" : new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function basename(path?: string): string {
  return path?.split("/").at(-1) ?? "—";
}

function SourceStatus({ available }: { available: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.12em] uppercase",
        available ? "text-success" : "text-fg-subtle",
      )}
    >
      {available ? <Check className="h-2.5 w-2.5" /> : <CircleDashed className="h-2.5 w-2.5" />}
      {available ? "captured" : "not emitted"}
    </span>
  );
}

function SectionHeading({
  index,
  title,
  icon: Icon,
  available = true,
}: {
  index: string;
  title: string;
  icon: typeof Map;
  available?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-mono text-[9px] tracking-[0.18em] text-fg-subtle">{index}</span>
      <span className="flex h-6 w-6 items-center justify-center border border-border bg-surface-elevated">
        <Icon className="h-3 w-3 text-fg-muted" />
      </span>
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-fg uppercase">{title}</h3>
      <span className="ml-auto">
        <SourceStatus available={available} />
      </span>
    </div>
  );
}

function StageLedger({
  logs,
  stage,
  progress,
  running,
}: {
  logs: AgentLogEntry[];
  stage: PipelineStage;
  progress: number;
  running: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <SectionHeading
        index="01"
        title="Live stage ledger"
        icon={Workflow}
        available={logs.length > 0}
      />
      <div className="flex items-baseline justify-between gap-2 font-mono">
        <span className="text-[9px] tracking-[0.12em] text-fg-subtle uppercase">
          {running
            ? stage.replaceAll("_", " ")
            : stage === "done"
              ? "composition complete"
              : stage === "error"
                ? "generation failed"
                : "awaiting run"}
        </span>
        <span className="text-[10px] tabular-nums text-fg-muted">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <div className="h-1 overflow-hidden bg-surface-subtle">
        <div
          className={cn(
            "h-full transition-[width] duration-300",
            stage === "error" ? "bg-danger" : "bg-info",
          )}
          style={{ width: `${Math.max(logs.length > 0 ? 2 : 0, progress * 100)}%` }}
        />
      </div>
      <ol className="relative space-y-0 before:absolute before:top-3 before:bottom-3 before:left-[4px] before:w-px before:bg-border">
        {EVIDENCE_STAGES.map((group) => {
          const entries = logs.filter((entry) => group.stages.includes(entry.stage));
          const active = running && group.stages.includes(stage);
          const observed = entries.length > 0;
          const latestEntries = entries.slice(-2);
          return (
            <li
              key={group.label}
              className="relative grid grid-cols-[9px_1fr] gap-2.5 pb-3 last:pb-0"
            >
              <span
                className={cn(
                  "relative z-10 mt-1 h-[9px] w-[9px] border bg-bg",
                  active
                    ? "animate-pulse border-info bg-info"
                    : observed
                      ? "border-success bg-success"
                      : "border-border-strong",
                )}
              />
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <p
                    className={cn(
                      "text-[10px] font-medium",
                      observed || active ? "text-fg" : "text-fg-subtle",
                    )}
                  >
                    {group.label}
                  </p>
                  <span className="font-mono text-[8px] text-fg-subtle uppercase">
                    {active ? "active" : observed ? "evidenced" : "pending"}
                  </span>
                </div>
                {latestEntries.length > 0 ? (
                  <div className="mt-1 space-y-1">
                    {latestEntries.map((entry) => (
                      <p key={entry.id} className="text-[9px] leading-relaxed text-fg-muted">
                        <span className="font-mono text-fg-subtle">
                          {entry.agent.replace(/Agent$/, "")} ·{" "}
                        </span>
                        {entry.message}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-0.5 text-[8px] leading-relaxed text-fg-subtle">
                    {group.expected}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ProviderCard({
  label,
  provider,
  detail,
}: {
  label: string;
  provider: string;
  detail: string;
}) {
  const unavailable = provider === "Not recorded" || provider === "Not generated";
  return (
    <div className="relative overflow-hidden border border-border bg-bg/70 px-2.5 py-2">
      <span
        className={cn(
          "absolute top-0 bottom-0 left-0 w-px",
          unavailable ? "bg-border" : "bg-success/70",
        )}
      />
      <p className="font-mono text-[8px] tracking-[0.16em] text-fg-subtle uppercase">{label}</p>
      <p className={cn("mt-1 truncate text-[11px]", unavailable ? "text-fg-subtle" : "text-fg")}>
        {provider}
      </p>
      <p className="mt-0.5 text-[9px] text-fg-subtle">{detail}</p>
    </div>
  );
}

function boundedEvidenceText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, Math.max(0, maximum - 1))}…`
    : normalized;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(finite)));
}

function normalizedScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

type StructuredOutputInspection =
  { valid: true; normalized: string } | { valid: false; reason: string };

function inspectStructuredOutput(value: unknown): StructuredOutputInspection | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (text.length > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputCharacters) {
    return {
      valid: false,
      reason: `Structured output exceeds the ${WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputCharacters}-character bound.`,
    };
  }
  if (/data:image\//i.test(text)) {
    return { valid: false, reason: "Structured output contains forbidden inline image data." };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return { valid: false, reason: "Structured output is not a JSON object." };
    }
    return { valid: true, normalized: JSON.stringify(parsed, null, 2) };
  } catch {
    return { valid: false, reason: "Structured output is not valid JSON." };
  }
}

function qaArtifactToken(value: unknown, fallback: number): string {
  const id = boundedEvidenceText(value, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters);
  // `~` is excluded from the safe-ID branch, keeping absent IDs in a distinct
  // namespace from every literal artifact ID.
  if (!id) return `missing~${fallback}`;
  if (/^[a-zA-Z0-9_-]+$/.test(id)) return id;
  // Fixed-width code points are injective; the `encoded~` prefix cannot be
  // produced by the safe branch, so distinct retained IDs cannot collide.
  return `encoded~${Array.from(id)
    .map((character) => character.codePointAt(0)!.toString(16).padStart(6, "0"))
    .join("")}`;
}

type DataImageInspection =
  { valid: true; width: number; height: number } | { valid: false; reason: string };

const MAX_IMAGE_HEADER_BASE64_CHARACTERS = 262_144;

function uint16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 256 + bytes[offset + 1]!;
}

function uint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 16_777_216 +
    bytes[offset + 1]! * 65_536 +
    bytes[offset + 2]! * 256 +
    bytes[offset + 3]!
  );
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;

    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.length) break;

    const segmentLength = uint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        height: uint16BE(bytes, offset + 3),
        width: uint16BE(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length < 30 || text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP") return undefined;

  const chunk = text(12, 4);
  if (chunk === "VP8X") {
    return {
      width: 1 + bytes[24]! + bytes[25]! * 256 + bytes[26]! * 65_536,
      height: 1 + bytes[27]! + bytes[28]! * 256 + bytes[29]! * 65_536,
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
    };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: (bytes[26]! + bytes[27]! * 256) & 0x3fff,
      height: (bytes[28]! + bytes[29]! * 256) & 0x3fff,
    };
  }
  return undefined;
}

/**
 * Reads dimensions from a bounded image header before the URL reaches an
 * <img>. This avoids decoding an oversized legacy or malformed artifact just
 * to discover that it exceeds the evidence contract.
 */
function inspectDataImage(dataUrl: string): DataImageInspection {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return { valid: false, reason: "Image data URL has no payload." };

  const header = dataUrl.slice(0, comma).toLowerCase();
  const mimeMatch = /^data:image\/(png|jpe?g|gif|webp);base64$/.exec(header);
  if (!mimeMatch) {
    return {
      valid: false,
      reason: "Only bounded base64 PNG, JPEG, GIF, or WebP evidence can be previewed.",
    };
  }

  const encoded = dataUrl.slice(comma + 1);
  if (!encoded || /[^a-zA-Z0-9+/=]/.test(encoded)) {
    return { valid: false, reason: "Image data URL contains an invalid base64 payload." };
  }

  const sampleLength = Math.min(encoded.length, MAX_IMAGE_HEADER_BASE64_CHARACTERS) & ~3;
  if (sampleLength < 4 || typeof globalThis.atob !== "function") {
    return { valid: false, reason: "Image dimensions could not be verified before decode." };
  }

  let bytes: Uint8Array;
  try {
    const binary = globalThis.atob(encoded.slice(0, sampleLength));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return { valid: false, reason: "Image data URL contains an invalid base64 payload." };
  }

  const mime = mimeMatch[1];
  let dimensions: { width: number; height: number } | undefined;
  if (
    mime === "png" &&
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    dimensions = { width: uint32BE(bytes, 16), height: uint32BE(bytes, 20) };
  } else if (mime === "jpeg" || mime === "jpg") {
    dimensions = readJpegDimensions(bytes);
  } else if (
    mime === "gif" &&
    bytes.length >= 10 &&
    (String.fromCharCode(...bytes.subarray(0, 6)) === "GIF87a" ||
      String.fromCharCode(...bytes.subarray(0, 6)) === "GIF89a")
  ) {
    dimensions = {
      width: bytes[6]! + bytes[7]! * 256,
      height: bytes[8]! + bytes[9]! * 256,
    };
  } else if (mime === "webp") {
    dimensions = readWebpDimensions(bytes);
  }

  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    return { valid: false, reason: "Image dimensions could not be verified before decode." };
  }
  if (
    dimensions.width > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageMaximumDimensionPixels ||
    dimensions.height > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageMaximumDimensionPixels
  ) {
    return {
      valid: false,
      reason: `Retained image exceeds the ${WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageMaximumDimensionPixels}px dimension bound.`,
    };
  }
  return { valid: true, ...dimensions };
}

const ARTIFACT_STATUS_STYLE: Record<EnsembleArtifactStatus, string> = {
  candidate: "border-info/35 bg-info/[0.035]",
  selected: "border-success/60 bg-success/[0.07]",
  rejected: "border-border-strong bg-bg/55",
  error: "border-danger/65 bg-danger/[0.06]",
};

const ARTIFACT_STATUS_TEXT: Record<EnsembleArtifactStatus, string> = {
  candidate: "text-info",
  selected: "text-success",
  rejected: "text-fg-subtle",
  error: "text-danger",
};

const ARTIFACT_STATUS_LABEL: Record<EnsembleArtifactStatus, string> = {
  candidate: "candidate",
  selected: "selected",
  rejected: "alternate",
  error: "provider error",
};

function InAppImagePreview({
  src,
  alt,
  label,
  className,
  imageClassName,
  imageRendering,
  loading = "lazy",
  onLoad,
  onError,
  testId,
}: {
  src: string;
  alt: string;
  label: string;
  className?: string;
  imageClassName?: string;
  imageRendering?: "auto" | "pixelated";
  loading?: "eager" | "lazy";
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={cn(
          "group relative block w-full overflow-hidden border border-border bg-black/25 text-left",
          className,
        )}
        onClick={() => setOpen(true)}
        aria-label={`View ${label} in WorldClaw`}
        data-testid={testId}
      >
        <img
          src={src}
          alt={alt}
          className={cn("w-full object-contain", imageClassName)}
          style={imageRendering ? { imageRendering } : undefined}
          loading={loading}
          decoding="async"
          onLoad={onLoad}
          onError={onError}
        />
        <span className="absolute right-1 bottom-1 inline-flex items-center gap-1 bg-black/80 px-1.5 py-1 font-mono text-[7px] tracking-[0.1em] text-white/85 uppercase">
          <Maximize2 className="h-2.5 w-2.5" /> View in app
        </span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={label}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/92 p-3 sm:p-8"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden border border-white/15 bg-[#0b0d10] shadow-2xl">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-white">{label}</p>
                    <p className="mt-0.5 text-[9px] text-white/45">
                      In-app preview · use Escape to close
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center border border-white/15 text-white/70 hover:bg-white/10 hover:text-white"
                    aria-label="Close image preview"
                    autoFocus
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto bg-black p-2">
                  <img
                    src={src}
                    alt={alt}
                    className="mx-auto block max-h-[calc(100dvh-8rem)] max-w-full object-contain"
                    style={imageRendering ? { imageRendering } : undefined}
                  />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function CommitteeProviderStatus({
  provider,
  status,
}: {
  provider: EnsembleProviderId;
  status?: EnsembleProviderStatus;
}) {
  const configured = status?.configured === true;
  const authenticated = status?.authenticated === true;
  const available = status?.available === true;
  const skipped = status?.skipped === true;
  const ready = configured && authenticated && available;
  const state = !status
    ? "status not recorded"
    : skipped
      ? "skipped after quorum"
    : !configured
      ? "not configured"
      : !authenticated
        ? "authentication unavailable"
        : !available
          ? "model unavailable"
          : "ready";
  const model = boundedEvidenceText(
    status?.model,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.modelCharacters,
  );
  const error = boundedEvidenceText(
    status?.error,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.textCharacters,
  );

  return (
    <article
      className={cn(
        "relative min-w-0 overflow-hidden border bg-bg/65 p-2.5",
        ready ? "border-success/45" : error ? "border-danger/55" : "border-border",
      )}
      data-provider={provider}
      data-model={model || undefined}
      data-configured={status ? String(configured) : "unknown"}
      data-authenticated={status ? String(authenticated) : "unknown"}
      data-available={status ? String(available) : "unknown"}
      data-skipped={status ? String(skipped) : "unknown"}
    >
      <span
        className={cn(
          "absolute top-0 bottom-0 left-0 w-px",
          ready ? "bg-success" : error ? "bg-danger" : "bg-border-strong",
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[9px] tracking-[0.16em] text-fg uppercase">{provider}</p>
          <p className="mt-1 truncate font-mono text-[9px] text-fg-muted">
            {model || "model not recorded"}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 border px-1.5 py-0.5 font-mono text-[7px] tracking-[0.12em] uppercase",
            ready
              ? "border-success/35 text-success"
              : error
                ? "border-danger/40 text-danger"
                : "border-border text-fg-subtle",
          )}
        >
          {state}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 font-mono text-[7px] tracking-[0.08em] uppercase">
        {(
          [
            ["configured", status ? configured : undefined],
            ["auth", status ? authenticated : undefined],
            ["available", status ? available : undefined],
          ] as const
        ).map(([label, value]) => (
          <span
            key={label}
            className={cn(
              "border px-1 py-1 text-center",
              value === true
                ? "border-success/25 text-success"
                : value === false
                  ? "border-danger/20 text-danger/85"
                  : "border-border text-fg-subtle",
            )}
          >
            {label} {value === undefined ? "—" : value ? "yes" : "no"}
          </span>
        ))}
      </div>
      {error && (
        <p className="mt-2 border-l border-danger/60 pl-2 text-[8px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </article>
  );
}

function ModelArtifactImage({
  artifact,
  permitted,
  omissionReason,
}: {
  artifact: EnsembleArtifact;
  permitted: boolean;
  omissionReason?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [dimensionIssue, setDimensionIssue] = useState("");
  const rawImage = typeof artifact.imageDataUrl === "string" ? artifact.imageDataUrl : "";
  const withinLimit = rawImage.length <= WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageDataUrlCharacters;
  const inspection = useMemo(
    () => (rawImage && withinLimit ? inspectDataImage(rawImage) : undefined),
    [rawImage, withinLimit],
  );
  const validDataUrl = withinLimit && inspection?.valid === true;

  useEffect(() => {
    setFailed(false);
    setDimensionIssue("");
  }, [rawImage]);

  if (!rawImage) return null;
  if (!permitted) {
    return (
      <div className="border border-warn/40 bg-warn/5 px-2 py-2 text-[8px] leading-relaxed text-warn">
        {omissionReason ?? "Image evidence exceeded the aggregate retained-image bound."}
      </div>
    );
  }
  if (!validDataUrl) {
    const reason = inspection && !inspection.valid ? inspection.reason : undefined;
    return (
      <div className="border border-danger/35 bg-danger/5 px-2 py-2 text-[8px] leading-relaxed text-danger">
        Image evidence was recorded but omitted before decode.{" "}
        {reason ?? "It exceeds the bounded image data-URL size."}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="border border-danger/35 bg-danger/5 px-2 py-2 text-[8px] text-danger">
        Retained image output could not be decoded.
      </div>
    );
  }
  if (dimensionIssue) {
    return (
      <div className="border border-danger/35 bg-danger/5 px-2 py-2 text-[8px] text-danger">
        {dimensionIssue}
      </div>
    );
  }

  return (
    <InAppImagePreview
      src={rawImage}
      alt={`${artifact.provider} ${artifact.stage.replaceAll("_", " ")} candidate`}
      label={`${artifact.stage.replaceAll("_", " ")} · ${artifact.provider} · ${artifact.model}`}
      imageClassName={artifact.stage === "layout" ? "aspect-square" : "aspect-video"}
      onLoad={(event) => {
        if (
          event.currentTarget.naturalWidth >
            WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageMaximumDimensionPixels ||
          event.currentTarget.naturalHeight >
            WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageMaximumDimensionPixels
        ) {
          setDimensionIssue(
            `Retained image exceeds the ${WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageMaximumDimensionPixels}px dimension bound.`,
          );
        }
      }}
      onError={() => setFailed(true)}
    />
  );
}

function ModelArtifactCard({
  artifact,
  index,
  imagePermitted,
  imageOmissionReason,
  structuredOutputPermitted,
  structuredOutputOmissionReason,
}: {
  artifact: EnsembleArtifact;
  index: number;
  imagePermitted: boolean;
  imageOmissionReason?: string;
  structuredOutputPermitted: boolean;
  structuredOutputOmissionReason?: string;
}) {
  const artifactId = boundedEvidenceText(
    artifact.id,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters,
  );
  const token = qaArtifactToken(artifact.id, index);
  const role = boundedEvidenceText(
    artifact.role,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.roleCharacters,
  );
  const model = boundedEvidenceText(
    artifact.model,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.modelCharacters,
  );
  const requestedModel = boundedEvidenceText(
    artifact.requestedModel,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.modelCharacters,
  );
  const responseId = boundedEvidenceText(
    artifact.responseId,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.responseIdentifierCharacters,
  );
  const identityAttestation = (
    ["provider-response", "request-only", "unattested"] as const
  ).includes(artifact.identityAttestation as "provider-response" | "request-only" | "unattested")
    ? artifact.identityAttestation
    : undefined;
  const score = normalizedScore(artifact.score);
  const parentIds = (Array.isArray(artifact.parentArtifactIds) ? artifact.parentArtifactIds : [])
    .slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.parentArtifactIds)
    .filter((value): value is string => typeof value === "string");
  const metrics = Object.entries(isRecord(artifact.metrics) ? artifact.metrics : {})
    .slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.metricsPerArtifact)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]));
  const observations = (Array.isArray(artifact.observations) ? artifact.observations : [])
    .slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.observationsPerArtifact)
    .filter((value): value is string => typeof value === "string");
  const conflicts = (Array.isArray(artifact.conflicts) ? artifact.conflicts : [])
    .slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.conflictsPerArtifact)
    .filter((value): value is string => typeof value === "string");
  const error = boundedEvidenceText(
    artifact.error,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.textCharacters,
  );
  const structuredOutput = inspectStructuredOutput(artifact.structuredOutput);

  return (
    <article
      id={`model-artifact-${token}`}
      data-testid={`model-artifact-${token}`}
      data-artifact-id={artifactId}
      data-provider={artifact.provider}
      data-model={model || undefined}
      data-requested-model={requestedModel || undefined}
      data-response-model={model || undefined}
      data-provider-response-id={responseId || undefined}
      data-response-id={responseId || undefined}
      data-identity-attestation={identityAttestation}
      data-role={role || undefined}
      data-stage={artifact.stage}
      data-status={artifact.status}
      data-iteration={artifact.iteration}
      data-image-retained={Boolean(artifact.imageDataUrl)}
      data-structured-output-retained={Boolean(artifact.structuredOutput)}
      data-structured-output-valid={structuredOutput?.valid === true}
      data-score={score}
      data-passed={artifact.passed === undefined ? undefined : String(artifact.passed)}
      data-parent-artifact-ids={parentIds.length > 0 ? JSON.stringify(parentIds) : undefined}
      className={cn(
        "relative min-w-0 space-y-2 overflow-hidden border p-2.5",
        ARTIFACT_STATUS_STYLE[artifact.status],
      )}
    >
      <span
        className={cn(
          "absolute top-0 right-0 left-0 h-px",
          artifact.status === "selected"
            ? "bg-success"
            : artifact.status === "error"
              ? "bg-danger"
              : "bg-border-strong",
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[8px] tracking-[0.08em] text-fg" title={artifactId}>
            {artifactId || `artifact ${index + 1}`}
          </p>
          <p className="mt-0.5 truncate font-mono text-[7px] text-fg-subtle">
            {artifact.provider} · {model || "model not recorded"}
          </p>
          {identityAttestation && (
            <p className="mt-0.5 truncate font-mono text-[7px] text-fg-subtle">
              {identityAttestation}
              {responseId ? ` · ${responseId}` : " · response ID unavailable"}
            </p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 border border-current/25 px-1.5 py-0.5 font-mono text-[7px] tracking-[0.12em] uppercase",
            ARTIFACT_STATUS_TEXT[artifact.status],
          )}
        >
          {ARTIFACT_STATUS_LABEL[artifact.status]}
        </span>
      </div>

      {role && <p className="text-[9px] leading-relaxed text-fg-muted">{role}</p>}
      <ModelArtifactImage
        artifact={artifact}
        permitted={imagePermitted}
        omissionReason={imageOmissionReason}
      />

      {structuredOutput?.valid === true && structuredOutputPermitted && (
        <details className="border border-border bg-black/15" data-model-structured-output>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 font-mono text-[7px] tracking-[0.12em] text-fg-muted uppercase">
            <ChevronDown className="h-2.5 w-2.5" /> Normalized stage JSON
          </summary>
          <pre
            data-testid={`model-artifact-structured-output-${token}`}
            className="max-h-80 overflow-auto border-t border-border p-2 font-mono text-[8px] leading-relaxed break-words whitespace-pre-wrap text-fg-muted"
          >
            {structuredOutput.normalized}
          </pre>
        </details>
      )}

      {structuredOutput?.valid === true && !structuredOutputPermitted && (
        <p className="border border-warn/35 bg-warn/5 px-2 py-1.5 text-[8px] leading-relaxed text-warn">
          {structuredOutputOmissionReason ??
            "Structured output exceeded the aggregate retained-output display budget."}
        </p>
      )}

      {structuredOutput?.valid === false && (
        <p className="border border-danger/35 bg-danger/5 px-2 py-1.5 text-[8px] leading-relaxed text-danger">
          Retained structured output was rejected: {structuredOutput.reason}
        </p>
      )}

      {(score !== undefined || artifact.passed !== undefined) && (
        <div className="flex items-center gap-2 border-y border-border/70 py-1.5 font-mono text-[8px]">
          <span className="text-fg-subtle">artifact score</span>
          <span className="ml-auto text-fg tabular-nums">
            {score === undefined ? "—" : `${Math.round(score * 100)}%`}
          </span>
          {artifact.passed !== undefined && (
            <span className={artifact.passed ? "text-success" : "text-danger"}>
              {artifact.passed ? "passed" : "failed"}
            </span>
          )}
        </div>
      )}

      {metrics.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-1">
          {metrics.map(([label, value], metricIndex) => {
            const metricLabel = boundedEvidenceText(label.replaceAll("_", " "), 80);
            return (
              <div key={`${metricLabel}-${metricIndex}`} className="border-l border-border pl-1.5">
                <p className="truncate font-mono text-[7px] text-fg-subtle" title={metricLabel}>
                  {metricLabel}
                </p>
                <p className="font-mono text-[9px] text-fg tabular-nums">
                  {Number.isInteger(value) ? value.toString() : value.toFixed(3)}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {parentIds.length > 0 && (
        <div>
          <p className="font-mono text-[7px] tracking-[0.12em] text-fg-subtle uppercase">
            Parent lineage
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {parentIds.map((parentId, parentIndex) => (
              <a
                key={`${parentId}-${parentIndex}`}
                href={`#model-artifact-${qaArtifactToken(parentId, parentIndex)}`}
                className="max-w-full truncate border border-border px-1.5 py-0.5 font-mono text-[7px] text-fg-muted hover:border-info/50 hover:text-info"
              >
                {boundedEvidenceText(
                  parentId,
                  WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters,
                )}
              </a>
            ))}
          </div>
        </div>
      )}

      {observations.length > 0 && (
        <ul className="space-y-1 border-t border-border/70 pt-1.5">
          {observations.map((observation, observationIndex) => (
            <li
              key={observationIndex}
              className="border-l border-info/45 pl-2 text-[8px] leading-relaxed text-fg-muted"
            >
              {boundedEvidenceText(observation, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.textCharacters)}
            </li>
          ))}
        </ul>
      )}

      {conflicts.length > 0 && (
        <div className="space-y-1 border-t border-danger/25 pt-1.5">
          <p className="font-mono text-[7px] tracking-[0.12em] text-danger uppercase">
            Conflicts · {conflicts.length}
          </p>
          {conflicts.map((conflict, conflictIndex) => (
            <p
              key={conflictIndex}
              className="border-l border-danger/60 pl-2 text-[8px] leading-relaxed text-fg-muted"
            >
              {boundedEvidenceText(conflict, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.textCharacters)}
            </p>
          ))}
        </div>
      )}

      {(error || artifact.status === "error") && (
        <p className="border border-danger/35 bg-danger/5 px-2 py-1.5 text-[8px] leading-relaxed text-danger">
          {error || "Provider returned an error without retained detail."}
        </p>
      )}
    </article>
  );
}

function GenerationFailureBanner({ failure }: { failure: GenerationFailureEvidence }) {
  return (
    <div
      data-testid="generation-failure-evidence"
      data-status={failure.status}
      data-failed-stage={failure.stage}
      data-failed-progress={failure.progress}
      data-committee-retained={String(failure.committee.retained)}
      data-provider-count={failure.committee.providerCount}
      data-artifact-count={failure.committee.artifactCount}
      data-image-artifact-count={failure.committee.imageArtifactCount}
      className="space-y-2 border border-danger/55 bg-danger/[0.055] p-2.5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="font-mono text-[8px] tracking-[0.15em] text-danger uppercase">
            Pipeline stopped after partial evidence
          </p>
          <p className="mt-1 text-[9px] leading-relaxed break-words text-fg-muted">
            {boundedEvidenceText(failure.message, WORLDCLAW_GENERATION_FAILURE_MESSAGE_MAX_CHARS)}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-1 border-t border-danger/20 pt-2">
        <ContractMetric label="last stage" value={failure.stage.replaceAll("_", " ")} />
        <ContractMetric label="progress" value={`${Math.round(failure.progress * 100)}%`} />
        <ContractMetric label="providers" value={String(failure.committee.providerCount)} />
        <ContractMetric label="artifacts" value={String(failure.committee.artifactCount)} />
        <ContractMetric label="images" value={String(failure.committee.imageArtifactCount)} />
      </div>
      <p className="border-l border-warn/60 pl-2 text-[8px] leading-relaxed text-warn">
        Retained candidates are the last bounded browser snapshot before failure. No missing final
        selection or later-stage output is inferred.
      </p>
    </div>
  );
}

function ModelCommitteeEvidence({
  ensemble,
  failure,
}: {
  ensemble?: EnsembleEvidence;
  failure?: GenerationFailureEvidence | null;
}) {
  const [artifactPage, setArtifactPage] = useState(0);
  const [artifactStage, setArtifactStage] = useState<EnsembleStage | "all">("all");

  if (!ensemble) {
    return (
      <div
        data-testid="model-committee"
        data-status={failure ? "failed-no-committee" : "not-retained"}
        className="space-y-2"
      >
        {failure && <GenerationFailureBanner failure={failure} />}
        <MissingEvidence>
          {failure
            ? "Generation stopped before any bounded committee provider or artifact rows reached the browser. No candidates are inferred."
            : "This run predates the retained multi-model ledger or used a single-provider path. No committee candidates, rejections, or unavailable-provider states are inferred."}
        </MissingEvidence>
      </div>
    );
  }

  const providerEntries = (Array.isArray(ensemble.providers) ? ensemble.providers : []).slice(
    0,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.providers,
  );
  const artifacts = (Array.isArray(ensemble.artifacts) ? ensemble.artifacts : []).slice(
    0,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.artifacts,
  );
  const maximumIterations = boundedInteger(
    ensemble.maxIterations,
    1,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.iterations,
  );
  const completedIterations = boundedInteger(ensemble.completedIterations, 0, maximumIterations);
  const indexedArtifacts = artifacts.map((artifact, index) => ({
    artifact,
    index,
    iteration: boundedInteger(artifact.iteration, 1, maximumIterations),
  }));
  const imagePermissions = new globalThis.Map<number, { permitted: boolean; reason?: string }>();
  const structuredOutputPermissions = new globalThis.Map<
    number,
    { permitted: boolean; reason?: string }
  >();
  let retainedImageCount = 0;
  let retainedImageCharacters = 0;
  let retainedStructuredOutputCount = 0;
  let retainedStructuredOutputCharacters = 0;
  for (const { artifact, index } of indexedArtifacts) {
    const image = typeof artifact.imageDataUrl === "string" ? artifact.imageDataUrl : "";
    if (!image) {
      imagePermissions.set(index, { permitted: true });
    } else if (image.length > WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageDataUrlCharacters) {
      imagePermissions.set(index, { permitted: true });
    } else if (retainedImageCount >= WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageArtifacts) {
      imagePermissions.set(index, {
        permitted: false,
        reason: `Image output exceeded the ${WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageArtifacts}-artifact display bound.`,
      });
    } else if (
      retainedImageCharacters + image.length >
      WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.imageDataUrlCharactersTotal
    ) {
      imagePermissions.set(index, {
        permitted: false,
        reason: "Image output exceeded the aggregate retained-image character bound.",
      });
    } else {
      retainedImageCount++;
      retainedImageCharacters += image.length;
      imagePermissions.set(index, { permitted: true });
    }

    const structuredOutput = inspectStructuredOutput(artifact.structuredOutput);
    if (!structuredOutput || structuredOutput.valid === false) {
      structuredOutputPermissions.set(index, { permitted: true });
      continue;
    }
    if (
      retainedStructuredOutputCount >= WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputArtifacts
    ) {
      structuredOutputPermissions.set(index, {
        permitted: false,
        reason: `Structured output exceeded the ${WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputArtifacts}-artifact display bound.`,
      });
      continue;
    }
    if (
      retainedStructuredOutputCharacters + structuredOutput.normalized.length >
      WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.structuredOutputCharactersTotal
    ) {
      structuredOutputPermissions.set(index, {
        permitted: false,
        reason: "Structured output exceeded the aggregate retained-output character bound.",
      });
      continue;
    }
    retainedStructuredOutputCount += 1;
    retainedStructuredOutputCharacters += structuredOutput.normalized.length;
    structuredOutputPermissions.set(index, { permitted: true });
  }
  const selectedCount = artifacts.filter((artifact) => artifact.status === "selected").length;
  const rejectedCount = artifacts.filter((artifact) => artifact.status === "rejected").length;
  const errorCount = artifacts.filter((artifact) => artifact.status === "error").length;
  const knownArtifactIds = new Set(
    artifacts.map((artifact) =>
      boundedEvidenceText(artifact.id, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters),
    ),
  );
  const omittedProviderCount = Math.max(
    0,
    (Array.isArray(ensemble.providers) ? ensemble.providers.length : 0) - providerEntries.length,
  );
  const omittedArtifactCount = Math.max(
    0,
    (Array.isArray(ensemble.artifacts) ? ensemble.artifacts.length : 0) - artifacts.length,
  );
  const selectionScore = normalizedScore(ensemble.selection?.consensusScore);
  const chosenLayoutArtifactId = boundedEvidenceText(
    ensemble.selection?.chosenLayoutArtifactId,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters,
  );
  const chosenMultiviewArtifactId = boundedEvidenceText(
    ensemble.selection?.chosenMultiviewArtifactId,
    WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters,
  );
  const hasRetainedCommittee = providerEntries.length > 0 || artifacts.length > 0;
  const filteredArtifacts = indexedArtifacts.filter(
    (entry) => artifactStage === "all" || entry.artifact.stage === artifactStage,
  );
  const safeArtifactPage = Math.min(
    Math.max(0, artifactPage),
    Math.max(0, filteredArtifacts.length - 1),
  );
  const visibleArtifactIndex = filteredArtifacts[safeArtifactPage]?.index;

  return (
    <div
      data-testid="model-committee"
      data-status={
        failure ? (hasRetainedCommittee ? "failed-retained" : "failed-no-committee") : "retained"
      }
      data-completed-iterations={completedIterations}
      data-max-iterations={maximumIterations}
      data-artifact-count={artifacts.length}
      className="space-y-3"
    >
      {failure && <GenerationFailureBanner failure={failure} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-1.5 border border-border bg-bg/55 p-2.5">
        <ContractMetric label="iterations" value={`${completedIterations}/${maximumIterations}`} />
        <ContractMetric label="artifacts" value={String(artifacts.length)} />
        <ContractMetric label="selected" value={String(selectedCount)} />
        <ContractMetric label="alternates" value={String(rejectedCount)} />
        <ContractMetric label="provider errors" value={String(errorCount)} />
      </div>

      <div className="space-y-1.5">
        <p className="font-mono text-[8px] tracking-[0.15em] text-fg-subtle uppercase">
          Provider readiness / exact models
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-1.5">
          {COMMITTEE_PROVIDERS.map((provider) => (
            <CommitteeProviderStatus
              key={provider}
              provider={provider}
              status={providerEntries.find((entry) => entry.provider === provider)}
            />
          ))}
        </div>
      </div>

      {omittedProviderCount > 0 && (
        <p className="border-l border-warn/60 pl-2 text-[8px] text-warn">
          {omittedProviderCount} provider row(s) exceeded the documented evidence bound and were not
          rendered.
        </p>
      )}

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-mono text-[8px] tracking-[0.15em] text-fg-subtle uppercase">
              Model outputs
            </p>
            <p className="mt-0.5 text-[8px] text-fg-muted">
              One artifact at a time · every retained row remains auditable
            </p>
          </div>
          <span className="font-mono text-[9px] tabular-nums text-fg-muted">
            {filteredArtifacts.length === 0
              ? "0 / 0"
              : `${safeArtifactPage + 1} / ${filteredArtifacts.length}`}
          </span>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1" aria-label="Filter model outputs by stage">
          {([{ id: "all", label: "All" }, ...COMMITTEE_STAGES] as const).map((entry) => {
            const count =
              entry.id === "all"
                ? indexedArtifacts.length
                : indexedArtifacts.filter((item) => item.artifact.stage === entry.id).length;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  setArtifactStage(entry.id);
                  setArtifactPage(0);
                }}
                className={cn(
                  "shrink-0 border px-2 py-1.5 font-mono text-[8px] tracking-[0.08em] uppercase",
                  artifactStage === entry.id
                    ? "border-info/60 bg-info/10 text-info"
                    : "border-border text-fg-subtle hover:text-fg",
                )}
              >
                {entry.label} {count}
              </button>
            );
          })}
        </div>

        {filteredArtifacts.length === 0 ? (
          <MissingEvidence>No retained model output matches this stage.</MissingEvidence>
        ) : (
          <div className="border border-border bg-[linear-gradient(135deg,rgba(255,255,255,.025),transparent_55%)] p-2.5">
            {indexedArtifacts.map(({ artifact, index, iteration }) => (
              <div
                key={`${artifact.id}-${index}`}
                className={visibleArtifactIndex === index ? "space-y-2" : "hidden"}
                data-committee-iteration={iteration}
                data-committee-stage={artifact.stage}
              >
                <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
                  <p className="font-mono text-[8px] text-fg-muted uppercase">
                    Iteration {iteration} · {artifact.stage.replaceAll("_", " ")}
                  </p>
                  <p className="font-mono text-[8px] text-fg-subtle">{artifact.provider}</p>
                </div>
                <ModelArtifactCard
                  artifact={artifact}
                  index={index}
                  imagePermitted={imagePermissions.get(index)?.permitted ?? true}
                  imageOmissionReason={imagePermissions.get(index)?.reason}
                  structuredOutputPermitted={
                    structuredOutputPermissions.get(index)?.permitted ?? true
                  }
                  structuredOutputOmissionReason={structuredOutputPermissions.get(index)?.reason}
                />
              </div>
            ))}
          </div>
        )}

        {filteredArtifacts.length > 1 && (
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <button
              type="button"
              onClick={() => setArtifactPage((page) => Math.max(0, page - 1))}
              disabled={safeArtifactPage === 0}
              className="flex h-10 items-center gap-1 border border-border px-2 text-[9px] text-fg-muted disabled:opacity-35"
            >
              <ChevronLeft className="h-3 w-3" /> Previous
            </button>
            <div className="h-px bg-border">
              <div
                className="h-px bg-info"
                style={{ width: `${((safeArtifactPage + 1) / filteredArtifacts.length) * 100}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() =>
                setArtifactPage((page) => Math.min(filteredArtifacts.length - 1, page + 1))
              }
              disabled={safeArtifactPage >= filteredArtifacts.length - 1}
              className="flex h-10 items-center gap-1 border border-border px-2 text-[9px] text-fg-muted disabled:opacity-35"
            >
              Next <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {omittedArtifactCount > 0 && (
        <p className="border-l border-warn/60 pl-2 text-[8px] text-warn">
          {omittedArtifactCount} artifact(s) exceeded the documented evidence bound and were not
          rendered.
        </p>
      )}

      <div
        className="border border-border bg-bg/60 p-2.5"
        data-testid="model-committee-selection"
        data-chosen-layout={chosenLayoutArtifactId || undefined}
        data-chosen-multiview={chosenMultiviewArtifactId || undefined}
        data-consensus-score={selectionScore}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[8px] tracking-[0.15em] text-fg uppercase">
              Final synthesis rationale
            </p>
            <p className="mt-0.5 text-[8px] text-fg-subtle">
              Explicit committee selection record; no winner is inferred from status color.
            </p>
          </div>
          <span className="font-mono text-lg text-fg tabular-nums">
            {selectionScore === undefined ? "—" : `${Math.round(selectionScore * 100)}%`}
          </span>
        </div>

        {ensemble.selection ? (
          <>
            <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-1.5">
              {(
                [
                  ["layout", ensemble.selection.chosenLayoutArtifactId],
                  ["multiview", ensemble.selection.chosenMultiviewArtifactId],
                ] as const
              ).map(([label, artifactId]) => {
                const boundedId = boundedEvidenceText(
                  artifactId,
                  WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.identifierCharacters,
                );
                const retained = boundedId ? knownArtifactIds.has(boundedId) : false;
                return (
                  <div key={label} className="border border-border px-2 py-1.5">
                    <p className="font-mono text-[7px] tracking-[0.12em] text-fg-subtle uppercase">
                      chosen {label}
                    </p>
                    {boundedId ? (
                      <a
                        href={`#model-artifact-${qaArtifactToken(boundedId, 0)}`}
                        className={cn(
                          "mt-1 block truncate font-mono text-[8px]",
                          retained ? "text-success" : "text-warn",
                        )}
                      >
                        {boundedId} · {retained ? "retained" : "missing"}
                      </a>
                    ) : (
                      <p className="mt-1 font-mono text-[8px] text-fg-subtle">not selected</p>
                    )}
                  </div>
                );
              })}
            </div>
            {Array.isArray(ensemble.selection.rationale) &&
            ensemble.selection.rationale.length > 0 ? (
              <ol className="mt-2 space-y-1 border-t border-border pt-2">
                {ensemble.selection.rationale
                  .slice(0, WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.rationaleItems)
                  .filter((value): value is string => typeof value === "string")
                  .map((reason, index) => (
                    <li
                      key={index}
                      data-committee-rationale={index}
                      className="grid grid-cols-[1rem_1fr] gap-1.5 text-[8px] leading-relaxed text-fg-muted"
                    >
                      <span className="font-mono text-fg-subtle">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>
                        {boundedEvidenceText(
                          reason,
                          WORLDCLAW_ENSEMBLE_EVIDENCE_LIMITS.textCharacters,
                        )}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="mt-2 border-l border-warn/60 pl-2 text-[8px] text-warn">
                A selection record exists without retained synthesis rationale.
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 border-l border-warn/60 pl-2 text-[8px] text-warn">
            No final committee selection was retained; candidate and failure rows remain visible
            above.
          </p>
        )}
      </div>
    </div>
  );
}

function MissingEvidence({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-border bg-bg/40 px-3 py-3 text-[10px] leading-relaxed text-fg-subtle">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] tracking-[0.12em] uppercase">
        <CircleDashed className="h-3 w-3" />
        No retained artifact
      </div>
      {children}
    </div>
  );
}

function ReferenceImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return <MissingEvidence>The retained image reference could not be decoded.</MissingEvidence>;
  }

  return (
    <div className="relative overflow-hidden border border-border bg-bg">
      <span className="pointer-events-none absolute top-2 left-2 z-10 border border-white/15 bg-black/65 px-1.5 py-1 font-mono text-[8px] tracking-[0.14em] text-white/80 uppercase backdrop-blur-sm">
        Map-conditioned concept views · full sheet
      </span>
      <InAppImagePreview
        src={src}
        alt={alt}
        label="Selected pre-build appearance concept board"
        className="min-h-48 border-0 bg-black/30"
        imageClassName="block h-auto min-h-48"
        loading="eager"
        onError={() => setFailed(true)}
      />
      <span className="pointer-events-none absolute top-0 left-0 h-3 w-3 border-t border-l border-white/45" />
      <span className="pointer-events-none absolute top-0 right-0 h-3 w-3 border-t border-r border-white/45" />
      <span className="pointer-events-none absolute bottom-0 left-0 h-3 w-3 border-b border-l border-white/45" />
      <span className="pointer-events-none absolute right-0 bottom-0 h-3 w-3 border-r border-b border-white/45" />
    </div>
  );
}

function ContractMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-border pl-2">
      <p className="font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">{label}</p>
      <p className="mt-0.5 font-mono text-xs text-fg">{value}</p>
    </div>
  );
}

function CameraCard({ camera }: { camera: VisualCameraReference }) {
  return (
    <div className="border border-border bg-bg/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] tracking-[0.14em] text-fg uppercase">
          {camera.view}
        </span>
        <Camera className="h-3 w-3 text-fg-subtle" />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[9px]">
        <span className="text-fg-muted">AZ {camera.azimuthDegrees.toFixed(0)}°</span>
        <span className="text-fg-muted">EL {camera.elevationDegrees.toFixed(0)}°</span>
        <span className="text-right text-fg-muted">D {camera.distanceScale.toFixed(2)}×</span>
      </div>
      <p className="mt-1 font-mono text-[8px] text-fg-subtle">
        {camera.projection}
        {camera.projection === "perspective"
          ? ` · ${camera.fovDegrees?.toFixed(0) ?? "—"}° FOV`
          : ` · ${camera.orthographicScale?.toFixed(2) ?? "—"}× span`}
      </p>
      <p className="mt-1 font-mono text-[8px] text-fg-subtle">
        target {Math.round(camera.target[0] * 100)}:{Math.round(camera.target[1] * 100)}
      </p>
      <p className="mt-1.5 text-[9px] leading-relaxed text-fg-muted">{camera.description}</p>
    </div>
  );
}

function VisualJudgementEvidence({
  judgement,
}: {
  judgement: NonNullable<VisualContract["judgement"]>;
}) {
  const score = Math.min(1, Math.max(0, judgement.agreementScore));
  const scorePercent = Math.round(score * 100);
  const issueCount = judgement.missingSubjects.length + judgement.conflicts.length;

  return (
    <div
      className={cn(
        "relative overflow-hidden border p-3",
        judgement.passed
          ? "border-success/50 bg-[linear-gradient(135deg,rgba(61,154,106,.16),transparent_65%)]"
          : "border-danger/60 bg-[linear-gradient(135deg,rgba(196,84,74,.18),transparent_65%)]",
      )}
    >
      <div
        className={cn(
          "absolute top-0 right-0 h-12 w-12 translate-x-6 -translate-y-6 rotate-45 border",
          judgement.passed ? "border-success/30" : "border-danger/35",
        )}
      />
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center border",
              judgement.passed
                ? "border-success/60 bg-success/10 text-success"
                : "border-danger/70 bg-danger/10 text-danger",
            )}
          >
            {judgement.passed ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[8px] tracking-[0.18em] text-fg-subtle uppercase">
              Map ↔ camera-conditioned concept gate
            </p>
            <p
              className={cn(
                "mt-1 text-sm font-semibold tracking-[0.08em] uppercase",
                judgement.passed ? "text-success" : "text-danger",
              )}
            >
              {judgement.passed ? "Agreement passed" : "Review warnings"}
            </p>
            <p className="mt-1 text-[9px] leading-relaxed text-fg-muted">
              Pass requires ≥72% agreement with no missing subjects or recorded conflicts.
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              "font-mono text-2xl leading-none font-semibold tabular-nums",
              judgement.passed ? "text-success" : "text-danger",
            )}
          >
            {scorePercent}
          </p>
          <p className="mt-1 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
            agreement
          </p>
        </div>
      </div>

      <div className="mt-3 h-1 overflow-hidden bg-bg/80">
        <div
          className={cn("h-full", judgement.passed ? "bg-success" : "bg-danger")}
          style={{ width: `${scorePercent}%` }}
        />
      </div>

      {issueCount === 0 ? (
        <p className="mt-3 border-t border-success/20 pt-2 text-[9px] text-success">
          No missing subjects or visual conflicts were reported.
        </p>
      ) : (
        <div className="mt-3 grid gap-2 border-t border-border/70 pt-2 sm:grid-cols-2">
          <div>
            <p className="flex items-center gap-1 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
              <AlertTriangle className="h-2.5 w-2.5" /> Missing subjects ·{" "}
              {judgement.missingSubjects.length}
            </p>
            {judgement.missingSubjects.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {judgement.missingSubjects.map((subject) => (
                  <li
                    key={subject}
                    className="border-l border-warn/60 pl-2 text-[9px] leading-relaxed text-fg-muted"
                  >
                    {subject}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[9px] text-fg-subtle">None reported</p>
            )}
          </div>
          <div>
            <p className="flex items-center gap-1 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
              <X className="h-2.5 w-2.5" /> Conflicts · {judgement.conflicts.length}
            </p>
            {judgement.conflicts.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {judgement.conflicts.map((conflict) => (
                  <li
                    key={conflict}
                    className="border-l border-danger/60 pl-2 text-[9px] leading-relaxed text-fg-muted"
                  >
                    {conflict}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[9px] text-fg-subtle">None reported</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VisualContractEvidence({ contract }: { contract: VisualContract }) {
  return (
    <div className="space-y-3">
      {contract.judgement ? (
        <VisualJudgementEvidence judgement={contract.judgement} />
      ) : (
        <div className="border border-dashed border-border bg-bg/40 px-3 py-2.5 text-[9px] leading-relaxed text-fg-subtle">
          This saved world predates explicit visual judgement; no pass/fail result is claimed.
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <ContractMetric label="relief" value={`${contract.terrainReliefScale.toFixed(2)}×`} />
        <ContractMetric
          label="micro detail"
          value={`${contract.terrainMicroDetailScale.toFixed(2)}×`}
        />
        <ContractMetric
          label="vegetation"
          value={`${contract.vegetationDensityScale.toFixed(2)}×`}
        />
        <ContractMetric label="objects" value={`${contract.objectDensityScale.toFixed(2)}×`} />
        <ContractMetric label="water datum" value={`${contract.waterLevelMeters.toFixed(2)} m`} />
        <ContractMetric label="analysis" value={contract.source} />
      </div>

      {contract.palette.length > 0 && (
        <div>
          <p className="mb-1.5 font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
            Palette evidence
          </p>
          <div className="flex min-h-7 overflow-hidden border border-border">
            {contract.palette.map((color, index) => (
              <span
                key={`${color}-${index}`}
                className="min-w-6 flex-1"
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </div>
        </div>
      )}

      {contract.dominantSilhouettes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {contract.dominantSilhouettes.map((silhouette) => (
            <span
              key={silhouette}
              className="border border-border bg-surface-elevated px-1.5 py-1 text-[9px] text-fg-muted"
            >
              {silhouette}
            </span>
          ))}
        </div>
      )}

      {contract.cameras.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
            Reference cameras
          </p>
          {contract.cameras.map((camera, index) => (
            <CameraCard key={`${camera.view}-${index}`} camera={camera} />
          ))}
        </div>
      )}

      {contract.compositionNotes.length > 0 && (
        <div className="border-l border-info/60 pl-2.5">
          {contract.compositionNotes.map((note) => (
            <p key={note} className="text-[9px] leading-relaxed text-fg-muted">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function FinalRenderEvidence({ validation }: { validation: FinalRenderValidation | null }) {
  if (!validation || validation.status === "running") {
    return (
      <div
        data-testid="final-render-validation"
        data-status={validation?.status ?? "pending"}
        className="flex items-center gap-2 border border-border bg-bg/50 p-3 text-[9px] text-fg-muted"
      >
        <CircleDashed className={cn("h-3 w-3", validation && "animate-spin")} />
        {validation
          ? "Capturing registered final views and running the configured final judge…"
          : "Final registered renderer comparison has not started."}
      </div>
    );
  }

  const judgement = validation.judgement;
  const deterministic = judgement?.deterministicChecks;
  return (
    <div
      data-testid="final-render-validation"
      data-status={validation.status}
      data-report={
        judgement
          ? JSON.stringify({
              status: validation.status,
              judgement,
              comparisonArtifacts: validation.comparisonArtifacts
                ? Object.keys(validation.comparisonArtifacts)
                : [],
            })
          : JSON.stringify({
              status: validation.status,
              error: validation.error ?? null,
              judgement: null,
              comparisonArtifacts: validation.comparisonArtifacts
                ? Object.keys(validation.comparisonArtifacts)
                : [],
            })
      }
      className="space-y-3"
    >
      {validation.captures && (
        <div className="grid grid-cols-2 gap-1.5">
          {(["map", "isometric", "oblique", "walk"] as const).map((view) => {
            const src = validation.captures?.[view];
            return src ? (
              <InAppImagePreview
                key={view}
                src={src}
                alt={`Final registered ${view} renderer capture`}
                label={`Final renderer · ${view}`}
                className="bg-bg"
                imageClassName={cn(
                  "object-cover",
                  view === "map" ? "aspect-square" : "aspect-video",
                )}
                loading="eager"
              />
            ) : null;
          })}
        </div>
      )}

      {validation.comparisonArtifacts && (
        <div className="space-y-1.5" data-testid="deterministic-comparison-artifacts">
          <p className="font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
            Deterministic map registration
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                ["canonicalLandWaterMask", "canonical semantic map"],
                ["renderedLandWaterMask", "rendered terrain mask"],
                ["shorelineOverlay", "shoreline overlay"],
                ["landWaterDifference", "difference map"],
              ] as const
            ).map(([key, label]) => (
              <InAppImagePreview
                key={key}
                src={validation.comparisonArtifacts?.[key] ?? ""}
                alt={label}
                label={label}
                className="bg-bg"
                imageClassName="aspect-square object-cover"
                imageRendering="pixelated"
                testId={`comparison-${key}`}
              />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1 border border-border bg-bg/50 p-2 font-mono text-[7px] text-fg-subtle">
            <span>green = agreement</span>
            <span>red = false water</span>
            <span>amber = missing water</span>
          </div>
        </div>
      )}

      {judgement ? (
        <div
          className={cn(
            "border p-3",
            judgement.passed ? "border-success/50 bg-success/5" : "border-danger/60 bg-danger/5",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[8px] tracking-[0.16em] text-fg-subtle uppercase">
                Canonical map + concepts ↔ final WebGL
              </p>
              <p
                className={cn(
                  "mt-1 text-sm font-semibold",
                  judgement.passed ? "text-success" : "text-danger",
                )}
              >
                {judgement.passed ? "Final build passed" : "Built with review warnings"}
              </p>
              <p className="mt-1 text-[9px] text-fg-muted">
                Hard gate: ≥78% visual agreement, ≥95% map IoU and shoreline F1, exact visible
                heroes, construction/material fidelity, valid cameras and intact water.
              </p>
            </div>
            <span
              className={cn(
                "font-mono text-2xl font-semibold",
                judgement.passed ? "text-success" : "text-danger",
              )}
            >
              {Math.round(judgement.agreementScore * 100)}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5">
            {Object.entries(judgement.metrics).map(([label, value]) => (
              <div key={label} className="border-l border-border pl-1.5">
                <p className="font-mono text-[10px] text-fg">{Math.round(value * 100)}</p>
                <p
                  className="truncate font-mono text-[6px] tracking-[0.08em] text-fg-subtle uppercase"
                  title={label}
                >
                  {label.replace(/[A-Z]/g, (letter) => ` ${letter}`)}
                </p>
              </div>
            ))}
          </div>
          {(judgement.missingSubjects.length > 0 || judgement.conflicts.length > 0) && (
            <ul className="mt-3 space-y-1 border-t border-border pt-2">
              {[...judgement.missingSubjects, ...judgement.conflicts].map((issue) => (
                <li
                  key={issue}
                  className="border-l border-danger/60 pl-2 text-[9px] leading-relaxed text-fg-muted"
                >
                  {issue}
                </li>
              ))}
            </ul>
          )}
          {judgement.observations.length > 0 && (
            <p className="mt-2 text-[8px] leading-relaxed text-fg-subtle">
              {judgement.observations.join(" · ")}
            </p>
          )}
          {deterministic && (
            <div className="mt-2 space-y-2 border-t border-border pt-2">
              <div className="grid grid-cols-2 gap-1.5 font-mono text-[7px] text-fg-subtle">
                <span>map north-up {deterministic.mapNorthUp ? "yes" : "no"}</span>
                <span>camera matrices {deterministic.cameraMatricesPassed ? "pass" : "fail"}</span>
                <span>
                  compiled slots {deterministic.compiledSlotsMatched ? "matched" : "missing"}
                </span>
                <span>depth passes {deterministic.depthPassesFinite ? "finite" : "invalid"}</span>
                <span>land/water IoU {(deterministic.landWaterIoU * 100).toFixed(1)}%</span>
                <span>shoreline F1 {(deterministic.shorelineBoundaryF1 * 100).toFixed(1)}%</span>
                <span>
                  shoreline P95 {deterministic.shorelineP95DistancePixels.toFixed(2)}px @{" "}
                  {deterministic.maskSize}px
                </span>
                <span>
                  orientation {deterministic.orientationSuspicious ? "suspect" : "identity"}
                </span>
                <span>
                  false water {(deterministic.falseWaterOnLandRatio * 100).toFixed(2)}% interior
                </span>
                <span>
                  missing water {(deterministic.missingCanonicalWaterRatio * 100).toFixed(2)}%
                  interior
                </span>
                <span>
                  raw water leak {(deterministic.rawFalseWaterOnLandRatio * 100).toFixed(2)}%
                </span>
                <span>
                  boundary exclusion {deterministic.leakageBoundaryTolerancePixels.toFixed(1)}px
                </span>
                <span>
                  water components {deterministic.renderedWaterComponents}/
                  {deterministic.referenceWaterComponents}
                </span>
                <span>material F1 {(deterministic.materialFamilyMacroF1 * 100).toFixed(1)}%</span>
                <span>
                  object coverage {Math.round(deterministic.objectSatisfactionRatio * 100)}%
                </span>
                <span>
                  heroes{" "}
                  {Object.values(deterministic.heroRequiredByKind).reduce(
                    (sum, count) => sum + count,
                    0,
                  )}{" "}
                  required
                </span>
                <span>water max {deterministic.waterMaxMeters?.toFixed(2) ?? "n/a"}m</span>
                <span>land min {deterministic.landMinMeters?.toFixed(2) ?? "n/a"}m</span>
              </div>
              {deterministic.failures.length > 0 && (
                <ul className="space-y-1 border-t border-danger/30 pt-2">
                  {deterministic.failures.map((failure) => (
                    <li
                      key={failure}
                      className="border-l border-danger/60 pl-2 font-mono text-[7px] leading-relaxed text-danger"
                    >
                      {failure}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : (
        <MissingEvidence>
          {validation.error ?? "No final renderer judgement was returned."}
        </MissingEvidence>
      )}
    </div>
  );
}

function BudgetBar({
  label,
  used,
  limit,
  utilization,
}: {
  label: string;
  used?: number;
  limit?: number;
  utilization?: number;
}) {
  const ratio = Math.min(1, Math.max(0, utilization ?? (used && limit ? used / limit : 0)));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 font-mono text-[8px] tracking-[0.1em] uppercase">
        <span className="text-fg-subtle">{label}</span>
        <span className="text-fg-muted">{Math.round(ratio * 100)}% budget</span>
      </div>
      <div className="h-1 overflow-hidden bg-surface-subtle">
        <div className="h-full bg-success/80" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

interface RequirementResolution {
  key: string;
  region: string;
  category: string;
  requested: number;
  placed: number;
}

function ObjectResolutionEvidence({ world }: { world: WorldScene }) {
  const resolution = useMemo(() => {
    const recorded = world.inferenceMeta?.objectCoverage;
    if (recorded) {
      const rows = Object.entries(recorded.requestedByKind)
        .filter(([, requested]) => requested > 0)
        .map(([category, requested]) => ({
          key: `recorded:${category}`,
          region: "all requested regions",
          category,
          requested,
          placed: recorded.placedByKind[category] ?? 0,
        }));
      const requested = rows.reduce((sum, row) => sum + row.requested, 0);
      const matched = rows.reduce((sum, row) => sum + Math.min(row.requested, row.placed), 0);
      return {
        rows,
        requested,
        matched,
        satisfaction: Math.min(1, Math.max(0, recorded.satisfactionRatio)),
        source: "pipeline record" as const,
        missingKinds: recorded.missingKinds,
        missingHeroKinds: recorded.missingHeroKinds,
      };
    }

    const rows: RequirementResolution[] = [];
    for (const region of world.plan.regions) {
      const requirements = world.plan.objectRequirements[region.name] ?? [];
      for (const requirement of requirements) {
        if (requirement.count <= 0) continue;
        const placed = world.objects.filter(
          (object) => object.regionId === region.id && object.kind === requirement.category,
        ).length;
        rows.push({
          key: `${region.id}:${requirement.category}`,
          region: region.name,
          category: requirement.category,
          requested: requirement.count,
          placed,
        });
      }
    }
    const requested = rows.reduce((sum, row) => sum + row.requested, 0);
    const matched = rows.reduce((sum, row) => sum + Math.min(row.requested, row.placed), 0);
    return {
      rows,
      requested,
      matched,
      satisfaction: requested > 0 ? matched / requested : 0,
      source: "derived regional match" as const,
      missingKinds: rows.filter((row) => row.placed < row.requested).map((row) => row.category),
      missingHeroKinds: [],
    };
  }, [world]);

  if (resolution.rows.length === 0) {
    return (
      <MissingEvidence>
        The final plan contains no countable per-region object requirements.
      </MissingEvidence>
    );
  }

  const coverage = resolution.satisfaction;
  const missingHeroKindSet = new Set<string>(resolution.missingHeroKinds);
  const missingNonHeroKinds = resolution.missingKinds.filter(
    (kind) => !missingHeroKindSet.has(kind),
  );
  return (
    <div className="space-y-2.5 border border-border bg-bg/45 p-2.5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
            Requested → placed · {resolution.source}
          </p>
          <p className="mt-1 font-mono text-sm text-fg">
            {resolution.requested} → {resolution.matched}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm text-fg-muted">{Math.round(coverage * 100)}%</p>
          <p className="text-[8px] text-fg-subtle uppercase">{world.objects.length} total placed</p>
        </div>
      </div>
      {resolution.missingHeroKinds.length > 0 && (
        <div className="border border-danger/50 bg-danger/10 px-2.5 py-2">
          <p className="flex items-center gap-1.5 font-mono text-[8px] tracking-[0.12em] text-danger uppercase">
            <AlertTriangle className="h-3 w-3" /> Missing hero kinds
          </p>
          <p className="mt-1.5 text-[9px] leading-relaxed text-fg-muted">
            {resolution.missingHeroKinds.join(" · ")}
          </p>
        </div>
      )}
      {missingNonHeroKinds.length > 0 && (
        <div className="border-l border-warn/60 pl-2.5 text-[9px] leading-relaxed text-fg-muted">
          Missing requested kinds: {missingNonHeroKinds.join(" · ")}
        </div>
      )}
      <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
        {resolution.rows.map((row) => {
          const ratio = Math.min(1, row.placed / row.requested);
          return (
            <div key={row.key} className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 py-1">
              <p
                className="min-w-0 truncate text-[9px] text-fg-muted"
                title={`${row.region} · ${row.category}`}
              >
                <span className="text-fg">{row.category}</span> · {row.region}
              </p>
              <p
                className={cn(
                  "font-mono text-[9px]",
                  row.placed >= row.requested ? "text-success" : "text-warn",
                )}
              >
                {row.placed}/{row.requested}
              </p>
              <div className="col-span-2 h-px bg-surface-subtle">
                <div
                  className={cn("h-px", row.placed >= row.requested ? "bg-success" : "bg-warn")}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[8px] leading-relaxed text-fg-subtle">
        {resolution.source === "pipeline record"
          ? "Counts are the final pipeline coverage record; terrain scatter and unrelated extras remain in the total placed count."
          : "Exact kind matches inside their requested named region; terrain scatter and unrelated extras remain in the total placed count."}
      </p>
    </div>
  );
}

function AssetEvidence({
  state,
  blenderCount,
  fallbackCount,
  compiledPrototypes,
  hasWorld,
}: {
  state: AssetEvidenceState;
  blenderCount: number;
  fallbackCount: number;
  compiledPrototypes: number;
  hasWorld: boolean;
}) {
  const [assetPage, setAssetPage] = useState(0);
  const total = blenderCount + fallbackCount;
  const coverage = total > 0 ? blenderCount / total : 0;
  const report = state.report;
  const counts = report?.validation?.counts;
  const budget = report?.validation?.budget;
  const validationPassed = report?.validation?.status === "passed";
  const authoredVariantCount = state.manifest
    ? Object.values(state.manifest.prototypes).reduce(
        (sum, definition) => sum + Math.max(1, definition?.variants?.length ?? 0),
        0,
      )
    : 0;
  const prototypeCount = hasWorld
    ? compiledPrototypes
    : state.manifest
      ? Object.keys(state.manifest.prototypes).length
      : undefined;
  const assetEntries = state.manifest
    ? Object.entries(state.manifest.prototypes).flatMap(([prototype, definition]) => {
        if (!definition) return [];
        const variants =
          definition.variants && definition.variants.length > 0 ? definition.variants : [undefined];
        return variants.flatMap((variant, index) => {
          const turnaroundUri =
            variant?.evidence?.turnaroundUri ??
            (index === 0 ? definition.evidence?.turnaroundUri : undefined);
          if (!turnaroundUri) return [];
          const recipe = variant?.constructionRecipe;
          const construction = [
            recipe?.wallAssembly,
            ...(recipe?.openingAssemblies ?? []),
            recipe?.doorAssembly,
            recipe?.roofAssembly,
            recipe?.gateAssembly,
            ...(recipe?.systems ?? []),
          ].filter((entry): entry is string => Boolean(entry));
          return [
            {
              prototype,
              label: variant?.id ?? prototype,
              turnaroundUri,
              construction,
              appearance: variant?.appearanceTerms ?? [],
              guarantees: recipe?.geometryGuarantees?.length ?? 0,
            },
          ];
        });
      })
    : [];
  const safeAssetPage = Math.min(Math.max(0, assetPage), Math.max(0, assetEntries.length - 1));
  const visibleAsset = assetEntries[safeAssetPage];

  return (
    <div className="space-y-3">
      {hasWorld && (
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3 border border-border bg-bg/70 p-2.5">
          <div>
            <p className="font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
              Runtime coverage
            </p>
            <p className="mt-1 text-xl font-semibold tracking-tight text-fg">
              {Math.round(coverage * 100)}%
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-base text-fg">{blenderCount}</p>
            <p className="text-[8px] text-fg-subtle uppercase">Blender</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-base text-fg-muted">{fallbackCount}</p>
            <p className="text-[8px] text-fg-subtle uppercase">Fallback</p>
          </div>
        </div>
      )}

      {state.loading && (
        <div className="flex items-center gap-2 border border-border bg-bg/40 px-2.5 py-2 text-[9px] text-fg-subtle">
          <CircleDashed className="h-3 w-3 animate-spin" />
          Reading published manifest and validation report…
        </div>
      )}

      {!state.loading && report && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <ContractMetric label="nodes" value={formatInteger(counts?.nodeCount)} />
            <ContractMetric label="meshes" value={formatInteger(counts?.meshCount)} />
            <ContractMetric label="materials" value={formatInteger(counts?.materialCount)} />
            <ContractMetric label="vertices" value={formatInteger(counts?.vertexCount)} />
            <ContractMetric label="triangles" value={formatInteger(counts?.triangleCount)} />
            <ContractMetric
              label={hasWorld ? "used prototypes" : "library prototypes"}
              value={formatInteger(prototypeCount)}
            />
          </div>

          <div className="space-y-2 border border-border bg-bg/50 p-2.5">
            <BudgetBar
              label={`${formatBytes(budget?.bytesUsed)} / ${formatBytes(budget?.bytesLimit)}`}
              used={budget?.bytesUsed}
              limit={budget?.bytesLimit}
              utilization={budget?.byteUtilization}
            />
            <BudgetBar
              label={`${formatInteger(budget?.trianglesUsed)} / ${formatInteger(budget?.trianglesLimit)} triangles`}
              used={budget?.trianglesUsed}
              limit={budget?.trianglesLimit}
              utilization={budget?.triangleUtilization}
            />
          </div>

          <div className="space-y-1.5 text-[9px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-fg-subtle">Validation</span>
              <span className={validationPassed ? "text-success" : "text-warn"}>
                {report.validation?.status ?? report.status ?? "unreported"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-fg-subtle">Compiler</span>
              <span className="font-mono text-fg-muted">
                Blender {report.generator?.blenderVersion ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-fg-subtle">Artifact</span>
              <span className="font-mono text-fg-muted">
                {basename(report.artifact?.path)} · {formatBytes(report.artifact?.byteLength)}
              </span>
            </div>
            {report.artifact?.sha256 && (
              <p
                className="truncate border-t border-border pt-1.5 font-mono text-[8px] text-fg-subtle"
                title={report.artifact.sha256}
              >
                sha256 {report.artifact.sha256}
              </p>
            )}
          </div>
        </>
      )}

      {!state.loading && state.manifest && (
        <div className="space-y-3 border-t border-border pt-2.5">
          <div className="grid grid-cols-2 gap-2 text-[9px]">
            <div>
              <p className="text-fg-subtle">Library contract</p>
              <p className="mt-0.5 font-mono text-fg-muted">
                {state.manifest.library.format.toUpperCase()} ·{" "}
                {state.manifest.library.metersPerUnit} m/unit
              </p>
            </div>
            <div>
              <p className="text-fg-subtle">Axis conversion</p>
              <p className="mt-0.5 font-mono text-fg-muted">
                {state.manifest.library.sourceUpAxis}-up → {state.manifest.library.runtimeUpAxis}-up
              </p>
            </div>
            <div>
              <p className="text-fg-subtle">Published aliases</p>
              <p className="mt-0.5 font-mono text-fg-muted">
                {Object.keys(state.manifest.aliases).length} kinds
              </p>
            </div>
            <div>
              <p className="text-fg-subtle">Manifest version</p>
              <p className="mt-0.5 font-mono text-fg-muted">v{state.manifest.version}</p>
            </div>
          </div>

          {state.manifest.evidence && (
            <div className="space-y-2 border border-border bg-bg/45 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
                    Exported-GLB roundtrip evidence
                  </p>
                  <p className="mt-0.5 text-[8px] text-fg-muted">
                    {state.manifest.evidence.projection} ·{" "}
                    {state.manifest.evidence.turnaroundViews.join(" / ")}
                  </p>
                </div>
                <span className="font-mono text-[8px] text-success">
                  {Object.keys(state.manifest.prototypes).length} prototypes ·{" "}
                  {authoredVariantCount} variants
                </span>
              </div>
              <InAppImagePreview
                src={state.manifest.evidence.contactSheetUri}
                alt="All WorldClaw compiled asset prototypes contact sheet"
                label="Saved WorldClaw asset library contact sheet"
                className="bg-black/20"
                imageClassName="h-auto"
              />
              {visibleAsset && (
                <div className="space-y-2 border border-border bg-bg p-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[9px] text-fg uppercase">
                        {visibleAsset.label.replaceAll("_", " ")}
                      </p>
                      <p className="mt-0.5 font-mono text-[7px] text-fg-subtle uppercase">
                        {visibleAsset.prototype} · saved authored variant
                      </p>
                    </div>
                    <span className="font-mono text-[9px] tabular-nums text-fg-muted">
                      {safeAssetPage + 1} / {assetEntries.length}
                    </span>
                  </div>
                  <InAppImagePreview
                    src={visibleAsset.turnaroundUri}
                    alt={`${visibleAsset.label} front, three-quarter, side and rear turnaround`}
                    label={`${visibleAsset.label.replaceAll("_", " ")} · four-view turnaround`}
                    imageClassName="aspect-[16/6.5] object-cover"
                  />
                  <p className="text-[8px] leading-relaxed text-fg-muted">
                    {visibleAsset.construction.length > 0
                      ? visibleAsset.construction.join(" · ")
                      : visibleAsset.appearance.join(" · ") || "Authored prototype"}
                  </p>
                  {visibleAsset.guarantees > 0 && (
                    <p className="font-mono text-[7px] tracking-[0.08em] text-success uppercase">
                      {visibleAsset.guarantees} geometry guarantees
                    </p>
                  )}
                </div>
              )}
              {assetEntries.length > 1 && (
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAssetPage((page) => Math.max(0, page - 1))}
                    disabled={safeAssetPage === 0}
                    className="flex h-10 items-center gap-1 border border-border px-2 text-[9px] text-fg-muted disabled:opacity-35"
                  >
                    <ChevronLeft className="h-3 w-3" /> Previous
                  </button>
                  <select
                    value={safeAssetPage}
                    onChange={(event) => setAssetPage(Number(event.target.value))}
                    className="h-10 min-w-0 border border-border bg-bg px-2 text-[9px] text-fg"
                    aria-label="Choose saved asset variant"
                  >
                    {assetEntries.map((entry, index) => (
                      <option key={`${entry.prototype}:${entry.label}`} value={index}>
                        {entry.label.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setAssetPage((page) => Math.min(assetEntries.length - 1, page + 1))
                    }
                    disabled={safeAssetPage >= assetEntries.length - 1}
                    className="flex h-10 items-center gap-1 border border-border px-2 text-[9px] text-fg-muted disabled:opacity-35"
                  >
                    Next <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!state.loading && state.error && !report && (
        <MissingEvidence>
          {state.error}. Runtime instance provenance remains available above.
        </MissingEvidence>
      )}
    </div>
  );
}

export function GenerationEvidence({
  world,
  logs,
  stage,
  progress,
  running,
}: {
  world: WorldScene | null;
  logs: AgentLogEntry[];
  stage: PipelineStage;
  progress: number;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [evidencePage, setEvidencePage] = useState<"run" | "models" | "world" | "library">("run");
  const [assetEvidence, setAssetEvidence] = useState<AssetEvidenceState>({
    loading: true,
  });
  const renderValidation = useWorldClaw((state) => state.renderValidation);
  const ensembleProgress = useWorldClaw((state) => state.ensembleProgress);
  const generationFailure = useWorldClaw((state) => state.generationFailure);

  const layoutReference =
    world?.plan.layoutImageDataUrl ||
    world?.plan.layoutImageUrl ||
    world?.inferenceMeta?.layoutImageUrl;
  const perspectiveReference =
    world?.plan.perspectiveImageDataUrl || world?.plan.perspectiveImageUrl;
  const contract = world?.plan.visualContract;
  const ensemble = world?.inferenceMeta?.ensemble ?? ensembleProgress ?? undefined;

  const assetSummary = useMemo(() => {
    let blenderCount = 0;
    const prototypes = new Set<string>();
    for (const object of world?.objects ?? []) {
      if (!object.browserAsset) continue;
      blenderCount++;
      prototypes.add(object.browserAsset.prototype);
    }
    return {
      blenderCount,
      fallbackCount: (world?.objects.length ?? 0) - blenderCount,
      compiledPrototypes: prototypes.size,
    };
  }, [world?.objects]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function loadEvidence() {
      const [manifestResult, reportResult] = await Promise.allSettled([
        loadWorldClawAssetManifest(),
        fetch(BUILD_REPORT_URI, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        }).then(async (response) => {
          if (!response.ok) throw new Error(`Build report HTTP ${response.status}`);
          return parseBuildReport(await response.json());
        }),
      ]);
      if (!active) return;

      const manifest =
        manifestResult.status === "fulfilled" ? manifestResult.value.manifest : undefined;
      const report = reportResult.status === "fulfilled" ? reportResult.value : undefined;
      const errors = [
        manifestResult.status === "rejected"
          ? String(manifestResult.reason)
          : manifestResult.value.error,
        reportResult.status === "rejected" ? String(reportResult.reason) : undefined,
      ].filter(Boolean);

      setAssetEvidence({
        loading: false,
        manifest,
        report,
        error: errors.length > 0 ? errors.join(" · ") : undefined,
      });
    }

    void loadEvidence();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const planSource = world?.inferenceMeta?.planSource ?? world?.plan.inferenceSource ?? "template";
  const terrainSource =
    world?.inferenceMeta?.terrainSource ?? world?.terrainSpec.source ?? "procedural";
  const evidenceLayerCount = [
    logs.length > 0,
    Boolean(world),
    Boolean(layoutReference),
    Boolean(perspectiveReference),
    Boolean(contract),
    Boolean(ensemble),
    Boolean(renderValidation?.judgement),
    Boolean(assetEvidence.manifest || assetEvidence.report),
  ].filter(Boolean).length;
  const retainedArtifacts = ensemble?.artifacts?.length ?? 0;
  const retainedImages =
    ensemble?.artifacts?.filter((artifact) => Boolean(artifact.imageDataUrl)).length ?? 0;
  const failedRun = Boolean(generationFailure) || stage === "error";
  const hasReferenceWarnings = world?.plan.visualContract?.judgement?.passed === false;
  const pageDefinitions = [
    { id: "run" as const, label: "Run", count: logs.length },
    { id: "models" as const, label: "Models", count: retainedArtifacts },
    { id: "world" as const, label: "World", count: world ? 1 : 0 },
    {
      id: "library" as const,
      label: "Library",
      count: assetEvidence.manifest ? Object.keys(assetEvidence.manifest.prototypes).length : 0,
    },
  ];

  return (
    <section
      className="shrink-0 overflow-hidden border border-border bg-[linear-gradient(145deg,rgba(255,255,255,0.025),transparent_55%)]"
      data-testid="generation-evidence"
      data-world-id={world?.id ?? ""}
      data-world-seed={world?.seed ?? ""}
      data-world-prompt={world?.plan.prompt ?? ""}
    >
      {world && (
        <pre data-testid="normalized-scene-plan" hidden aria-hidden="true">
          {JSON.stringify({
            ...world.plan,
            layoutImageDataUrl: undefined,
            perspectiveImageDataUrl: undefined,
          })}
        </pre>
      )}
      <button
        type="button"
        className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-surface-subtle/50"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls="generation-evidence-body"
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-bg">
          <ScanSearch className="h-4 w-4 text-fg-muted" />
          <span className="absolute -top-px -right-px h-1.5 w-1.5 bg-success" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[8px] tracking-[0.2em] text-fg-subtle uppercase">
            Reproducibility record
          </span>
          <span className="mt-0.5 block text-xs font-semibold text-fg">
            Generation evidence dossier
          </span>
        </span>
        <span className="text-right">
          <span
            className={cn(
              "block font-mono text-[10px]",
              failedRun ? "text-danger" : "text-fg-muted",
            )}
          >
            {failedRun
              ? "stopped"
              : running
                ? `${Math.round(progress * 100)}%`
                : world
                  ? "ready"
                  : "idle"}
          </span>
          <span className="block text-[8px] text-fg-subtle uppercase">
            {retainedImages} images saved
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div
          id="generation-evidence-body"
          className="space-y-3 border-t border-border px-3 pt-3 pb-4"
        >
          <div
            className="grid grid-cols-4 gap-1 border border-border bg-bg/45 p-1"
            role="tablist"
            aria-label="Generation evidence pages"
          >
            {pageDefinitions.map((page) => (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={evidencePage === page.id}
                onClick={() => setEvidencePage(page.id)}
                className={cn(
                  "min-w-0 px-1 py-2 text-center",
                  evidencePage === page.id
                    ? "bg-surface-elevated text-fg"
                    : "text-fg-subtle hover:text-fg",
                )}
              >
                <span className="block truncate text-[9px] font-medium">{page.label}</span>
                <span className="mt-0.5 block font-mono text-[7px]">{page.count}</span>
              </button>
            ))}
          </div>

          <div className={cn("space-y-3", evidencePage !== "run" && "hidden")}>
            <div
              className={cn(
                "border p-2.5",
                failedRun ? "border-danger/50 bg-danger/5" : "border-border bg-bg/55",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[8px] tracking-[0.14em] text-fg-subtle uppercase">
                    Current result
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-sm font-semibold",
                      failedRun ? "text-danger" : world ? "text-success" : "text-fg",
                    )}
                  >
                    {failedRun
                      ? "Stopped with retained work"
                      : world
                        ? hasReferenceWarnings
                          ? "World ready with reference warnings"
                          : "World ready"
                        : running
                          ? stage.replaceAll("_", " ")
                          : "Ready to generate"}
                  </p>
                </div>
                <span className="font-mono text-xl tabular-nums text-fg">
                  {Math.round(progress * 100)}%
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border/70 pt-2">
                <ContractMetric label="model outputs" value={String(retainedArtifacts)} />
                <ContractMetric label="images" value={String(retainedImages)} />
                <ContractMetric label="evidence" value={`${evidenceLayerCount}/8`} />
              </div>
            </div>
            {generationFailure && <GenerationFailureBanner failure={generationFailure} />}
            <StageLedger
              logs={logs}
              stage={stage}
              progress={progress}
              running={running || renderValidation?.status === "running"}
            />
          </div>

          <div className={cn("space-y-2.5", evidencePage !== "models" && "hidden")}>
            <SectionHeading
              index="02"
              title="Model outputs"
              icon={Workflow}
              available={Boolean(ensemble)}
            />
            <ModelCommitteeEvidence ensemble={ensemble} failure={null} />
          </div>

          <div className={cn("space-y-3", evidencePage !== "world" && "hidden")}>
            {world ? (
              <>
                <div className="space-y-2.5">
                  <SectionHeading index="03" title="Intent & providers" icon={Workflow} />
                  <blockquote className="border-l border-fg-subtle/60 pl-2.5 text-[10px] leading-relaxed text-fg-muted">
                    “{world.plan.prompt}”
                  </blockquote>
                  <div className="grid grid-cols-2 gap-1.5">
                    <ProviderCard
                      label="Scene plan"
                      provider={
                        world.inferenceMeta?.planProvider ??
                        (planSource === "template"
                          ? "Local deterministic templates"
                          : "Not recorded")
                      }
                      detail={planSource === "llm" ? "model-authored plan" : "template plan"}
                    />
                    <ProviderCard
                      label="Layout / terrain"
                      provider={
                        world.inferenceMeta?.terrainProvider ??
                        (terrainSource === "procedural" ? "Procedural generator" : "Not recorded")
                      }
                      detail={
                        terrainSource === "image_guided" ? "image-guided field" : "procedural field"
                      }
                    />
                    <ProviderCard
                      label="Perspective sheet"
                      provider={
                        perspectiveReference
                          ? (world.inferenceMeta?.perspectiveProvider ?? "Not recorded")
                          : "Not generated"
                      }
                      detail={perspectiveReference ? "retained reference" : "no image artifact"}
                    />
                    <ProviderCard
                      label="Visual analysis"
                      provider={
                        contract
                          ? (world.inferenceMeta?.visualAnalysisProvider ?? contract.source)
                          : "Not generated"
                      }
                      detail={contract ? "bounded visual contract" : "no reconciliation pass"}
                    />
                  </div>
                </div>

                <div className="space-y-2.5">
                  <SectionHeading index="04" title="Map evidence" icon={Map} />
                  <div className="relative bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:12px_12px] p-2">
                    <LayoutMap size={520} showProvenance={false} />
                  </div>
                  <p className="text-[9px] leading-relaxed text-fg-subtle">
                    {layoutReference
                      ? "The retained top-down image is authoritative for X/Z organization. The semantic raster is the runtime region extraction used by terrain placement."
                      : "No source layout image was retained for this run. The visible semantic raster is runtime evidence from the generated region field, not an image-model artifact."}
                  </p>
                </div>

                <div className="space-y-2.5">
                  <SectionHeading
                    index="05"
                    title="Pre-build appearance concepts"
                    icon={ImageIcon}
                    available={Boolean(perspectiveReference || contract)}
                  />
                  {perspectiveReference ? (
                    <ReferenceImage
                      src={perspectiveReference}
                      alt="Selected pre-build perspective and construction concept board"
                    />
                  ) : (
                    <MissingEvidence>
                      This run did not retain a perspective or turnaround sheet. No unseen reference
                      is claimed.
                    </MissingEvidence>
                  )}
                  {contract ? (
                    <VisualContractEvidence contract={contract} />
                  ) : (
                    <MissingEvidence>
                      No VisualContract values or reference cameras were emitted. Map and plan
                      evidence remain independently inspectable.
                    </MissingEvidence>
                  )}
                </div>

                <div className="space-y-2.5">
                  <SectionHeading
                    index="06"
                    title="Final build comparison"
                    icon={FileCheck2}
                    available={Boolean(renderValidation)}
                  />
                  <FinalRenderEvidence validation={renderValidation} />
                </div>

                <div className="space-y-2.5">
                  <SectionHeading index="07" title="Object resolution" icon={ScanSearch} />
                  <ObjectResolutionEvidence world={world} />
                </div>
              </>
            ) : (
              <MissingEvidence>
                No world was built yet. Open Models to page through every retained plan and image.
              </MissingEvidence>
            )}
          </div>

          <div className={cn("space-y-2.5", evidencePage !== "library" && "hidden")}>
            <SectionHeading
              index="04"
              title="Saved asset library"
              icon={Library}
              available={Boolean(assetEvidence.manifest || assetEvidence.report)}
            />
            <Link
              to="/assets"
              className="flex h-9 items-center justify-between border border-border bg-bg/55 px-2.5 font-mono text-[8px] tracking-[0.1em] text-fg-muted uppercase transition hover:border-border-strong hover:text-fg"
            >
              Browse all saved variants
              <ChevronRight className="h-3 w-3" />
            </Link>
            <AssetEvidence
              state={assetEvidence}
              blenderCount={assetSummary.blenderCount}
              fallbackCount={assetSummary.fallbackCount}
              compiledPrototypes={assetSummary.compiledPrototypes}
              hasWorld={Boolean(world)}
            />
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-2 font-mono text-[8px] tracking-[0.1em] text-fg-subtle uppercase">
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="h-3 w-3" /> world {world?.id ?? "pending"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Gauge className="h-3 w-3" />
              {world ? `seed 0x${world.seed.toString(16)}` : `${Math.round(progress * 100)}%`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
