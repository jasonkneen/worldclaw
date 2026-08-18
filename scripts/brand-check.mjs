/**
 * Brand-asset gate shared by browser-smoke.mjs (and unit-testable without a
 * browser): a canvas app is almost always a game / visually rich app, and
 * those must ship a custom share card — the default og.grok.me placeholder is
 * not acceptable for them (see .grok/skills/og/SKILL.md).
 *
 * Checked on the filesystem (not the served head) because live preview has no
 * VITE_PUBLIC_HOSTNAME and renders no og:image tag at all, so the page alone
 * can't reveal the placeholder.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Over this, link scrapers (X card previews included) time out or skip the
// image, so the card silently fails to unfurl. The og skill's JPEG contract
// (ffmpeg -q:v 4, ~150-300 KB) exists precisely to stay under it.
export const MAX_CARD_BYTES = 600 * 1024;

export function computeBrandWarnings({ hasCanvas, workspaceRoot = "/workspace" }) {
  const skillPath = join(workspaceRoot, ".grok/skills/og/SKILL.md");
  const rootTsxPath = join(workspaceRoot, "src/routes/__root.tsx");
  const rootTsx = existsSync(rootTsxPath) ? readFileSync(rootTsxPath, "utf8") : "";
  const cardPath = [
    join(workspaceRoot, "public/og.jpg"),
    join(workspaceRoot, "public/og.png"),
  ].find(existsSync);

  // A shipped card is validated the same way for every app type.
  if (cardPath !== undefined) {
    if (rootTsx.includes("og.grok.me")) {
      return [
        `BRAND WARNING: ${cardPath} exists but src/routes/__root.tsx still points og:image `
          + 'at the og.grok.me placeholder. Wire og:image to "https://${host}/og.jpg" per '
          + `${skillPath}.`,
      ];
    }
    if (statSync(cardPath).size > MAX_CARD_BYTES) {
      return [
        `BRAND WARNING: ${cardPath} is over 600 KB — link scrapers (X card previews included) `
          + "time out or skip images this heavy, so the card silently fails to unfurl. "
          + `Re-encode as JPEG (public/og.jpg, ffmpeg -q:v 4) per ${skillPath}.`,
      ];
    }
    return [];
  }

  // No card. Canvas is a high-confidence game signal — hard warning.
  if (hasCanvas) {
    return [
      `BRAND WARNING: this looks like a game/canvas app but ${workspaceRoot}/public/og.jpg `
        + "is missing. Games and visually rich apps must ship a custom 1200x630 share card "
        + "built from the app's own art — the default og.grok.me placeholder card is not "
        + `acceptable for them. You are not done: open ${skillPath} and finish the `
        + "brand-asset pass.",
    ];
  }
  // No canvas but the placeholder is wired: custom cards are the DEFAULT
  // (DOM games, whimsical apps, creative tools, brand-forward pages) — only
  // plain utilities keep the placeholder. Softer prefix: for a genuine
  // utility this note is correctly dismissed, not acted on.
  if (rootTsx.includes("og.grok.me")) {
    return [
      "BRAND NOTE: og:image is still the og.grok.me placeholder. Custom public/og.jpg "
        + "cards are the default for games of every kind (DOM board/word games included), "
        + "whimsical apps, creative tools, and brand-forward pages — only plain utilities "
        + "(converters, CRUD trackers, admin dashboards) keep the placeholder. If this app "
        + `is not a plain utility, finish the brand-asset pass per ${skillPath}.`,
    ];
  }
  return [];
}
