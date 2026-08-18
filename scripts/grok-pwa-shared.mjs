/**
 * Single source of truth for the platform PWA chrome, shared by the dev/preview
 * Vite plugin (scripts/grok-pwa-plugin.mjs) and the deployed-app Nitro
 * middleware (server/middleware/grok-pwa.ts). Plain ESM so `node --test` and
 * the Nitro bundler can both consume it.
 */

export const DEFAULT_APP_NAME = "Grok App";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * "wild-race.grok.me" → "Wild Race". Host headers are attacker-controlled, so
 * anything outside a plain [a-z0-9-] slug falls back to the default name.
 */
export function appNameFromHost(hostHeader) {
  const host = String(hostHeader ?? "")
    .split(",")[0]
    .trim()
    .split(":")[0]
    .toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".local") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
  ) {
    return DEFAULT_APP_NAME;
  }
  const slug = host.split(".")[0] ?? "";
  if (!slug || slug === "www" || !/^[a-z0-9-]{1,63}$/.test(slug)) {
    return DEFAULT_APP_NAME;
  }
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || DEFAULT_APP_NAME
  );
}

export function isInstallQuery(url) {
  const query = String(url ?? "").split("?", 2)[1] ?? "";
  const params = new URLSearchParams(query);
  const install = params.get("install");
  const platform = (params.get("platform") ?? "").toLowerCase();
  return (install === "1" || install === "true") && platform === "ios";
}

/** Paths that can carry an app document (vs assets / API / internals). */
export function isDocumentPath(pathname) {
  const path = String(pathname ?? "");
  return (
    !path.startsWith("/__grok/") &&
    !path.startsWith("/api/") &&
    !path.startsWith("/@") &&
    !path.startsWith("/node_modules") &&
    !/\.[a-z0-9]+$/i.test(path)
  );
}

export function acceptsHtml(accept) {
  const value = String(accept ?? "");
  return value === "" || value.includes("text/html") || value.includes("*/*");
}

/** The same URL without the install-tutorial params (used as the app link). */
export function stripInstallParams(url) {
  const [path = "/", query = ""] = String(url ?? "/").split("?", 2);
  const params = new URLSearchParams(query);
  params.delete("install");
  params.delete("platform");
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

export function renderInstallPageHtml(template, { host, url } = {}) {
  return String(template)
    .replaceAll("{{APP_NAME}}", escapeHtml(appNameFromHost(host)))
    .replaceAll("{{APP_URL}}", escapeHtml(stripInstallParams(url)));
}

export function renderWebManifest(hostHeader) {
  const name = appNameFromHost(hostHeader);
  return JSON.stringify(
    {
      name,
      short_name: name,
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      icons: [
        {
          src: "/__grok/icon-180.png",
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
    null,
    2,
  );
}

export function grokPwaHeadTags(appName = DEFAULT_APP_NAME) {
  return [
    // Standalone display comes from the manifest ("display": "standalone");
    // the legacy *-web-app-capable metas it replaces are deliberately absent.
    ["manifest", '<link rel="manifest" href="/__grok/manifest.webmanifest">'],
    ["apple-touch-icon", '<link rel="apple-touch-icon" href="/__grok/icon-180.png">'],
    [
      "apple-mobile-web-app-title",
      `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appName)}">`,
    ],
    [
      "apple-mobile-web-app-status-bar-style",
      '<meta name="apple-mobile-web-app-status-bar-style" content="black">',
    ],
    ["theme-color", '<meta name="theme-color" content="#000000">'],
  ];
}

export function injectGrokPwaHead(html, appName = DEFAULT_APP_NAME) {
  if (typeof html !== "string") return html;
  const missing = grokPwaHeadTags(appName)
    .filter(([key]) => {
      if (key === "manifest") return !html.includes('href="/__grok/manifest.webmanifest"');
      if (key === "apple-touch-icon") return !html.includes('href="/__grok/icon-180.png"');
      return !html.includes(`name="${key}"`);
    })
    .map(([, tag]) => tag);
  if (missing.length === 0) return html;
  const snippet = missing.join("");
  if (html.includes("</head>")) return html.replace("</head>", `${snippet}</head>`);
  if (html.includes("<head>")) return html.replace("<head>", `<head>${snippet}`);
  return html;
}

const HEAD_CLOSE = Buffer.from("</head>");

/**
 * Streaming head injector: buffers only until `</head>` (multi-byte safe — the
 * marker is pure ASCII, which never appears inside a UTF-8 continuation byte),
 * injects any missing tags there, then passes every later chunk through
 * untouched so streaming SSR keeps streaming.
 */
export function createHeadInjector(appName = DEFAULT_APP_NAME) {
  /** @type {Buffer[]} */
  let pending = [];
  let done = false;

  return {
    /** @param {Uint8Array | string} chunk @returns {Buffer[]} chunks ready to emit */
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (done) return [buf];
      pending.push(buf);
      const joined = Buffer.concat(pending);
      const at = joined.indexOf(HEAD_CLOSE);
      if (at === -1) return [];
      done = true;
      pending = [];
      const head = injectGrokPwaHead(joined.subarray(0, at).toString("utf8") + "</head>", appName);
      return [Buffer.concat([Buffer.from(head, "utf8"), joined.subarray(at + HEAD_CLOSE.length)])];
    },
    /** @returns {Buffer[]} whatever is still buffered (no `</head>` seen) */
    flush() {
      if (done || pending.length === 0) return [];
      const rest = Buffer.concat(pending);
      pending = [];
      done = true;
      return [Buffer.from(injectGrokPwaHead(rest.toString("utf8"), appName), "utf8")];
    },
  };
}
