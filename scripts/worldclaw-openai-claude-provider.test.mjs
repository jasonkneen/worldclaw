import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasOpenAIKey,
  hasOpenAiKey,
  openaiImage,
  openaiTextJson,
  openaiVisionJson,
} from "../src/lib/worldclaw/openai.server.ts";
import {
  claudeTextJson,
  claudeVisionJson,
  hasAiGatewayKey,
  hasClaudeKey,
} from "../src/lib/worldclaw/claude.server.ts";

const ENV_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_TEXT_MODEL",
  "OPENAI_IMAGE_MODEL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "CLAUDE_MODEL",
];

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const name of ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function responseOutput(text, model = "gpt-5.6-sol", id = "resp_openai_test") {
  return {
    id,
    model,
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

function chatOutput(
  text,
  finishReason = "stop",
  model = "anthropic/claude-opus-5",
  id = "chatcmpl_claude_test",
) {
  return {
    id,
    model,
    choices: [
      {
        finish_reason: finishReason,
        message: { role: "assistant", content: text },
      },
    ],
  };
}

test("OpenAI and Claude defaults authenticate only in server headers and preserve identity", async () => {
  const requests = [];
  await withEnvironment(
    {
      OPENAI_API_KEY: "openai-server-secret",
      AI_GATEWAY_API_KEY: "gateway-server-secret",
    },
    async () => {
      await withMockFetch(
        async (url, init) => {
          const request = {
            url: String(url),
            headers: new Headers(init?.headers),
            body: String(init?.body),
          };
          requests.push(request);
          const payload = request.url.includes("ai-gateway.vercel.sh")
            ? chatOutput('```json\n{"judge":"claude"}\n```')
            : responseOutput('{"planner":"openai"}');
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        async () => {
          assert.equal(hasOpenAIKey(), true);
          assert.equal(hasOpenAiKey(), true);
          assert.equal(hasClaudeKey(), true);
          assert.equal(hasAiGatewayKey(), true);

          const openai = await openaiTextJson({
            system: "Plan a scene as JSON.",
            user: "Make a forest world.",
          });
          const claude = await claudeTextJson({
            system: "Review a scene as JSON.",
            user: "Rate the forest world.",
          });

          assert.deepEqual(openai, {
            text: '{"planner":"openai"}',
            provider: "openai",
            model: "gpt-5.6-sol",
            responseId: "resp_openai_test",
          });
          assert.deepEqual(claude, {
            text: '{"judge":"claude"}',
            provider: "anthropic",
            model: "anthropic/claude-opus-5",
            responseId: "chatcmpl_claude_test",
          });
        },
      );
    },
  );

  assert.equal(requests.length, 2);
  const openaiRequest = requests[0];
  const claudeRequest = requests[1];
  assert.equal(openaiRequest.url, "https://api.openai.com/v1/responses");
  assert.equal(openaiRequest.headers.get("authorization"), "Bearer openai-server-secret");
  assert.equal(JSON.parse(openaiRequest.body).model, "gpt-5.6-sol");
  assert.deepEqual(JSON.parse(openaiRequest.body).text, {
    format: { type: "json_object" },
  });
  assert.match(JSON.parse(openaiRequest.body).input[0].content[0].text, /JSON object/);
  assert.equal(claudeRequest.url, "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(claudeRequest.headers.get("authorization"), "Bearer gateway-server-secret");
  assert.equal(JSON.parse(claudeRequest.body).model, "anthropic/claude-opus-5");
  assert.equal(JSON.parse(claudeRequest.body).response_format, undefined);
  for (const request of requests) {
    assert.doesNotMatch(request.url, /server-secret/);
    assert.doesNotMatch(request.body, /server-secret/);
  }
});

test("provider model defaults are overridable without changing endpoint identity", async () => {
  const models = [];
  await withEnvironment(
    {
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_TEXT_MODEL: "gpt-5.6-terra",
      OPENAI_IMAGE_MODEL: "gpt-image-2-2026-04-21",
      AI_GATEWAY_API_KEY: "gateway-test-key",
      CLAUDE_MODEL: "anthropic/claude-opus-4.8",
    },
    async () => {
      await withMockFetch(
        async (url, init) => {
          const isForm = init?.body instanceof FormData;
          const body = isForm ? init.body : JSON.parse(String(init?.body));
          models.push(isForm ? body.get("model") : body.model);
          const payload = String(url).includes("/images/")
            ? { data: [{ b64_json: "dGVzdA==" }] }
            : String(url).includes("ai-gateway.vercel.sh")
              ? chatOutput('{"ok":true}', "stop", body.model, "chatcmpl_claude_override")
              : responseOutput('{"ok":true}', body.model, "resp_openai_override");
          return new Response(JSON.stringify(payload), { status: 200 });
        },
        async () => {
          const openai = await openaiTextJson({
            system: "Return JSON.",
            user: "Plan.",
          });
          const image = await openaiImage({ prompt: "Terrain" });
          const claude = await claudeTextJson({
            system: "Return JSON.",
            user: "Review.",
          });
          assert.equal(openai.model, "gpt-5.6-terra");
          assert.equal(image.model, "gpt-image-2-2026-04-21");
          assert.equal(claude.model, "anthropic/claude-opus-4.8");
        },
      );
    },
  );
  assert.deepEqual(models, [
    "gpt-5.6-terra",
    "gpt-image-2-2026-04-21",
    "anthropic/claude-opus-4.8",
  ]);
});

test("OpenAI and Gateway responses fail closed on missing or mismatched attestation", async () => {
  const payloads = [
    responseOutput('{"ok":true}', "gpt-5.5", "resp_openai_wrong_model"),
    { ...responseOutput('{"ok":true}'), id: undefined },
    { ...responseOutput('{"ok":true}'), model: undefined },
    chatOutput(
      '{"ok":true}',
      "stop",
      "anthropic/claude-opus-4.9",
      "chatcmpl_claude_wrong_model",
    ),
    { ...chatOutput('{"ok":true}'), model: undefined },
    { ...chatOutput('{"ok":true}'), id: undefined },
  ];
  await withEnvironment(
    {
      OPENAI_API_KEY: "openai-test-key",
      AI_GATEWAY_API_KEY: "gateway-test-key",
    },
    async () => {
      await withMockFetch(
        async () => new Response(JSON.stringify(payloads.shift()), { status: 200 }),
        async () => {
          await assert.rejects(
            openaiTextJson({ system: "Return JSON.", user: "Plan." }),
            /provider model mismatch: requested gpt-5\.6-sol, received gpt-5\.5/,
          );
          await assert.rejects(
            openaiTextJson({ system: "Return JSON.", user: "Plan." }),
            /no valid response identifier/,
          );
          await assert.rejects(
            openaiTextJson({ system: "Return JSON.", user: "Plan." }),
            /no valid provider model identity/,
          );
          await assert.rejects(
            claudeTextJson({ system: "Return JSON.", user: "Review." }),
            /provider model mismatch: requested anthropic\/claude-opus-5, received anthropic\/claude-opus-4\.9/,
          );
          await assert.rejects(
            claudeTextJson({ system: "Return JSON.", user: "Review." }),
            /no valid provider model identity/,
          );
          await assert.rejects(
            claudeTextJson({ system: "Return JSON.", user: "Review." }),
            /no valid response identifier/,
          );
        },
      );
    },
  );
});

test("vision requests use current multimodal formats and reject image budget violations before fetch", async () => {
  const requests = [];
  await withEnvironment(
    {
      OPENAI_API_KEY: "openai-test-key",
      AI_GATEWAY_API_KEY: "gateway-test-key",
    },
    async () => {
      await withMockFetch(
        async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(
            JSON.stringify(
              String(url).includes("ai-gateway.vercel.sh")
                ? chatOutput('{"ok":true}')
                : responseOutput('{"ok":true}'),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
        async () => {
          const image = { mime: "image/png", b64: "dGVzdA==" };
          await openaiVisionJson({
            system: "Return JSON.",
            user: "Inspect the reference.",
            images: [image],
          });
          await claudeVisionJson({
            system: "Return JSON.",
            user: "Cross-check the reference.",
            images: [image],
          });

          const tooMany = Array.from({ length: 5 }, () => image);
          await assert.rejects(
            openaiVisionJson({
              system: "Return JSON.",
              user: "Inspect.",
              images: tooMany,
            }),
            /at most 4 images/,
          );
          await assert.rejects(
            claudeVisionJson({
              system: "Return JSON.",
              user: "Inspect.",
              images: tooMany,
            }),
            /at most 4 images/,
          );
          await assert.rejects(
            openaiVisionJson({
              system: "Return JSON.",
              user: "Inspect.",
              images: [{ mime: "image/png", b64: "not-base64!" }],
            }),
            /malformed base64/,
          );

          const overEightMiB = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
          await assert.rejects(
            claudeVisionJson({
              system: "Return JSON.",
              user: "Inspect.",
              images: [{ mime: "image/png", b64: overEightMiB }],
            }),
            /byte budget/,
          );
          await assert.rejects(
            openaiTextJson({
              system: "x".repeat(32_001),
              user: "Inspect.",
            }),
            /system prompt exceeds the 32000-character budget/,
          );
          await assert.rejects(
            claudeTextJson({
              system: "Return JSON.",
              user: "x".repeat(64_001),
            }),
            /user prompt exceeds the 64000-character budget/,
          );
        },
      );
    },
  );

  assert.equal(requests.length, 2, "invalid inputs must not reach a provider");
  const openaiContent = requests[0].body.input[0].content;
  assert.deepEqual(openaiContent[1], {
    type: "input_image",
    image_url: "data:image/png;base64,dGVzdA==",
    detail: "high",
  });
  const claudeContent = requests[1].body.messages[1].content;
  assert.deepEqual(claudeContent[1], {
    type: "image_url",
    image_url: {
      url: "data:image/png;base64,dGVzdA==",
      detail: "high",
    },
  });
});

test("GPT Image 2 uses generations without references and multipart edits with references", async () => {
  const requests = [];
  await withEnvironment({ OPENAI_API_KEY: "openai-image-secret" }, async () => {
    await withMockFetch(
      async (url, init) => {
        requests.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: init?.body,
        });
        return new Response(JSON.stringify({ data: [{ b64_json: "dGVzdA==" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        const generated = await openaiImage({
          prompt: "A top-down terrain map",
          outputFormat: "jpeg",
        });
        const edited = await openaiImage({
          prompt: "Preserve the coastline and add a settlement",
          referenceImages: [
            { mime: "image/png", b64: "dGVzdA==" },
            { mime: "image/jpeg", b64: "dGVzdDI=" },
          ],
        });
        assert.deepEqual(generated, {
          b64: "dGVzdA==",
          mime: "image/jpeg",
          provider: "openai",
          model: "gpt-image-2",
        });
        assert.deepEqual(edited, {
          b64: "dGVzdA==",
          mime: "image/png",
          provider: "openai",
          model: "gpt-image-2",
        });
      },
    );
  });

  assert.equal(requests[0].url, "https://api.openai.com/v1/images/generations");
  const generationBody = JSON.parse(String(requests[0].body));
  assert.equal(generationBody.model, "gpt-image-2");
  assert.equal(generationBody.output_format, "jpeg");
  assert.equal(requests[0].headers.get("content-type"), "application/json");
  assert.equal(requests[1].url, "https://api.openai.com/v1/images/edits");
  assert.ok(requests[1].body instanceof FormData);
  assert.equal(requests[1].headers.get("authorization"), "Bearer openai-image-secret");
  assert.equal(
    requests[1].headers.has("content-type"),
    false,
    "fetch must add the multipart boundary",
  );
  const formEntries = [...requests[1].body.entries()];
  assert.equal(formEntries.filter(([name]) => name === "image[]").length, 2);
  assert.equal(requests[1].body.get("model"), "gpt-image-2");
  assert.equal(requests[1].body.get("output_format"), "png");
  assert.equal(requests[1].body.get("prompt"), "Preserve the coastline and add a settlement");
  assert.doesNotMatch(String(requests[1].body.get("prompt")), /image-secret/);
});

test("caller abort and hard timeouts propagate to provider fetches", async () => {
  const observedSignals = [];
  const heldFetch = async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observedSignals.push(signal);
    return new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };

  await withEnvironment(
    {
      OPENAI_API_KEY: "openai-test-key",
      AI_GATEWAY_API_KEY: "gateway-test-key",
    },
    async () => {
      await withMockFetch(heldFetch, async () => {
        const controller = new AbortController();
        const openaiRequest = openaiTextJson({
          system: "Return JSON.",
          user: "Plan.",
          signal: controller.signal,
          timeoutMs: 5_000,
        });
        controller.abort();
        await assert.rejects(openaiRequest, /OpenAI text cancelled/);

        await assert.rejects(
          claudeTextJson({
            system: "Return JSON.",
            user: "Review.",
            timeoutMs: 10,
          }),
          /Claude Gateway text timed out after 10ms/,
        );
      });

      await assert.rejects(
        openaiImage({
          prompt: "Terrain",
          timeoutMs: 240_001,
        }),
        /must be an integer from 1 to 240000/,
      );
    },
  );

  // The pre-dispatch seam sees an already-aborted caller before OpenAI fetch;
  // only the Claude hard-timeout request reaches the transport.
  assert.equal(observedSignals.length, 1);
  assert.ok(observedSignals.every((signal) => signal.aborted));
});

test("malformed, truncated, oversized, and secret-bearing provider responses fail closed", async () => {
  let requestNumber = 0;
  await withEnvironment(
    {
      OPENAI_API_KEY: "openai-do-not-leak",
      AI_GATEWAY_API_KEY: "gateway-do-not-leak",
    },
    async () => {
      await withMockFetch(
        async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return new Response(JSON.stringify(responseOutput('{"broken":')), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (requestNumber === 2) {
            return new Response(JSON.stringify(chatOutput('{"ok":true}')), {
              status: 200,
              headers: { "content-length": String(2 * 1024 * 1024 + 1) },
            });
          }
          if (requestNumber === 3) {
            return new Response("gateway-do-not-leak openai-do-not-leak upstream diagnostic", {
              status: 401,
              headers: { "x-request-id": "safe-request-123" },
            });
          }
          if (requestNumber === 4) {
            return new Response(JSON.stringify(chatOutput('{"partial":true}', "length")), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ data: [{ b64_json: "invalid!" }] }), {
            status: 200,
          });
        },
        async () => {
          await assert.rejects(
            openaiTextJson({ system: "Return JSON.", user: "Plan." }),
            /invalid JSON output/,
          );
          await assert.rejects(
            claudeTextJson({ system: "Return JSON.", user: "Review." }),
            /response exceeds the output budget/,
          );
          await assert.rejects(
            openaiTextJson({ system: "Return JSON.", user: "Plan." }),
            (error) => {
              assert.match(error.message, /HTTP 401 \(safe-request-123\)/);
              assert.doesNotMatch(error.message, /do-not-leak|upstream diagnostic/);
              return true;
            },
          );
          await assert.rejects(
            claudeTextJson({ system: "Return JSON.", user: "Review." }),
            /truncated response/,
          );
          await assert.rejects(openaiImage({ prompt: "Terrain" }), /malformed base64 image data/);
        },
      );
    },
  );
});

test("availability helpers and calls fail closed when server keys are absent", async () => {
  await withEnvironment({}, async () => {
    assert.equal(hasOpenAIKey(), false);
    assert.equal(hasClaudeKey(), false);
    let fetchCalled = false;
    await withMockFetch(
      async () => {
        fetchCalled = true;
        throw new Error("fetch should not run");
      },
      async () => {
        await assert.rejects(
          openaiTextJson({ system: "Return JSON.", user: "Plan." }),
          /OPENAI_API_KEY is not configured/,
        );
        await assert.rejects(
          claudeTextJson({ system: "Return JSON.", user: "Review." }),
          /AI_GATEWAY_API_KEY is not configured/,
        );
      },
    );
    assert.equal(fetchCalled, false);
  });
});
