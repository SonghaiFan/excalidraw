import { afterEach, describe, expect, it, vi } from "vitest";

import { handleFrankAIRequest, validateAIRequest } from "./ai-server";

const apiKey = "test-key-12345678901234567890";
const body = {
  provider: "openai" as const,
  apiKey,
  messages: [{ role: "user" as const, content: "Draw a plan" }],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Frank AI server", () => {
  it("rejects malformed requests before contacting a provider", async () => {
    expect(validateAIRequest({ messages: [] })).toBeNull();
    const response = await handleFrankAIRequest(
      new Request("http://localhost/api/ai", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("normalizes the provider stream into Frank Canvas events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            [
              'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
              'data: {"type":"response.completed"}\n\n',
            ].join(""),
            { status: 200 },
          ),
        ),
      ),
    );

    const response = await handleFrankAIRequest(
      new Request("http://localhost/api/ai", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      'data: {"delta":"Hello"}\n\ndata: [DONE]\n\n',
    );
  });

  it("aborts the provider request when the client disconnects", async () => {
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            providerSignal = init?.signal || undefined;
            const rejectAbort = () =>
              reject(new DOMException("Aborted", "AbortError"));
            if (providerSignal?.aborted) {
              rejectAbort();
            } else {
              providerSignal?.addEventListener("abort", rejectAbort);
            }
          }),
      ),
    );
    const controller = new AbortController();
    const responsePromise = handleFrankAIRequest({
      method: "POST",
      text: async () => JSON.stringify(body),
      signal: controller.signal,
    } as Request);

    controller.abort();
    const response = await responsePromise;

    expect(providerSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
  });

  it("keeps an active provider stream alive past sixty seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              const enqueue = (value: string) =>
                controller.enqueue(encoder.encode(value));
              setTimeout(
                () =>
                  enqueue(
                    'data: {"type":"response.output_text.delta","delta":"Still "}\n\n',
                  ),
                50_000,
              );
              setTimeout(() => {
                enqueue(
                  'data: {"type":"response.output_text.delta","delta":"working"}\n\n',
                );
                enqueue('data: {"type":"response.completed"}\n\n');
                controller.close();
              }, 100_000);
              signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status: 200 },
        );
      }),
    );

    const response = await handleFrankAIRequest(
      new Request("http://localhost/api/ai", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const result = response.text();

    await vi.advanceTimersByTimeAsync(50_000);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(await result).toBe(
      'data: {"delta":"Still "}\n\ndata: {"delta":"working"}\n\ndata: [DONE]\n\n',
    );
  });

  it("reports a provider stream that disconnects before completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
            { status: 200 },
          ),
        ),
      ),
    );

    const response = await handleFrankAIRequest(
      new Request("http://localhost/api/ai", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

    expect(await response.text()).toBe(
      'data: {"delta":"Partial"}\n\ndata: {"error":"AI stream was interrupted"}\n\n',
    );
  });
});
