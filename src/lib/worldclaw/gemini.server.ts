/**
 * Server-only Gemini client for WorldClaw agents — companion provider to
 * xAI. Text planning uses GEMINI_TEXT_MODEL (default gemini-3.6-flash);
 * layout images use GEMINI_IMAGE_MODEL (default gemini-3.1-flash-image).
 * Uses process.env.GEMINI_API_KEY — never expose to the client.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";

const TEXT_MODEL = () =>
  process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash";
const IMAGE_MODEL = () =>
  process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";

function getKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Gemini inference requires an API key.",
    );
  }
  return key;
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  error?: { message?: string };
}

async function generateContent(
  model: string,
  body: Record<string, unknown>,
): Promise<GeminiPart[]> {
  const res = await fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": getKey(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gemini ${model} failed ${res.status}: ${err.slice(0, 240)}`);
  }
  const data = (await res.json()) as GeminiResponse;
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts?.length) {
    throw new Error(
      `Gemini ${model} returned no content: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return parts;
}

export async function geminiChat(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}): Promise<string> {
  const parts = await generateContent(opts.model ?? TEXT_MODEL(), {
    system_instruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxTokens ?? 4096,
    },
  });
  // Thinking models may interleave thought parts — keep answer text only.
  // maxOutputTokens includes thinking tokens, so a thought-only response is
  // possible; surface it as an error so callers can fall back or retry.
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error(
      "Gemini returned no answer text (output budget may have been consumed by thinking tokens)",
    );
  }
  return text;
}

export async function geminiImage(opts: {
  prompt: string;
  model?: string;
}): Promise<{ b64: string; mime: string }> {
  const parts = await generateContent(opts.model ?? IMAGE_MODEL(), {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    },
  });
  const img = parts.find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) {
    throw new Error("Gemini image returned no inline image data");
  }
  return {
    b64: img.inlineData.data,
    mime: img.inlineData.mimeType ?? "image/jpeg",
  };
}
