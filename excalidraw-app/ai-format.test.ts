import { describe, expect, it } from "vitest";

import {
  createAIStreamParser,
  createFormattedCanvasElements,
  createIncrementalCanvasMarkdown,
  createStreamingCanvasBlockElements,
  createStreamingCanvasText,
  frameCanvasElements,
  getCanvasDocumentTitle,
  measureCanvasBlockHeight,
  paginateCanvasBlockHeights,
  parseCanvasMarkdown,
  readAIStream,
} from "./ai-format";

describe("createIncrementalCanvasMarkdown", () => {
  it("keeps completed blocks stable while only the tail changes", () => {
    const parser = createIncrementalCanvasMarkdown();

    expect(parser.push("## Head")).toEqual([
      {
        id: 0,
        block: { type: "h2", text: "Head" },
        complete: false,
      },
    ]);

    const paragraph = parser.push("ing\n\nLive para");
    expect(paragraph).toEqual([
      {
        id: 0,
        block: { type: "h2", text: "Heading" },
        complete: true,
      },
      {
        id: 1,
        block: { type: "paragraph", text: "Live para" },
        complete: false,
      },
    ]);

    const table = parser.push(
      "graph\n\n| Name | Value |\n| --- | --- |\n| Frank | Can",
    );
    expect(table.slice(0, 2)).toEqual([
      {
        id: 0,
        block: { type: "h2", text: "Heading" },
        complete: true,
      },
      {
        id: 1,
        block: { type: "paragraph", text: "Live paragraph" },
        complete: true,
      },
    ]);
    expect(table[2]).toEqual({
      id: 2,
      block: {
        type: "table",
        rows: [
          ["Name", "Value"],
          ["Frank", "Can"],
        ],
      },
      complete: false,
    });
  });

  it("holds an unfinished code fence as one active block", () => {
    const parser = createIncrementalCanvasMarkdown();
    parser.push("```ts\nconst ready = ");

    expect(parser.snapshot()).toEqual([
      {
        id: 0,
        block: { type: "code", text: "const ready = " },
        complete: false,
      },
    ]);
    expect(parser.push("true;\n```\n")).toEqual([
      {
        id: 0,
        block: { type: "code", text: "const ready = true;" },
        complete: true,
      },
    ]);
  });
});

describe("paginateCanvasBlockHeights", () => {
  it("fills pages in order and can leave a header-only first page", () => {
    expect(
      paginateCanvasBlockHeights({
        heights: [80, 40, 70],
        firstPageHeight: 100,
        pageHeight: 100,
      }),
    ).toEqual([[0], [1], [2]]);

    expect(
      paginateCanvasBlockHeights({
        heights: [90],
        firstPageHeight: 50,
        pageHeight: 100,
      }),
    ).toEqual([[], [0]]);
  });

  it("keeps every block when long generated content spans Frames", () => {
    const document = parseCanvasMarkdown(
      [
        "# Long document",
        ...Array.from(
          { length: 30 },
          (_, index) =>
            `## Section ${index + 1}\n\nParagraph ${
              index + 1
            } with preserved source material.`,
        ),
      ].join("\n\n"),
    );
    const heights = document.blocks.map((block) =>
      measureCanvasBlockHeight({ block, width: 900, isDark: false }),
    );
    const pages = paginateCanvasBlockHeights({
      heights,
      firstPageHeight: 1_100,
      pageHeight: 1_200,
    });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(document.blocks.map((_, index) => index));
  });
});

describe("parseCanvasMarkdown", () => {
  it("keeps formatted text and extracts one Mermaid diagram", () => {
    const result = parseCanvasMarkdown(`# Title

Complete **paragraph** text.

- First point

\`\`\`ts
const ready = true;
\`\`\`

\`\`\`mermaid
flowchart LR
A --> B
\`\`\``);

    expect(result.mermaid).toBe("flowchart LR\nA --> B");
    expect(result.blocks).toEqual([
      { type: "h1", text: "Title" },
      { type: "paragraph", text: "Complete paragraph text." },
      { type: "list", text: "• First point" },
      { type: "code", text: "const ready = true;" },
    ]);
  });

  it("turns a Markdown table into structured rows", () => {
    const result = parseCanvasMarkdown(`| Method | Best for |
| --- | --- |
| Flexbox | One dimension |
| Grid | Two dimensions |`);

    expect(result.blocks).toEqual([
      {
        type: "table",
        rows: [
          ["Method", "Best for"],
          ["Flexbox", "One dimension"],
          ["Grid", "Two dimensions"],
        ],
      },
    ]);
  });

  it("uses the first AI heading as the document title", () => {
    const document = parseCanvasMarkdown(
      "Intro text\n\n# Generated title\n\n## Detail",
    );

    expect(getCanvasDocumentTitle(document.blocks)).toBe("Generated title");
    expect(getCanvasDocumentTitle([], "Fallback title")).toBe("Fallback title");
  });
});

describe("createAIStreamParser", () => {
  it("preserves split SSE chunks and accumulates deltas", () => {
    const updates: string[] = [];
    const parser = createAIStreamParser((text) => updates.push(text));

    parser.push('data: {"delta":"Hel');
    parser.push('lo"}\n\ndata: {"delta":" world"}\n');
    parser.push("\ndata: [DONE]\n\n");

    expect(parser.finish()).toEqual({ text: "Hello world", done: true });
    expect(updates).toEqual(["Hello", "Hello world"]);
  });

  it("rejects a transport disconnect instead of accepting partial text", async () => {
    const updates: string[] = [];
    const response = new Response('data: {"delta":"Partial answer"}\n\n');

    await expect(
      readAIStream(response, (text) => updates.push(text)),
    ).rejects.toThrow("AI connection was interrupted");
    expect(updates).toEqual(["Partial answer"]);
  });
});

describe("AI canvas elements", () => {
  it("keeps streaming text stable and places the final table in one frame", () => {
    const streaming = createStreamingCanvasText({
      text: "partial",
      id: "stream-1",
      x: 0,
      y: 0,
      width: 640,
      isDark: false,
    });
    const updated = createStreamingCanvasText({
      text: "partial answer",
      id: streaming.id,
      x: 0,
      y: 0,
      width: 640,
      isDark: false,
      previous: streaming,
    });
    expect(updated.id).toBe(streaming.id);
    expect(updated.version).toBeGreaterThan(streaming.version);

    const partialBlock = createStreamingCanvasBlockElements({
      block: { type: "paragraph", text: "Native canvas" },
      idPrefix: "answer-block-0",
      x: 0,
      y: 0,
      width: 640,
      isDark: false,
    });
    const updatedBlock = createStreamingCanvasBlockElements({
      block: { type: "paragraph", text: "Native canvas formatting" },
      idPrefix: "answer-block-0",
      x: 0,
      y: 0,
      width: 640,
      isDark: false,
      previous: partialBlock.elements,
    });
    expect(updatedBlock.elements[0].id).toBe(partialBlock.elements[0].id);
    expect(updatedBlock.elements[0].version).toBeGreaterThan(
      partialBlock.elements[0].version,
    );

    const document = createFormattedCanvasElements({
      markdown:
        "# Generated title\n\n| Feature | Result |\n| --- | --- |\n| Frame | Ready |",
      provider: "deepseek",
      intent: "create",
      x: 0,
      y: 0,
      isDark: false,
    });
    const framed = frameCanvasElements({
      elements: document.elements,
      name: `AI / ${getCanvasDocumentTitle(
        parseCanvasMarkdown("# Generated title").blocks,
      )}`,
      isDark: false,
    });

    expect(framed.frame.type).toBe("frame");
    expect(framed.frame.name).toBe("AI / Generated title");
    expect(framed.frame.customData?.frankThemeColor).toEqual({
      strokeColor: true,
    });
    expect(
      document.elements.some(
        (element) =>
          element.strokeColor === "#002fa7" &&
          element.customData?.frankThemeColor,
      ),
    ).toBe(true);
    expect(
      document.elements
        .filter((element) => element.type === "text")
        .map((element) => element.originalText),
    ).toContain("FRANK AI / DEEPSEEK / CREATE");
    expect(
      framed.elements
        .slice(0, -1)
        .every((element) => element.frameId === framed.frame.id),
    ).toBe(true);
    expect(
      framed.elements.filter((element) => element.type === "rectangle").length,
    ).toBeGreaterThanOrEqual(5);

    const fixedFrame = frameCanvasElements({
      elements: document.elements,
      name: "AI / Page 1",
      isDark: false,
      bounds: { x: 100, y: 200, width: 1080, height: 1350 },
    });
    expect(fixedFrame.bounds).toEqual({
      x: 100,
      y: 200,
      width: 1080,
      height: 1350,
    });
  });
});
