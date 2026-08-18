import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORLDCLAW_SERVER_ENV_KEYS = Object.freeze([
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "XAI_TEXT_MODEL",
  "GEMINI_TEXT_MODEL",
  "GEMINI_IMAGE_MODEL",
  "OPENAI_TEXT_MODEL",
  "OPENAI_IMAGE_MODEL",
  "CLAUDE_MODEL",
]);

const ALLOWED = new Set(WORLDCLAW_SERVER_ENV_KEYS);

export function parseWorldclawEnvFile(contents) {
  const values = {};
  if (typeof contents !== "string") return values;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!ALLOWED.has(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    values[key] = value;
  }
  return values;
}

export function applyWorldclawEnvValues(values, env = process.env) {
  const applied = [];
  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED.has(key) || typeof value !== "string" || !value.trim()) continue;
    if (env[key]?.trim()) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** Load `.xai_env` into process.env without overwriting a value already set. */
export function loadWorldclawServerEnv(root = process.cwd()) {
  const filePath = resolve(root, ".xai_env");
  if (!existsSync(filePath)) return { loaded: false, applied: [] };
  const values = parseWorldclawEnvFile(readFileSync(filePath, "utf8"));
  return { loaded: true, applied: applyWorldclawEnvValues(values) };
}

export { WORLDCLAW_SERVER_ENV_KEYS };
