import path from "path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import svgrPlugin from "vite-plugin-svgr";
import { ViteEjsPlugin } from "vite-plugin-ejs";
import { VitePWA } from "vite-plugin-pwa";
import checker from "vite-plugin-checker";
import { createHtmlPlugin } from "vite-plugin-html";
import Sitemap from "vite-plugin-sitemap";
import { woff2BrowserPlugin } from "../scripts/woff2/woff2-vite-plugins";

type AIMessage = {
  role: "user" | "assistant";
  content: string;
};

type AIProvider = "openai" | "deepseek";

const frankAIPlugin = (
  openAIKey?: string,
  openAIModel = "gpt-5.4-mini",
): Plugin => ({
  name: "frank-ai",
  configureServer(server) {
    server.middlewares.use("/api/ai", async (request, response) => {
      response.setHeader("Content-Type", "application/json; charset=utf-8");

      if (request.method !== "POST") {
        response.statusCode = 405;
        response.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      try {
        let rawBody = "";
        for await (const chunk of request) {
          rawBody += chunk;
          if (rawBody.length > 64_000) {
            throw new Error("Request is too large");
          }
        }

        const body = JSON.parse(rawBody) as {
          provider?: AIProvider;
          apiKey?: string;
          messages?: AIMessage[];
        };
        const provider = body.provider || "openai";
        const messages = body.messages;
        const apiKey = body.apiKey?.trim() || openAIKey;
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

        if (!isValid) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "Invalid AI configuration" }));
          return;
        }

        const isDeepSeek = provider === "deepseek";
        const providerResponse = await fetch(
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
                      {
                        role: "system",
                        content:
                          "You are the thinking and drawing partner inside Frank Canvas. Return a complete, well-structured Markdown answer using headings, paragraphs, lists, quotes, code blocks, and compact Markdown tables when useful. If a visual diagram materially improves the answer, include one simple fenced mermaid flowchart after the explanation. Never wrap the whole answer in a code fence.",
                      },
                      ...messages,
                    ],
                    max_tokens: 2400,
                    stream: true,
                  }
                : {
                    model: openAIModel,
                    store: false,
                    instructions:
                      "You are the thinking and drawing partner inside Frank Canvas. Return a complete, well-structured Markdown answer using headings, paragraphs, lists, quotes, code blocks, and compact Markdown tables when useful. If a visual diagram materially improves the answer, include one simple fenced mermaid flowchart after the explanation. Never wrap the whole answer in a code fence.",
                    input: messages,
                    max_output_tokens: 2400,
                    stream: true,
                  },
            ),
            signal: AbortSignal.timeout(60_000),
          },
        );

        if (!providerResponse.ok) {
          const data = (await providerResponse.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          console.error(`${provider} request failed:`, data?.error?.message);
          response.statusCode = 502;
          response.end(JSON.stringify({ error: `${provider} request failed` }));
          return;
        }

        if (!providerResponse.body) {
          throw new Error("AI response stream is unavailable");
        }

        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        const reader = providerResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        const writeEvent = (data: object | "[DONE]") => {
          response.write(
            `data: ${data === "[DONE]" ? data : JSON.stringify(data)}\n\n`,
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
          } else if (
            event.type === "response.output_text.delta" &&
            event.delta
          ) {
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
        response.end();
      } catch (error) {
        console.error("Frank AI error:", error);
        if (response.headersSent) {
          response.write(
            `data: ${JSON.stringify({
              error: "AI stream was interrupted",
            })}\n\n`,
          );
          response.end();
        } else {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "Unable to answer right now" }));
        }
      }
    });
  },
});

export default defineConfig(({ mode }) => {
  // To load .env variables
  const envVars = loadEnv(mode, `../`);
  const serverEnv = loadEnv(mode, `../`, "OPENAI_");
  // https://vitejs.dev/config/
  return {
    server: {
      port: Number(envVars.VITE_APP_PORT || 3000),
      // open the browser
      open: true,
    },
    // We need to specify the envDir since now there are no
    //more located in parallel with the vite.config.ts file but in parent dir
    envDir: "../",
    resolve: {
      alias: [
        {
          find: /^@excalidraw\/common$/,
          replacement: path.resolve(
            __dirname,
            "../packages/common/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/common\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/common/src/$1"),
        },
        {
          find: /^@excalidraw\/element$/,
          replacement: path.resolve(
            __dirname,
            "../packages/element/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/element\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/element/src/$1"),
        },
        {
          find: /^@excalidraw\/excalidraw$/,
          replacement: path.resolve(
            __dirname,
            "../packages/excalidraw/index.tsx",
          ),
        },
        {
          find: /^@excalidraw\/excalidraw\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/excalidraw/$1"),
        },
        {
          find: /^@excalidraw\/math$/,
          replacement: path.resolve(__dirname, "../packages/math/src/index.ts"),
        },
        {
          find: /^@excalidraw\/math\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/math/src/$1"),
        },
        {
          find: /^@excalidraw\/utils$/,
          replacement: path.resolve(
            __dirname,
            "../packages/utils/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/utils\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/utils/src/$1"),
        },
        {
          find: /^@excalidraw\/fractional-indexing$/,
          replacement: path.resolve(
            __dirname,
            "../packages/fractional-indexing/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/laser-pointer$/,
          replacement: path.resolve(
            __dirname,
            "../packages/laser-pointer/src/index.ts",
          ),
        },
      ],
    },
    build: {
      outDir: "build",
      rollupOptions: {
        output: {
          assetFileNames(chunkInfo) {
            if (chunkInfo?.name?.endsWith(".woff2")) {
              const family = chunkInfo.name.split("-")[0];
              return `fonts/${family}/[name][extname]`;
            }

            return "assets/[name]-[hash][extname]";
          },
          // Creating separate chunk for locales except for en and percentages.json so they
          // can be cached at runtime and not merged with
          // app precache. en.json and percentages.json are needed for first load
          // or fallback hence not clubbing with locales so first load followed by offline mode works fine. This is how CRA used to work too.
          manualChunks(id) {
            if (
              id.includes("packages/excalidraw/locales") &&
              id.match(/en.json|percentages.json/) === null
            ) {
              const index = id.indexOf("locales/");
              // Taking the substring after "locales/"
              return `locales/${id.substring(index + 8)}`;
            }

            if (id.includes("@excalidraw/mermaid-to-excalidraw")) {
              return "mermaid-to-excalidraw";
            }

            if (id.includes("@codemirror/") || id.includes("@lezer/")) {
              return "codemirror.chunk";
            }
          },
        },
      },
      sourcemap: true,
      // don't auto-inline small assets (i.e. fonts hosted on CDN)
      assetsInlineLimit: 0,
    },
    plugins: [
      // ponytail: keep the API key in the local Vite server; extract this
      // endpoint only when Frank Canvas gets a production backend.
      frankAIPlugin(serverEnv.OPENAI_API_KEY, serverEnv.OPENAI_MODEL),
      Sitemap({
        hostname: "https://excalidraw.com",
        outDir: "build",
        changefreq: "monthly",
        // its static in public folder
        generateRobotsTxt: false,
      }),
      woff2BrowserPlugin(),
      react(),
      checker({
        typescript: true,
        eslint:
          envVars.VITE_APP_ENABLE_ESLINT === "false"
            ? undefined
            : { lintCommand: 'eslint "./**/*.{js,ts,tsx}"' },
        overlay: {
          initialIsOpen: envVars.VITE_APP_COLLAPSE_OVERLAY === "false",
          badgeStyle: "margin-bottom: 4rem; margin-left: 1rem",
        },
      }),
      svgrPlugin(),
      ViteEjsPlugin(),
      VitePWA({
        registerType: "autoUpdate",
        devOptions: {
          /* set this flag to true to enable in Development mode */
          enabled: envVars.VITE_APP_ENABLE_PWA === "true",
        },

        workbox: {
          // don't precache fonts, locales and separate chunks
          globIgnores: [
            "fonts.css",
            "**/locales/**",
            "service-worker.js",
            "**/*.chunk-*.js",
            // CodeMirrorEditor can't be assigned a `.chunk` name via
            // manualChunks because Rollup would hoist shared deps (React)
            // via a static import from the main bundle, defeating lazy
            // loading. So we exclude it by name instead.
            "**/CodeMirrorEditor-*.js",
          ],
          runtimeCaching: [
            {
              urlPattern: new RegExp(".+.woff2"),
              handler: "CacheFirst",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 1000,
                  maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
                },
                cacheableResponse: {
                  // 0 to cache "opaque" responses from cross-origin requests (i.e. CDN)
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: new RegExp("fonts.css"),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 50,
                },
              },
            },
            {
              urlPattern: new RegExp("locales/[^/]+.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "locales",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 30, // <== 30 days
                },
              },
            },
            {
              urlPattern: new RegExp("(.chunk-.+|CodeMirrorEditor-.+)\\.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "chunk",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 90, // <== 90 days
                },
              },
            },
          ],
          maximumFileSizeToCacheInBytes: 2.3 * 1024 ** 2, // 2.3MB
        },
        manifest: {
          short_name: "Excalidraw",
          name: "Excalidraw",
          description:
            "Excalidraw is a whiteboard tool that lets you easily sketch diagrams that have a hand-drawn feel to them.",
          icons: [
            {
              src: "android-chrome-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "apple-touch-icon.png",
              type: "image/png",
              sizes: "180x180",
            },
            {
              src: "favicon-32x32.png",
              sizes: "32x32",
              type: "image/png",
            },
            {
              src: "favicon-16x16.png",
              sizes: "16x16",
              type: "image/png",
            },
          ],
          start_url: "/",
          id: "excalidraw",
          display: "standalone",
          theme_color: "#121212",
          background_color: "#ffffff",
          file_handlers: [
            {
              action: "/",
              accept: {
                "application/vnd.excalidraw+json": [".excalidraw"],
              },
            },
          ],
          share_target: {
            action: "/web-share-target",
            method: "POST",
            enctype: "multipart/form-data",
            params: {
              files: [
                {
                  name: "file",
                  accept: [
                    "application/vnd.excalidraw+json",
                    "application/json",
                    ".excalidraw",
                  ],
                },
              ],
            },
          },
          screenshots: [
            {
              src: "/screenshots/virtual-whiteboard.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/wireframe.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/illustration.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/shapes.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/collaboration.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/export.png",
              type: "image/png",
              sizes: "462x945",
            },
          ],
        },
      }),
      createHtmlPlugin({
        minify: true,
      }),
    ],
    publicDir: "../public",
  };
});
