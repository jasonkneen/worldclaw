import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  FileBox,
  GitCompareArrows,
  Image as ImageIcon,
  Layers3,
  Library,
  Maximize2,
  Ruler,
  Search,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WORLDCLAW_ASSET_MANIFEST_URI,
  loadWorldClawAssetManifest,
  type AssetPrototypeManifest,
  type AssetVariantManifest,
  type WorldClawAssetManifest,
} from "~/lib/worldclaw/assets";
import type { BrowserAssetCollider, BrowserAssetPrototype } from "~/lib/worldclaw/types";
import { cn } from "~/lib/utils";

const BUILD_REPORT_URI = "/worldclaw/assets/worldclaw-kit.report.json";

interface CompiledAssetStats {
  boundsYUpMeters?: {
    min?: number[];
    max?: number[];
    size?: number[];
  };
  meshCount?: number;
  materialCount?: number;
  vertexCount?: number;
  triangleCount?: number;
}

interface AssetBuildReport {
  status?: string;
  artifact?: {
    byteLength?: number;
  };
  validation?: {
    status?: string;
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
    prototypes?: Partial<Record<BrowserAssetPrototype, CompiledAssetStats>>;
    variants?: Record<string, CompiledAssetStats>;
  };
}

interface AssetBrowserState {
  loading: boolean;
  manifest?: WorldClawAssetManifest;
  report?: AssetBuildReport;
  error?: string;
}

interface AssetEntry {
  key: string;
  prototype: BrowserAssetPrototype;
  definition: AssetPrototypeManifest;
  variant?: AssetVariantManifest;
  id: string;
  node: string;
  status: string;
  heightMeters: number;
  collider: BrowserAssetCollider;
  appearanceTerms: string[];
  materialIds: string[];
  turnaroundUri?: string;
  isDefault: boolean;
}

type EvidenceView = "turnaround" | "contact-sheet";
type BrowserMode = "inspect" | "compare";

interface LightboxTarget {
  src: string;
  alt: string;
  kind: "browse" | "compare" | "contact-sheet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBuildReport(value: unknown): AssetBuildReport {
  if (!isRecord(value)) throw new Error("Build report is not an object");
  return value as AssetBuildReport;
}

function savedAssetUri(uri?: string): string | undefined {
  if (!uri?.startsWith("/worldclaw/assets/")) return undefined;
  if (/^(?:data|blob|javascript):/i.test(uri)) return undefined;
  return uri;
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function formatMeasurement(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatVector(vector: readonly number[]): string {
  return vector.map(formatMeasurement).join(" × ");
}

function flattenAssetManifest(manifest?: WorldClawAssetManifest): AssetEntry[] {
  if (!manifest) return [];
  return Object.entries(manifest.prototypes).flatMap(([prototypeName, definition]) => {
    if (!definition) return [];
    const prototype = prototypeName as BrowserAssetPrototype;
    const variants = definition.variants?.length ? definition.variants : [undefined];
    return variants.map((variant, index) => {
      const id = variant?.id ?? prototype;
      const isDefault = variant ? id === definition.defaultVariant : true;
      const turnaroundUri = savedAssetUri(
        variant?.evidence?.turnaroundUri ??
          (isDefault || index === 0 ? definition.evidence?.turnaroundUri : undefined),
      );
      return {
        key: `${prototype}/${id}`,
        prototype,
        definition,
        variant,
        id,
        node: variant?.node ?? definition.node,
        status: variant?.status ?? "authored",
        heightMeters: variant?.targetHeightMeters ?? definition.targetHeightMeters,
        collider: variant?.collider ?? definition.collider,
        appearanceTerms: variant?.appearanceTerms ?? [],
        materialIds: variant?.materialIds ?? [],
        turnaroundUri,
        isDefault,
      } satisfies AssetEntry;
    });
  });
}

function constructionValues(entry: AssetEntry): string[] {
  const recipe = entry.variant?.constructionRecipe;
  if (!recipe) return [];
  return [
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
  ].filter((value): value is string => Boolean(value));
}

function constructionRows(entry: AssetEntry): [string, string][] {
  const recipe = entry.variant?.constructionRecipe;
  if (!recipe) return [];
  return [
    ["Wall assembly", recipe.wallAssembly],
    ["Openings", recipe.openingAssemblies?.join(" · ")],
    ["Door assembly", recipe.doorAssembly],
    ["Roof assembly", recipe.roofAssembly],
    ["Gate assembly", recipe.gateAssembly],
    ["Botanical assembly", recipe.botanicalAssembly],
    ["Bridge assembly", recipe.bridgeAssembly],
    ["Creature assembly", recipe.creatureAssembly],
    ["Industrial assembly", recipe.industrialAssembly],
    ["Communications", recipe.communicationsAssembly],
    ["Earthwork assembly", recipe.earthworkAssembly],
    ["Prop assembly", recipe.propAssembly],
    ["Weathering", recipe.weatheringProfile],
  ].filter((row): row is [string, string] => Boolean(row[1]));
}

function compiledStatsFor(
  entry: AssetEntry | undefined,
  report: AssetBuildReport | undefined,
): CompiledAssetStats | undefined {
  if (!entry) return undefined;
  return (
    report?.validation?.variants?.[entry.key] ?? report?.validation?.prototypes?.[entry.prototype]
  );
}

function comparisonDefaults(
  entries: AssetEntry[],
  anchorKey?: string,
): [string, string] | undefined {
  if (entries.length < 2) return undefined;
  const anchorIndex = Math.max(
    0,
    anchorKey ? entries.findIndex((entry) => entry.key === anchorKey) : 0,
  );
  const anchor = entries[anchorIndex] ?? entries[0];
  const sibling = entries.find(
    (entry) => entry.prototype === anchor.prototype && entry.key !== anchor.key,
  );
  const fallback = entries[(anchorIndex + 1) % entries.length];
  const second = sibling ?? fallback;
  return second && second.key !== anchor.key ? [anchor.key, second.key] : undefined;
}

function colliderSummary(collider: BrowserAssetCollider): string {
  if (collider.type === "box") {
    return `box · ${formatVector(collider.sizeMeters)} m`;
  }
  if (collider.type === "capsule") {
    return `capsule · r ${formatMeasurement(collider.radiusMeters)} m · h ${formatMeasurement(
      collider.heightMeters,
    )} m`;
  }
  return `sphere · r ${formatMeasurement(collider.radiusMeters)} m`;
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-r border-border px-3 py-2.5 last:border-r-0 sm:px-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-bg/65">
        <Icon className="h-3.5 w-3.5 text-fg-subtle" />
      </span>
      <div className="min-w-0">
        <p className="truncate font-mono text-[8px] tracking-[0.16em] text-fg-subtle uppercase">
          {label}
        </p>
        <p className="mt-0.5 truncate font-mono text-sm tabular-nums text-fg">{value}</p>
      </div>
    </div>
  );
}

function SectionLabel({ index, children }: { index: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <span className="font-mono text-[8px] tracking-[0.16em] text-fg-subtle">{index}</span>
      <h2 className="text-[10px] font-semibold tracking-[0.14em] text-fg uppercase">{children}</h2>
    </div>
  );
}

function EmptyValue({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] leading-relaxed text-fg-subtle">{children}</p>;
}

function TagList({
  values,
  tone = "neutral",
}: {
  values: string[];
  tone?: "neutral" | "material";
}) {
  if (values.length === 0) return <EmptyValue>No authored vocabulary published.</EmptyValue>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          key={value}
          className={cn(
            "border px-2 py-1 font-mono text-[8px] leading-none tracking-[0.04em]",
            tone === "material"
              ? "border-info/25 bg-info/5 text-info"
              : "border-border bg-surface-elevated text-fg-muted",
          )}
        >
          {value.replaceAll("_", " ")}
        </span>
      ))}
    </div>
  );
}

function ColliderReadout({ collider }: { collider: BrowserAssetCollider }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[9px]">
      <div>
        <p className="text-fg-subtle">Volume</p>
        <p className="mt-0.5 font-mono text-fg">{collider.type}</p>
      </div>
      <div>
        <p className="text-fg-subtle">Center Y-up</p>
        <p className="mt-0.5 font-mono text-fg">{formatVector(collider.centerMeters)} m</p>
      </div>
      {collider.type === "box" && (
        <div className="col-span-2">
          <p className="text-fg-subtle">Size</p>
          <p className="mt-0.5 font-mono text-fg">{formatVector(collider.sizeMeters)} m</p>
        </div>
      )}
      {collider.type === "capsule" && (
        <>
          <div>
            <p className="text-fg-subtle">Radius</p>
            <p className="mt-0.5 font-mono text-fg">{formatMeasurement(collider.radiusMeters)} m</p>
          </div>
          <div>
            <p className="text-fg-subtle">Collider height</p>
            <p className="mt-0.5 font-mono text-fg">{formatMeasurement(collider.heightMeters)} m</p>
          </div>
        </>
      )}
      {collider.type === "sphere" && (
        <div className="col-span-2">
          <p className="text-fg-subtle">Radius</p>
          <p className="mt-0.5 font-mono text-fg">{formatMeasurement(collider.radiusMeters)} m</p>
        </div>
      )}
    </div>
  );
}

function SavedImage({
  src,
  alt,
  onOpen,
  eager = false,
}: {
  src?: string;
  alt: string;
  onOpen: () => void;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="flex aspect-[16/6.5] items-center justify-center border border-dashed border-border bg-bg/50 px-6 text-center">
        <div>
          <ImageIcon className="mx-auto h-5 w-5 text-fg-subtle" />
          <p className="mt-2 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
            Saved evidence unavailable
          </p>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative block w-full overflow-hidden border border-border bg-black/25 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={`Open ${alt} fullscreen`}
    >
      <img
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onError={() => setFailed(true)}
        className="aspect-[16/6.5] w-full object-cover transition duration-300 group-hover:scale-[1.008] group-hover:opacity-90"
      />
      <span className="absolute right-2 bottom-2 flex h-8 items-center gap-1.5 border border-white/15 bg-black/70 px-2.5 font-mono text-[8px] tracking-[0.12em] text-white uppercase backdrop-blur-sm">
        <Maximize2 className="h-3 w-3" /> Inspect
      </span>
    </button>
  );
}

function VariantSelect({
  side,
  entry,
  entries,
  onChange,
}: {
  side: "A" | "B";
  entry: AssetEntry;
  entries: AssetEntry[];
  onChange: (key: string) => void;
}) {
  const families = [...new Set(entries.map((candidate) => candidate.prototype))];
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center gap-2 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center border",
            side === "A" ? "border-info/45 text-info" : "border-warn/45 text-warn",
          )}
        >
          {side}
        </span>
        Authored variant {side}
      </span>
      <span className="relative block">
        <select
          data-testid={`compare-${side.toLocaleLowerCase()}-select`}
          value={entry.key}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full appearance-none truncate border border-border bg-bg px-3 pr-9 text-[9px] text-fg outline-none focus:border-border-strong focus:ring-1 focus:ring-ring/50"
          aria-label={`Choose authored variant ${side}`}
        >
          {families.map((prototype) => (
            <optgroup key={prototype} label={titleCase(prototype)}>
              {entries
                .filter((candidate) => candidate.prototype === prototype)
                .map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {titleCase(candidate.id)}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
      </span>
      <span className="mt-1.5 block truncate font-mono text-[7px] tracking-[0.06em] text-fg-subtle uppercase">
        {entry.prototype} · {entry.node}
      </span>
    </label>
  );
}

function ComparisonRow({ label, left, right }: { label: string; left: string; right: string }) {
  const differs = left !== right;
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)] border-t border-border first:border-t-0">
      <div className="flex min-h-11 items-center justify-between gap-1 border-r border-border bg-surface-elevated/55 px-2.5 py-2">
        <span className="font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
          {label}
        </span>
        {differs && <span className="h-1.5 w-1.5 shrink-0 bg-info/75" aria-label="Values differ" />}
      </div>
      <div className="min-w-0 border-r border-border bg-bg/55 px-3 py-2 font-mono text-[8px] leading-relaxed text-fg-muted">
        {left}
      </div>
      <div className="min-w-0 bg-bg/55 px-3 py-2 font-mono text-[8px] leading-relaxed text-fg-muted">
        {right}
      </div>
    </div>
  );
}

function ComparisonRecipe({ entry, side }: { entry: AssetEntry; side: "A" | "B" }) {
  const recipe = entry.variant?.constructionRecipe;
  const rows = constructionRows(entry);
  const systems = recipe?.systems ?? [];
  const guarantees = recipe?.geometryGuarantees ?? [];
  return (
    <article className="min-w-0 border border-border bg-bg/55 p-3">
      <div className="flex items-start justify-between gap-2 border-b border-border pb-2.5">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-medium text-fg">{titleCase(entry.id)}</p>
          <p className="mt-0.5 font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
            Construction recipe
          </p>
        </div>
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[8px]",
            side === "A" ? "border-info/45 text-info" : "border-warn/45 text-warn",
          )}
        >
          {side}
        </span>
      </div>
      {rows.length > 0 || systems.length > 0 || guarantees.length > 0 ? (
        <div className="mt-3 space-y-3">
          {rows.length > 0 && (
            <dl className="space-y-2 border-l border-border-strong pl-2.5">
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt className="font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
                    {label}
                  </dt>
                  <dd className="mt-0.5 text-[9px] leading-relaxed text-fg-muted">
                    {value.replaceAll("_", " ")}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {systems.length > 0 && (
            <div>
              <p className="mb-1.5 font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
                Systems
              </p>
              <ol className="space-y-1.5">
                {systems.map((system, index) => (
                  <li
                    key={system}
                    className="grid grid-cols-[1rem_1fr] gap-1.5 text-[9px] leading-relaxed text-fg-muted"
                  >
                    <span className="font-mono text-[7px] text-fg-subtle">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>{system}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {guarantees.length > 0 && (
            <div className="border border-success/20 bg-success/5 p-2">
              <p className="font-mono text-[7px] tracking-[0.08em] text-success uppercase">
                {guarantees.length} geometry guarantee{guarantees.length === 1 ? "" : "s"}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[9px] leading-relaxed text-fg-subtle">
          No variant-level construction recipe published.
        </p>
      )}
    </article>
  );
}

function AuthoredVariantComparison({
  left,
  right,
  entries,
  report,
  contactSheetUri,
  turnaroundViews,
  onChoose,
  onPreset,
  onOpenImage,
  onClose,
}: {
  left: AssetEntry;
  right: AssetEntry;
  entries: AssetEntry[];
  report?: AssetBuildReport;
  contactSheetUri?: string;
  turnaroundViews: string[];
  onChoose: (side: 0 | 1, key: string) => void;
  onPreset: (prototype: BrowserAssetPrototype) => void;
  onOpenImage: (target: LightboxTarget) => void;
  onClose: () => void;
}) {
  const leftStats = compiledStatsFor(left, report);
  const rightStats = compiledStatsFor(right, report);
  const familyCounts = entries.reduce(
    (counts, entry) => counts.set(entry.prototype, (counts.get(entry.prototype) ?? 0) + 1),
    new Map<BrowserAssetPrototype, number>(),
  );
  const multiVariantFamilies = [...familyCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([leftPrototype], [rightPrototype]) => leftPrototype.localeCompare(rightPrototype));
  const sharedFamily = left.prototype === right.prototype ? left.prototype : "";

  return (
    <div data-testid="authored-variant-comparison" className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[8px] tracking-[0.16em] text-info uppercase">
            <GitCompareArrows className="h-3.5 w-3.5" /> Authored variant comparison
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-fg sm:text-2xl">
            Compare two saved authored roots
          </h2>
          <p className="mt-1 max-w-2xl text-[9px] leading-relaxed text-fg-muted">
            Both columns come from the same published asset library output. This compares authored
            design variants, not version history.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 items-center gap-2 border border-border bg-surface px-3 font-mono text-[8px] tracking-[0.1em] text-fg-muted uppercase hover:border-border-strong hover:text-fg"
        >
          <X className="h-3 w-3" /> Exit comparison
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <VariantSelect
          side="A"
          entry={left}
          entries={entries}
          onChange={(key) => onChoose(0, key)}
        />
        <VariantSelect
          side="B"
          entry={right}
          entries={entries}
          onChange={(key) => onChoose(1, key)}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-surface/65 p-2.5">
        <div>
          <p className="font-mono text-[7px] tracking-[0.12em] text-fg-subtle uppercase">
            Useful same-family defaults
          </p>
          <p className="mt-0.5 text-[9px] text-fg-muted">
            Start with two separately authored roots from one prototype family.
          </p>
        </div>
        <label className="relative min-w-48 flex-1 sm:max-w-64">
          <span className="sr-only">Choose a multi-variant family preset</span>
          <select
            data-testid="compare-family-preset"
            value={sharedFamily && (familyCounts.get(sharedFamily) ?? 0) > 1 ? sharedFamily : ""}
            onChange={(event) => {
              if (event.target.value) onPreset(event.target.value as BrowserAssetPrototype);
            }}
            className="h-9 w-full appearance-none border border-border bg-bg px-3 pr-8 font-mono text-[8px] tracking-[0.06em] text-fg outline-none uppercase focus:border-border-strong focus:ring-1 focus:ring-ring/50"
          >
            <option value="">Mixed families</option>
            {multiVariantFamilies.map(([prototype, count]) => (
              <option key={prototype} value={prototype}>
                {titleCase(prototype)} · {count} authored variants
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
        </label>
      </div>

      <section aria-label="Saved authored turnaround comparison">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
            Saved turnarounds
          </p>
          <p className="hidden font-mono text-[7px] text-fg-subtle sm:block">
            {turnaroundViews.join(" · ") || "front · three-quarter · side · rear"}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-1.5 sm:gap-3">
          {(
            [
              { entry: left, side: "A" },
              { entry: right, side: "B" },
            ] as const
          ).map(({ entry, side }) => {
            const alt = `${titleCase(entry.id)} authored four-view turnaround`;
            return (
              <article
                key={entry.key}
                className="min-w-0 border border-border bg-surface p-1.5 sm:p-2"
              >
                <SavedImage
                  src={entry.turnaroundUri}
                  alt={alt}
                  onOpen={() => {
                    if (entry.turnaroundUri) {
                      onOpenImage({
                        src: entry.turnaroundUri,
                        alt,
                        kind: "compare",
                      });
                    }
                  }}
                  eager
                />
                <div className="flex min-w-0 items-center gap-2 px-1 pt-2">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[8px]",
                      side === "A" ? "border-info/45 text-info" : "border-warn/45 text-warn",
                    )}
                  >
                    {side}
                  </span>
                  <p className="min-w-0 truncate text-[9px] font-medium text-fg">
                    {titleCase(entry.id)}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <p className="mb-2 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
          Geometry contract
        </p>
        <div className="scrollbar-thin overflow-x-auto border border-border">
          <div data-testid="authored-variant-comparison-matrix" className="min-w-[36rem]">
            <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)] bg-surface-elevated">
              <div className="border-r border-border px-2.5 py-2 font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
                Field
              </div>
              <div className="border-r border-border px-3 py-2 font-mono text-[8px] text-info">
                A · {titleCase(left.id)}
              </div>
              <div className="px-3 py-2 font-mono text-[8px] text-warn">
                B · {titleCase(right.id)}
              </div>
            </div>
            <ComparisonRow
              label="Target height"
              left={`${formatMeasurement(left.heightMeters)} m`}
              right={`${formatMeasurement(right.heightMeters)} m`}
            />
            <ComparisonRow
              label="Bounds X/Y/Z"
              left={
                leftStats?.boundsYUpMeters?.size
                  ? `${formatVector(leftStats.boundsYUpMeters.size)} m`
                  : "—"
              }
              right={
                rightStats?.boundsYUpMeters?.size
                  ? `${formatVector(rightStats.boundsYUpMeters.size)} m`
                  : "—"
              }
            />
            <ComparisonRow
              label="Collider"
              left={colliderSummary(left.collider)}
              right={colliderSummary(right.collider)}
            />
            <ComparisonRow
              label="Center Y-up"
              left={`${formatVector(left.collider.centerMeters)} m`}
              right={`${formatVector(right.collider.centerMeters)} m`}
            />
            <ComparisonRow
              label="Meshes"
              left={formatInteger(leftStats?.meshCount)}
              right={formatInteger(rightStats?.meshCount)}
            />
            <ComparisonRow
              label="Vertices"
              left={formatInteger(leftStats?.vertexCount)}
              right={formatInteger(rightStats?.vertexCount)}
            />
            <ComparisonRow
              label="Triangles"
              left={formatInteger(leftStats?.triangleCount)}
              right={formatInteger(rightStats?.triangleCount)}
            />
          </div>
        </div>
      </section>

      <section>
        <p className="mb-2 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
          Material vocabulary
        </p>
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          {(
            [
              { entry: left, side: "A" },
              { entry: right, side: "B" },
            ] as const
          ).map(({ entry, side }) => {
            return (
              <article
                key={entry.key}
                className="min-w-0 border border-border bg-bg/55 p-2.5 sm:p-3"
              >
                <p className="mb-2 truncate font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
                  {side} · {entry.materialIds.length} material IDs
                </p>
                <TagList values={entry.materialIds} tone="material" />
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <p className="mb-2 font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
          Construction recipes
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
          <ComparisonRecipe entry={left} side="A" />
          <ComparisonRecipe entry={right} side="B" />
        </div>
      </section>

      {contactSheetUri && (
        <button
          type="button"
          onClick={() =>
            onOpenImage({
              src: contactSheetUri,
              alt: "WorldClaw compiled asset library contact sheet",
              kind: "contact-sheet",
            })
          }
          className="group grid w-full grid-cols-[5.25rem_1fr_auto] items-center gap-3 border border-border bg-surface p-2 text-left transition hover:border-border-strong"
        >
          <img
            src={contactSheetUri}
            alt=""
            loading="lazy"
            decoding="async"
            className="aspect-video w-full border border-border object-cover opacity-75 transition group-hover:opacity-100"
          />
          <span className="min-w-0">
            <span className="block font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
              Saved library context
            </span>
            <span className="mt-1 block truncate text-[10px] text-fg-muted">
              Inspect both authored roots in the full compiled contact sheet
            </span>
          </span>
          <Maximize2 className="h-3.5 w-3.5 text-fg-subtle group-hover:text-fg" />
        </button>
      )}
    </div>
  );
}

function LoadingLibrary() {
  return (
    <div className="flex min-h-[420px] items-center justify-center border border-border bg-surface/70 p-8">
      <div className="text-center">
        <CircleDashed className="mx-auto h-5 w-5 animate-spin text-fg-muted" />
        <p className="mt-3 font-mono text-[9px] tracking-[0.16em] text-fg-muted uppercase">
          Indexing saved assets
        </p>
        <p className="mt-1 text-[10px] text-fg-subtle">
          Reading the published manifest and build report.
        </p>
      </div>
    </div>
  );
}

function LoadFailure({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="flex min-h-[420px] items-center justify-center border border-danger/35 bg-danger/5 p-8">
      <div className="max-w-sm text-center">
        <FileBox className="mx-auto h-6 w-6 text-danger" />
        <h2 className="mt-3 text-sm font-semibold text-fg">
          The saved library could not be opened
        </h2>
        <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">{error}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 h-9 border border-border-strong bg-surface-elevated px-4 font-mono text-[9px] tracking-[0.12em] text-fg uppercase hover:border-fg-subtle"
        >
          Read again
        </button>
      </div>
    </div>
  );
}

export function AssetLibraryBrowser() {
  const navigate = useNavigate();
  const [state, setState] = useState<AssetBrowserState>({ loading: true });
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [family, setFamily] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [mode, setMode] = useState<BrowserMode>("inspect");
  const [compareKeys, setCompareKeys] = useState<[string, string]>(["", ""]);
  const [view, setView] = useState<EvidenceView>("turnaround");
  const [lightbox, setLightbox] = useState<LightboxTarget>();

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ loading: true });

    async function loadLibrary() {
      const [manifestResult, reportResult] = await Promise.allSettled([
        loadWorldClawAssetManifest(WORLDCLAW_ASSET_MANIFEST_URI, controller.signal),
        fetch(BUILD_REPORT_URI, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        }).then(async (response) => {
          if (!response.ok) throw new Error(`Build report HTTP ${response.status}`);
          return parseBuildReport(await response.json());
        }),
      ]);
      if (!active) return;

      const manifestLoad = manifestResult.status === "fulfilled" ? manifestResult.value : undefined;
      const manifest = manifestLoad?.manifest;
      const report = reportResult.status === "fulfilled" ? reportResult.value : undefined;
      const errors = [
        manifestResult.status === "rejected" ? String(manifestResult.reason) : manifestLoad?.error,
        reportResult.status === "rejected" ? String(reportResult.reason) : undefined,
      ].filter((value): value is string => Boolean(value));

      setState({
        loading: false,
        manifest,
        report,
        error: errors.length ? errors.join(" · ") : undefined,
      });
    }

    void loadLibrary();
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey]);

  const entries = useMemo(() => flattenAssetManifest(state.manifest), [state.manifest]);
  const families = useMemo(
    () => [...new Set(entries.map((entry) => entry.prototype))].sort(),
    [entries],
  );
  const materialCount = useMemo(
    () => new Set(entries.flatMap((entry) => entry.materialIds)).size,
    [entries],
  );
  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (family !== "all" && entry.prototype !== family) return false;
      if (!needle) return true;
      const haystack = [
        entry.prototype,
        entry.id,
        entry.node,
        ...entry.appearanceTerms,
        ...entry.materialIds,
        ...constructionValues(entry),
      ]
        .join(" ")
        .replaceAll("_", " ")
        .toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [entries, family, search]);

  const selected = filteredEntries.find((entry) => entry.key === selectedKey) ?? filteredEntries[0];
  const selectedIndex = selected
    ? filteredEntries.findIndex((entry) => entry.key === selected.key)
    : -1;
  const contactSheetUri = savedAssetUri(state.manifest?.evidence?.contactSheetUri);
  const activeImageUri = view === "contact-sheet" ? contactSheetUri : selected?.turnaroundUri;
  const activeImageAlt =
    view === "contact-sheet"
      ? "WorldClaw compiled asset library contact sheet"
      : selected
        ? `${titleCase(selected.id)} four-view turnaround`
        : "Saved asset turnaround";
  const compiledStats = compiledStatsFor(selected, state.report);
  const compareLeft = entries.find((entry) => entry.key === compareKeys[0]);
  const compareRight = entries.find((entry) => entry.key === compareKeys[1]);

  const openComparison = useCallback(() => {
    const defaults = comparisonDefaults(entries, selected?.key);
    if (!defaults) return;
    setCompareKeys(defaults);
    setMode("compare");
    setView("turnaround");
  }, [entries, selected?.key]);

  const chooseComparisonVariant = useCallback((side: 0 | 1, key: string) => {
    setCompareKeys((current) => {
      if (side === 0) {
        return key === current[1] ? [key, current[0]] : [key, current[1]];
      }
      return key === current[0] ? [current[1], key] : [current[0], key];
    });
  }, []);

  const applyComparisonPreset = useCallback(
    (prototype: BrowserAssetPrototype) => {
      const candidates = entries
        .filter((entry) => entry.prototype === prototype)
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
      if (candidates.length >= 2) {
        setCompareKeys([candidates[0].key, candidates[1].key]);
      }
    },
    [entries],
  );

  const moveSelection = useCallback(
    (offset: number) => {
      if (selectedIndex < 0) return;
      const nextIndex = Math.min(filteredEntries.length - 1, Math.max(0, selectedIndex + offset));
      const next = filteredEntries[nextIndex];
      if (next) {
        setSelectedKey(next.key);
        setView("turnaround");
      }
    },
    [filteredEntries, selectedIndex],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "Escape") {
        event.preventDefault();
        if (lightbox) {
          setLightbox(undefined);
        } else if (mode === "compare") {
          setMode("inspect");
        } else if (search || family !== "all") {
          setSearch("");
          setFamily("all");
        } else {
          void navigate({ to: "/" });
        }
        return;
      }

      if (
        typing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        lightbox?.kind === "compare"
      ) {
        return;
      }
      if (event.key.toLocaleLowerCase() === "c") {
        event.preventDefault();
        if (lightbox) return;
        if (mode === "compare") {
          setMode("inspect");
        } else {
          openComparison();
        }
        return;
      }
      if (mode === "compare" || view === "contact-sheet") return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelection(1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [family, lightbox, mode, moveSelection, navigate, openComparison, search, view]);

  const validationPassed = state.report?.validation?.status === "passed";
  const recipe = selected?.variant?.constructionRecipe;
  const assemblyRows = selected ? constructionRows(selected) : [];
  const lightboxImageUri = lightbox?.kind === "browse" ? activeImageUri : lightbox?.src;
  const lightboxImageAlt = lightbox?.kind === "browse" ? activeImageAlt : lightbox?.alt;

  return (
    <main
      data-testid="asset-library-browser"
      className="relative h-dvh overflow-y-auto bg-bg text-fg lg:overflow-hidden"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-[0.035] [background-image:linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] [background-size:32px_32px]"
      />

      <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-4 border-b border-border bg-bg/95 px-3 py-3 backdrop-blur-md sm:px-5 lg:h-16 lg:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="flex h-9 shrink-0 items-center gap-2 border border-border bg-surface px-3 font-mono text-[9px] tracking-[0.1em] text-fg-muted uppercase transition hover:border-border-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="h-3 w-3" />
            <span className="hidden sm:inline">Back to world</span>
            <span className="sm:hidden">World</span>
          </Link>
          <span className="hidden h-8 w-px bg-border sm:block" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Library className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              <h1 className="truncate text-[12px] font-semibold tracking-[0.12em] uppercase">
                Asset library
              </h1>
            </div>
            <p className="mt-0.5 hidden truncate font-mono text-[8px] tracking-[0.1em] text-fg-subtle uppercase sm:block">
              Published geometry · saved render evidence · provider-free
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden font-mono text-[8px] tracking-[0.1em] text-fg-subtle uppercase md:inline">
            {mode === "compare"
              ? "C / Esc exit comparison"
              : "← / → browse · C compare · Esc close"}
          </span>
          <span
            className={cn(
              "inline-flex h-7 items-center gap-1.5 border px-2 font-mono text-[8px] tracking-[0.1em] uppercase",
              state.loading
                ? "border-border text-fg-subtle"
                : validationPassed
                  ? "border-success/35 bg-success/5 text-success"
                  : "border-warn/35 bg-warn/5 text-warn",
            )}
          >
            {state.loading ? (
              <CircleDashed className="h-2.5 w-2.5 animate-spin" />
            ) : validationPassed ? (
              <Check className="h-2.5 w-2.5" />
            ) : (
              <ShieldCheck className="h-2.5 w-2.5" />
            )}
            {state.loading ? "reading" : validationPassed ? "validated" : "published"}
          </span>
        </div>
      </header>

      <section
        aria-label="Asset library summary"
        className="relative z-10 grid grid-cols-2 border-b border-border bg-surface/85 sm:grid-cols-4 lg:h-16"
      >
        <Metric icon={Box} label="Prototype families" value={formatInteger(families.length)} />
        <Metric icon={Layers3} label="Authored variants" value={formatInteger(entries.length)} />
        <Metric icon={Ruler} label="Material IDs" value={formatInteger(materialCount)} />
        <Metric
          icon={FileBox}
          label="Compiled geometry"
          value={`${formatInteger(state.report?.validation?.counts?.triangleCount)} tris · ${formatBytes(
            state.report?.artifact?.byteLength ?? state.report?.validation?.budget?.bytesUsed,
          )}`}
        />
      </section>

      {state.loading ? (
        <div className="relative z-10 p-3 sm:p-5">
          <LoadingLibrary />
        </div>
      ) : !state.manifest ? (
        <div className="relative z-10 p-3 sm:p-5">
          <LoadFailure
            error={state.error ?? "The published manifest did not return a usable asset contract."}
            retry={() => setReloadKey((key) => key + 1)}
          />
        </div>
      ) : (
        <div className="relative z-10 lg:grid lg:h-[calc(100dvh-8rem)] lg:grid-cols-[19rem_minmax(0,1fr)_23rem] lg:overflow-hidden">
          <aside className="border-b border-border bg-surface/70 lg:flex lg:min-h-0 lg:flex-col lg:border-r lg:border-b-0">
            <div className="space-y-3 border-b border-border p-3">
              <SectionLabel index="01">
                {mode === "compare" ? "Choose authored variant B" : "Find a compiled root"}
              </SectionLabel>
              <label className="relative block">
                <span className="sr-only">Search asset variants</span>
                <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
                <input
                  data-testid="asset-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search form, material, recipe…"
                  className="h-10 w-full border border-border bg-bg pr-9 pl-9 text-[10px] text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong focus:ring-1 focus:ring-ring/50"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute top-1/2 right-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-fg-subtle hover:text-fg"
                    aria-label="Clear asset search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              <label className="relative block">
                <span className="sr-only">Filter by prototype family</span>
                <select
                  data-testid="asset-family-filter"
                  value={family}
                  onChange={(event) => setFamily(event.target.value)}
                  className="h-10 w-full appearance-none border border-border bg-bg px-3 pr-9 font-mono text-[9px] tracking-[0.06em] text-fg outline-none uppercase focus:border-border-strong focus:ring-1 focus:ring-ring/50"
                >
                  <option value="all">All prototype families</option>
                  {families.map((prototype) => (
                    <option key={prototype} value={prototype}>
                      {titleCase(prototype)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
              </label>
              <div className="flex items-center justify-between font-mono text-[8px] tracking-[0.1em] text-fg-subtle uppercase">
                <span>{filteredEntries.length} visible</span>
                {(search || family !== "all") && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setFamily("all");
                    }}
                    className="text-fg-muted hover:text-fg"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            </div>

            <div
              data-testid="asset-variant-grid"
              className="scrollbar-thin grid max-h-72 grid-cols-2 gap-px overflow-y-auto bg-border p-px sm:grid-cols-3 lg:min-h-0 lg:max-h-none lg:flex-1 lg:grid-cols-1 lg:content-start"
              aria-label="Saved asset variants"
            >
              {filteredEntries.map((entry, index) => {
                const compareSide =
                  mode === "compare"
                    ? entry.key === compareKeys[0]
                      ? "A"
                      : entry.key === compareKeys[1]
                        ? "B"
                        : undefined
                    : undefined;
                const active =
                  mode === "compare" ? Boolean(compareSide) : entry.key === selected?.key;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => {
                      if (mode === "compare") {
                        chooseComparisonVariant(1, entry.key);
                      } else {
                        setSelectedKey(entry.key);
                        setView("turnaround");
                      }
                    }}
                    aria-pressed={active}
                    aria-label={
                      mode === "compare"
                        ? `Set authored variant B to ${titleCase(entry.id)}`
                        : undefined
                    }
                    className={cn(
                      "group relative min-w-0 bg-surface px-3 py-3 text-left transition focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      compareSide === "B"
                        ? "bg-warn/10"
                        : active
                          ? "bg-info/10"
                          : "hover:bg-surface-elevated",
                    )}
                  >
                    {active && (
                      <span
                        className={cn(
                          "absolute inset-y-0 left-0 w-0.5",
                          compareSide === "B" ? "bg-warn" : "bg-info",
                        )}
                      />
                    )}
                    <div className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-[7px] tabular-nums",
                          compareSide === "B"
                            ? "border-warn/50 bg-warn/10 text-warn"
                            : active
                              ? "border-info/50 bg-info/10 text-info"
                              : "border-border bg-bg text-fg-subtle group-hover:border-border-strong",
                        )}
                      >
                        {compareSide ?? String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10px] font-medium text-fg">
                          {titleCase(entry.id)}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 font-mono text-[7px] tracking-[0.08em] text-fg-subtle uppercase">
                          {entry.prototype}
                          {entry.isDefault && (
                            <span className="border border-border px-1 py-0.5 text-[6px]">
                              default
                            </span>
                          )}
                        </span>
                      </span>
                      {entry.turnaroundUri && (
                        <ImageIcon
                          className="h-3 w-3 shrink-0 text-fg-subtle"
                          aria-label="Turnaround saved"
                        />
                      )}
                    </div>
                  </button>
                );
              })}
              {filteredEntries.length === 0 && (
                <div className="col-span-full bg-surface p-6 text-center">
                  <Search className="mx-auto h-4 w-4 text-fg-subtle" />
                  <p className="mt-2 text-[10px] text-fg-muted">No authored variant matches.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setFamily("all");
                    }}
                    className="mt-2 font-mono text-[8px] tracking-[0.1em] text-info uppercase"
                  >
                    Show the full library
                  </button>
                </div>
              )}
            </div>
          </aside>

          <section
            className={cn(
              "scrollbar-thin min-w-0 border-b border-border bg-bg/65 p-3 sm:p-5 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0",
              mode === "compare" && "lg:col-span-2 lg:border-r-0",
            )}
          >
            {mode === "compare" && compareLeft && compareRight ? (
              <AuthoredVariantComparison
                left={compareLeft}
                right={compareRight}
                entries={entries}
                report={state.report}
                contactSheetUri={contactSheetUri}
                turnaroundViews={state.manifest.evidence?.turnaroundViews ?? []}
                onChoose={chooseComparisonVariant}
                onPreset={applyComparisonPreset}
                onOpenImage={setLightbox}
                onClose={() => setMode("inspect")}
              />
            ) : selected ? (
              <div className="mx-auto max-w-5xl space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[8px] tracking-[0.16em] text-fg-subtle uppercase">
                      {selected.prototype} / {selected.node}
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-fg sm:text-2xl">
                      {titleCase(selected.id)}
                    </h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      data-testid="open-authored-variant-comparison"
                      type="button"
                      onClick={openComparison}
                      disabled={entries.length < 2}
                      className="flex h-9 items-center gap-2 border border-info/35 bg-info/5 px-3 font-mono text-[8px] tracking-[0.08em] text-info uppercase transition hover:border-info/60 hover:bg-info/10 disabled:opacity-35"
                    >
                      <GitCompareArrows className="h-3.5 w-3.5" /> Compare authored variants
                    </button>
                    <div
                      className="flex border border-border bg-surface p-0.5"
                      role="group"
                      aria-label="Evidence view"
                    >
                      <button
                        type="button"
                        onClick={() => setView("turnaround")}
                        className={cn(
                          "h-8 px-3 font-mono text-[8px] tracking-[0.1em] uppercase",
                          view === "turnaround"
                            ? "bg-surface-elevated text-fg"
                            : "text-fg-subtle hover:text-fg",
                        )}
                      >
                        Turnaround
                      </button>
                      <button
                        type="button"
                        onClick={() => setView("contact-sheet")}
                        disabled={!contactSheetUri}
                        className={cn(
                          "h-8 border-l border-border px-3 font-mono text-[8px] tracking-[0.1em] uppercase disabled:opacity-35",
                          view === "contact-sheet"
                            ? "bg-surface-elevated text-fg"
                            : "text-fg-subtle hover:text-fg",
                        )}
                      >
                        Contact sheet
                      </button>
                    </div>
                  </div>
                </div>

                <div className="relative border border-border bg-surface p-1.5 shadow-2xl shadow-black/20 sm:p-2.5">
                  <div className="pointer-events-none absolute top-0 left-4 h-2 w-px bg-fg-subtle/60" />
                  <div className="pointer-events-none absolute top-4 left-0 h-px w-2 bg-fg-subtle/60" />
                  <SavedImage
                    key={`${view}:${activeImageUri ?? "missing"}`}
                    src={activeImageUri}
                    alt={activeImageAlt}
                    onOpen={() => {
                      if (activeImageUri) {
                        setLightbox({
                          src: activeImageUri,
                          alt: activeImageAlt,
                          kind: view === "contact-sheet" ? "contact-sheet" : "browse",
                        });
                      }
                    }}
                    eager={view === "turnaround"}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2 font-mono text-[8px] tracking-[0.08em] text-fg-subtle uppercase">
                    <span>
                      {view === "turnaround"
                        ? state.manifest.evidence?.turnaroundViews.join(" · ") ||
                          "front · three-quarter · side · rear"
                        : `${state.manifest.evidence?.projection ?? "orthographic"} compiled overview`}
                    </span>
                    <span>{state.manifest.evidence?.renderSource ?? "saved public render"}</span>
                  </div>
                </div>

                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={() => moveSelection(-1)}
                    disabled={selectedIndex <= 0}
                    className="flex h-10 items-center gap-1.5 border border-border bg-surface px-3 font-mono text-[8px] tracking-[0.08em] text-fg-muted uppercase transition hover:border-border-strong hover:text-fg disabled:opacity-30"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </button>
                  <div className="text-center font-mono text-[8px] tabular-nums text-fg-subtle">
                    {selectedIndex + 1} / {filteredEntries.length}
                  </div>
                  <button
                    type="button"
                    onClick={() => moveSelection(1)}
                    disabled={selectedIndex < 0 || selectedIndex >= filteredEntries.length - 1}
                    className="flex h-10 items-center gap-1.5 border border-border bg-surface px-3 font-mono text-[8px] tracking-[0.08em] text-fg-muted uppercase transition hover:border-border-strong hover:text-fg disabled:opacity-30"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                {contactSheetUri && view === "turnaround" && (
                  <button
                    type="button"
                    onClick={() => setView("contact-sheet")}
                    className="group grid w-full grid-cols-[5.25rem_1fr_auto] items-center gap-3 border border-border bg-surface p-2 text-left transition hover:border-border-strong"
                  >
                    <img
                      src={contactSheetUri}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="aspect-video w-full border border-border object-cover opacity-75 transition group-hover:opacity-100"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-[8px] tracking-[0.12em] text-fg-subtle uppercase">
                        Library context
                      </span>
                      <span className="mt-1 block truncate text-[10px] text-fg-muted">
                        Inspect every compiled root on the saved contact sheet
                      </span>
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:text-fg" />
                  </button>
                )}
              </div>
            ) : (
              <div className="flex min-h-80 items-center justify-center text-center">
                <div>
                  <Box className="mx-auto h-5 w-5 text-fg-subtle" />
                  <p className="mt-2 text-[10px] text-fg-muted">
                    Choose a visible asset to inspect.
                  </p>
                </div>
              </div>
            )}
          </section>

          {mode === "inspect" && (
            <aside className="scrollbar-thin bg-surface/75 p-3 sm:p-4 lg:min-h-0 lg:overflow-y-auto">
              {selected && (
                <div className="space-y-5">
                  <section>
                    <SectionLabel index="02">Authored contract</SectionLabel>
                    <div className="mt-3 grid grid-cols-2 gap-3 border border-border bg-bg/55 p-3 text-[9px]">
                      <div>
                        <p className="text-fg-subtle">Target height</p>
                        <p className="mt-1 font-mono text-base text-fg">
                          {formatMeasurement(selected.heightMeters)}{" "}
                          <span className="text-[9px] text-fg-muted">m</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-fg-subtle">Authored state</p>
                        <p className="mt-1 font-mono text-[10px] text-success">{selected.status}</p>
                      </div>
                      <div className="col-span-2 border-t border-border pt-2">
                        <p className="text-fg-subtle">GLB root</p>
                        <p className="mt-1 break-all font-mono text-[8px] text-fg-muted">
                          {selected.node}
                        </p>
                      </div>
                    </div>
                  </section>

                  <section>
                    <SectionLabel index="03">Appearance language</SectionLabel>
                    <div className="mt-3">
                      <TagList values={selected.appearanceTerms} />
                    </div>
                  </section>

                  <section>
                    <SectionLabel index="04">Material vocabulary</SectionLabel>
                    <div className="mt-3">
                      <TagList values={selected.materialIds} tone="material" />
                    </div>
                  </section>

                  <section>
                    <SectionLabel index="05">Construction recipe</SectionLabel>
                    <div className="mt-3 space-y-3">
                      {assemblyRows.length > 0 && (
                        <dl className="space-y-2 border-l border-border-strong pl-3">
                          {assemblyRows.map(([label, value]) => (
                            <div key={label}>
                              <dt className="font-mono text-[7px] tracking-[0.1em] text-fg-subtle uppercase">
                                {label}
                              </dt>
                              <dd className="mt-0.5 text-[9px] leading-relaxed text-fg-muted">
                                {value.replaceAll("_", " ")}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {recipe?.openingAssemblies && recipe.openingAssemblies.length > 0 && (
                        <div>
                          <p className="mb-1.5 font-mono text-[7px] tracking-[0.1em] text-fg-subtle uppercase">
                            Openings
                          </p>
                          <TagList values={recipe.openingAssemblies} />
                        </div>
                      )}
                      {recipe?.systems && recipe.systems.length > 0 && (
                        <div>
                          <p className="mb-1.5 font-mono text-[7px] tracking-[0.1em] text-fg-subtle uppercase">
                            Systems
                          </p>
                          <ol className="space-y-1.5">
                            {recipe.systems.map((system, index) => (
                              <li
                                key={system}
                                className="grid grid-cols-[1rem_1fr] gap-2 text-[9px] leading-relaxed text-fg-muted"
                              >
                                <span className="font-mono text-[7px] text-fg-subtle">
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                                <span>{system}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                      {recipe?.authoredDimensions && (
                        <div className="grid grid-cols-2 gap-px overflow-hidden border border-border bg-border">
                          {Object.entries(recipe.authoredDimensions).map(([label, value]) => (
                            <div key={label} className="min-w-0 bg-bg/90 p-2">
                              <p
                                className="truncate text-[7px] text-fg-subtle"
                                title={titleCase(label)}
                              >
                                {titleCase(label)}
                              </p>
                              <p className="mt-1 break-words font-mono text-[8px] text-fg">
                                {Array.isArray(value)
                                  ? formatVector(value)
                                  : formatMeasurement(value)}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                      {recipe?.geometryGuarantees && recipe.geometryGuarantees.length > 0 && (
                        <div className="border border-success/25 bg-success/5 p-2.5">
                          <p className="mb-2 flex items-center gap-1.5 font-mono text-[7px] tracking-[0.1em] text-success uppercase">
                            <ShieldCheck className="h-3 w-3" /> Geometry guarantees
                          </p>
                          <ul className="space-y-1.5">
                            {recipe.geometryGuarantees.map((guarantee) => (
                              <li
                                key={guarantee}
                                className="flex gap-2 text-[9px] leading-relaxed text-fg-muted"
                              >
                                <span className="mt-[0.45em] h-1 w-1 shrink-0 bg-success" />
                                {guarantee}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!recipe && (
                        <EmptyValue>No variant-level construction recipe published.</EmptyValue>
                      )}
                    </div>
                  </section>

                  <section>
                    <SectionLabel index="06">Collision volume</SectionLabel>
                    <div className="mt-3 border border-border bg-bg/55 p-3">
                      <ColliderReadout collider={selected.collider} />
                    </div>
                  </section>

                  {compiledStats && (
                    <section>
                      <SectionLabel index="07">Compiled geometry</SectionLabel>
                      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-border bg-border">
                        {[
                          ["Meshes", compiledStats.meshCount],
                          ["Materials", compiledStats.materialCount],
                          ["Vertices", compiledStats.vertexCount],
                          ["Triangles", compiledStats.triangleCount],
                        ].map(([label, value]) => (
                          <div key={label} className="bg-bg/90 p-2.5">
                            <p className="text-[8px] text-fg-subtle">{label}</p>
                            <p className="mt-1 font-mono text-[10px] text-fg">
                              {formatInteger(value as number | undefined)}
                            </p>
                          </div>
                        ))}
                      </div>
                      {compiledStats.boundsYUpMeters?.size && (
                        <p className="mt-2 font-mono text-[8px] text-fg-subtle">
                          Bounds {formatVector(compiledStats.boundsYUpMeters.size)} m · Y-up
                        </p>
                      )}
                    </section>
                  )}

                  {selected.variant?.provenance && (
                    <section>
                      <SectionLabel index="08">Provenance</SectionLabel>
                      <div className="mt-3 space-y-2 text-[9px] leading-relaxed text-fg-muted">
                        {selected.variant.provenance.note && (
                          <p>{selected.variant.provenance.note}</p>
                        )}
                        {selected.variant.provenance.paperPages?.length ? (
                          <p className="font-mono text-[8px] text-fg-subtle">
                            Paper pages {selected.variant.provenance.paperPages.join(", ")}
                          </p>
                        ) : null}
                        {selected.variant.provenance.researchReferenceIds?.length ? (
                          <TagList values={selected.variant.provenance.researchReferenceIds} />
                        ) : null}
                      </div>
                    </section>
                  )}

                  <div className="border-t border-border pt-3 font-mono text-[7px] leading-relaxed tracking-[0.08em] text-fg-subtle uppercase">
                    Source: {state.manifest.library.uri} · {state.manifest.library.sourceUpAxis}-up
                    authored → {state.manifest.library.runtimeUpAxis}-up runtime
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {lightbox && lightboxImageUri && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightboxImageAlt}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-3 sm:p-8"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLightbox(undefined);
          }}
        >
          <div className="relative max-h-full w-full max-w-[1600px]">
            <img
              src={lightboxImageUri}
              alt={lightboxImageAlt}
              className="max-h-[88dvh] w-full border border-white/15 object-contain shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setLightbox(undefined)}
              autoFocus
              className="absolute top-2 right-2 flex h-9 items-center gap-2 border border-white/20 bg-black/80 px-3 font-mono text-[8px] tracking-[0.12em] text-white uppercase backdrop-blur-sm hover:bg-black"
            >
              <X className="h-3.5 w-3.5" /> Close · Esc
            </button>
            {lightbox.kind === "browse" && view === "turnaround" && filteredEntries.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => moveSelection(-1)}
                  disabled={selectedIndex <= 0}
                  className="absolute top-1/2 left-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center border border-white/20 bg-black/75 text-white backdrop-blur-sm disabled:opacity-25"
                  aria-label="Previous asset"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => moveSelection(1)}
                  disabled={selectedIndex >= filteredEntries.length - 1}
                  className="absolute top-1/2 right-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center border border-white/20 bg-black/75 text-white backdrop-blur-sm disabled:opacity-25"
                  aria-label="Next asset"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
