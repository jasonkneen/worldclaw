/**
 * Top branding bar for deployed apps. Shown only when live
 * GetRemixEligibility reports forkable. Project id is the sole VITE_ input
 * (needed to call the RPC and build the remix link).
 */
"use client";

import { useEffect, useState } from "react";

const BANNER_HEIGHT = "2.75rem";
const BANNER_HEIGHT_VAR = "--grok-banner-h";
const REMIX_ELIGIBILITY_PATH = "/rest/app-deployer/v1/projects/{project_id}/remix-eligibility";

function readEnv(key: string): string | undefined {
  const vite = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const fromVite = vite?.[key];
  if (fromVite !== undefined && fromVite !== "") return fromVite;
  return undefined;
}

function remixEligibilityUrl(projectId: string): string {
  return `https://app-builder-deployer.grok.com${REMIX_ELIGIBILITY_PATH.replace(
    "{project_id}",
    encodeURIComponent(projectId),
  )}`;
}

async function fetchRemixEligible(projectId: string): Promise<boolean> {
  try {
    const response = await fetch(remixEligibilityUrl(projectId), {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("forkable" in data)) return false;
    return data.forkable === true;
  } catch {
    return false;
  }
}

function RemixIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="block size-3.5 shrink-0"
      aria-hidden
    >
      <path
        d="M2.85059 3.5C3.42171 3.49757 3.9879 3.74949 4.36816 4.17562C5.82851 5.79822 7.28852 7.42134 8.74886 9.04394C8.91014 9.22468 9.14982 9.3323 9.39201 9.33333C9.39445 9.33335 9.39697 9.33333 9.39941 9.33333C9.69335 9.33354 9.98729 9.34136 10.2812 9.35612L9.50423 8.5791L10.3291 7.75423L12.4915 9.91667L10.3291 12.0791L9.50423 11.2542L10.2812 10.4766C9.98728 10.4914 9.69336 10.4998 9.39941 10.5C9.39371 10.5 9.38802 10.5 9.38232 10.5C8.81697 10.4976 8.25832 10.2462 7.88184 9.82438C6.42149 8.20178 4.96148 6.57866 3.50114 4.95605C3.33823 4.77345 3.09529 4.66561 2.85059 4.66667H1.75V3.5H2.85059Z"
        fill="#417CFF"
      />
      <path
        d="M5.53597 8.52612C5.14663 8.95882 4.75754 9.39174 4.36816 9.82438C3.9879 10.2505 3.42171 10.5024 2.85059 10.5H1.75V9.33333H2.85059C3.09529 9.33439 3.33823 9.22655 3.50114 9.04394C3.91804 8.58073 4.33469 8.11725 4.75155 7.65397L5.53597 8.52612Z"
        fill="#417CFF"
      />
      <path
        d="M12.4915 4.08333L10.3291 6.24577L9.50423 5.4209L10.2801 4.64445C9.99185 4.65884 9.70361 4.66667 9.41536 4.66667H9.39941C9.15471 4.66561 8.91177 4.77346 8.74886 4.95605C8.33197 5.41926 7.91473 5.88219 7.49788 6.34546L6.71346 5.47331C7.10279 5.04063 7.49247 4.60825 7.88184 4.17562C8.2621 3.74949 8.8283 3.49757 9.39941 3.5H9.41536C9.7036 3.5 9.99186 3.50726 10.2801 3.52165L9.50423 2.74577L10.3291 1.9209L12.4915 4.08333Z"
        fill="#417CFF"
      />
    </svg>
  );
}

export function CreatedWithGrokBanner() {
  const projectId = (readEnv("VITE_PROJECT_ID") ?? "").trim();
  const [showRemix, setShowRemix] = useState(false);

  useEffect(() => {
    if (projectId.length === 0) return;
    void fetchRemixEligible(projectId).then(setShowRemix);
  }, [projectId]);

  if (!showRemix) return null;

  return (
    <div
      className="pointer-events-none fixed top-2 left-0 right-0 z-[100] flex justify-center"
      data-created-with-grok-banner
    >
      {/* Inline style: the clearance var must be in SSR HTML or layouts
          using it jump after hydration. */}
      <style>{`:root{${BANNER_HEIGHT_VAR}:${BANNER_HEIGHT};}`}</style>
      <a
        href={`https://grok.com/remix?app_id=${encodeURIComponent(projectId)}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Created with Grok — Remix this app"
        className={
          "group pointer-events-auto flex h-9 select-none items-center gap-2 rounded-full " +
          "border border-white/15 bg-black/85 backdrop-blur-md " +
          "shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.08)] " +
          "pl-4 pr-1.5 text-[13px] leading-none text-white/90"
        }
      >
        <span className="font-medium tracking-tight text-white/85">Created with Grok</span>
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-2.5 text-[12px] font-medium text-white transition-colors group-hover:bg-white/15">
          <RemixIcon />
          Remix
        </span>
      </a>
    </div>
  );
}
