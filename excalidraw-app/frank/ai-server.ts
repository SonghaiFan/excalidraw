type AIMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AIProvider = "openai" | "deepseek";

type AIRequestBody = {
  provider?: AIProvider;
  apiKey?: string;
  messages?: AIMessage[];
};

type FrankAIOptions = {
  openAIKey?: string;
  openAIModel?: string;
};

const SYSTEM_PROMPT =
  "You are the thinking and drawing partner inside Frank Canvas. Return a complete, well-structured Markdown answer using headings, paragraphs, lists, quotes, code blocks, and compact Markdown tables when useful. If a visual diagram materially improves the answer, include one simple fenced mermaid flowchart after the explanation. Never wrap the whole answer in a code fence.";

const jsonResponse = (status: number, error: string) =>
  Response.json({ error }, { status });

export const validateAIRequest = (
  body: AIRequestBody,
  fallbackKey?: string,
) => {
  const provider = body.provider || "openai";
  const apiKey = body.apiKey?.trim() || fallbackKey;
  const messages = body.messages;
  const isValid =
    (provider === "openai" || provider === "deepseek") &&
    typeof apiKey === "string" &&
    apiKey.length >= 20 &&
    apiKey.length <= 256 &&
    !/\s/.test(apiKey) &&
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= 12 &&
    messages.every(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0 &&
        message.content.length <= 8_000,
    ) &&
    messages.at(-1)?.role === "user";

  return isValid ? { provider, apiKey, messages } : null;
};

const createAbortController = (requestSignal: AbortSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (requestSignal.aborted) {
    controller.abort();
  } else {
    requestSignal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, 60_000);
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", abort);
    },
  };
};

export const handleFrankAIRequest = async (
  request: Request,
  { openAIKey, openAIModel = "gpt-5.4-mini" }: FrankAIOptions = {},
) => {
  if (request.method !== "POST") {
    return jsonResponse(405, "Method not allowed");
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse(400, "Invalid request body");
  }
  if (rawBody.length > 64_000) {
    return jsonResponse(413, "Request is too large");
  }

  let body: AIRequestBody;
  try {
    body = JSON.parse(rawBody) as AIRequestBody;
  } catch {
    return jsonResponse(400, "Invalid request body");
  }
  const configuration = validateAIRequest(body, openAIKey);
  if (!configuration) {
    return jsonResponse(400, "Invalid AI configuration");
  }

  const { provider, apiKey, messages } = configuration;
  const isDeepSeek = provider === "deepseek";
  const abort = createAbortController(request.signal);
  let providerResponse: Response;
  try {
    providerResponse = await fetch(
      isDeepSeek
        ? "https://api.deepseek.com/chat/completions"
        : "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          isDeepSeek
            ? {
                model: "deepseek-v4-flash",
                messages: [
                  { role: "system", content: SYSTEM_PROMPT },
                  ...messages,
                ],
                max_tokens: 2400,
                stream: true,
              }
            : {
                model: openAIModel,
                store: false,
                instructions: SYSTEM_PROMPT,
                input: messages,
                max_output_tokens: 2400,
                stream: true,
              },
        ),
        signal: abort.controller.signal,
      },
    );
  } catch (error) {
    abort.dispose();
    if (abort.controller.signal.aborted) {
      return jsonResponse(499, "AI request was cancelled");
    }
    console.error("Frank AI provider connection failed", error);
    return jsonResponse(502, "Unable to reach the AI provider");
  }

  if (!providerResponse.ok) {
    const data = (await providerResponse.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    console.error(`${provider} request failed:`, data?.error?.message);
    abort.dispose();
    return jsonResponse(502, `${provider} request failed`);
  }
  if (!providerResponse.body) {
    abort.dispose();
    return jsonResponse(502, "AI response stream is unavailable");
  }

  const reader = providerResponse.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let finished = false;
      const writeEvent = (data: object | "[DONE]") => {
        controller.enqueue(
          encoder.encode(
            `data: ${data === "[DONE]" ? data : JSON.stringify(data)}\n\n`,
          ),
        );
      };
      const processLine = (line: string) => {
        const value = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!value) {
          return;
        }
        if (value === "[DONE]") {
          finished = true;
          return;
        }
        const event = JSON.parse(value) as {
          type?: string;
          delta?: string;
          error?: { message?: string };
          response?: { error?: { message?: string } };
          choices?: Array<{ delta?: { content?: string } }>;
        };
        if (isDeepSeek) {
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            writeEvent({ delta });
          }
        } else if (event.type === "response.output_text.delta" && event.delta) {
          writeEvent({ delta: event.delta });
        } else if (event.type === "response.completed") {
          finished = true;
        } else if (event.type === "response.failed") {
          throw new Error(
            event.response?.error?.message ||
              event.error?.message ||
              "OpenAI response failed",
          );
        }
      };

      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          lines.forEach((line) => processLine(line.replace(/\r$/, "")));
        }
        buffer += decoder.decode();
        if (!finished && buffer.trim()) {
          processLine(buffer.replace(/\r$/, ""));
        }
        writeEvent("[DONE]");
        controller.close();
      } catch (error) {
        if (!abort.controller.signal.aborted) {
          console.error("Frank AI stream failed", error);
          writeEvent({ error: "AI stream was interrupted" });
        }
        try {
          controller.close();
        } catch {
          // The consumer may already have cancelled the stream.
        }
      } finally {
        abort.dispose();
        reader.releaseLock();
      }
    },
    cancel() {
      abort.controller.abort();
      void reader.cancel();
      abort.dispose();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
};
