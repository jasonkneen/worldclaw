---
name: og
description: >
  Share-link previews and app identity for apps on *.grok.me: the og:image
  card in the root head, the SVG favicon, and PWA icons for installable apps.
  Use when scaffolding, renaming, or restyling the app — and for share /
  unfurl / OG / Twitter card questions. A custom 1200×630 card from the app's
  own art is the default — games of every kind (DOM board/word games
  included), whimsical apps, creative tools, and brand-forward pages; only
  plain utilities keep the placeholder. By default run the whole brand-asset
  pass in a parallel background task (the `task` tool) while the app builds.
  Triggers on "share", "rename", "app name", "OG", "Open Graph",
  "twitter card", "unfurl", "og:image", "link preview", "social card",
  "thumbnail", "preview image", "favicon", "app icon", "PWA", "manifest",
  "installable", "home screen", "SEO", "meta description".
metadata:
  short-description: "Brand assets: og.jpg card, SVG favicon, PWA icons — parallel task by default"
---

# Share cards, favicon, and app icons

A deployed app (`https://{name}.grok.me`) unfurls with a 1200×630 card, and
every app (preview included) shows a favicon in the browser tab. Both are
wired in the root `head()` — AGENTS.md § "First scaffold" is the source of
truth for `src/routes/__root.tsx`. **Extend `__root.tsx`; never replace it
wholesale** (auth SSR, redesign, another skill's excerpt). Dropping `og:image`
or the favicon link ships a broken card / blank tab icon, and `npm run dev` /
`build` will not catch it.

## Parallelize the brand-asset pass (default)

The identity bundle — `public/og.jpg`, `public/favicon.svg`, PWA icons when
installable — needs only the app's name, theme, and palette, and writes only
`public/` plus a few `head()` / manifest lines. **Start it as a background
task with the `task` tool early in the build** (AGENTS.md § "Parallel work"),
right after the name and palette are settled: give the task this skill and
sole ownership of `public/` brand assets, keep building the app, and
integrate its `head()` edits at the end (`wait_tasks` before the final
verify). Image generation is pure waiting — a build that runs the card pass
inline at the end serializes minutes of model latency behind an already
finished app.

A default, not a hard rule: stay sequential when the user is art-directing
the card, when the app art the card should reuse doesn't exist yet, or when
the `task` tool isn't available.

## Which card an app gets

**Default: generate a custom card.** Any app with a face of its own gets one
built from its own art (below):

- **Games — every kind and rendering tech.** Canvas and WebGL, but equally
  DOM-rendered board, card, word, puzzle, and quiz games. A tic-tac-toe grid
  made of divs is still a game and still ships a custom card.
- **Whimsical, playful, and toy apps** — generators, virtual pets, screensavers.
- **Creative tools** — drawing, music, photo, design, anything whose output is
  visual or expressive.
- **Content- and brand-forward apps** — landing pages, portfolios,
  storefronts, anything presenting an identity to visitors.

**When in doubt, make the custom card** — a themed card is the better unfurl
for anything a user would *show someone*.

- **Plain utility apps only** (converters, invoice/CRUD trackers, internal
  dashboards, minimal notes/admin tools — apps whose face is the data, not a
  theme) → keep the default `og.grok.me` card:

  ```
  https://og.grok.me/v1/card.png?host={VITE_PUBLIC_HOSTNAME}&title={APP_NAME}
  ```

  plus `og:image:width` / `og:image:height` of `1200` / `630`. When the user
  renames the app, update `APP_NAME` — it is both the document title and the
  painted card title.

Either way: **live preview has no `VITE_PUBLIC_HOSTNAME`, so emit no
`og:image` at all** (text-only unfurl is expected). On publish the platform
injects the hostname — do **not** write a `.env` for it. Card pixels update on
the **next deploy** (the URL is baked into HTML at build time).

## Custom card: generate `public/og.jpg`

For prompt-craft, composition, and blind read-back verification, follow the
`imagine` and `game-asset-core` skills — this skill owns the **card-specific**
contract only (size, lockup, wiring).

1. **Get a true 2:1 canvas — `generate_image` alone cannot produce one.**
   Its only ratio knob is `orientation`, and `landscape` is hard-mapped to a
   **3:2** canvas (1176×784); there is no `aspect_ratio` parameter, and ratio
   words in the prompt do **not** control the canvas. Cropping 3:2 down to
   the card's 1200×630 trims **~21% vertically** — straight through a
   centered title. Two sanctioned paths to 2:1 (which renders 1408×704, so
   the normalize below trims only ~2.5% per side and nothing vertical):

   - **Default — generate, then reframe:** `generate_image`
     (`orientation: "landscape"`) for the art + baked title, then one
     `edit_image` pass with **`aspect_ratio: "2:1"`** and a prompt like
     "extend the scenery left and right into a wider frame; keep the title
     lettering and central subject exactly as they are". `edit_image` is the
     documented ratio-change path. **Check the output dimensions** — if the
     edit came back at the source ratio (some edit paths pin to the input),
     switch to the direct path below instead of re-trying.
   - **Direct — one call, guaranteed ratio:** the xAI Images API with
     `"aspect_ratio": "2:1"` using the injected `XAI_API_KEY` (see the
     `xai-api` skill; same generator underneath): `POST
     https://api.x.ai/v1/images/generations` with `response_format:
     "b64_json"`. The API accepts `2:1` even where docs don't list it.

   Build the prompt from the app's theme, palette, and characters. If the
   app already has a key generated asset (hero sprite, title scene), feed it
   to `edit_image` so the card matches in-game art — same 2:1 +
   check-the-output rule applies.
   **Last resort only** (both paths unavailable): stay on the 3:2 canvas and
   keep the entire title block inside the **middle half** of the frame
   height, with the crop-clipping check in step 6 as the gate.
2. **Bake the title in like a game cover.** Store-page covers (Stardew Valley,
   Cuphead) lead with a short stylized logo-type title. Put the exact app name
   in quotes in the prompt; 1–3 strong words; optional short tagline under the
   title in smaller lettering (exact words in quotes).
   - **Stack multi-word titles** into a two-line lockup ("SKY" over "STRIKE").
   - **Center the block both ways** with generous margins — avoid "upper third"
     / percentage placement (models hug the edge).
   - **Bound the width**: lettering spans roughly half to two-thirds of the
     frame, never border to border.
   - **Keep comfortable margins anyway.** From a 2:1 canvas the normalize
     below trims nothing vertically and only ~2.5% per side, so the width
     bound above is the real protection. The crop only turns destructive
     when the canvas is off-ratio (a 3:2 canvas that never got reframed, an
     edit that pinned to its input's ratio, a model miss) — **check the raw
     canvas dimensions before cropping**, and re-ratio first if it isn't 2:1.
3. **Verify glyphs *and* layout on read-back** (see `imagine` / `game-asset-core`
   for the blind-describe loop). On a garble or layout miss, **regenerate with a
   corrected prompt** — never try to move a logo with `image_edit` (frame
   translation / seams). After two failed attempts, ship the card **artwork-only**
   (titleless).

   **Intentional exception vs `imagine`'s "rebuild text with code" rule:** the
   share card is a single static PNG; there is no reliable in-sandbox path to
   composite crisp code-drawn lettering onto generative art for this asset, so
   a clean titleless card is the correct fallback after two glyph failures.
4. **Normalize to exactly 1200×630 JPEG** with the baked-in ffmpeg (cover-crop —
   from a 2:1 canvas this shaves ~2.5% off each side and leaves the vertical
   composition untouched). **JPEG, not PNG**: the card is
   photographic generative art, and a PNG of it lands at 1–2 MB — heavy
   enough that link scrapers (X card previews included) time out or skip the
   image, so the card silently fails to unfurl. JPEG at this quality is
   ~150–300 KB with no visible loss at unfurl size:

   ```sh
   ffmpeg -y -i card-raw.jpg \
     -vf "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630" \
     -q:v 4 public/og.jpg
   ```

5. **Point `og:image` at the app's own asset** — absolute URL, scrapers do not
   resolve relative paths — keeping the no-host guard:

   ```tsx
   const ogImage = host ? `https://${host}/og.jpg` : undefined;
   ```

   Keep `og:image:width` / `og:image:height` at `1200` / `630`.
6. **Verify before finishing** (Pillow is installed; `ffprobe` is **not**):

   ```sh
   python3 -c "
   from PIL import Image; import os
   im = Image.open('public/og.jpg')
   kb = os.path.getsize('public/og.jpg') // 1024
   print(im.size, f'{kb} KB')"
   # expect: (1200, 630) and under 600 KB (keeps X and other scrapers
   # reliable; target <= 300 KB — if over, bump -q:v up a step and re-encode)
   ```

   **Read back the final `public/og.jpg`, not the pre-crop raw** — the crop
   is where clipping happens. This is a **hard gate, not an impression**:
   if any title glyph touches a frame edge or is visibly cut, the card is
   **rejected** — do not ship it, whatever else is right about it. Fix the
   ratio (step 1) or regenerate with the width bound restated; a shipped
   decapitated title is worse than the placeholder. Then confirm the card
   reads like *this* app at thumbnail size — clear subject, correctly
   spelled title (if any), comfortable margins.

If neither `generate_image`/`edit_image` nor the xAI Images API is available,
fall back to the `og.grok.me` card — never ship a missing or broken
`og:image` URL.

Regenerate the card when the app's visual identity materially changes (theme
overhaul, new hero art) — and on rename: the title is baked into the pixels,
so update `APP_NAME` *and* regenerate the card with the new name. (A titleless
fallback card survives a rename without regeneration.)

## Favicon: hand-author `public/favicon.svg`

Every app gets one, and it works in live preview immediately (no host needed).

- **Write the SVG by hand — never `image_gen`.** It must stay crisp at 16px:
  one bold glyph or shape, flat fills from the app's design tokens, a square
  `viewBox`, a handful of elements at most. For whimsical apps an emoji-text
  SVG is a fine quick win:

  ```svg
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#1a1b26"/>
    <text x="50" y="50" font-size="62" text-anchor="middle"
      dominant-baseline="central">🥕</text>
  </svg>
  ```

- Wire it in the root `head()`:

  ```tsx
  links: [
    { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    { rel: "stylesheet", href: appCss },
  ],
  ```

- Verify it renders non-blank and legible small (browser tab in a preview
  screenshot, or read back a rasterized copy). Update it when the app's theme
  or name changes meaning — it is part of the app's identity, not a set-and-forget.

## PWA icons: only for installable apps

When the app ships a web manifest (the user asked for installable / PWA /
home-screen behavior — do **not** invent a manifest just to have icons), add
raster icons derived from the favicon artwork so the identity stays
consistent:

- `public/icon-192.png` and `public/icon-512.png` — the favicon's glyph on
  its tile, rasterized at size. Playwright (baked into the sandbox) can
  screenshot the served `/favicon.svg` at a 192/512 viewport; or redraw the
  same mark as a flat PNG. Keep it bold and flat — no photographic detail.
- A maskable variant (`"purpose": "maskable"`) needs the glyph inside the
  center ~80% safe zone so launcher shapes don't clip it.
- Wire the manifest `icons` array plus `theme_color` / `background_color`
  from the app's design tokens, and read the 192 back to confirm it stays
  legible.

## Not supported

No `/api/og` route, no runtime image renderer, no per-route cards, no runtime
`og:*` mutation. The card is one static site-wide image chosen at build time.

If you add `robots.txt`, never blanket `Disallow: /` — crawlers must fetch `/`
to read the meta tags.
