/**
 * Server-only xAI client for WorldClaw agents.
 * Uses process.env.XAI_API_KEY — never expose to the client.
 */

const API = "https://api.x.ai/v1";

function getKey(): string {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "XAI_API_KEY is not configured. WorldClaw inference requires an xAI API key.",
    );
  }
  return key;
}

export async function xaiChat(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}): Promise<string> {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "grok-4.5",
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 4096,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`xAI chat failed ${res.status}: ${err.slice(0, 240)}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return body.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function xaiImage(opts: {
  prompt: string;
  quality?: boolean;
}): Promise<{ b64: string; mime: string }> {
  const res = await fetch(`${API}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model: opts.quality
        ? "grok-imagine-image-quality"
        : "grok-imagine-image",
      prompt: opts.prompt,
      n: 1,
      response_format: "b64_json",
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`xAI image failed ${res.status}: ${err.slice(0, 240)}`);
  }
  const body = (await res.json()) as {
    data?: { b64_json?: string; url?: string }[];
  };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("xAI image returned no data");
  return { b64, mime: "image/jpeg" };
}

export function parseJsonFromLlm<T>(text: string): T {
  // strip markdown fences if present
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // try direct parse
  try {
    return JSON.parse(s) as T;
  } catch {
    // extract first {...}
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as T;
    }
    throw new Error("LLM did not return valid JSON");
  }
}

export function hasXaiKey(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}
