import {
  FONT_FAMILY,
  getFontString,
  removeDarkModeFilter,
} from "@excalidraw/common";
import {
  convertToExcalidrawElements,
  getCommonBounds,
  newElementWith,
  newFrameElement,
  wrapText,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  ExcalidrawTextElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { getFrankThemeColorData } from "./frank/accent-colors";

type TextCanvasBlock = {
  type: "h1" | "h2" | "h3" | "paragraph" | "list" | "quote" | "code" | "rule";
  text: string;
};

export type CanvasBlock =
  | TextCanvasBlock
  | {
      type: "table";
      rows: string[][];
    };

export const getCanvasDocumentTitle = (
  blocks: readonly CanvasBlock[],
  fallback = "Frank Canvas",
) => {
  const heading = blocks.find(
    (block): block is TextCanvasBlock => block.type === "h1",
  );
  return (heading?.text.trim() || fallback).slice(0, 72);
};

const cleanInlineMarkdown = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.*?)\*\*|__(.*?)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.*?)~~/g, "$1");

const parseTableRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cleanInlineMarkdown(cell.trim()));

const isTableDivider = (line: string) => {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

export type StreamingCanvasBlock = {
  id: number;
  block: CanvasBlock;
  complete: boolean;
};

type PendingCanvasBlock =
  | { id: number; type: "paragraph"; lines: string[] }
  | { id: number; type: "code"; lines: string[] }
  | { id: number; type: "table"; rows: string[][] };

const parseLineBlock = (line: string): CanvasBlock | null => {
  const trimmed = line.trim();
  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  const list = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);

  if (heading) {
    return {
      type: `h${heading[1].length}` as "h1" | "h2" | "h3",
      text: cleanInlineMarkdown(heading[2]),
    };
  }
  if (list) {
    return {
      type: "list",
      text: `${/\d/.test(list[1]) ? list[1] : "•"} ${cleanInlineMarkdown(
        list[2],
      )}`,
    };
  }
  if (trimmed.startsWith(">")) {
    return {
      type: "quote",
      text: cleanInlineMarkdown(trimmed.replace(/^>\s?/, "")),
    };
  }
  if (/^([-*_])\1{2,}$/.test(trimmed)) {
    return { type: "rule", text: "" };
  }
  return null;
};

/**
 * Consumes every completed line once and keeps only the unfinished block live.
 * This avoids reparsing the complete answer for every streamed token.
 */
export const createIncrementalCanvasMarkdown = () => {
  const committed: StreamingCanvasBlock[] = [];
  let pending: PendingCanvasBlock | null = null;
  let lineBuffer = "";
  let nextId = 0;

  const allocateId = () => nextId++;
  const commit = (block: CanvasBlock, id = allocateId()) => {
    committed.push({ id, block, complete: true });
  };
  const flushPending = () => {
    if (!pending) {
      return;
    }
    if (pending.type === "paragraph") {
      const text = cleanInlineMarkdown(pending.lines.join(" ").trim());
      if (text) {
        commit({ type: "paragraph", text }, pending.id);
      }
    } else if (pending.type === "code") {
      commit({ type: "code", text: pending.lines.join("\n") }, pending.id);
    } else {
      commit({ type: "table", rows: pending.rows }, pending.id);
    }
    pending = null;
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();

    if (pending?.type === "code") {
      if (trimmed.startsWith("```")) {
        flushPending();
      } else {
        pending.lines.push(line);
      }
      return;
    }

    if (pending?.type === "table") {
      if (trimmed && line.includes("|")) {
        pending.rows.push(parseTableRow(line));
        return;
      }
      flushPending();
      if (!trimmed) {
        return;
      }
    }

    if (trimmed.startsWith("```")) {
      flushPending();
      pending = { id: allocateId(), type: "code", lines: [] };
      return;
    }
    if (!trimmed) {
      flushPending();
      return;
    }

    if (
      pending?.type === "paragraph" &&
      pending.lines.length === 1 &&
      pending.lines[0].includes("|") &&
      isTableDivider(line)
    ) {
      pending = {
        id: pending.id,
        type: "table",
        rows: [parseTableRow(pending.lines[0])],
      };
      return;
    }

    const lineBlock = parseLineBlock(line);
    if (lineBlock) {
      flushPending();
      commit(lineBlock);
      return;
    }

    if (pending?.type === "paragraph") {
      pending.lines.push(line);
    } else {
      pending = { id: allocateId(), type: "paragraph", lines: [line] };
    }
  };

  const getActiveBlock = (): StreamingCanvasBlock | null => {
    if (pending?.type === "code") {
      return {
        id: pending.id,
        block: {
          type: "code",
          text: [...pending.lines, lineBuffer].join("\n"),
        },
        complete: false,
      };
    }
    if (pending?.type === "table") {
      const rows = [...pending.rows];
      if (lineBuffer.trim() && lineBuffer.includes("|")) {
        rows.push(parseTableRow(lineBuffer));
      }
      return {
        id: pending.id,
        block: { type: "table", rows },
        complete: false,
      };
    }

    const paragraphLines = pending?.lines || [];
    const text = [...paragraphLines, lineBuffer].filter(Boolean).join(" ");
    if (!text.trim()) {
      return null;
    }
    return {
      id: pending?.id ?? nextId,
      block:
        paragraphLines.length === 0
          ? parseLineBlock(lineBuffer) || {
              type: "paragraph",
              text: cleanInlineMarkdown(text.trim()),
            }
          : {
              type: "paragraph",
              text: cleanInlineMarkdown(text.trim()),
            },
      complete: false,
    };
  };

  const snapshot = () => {
    const active = getActiveBlock();
    return active ? [...committed, active] : [...committed];
  };

  return {
    push(delta: string) {
      lineBuffer += delta;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      lines.forEach(processLine);
      return snapshot();
    },
    snapshot,
    finish() {
      if (lineBuffer) {
        processLine(lineBuffer);
        lineBuffer = "";
      }
      flushPending();
      return snapshot();
    },
  };
};

export const parseCanvasMarkdown = (markdown: string) => {
  const mermaidMatch = markdown.match(/```mermaid\s*\n([\s\S]*?)```/i);
  const source = mermaidMatch
    ? markdown.replace(mermaidMatch[0], "").trim()
    : markdown.trim();
  const blocks: CanvasBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({
        type: "paragraph",
        text: cleanInlineMarkdown(paragraph.join(" ")),
      });
      paragraph = [];
    }
  };

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```") && code === null) {
      flushParagraph();
      code = [];
      continue;
    }
    if (trimmed === "```" && code !== null) {
      blocks.push({ type: "code", text: code.join("\n") });
      code = null;
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1])
    ) {
      flushParagraph();
      const rows = [parseTableRow(line)];
      index += 2;
      while (
        index < lines.length &&
        lines[index].trim() &&
        lines[index].includes("|")
      ) {
        rows.push(parseTableRow(lines[index]));
        index++;
      }
      index--;
      blocks.push({ type: "table", rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    const list = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: `h${heading[1].length}` as "h1" | "h2" | "h3",
        text: cleanInlineMarkdown(heading[2]),
      });
    } else if (list) {
      flushParagraph();
      blocks.push({
        type: "list",
        text: `${/\d/.test(list[1]) ? list[1] : "•"} ${cleanInlineMarkdown(
          list[2],
        )}`,
      });
    } else if (trimmed.startsWith(">")) {
      flushParagraph();
      blocks.push({
        type: "quote",
        text: cleanInlineMarkdown(trimmed.replace(/^>\s?/, "")),
      });
    } else if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: "rule", text: "" });
    } else {
      paragraph.push(trimmed);
    }
  }

  flushParagraph();
  if (code?.length) {
    blocks.push({ type: "code", text: code.join("\n") });
  }

  return { blocks, mermaid: mermaidMatch?.[1].trim() || null };
};

type CanvasSkeletons = Parameters<typeof convertToExcalidrawElements>[0];

const createCanvasBlockSkeletons = ({
  block,
  x,
  y,
  width,
  isDark,
  accentColor = "#000000",
}: {
  block: CanvasBlock;
  x: number;
  y: number;
  width: number;
  isDark: boolean;
  accentColor?: string;
}) => {
  const scale = Math.min(2.5, Math.max(0.75, width / 640));
  const scaled = (value: number) => value * scale;
  const color = (value: string) =>
    isDark ? removeDarkModeFilter(value) : value;
  const ink = color(isDark ? "#f5f5f5" : "#171717");
  const muted = color(isDark ? "#a8a8a8" : "#686862");
  const blue = color(accentColor);
  const codeBackground = color(isDark ? "#1b1b1b" : "#f1f1ed");
  const tableBackground = color(isDark ? "#111111" : "#ffffff");
  const white = color("#ffffff");
  const skeletons: CanvasSkeletons = [];
  let cursorY = y;

  const addText = ({
    text,
    fontSize,
    fontFamily = FONT_FAMILY.Helvetica,
    strokeColor = ink,
    indent = 0,
    maxWidth = width - indent,
    gap = 18,
    customData,
  }: {
    text: string;
    fontSize: number;
    fontFamily?: typeof FONT_FAMILY[keyof typeof FONT_FAMILY];
    strokeColor?: string;
    indent?: number;
    maxWidth?: number;
    gap?: number;
    customData?: ExcalidrawElement["customData"];
  }) => {
    const wrapped = wrapText(
      text,
      getFontString({ fontFamily, fontSize }),
      maxWidth,
    );
    const height = Math.max(
      fontSize * 1.25,
      wrapped.split("\n").length * fontSize * 1.25,
    );
    skeletons.push({
      type: "text",
      x: x + indent,
      y: cursorY,
      text: wrapped,
      fontFamily,
      fontSize,
      strokeColor,
      customData,
      roughness: 0,
    });
    cursorY += height + gap;
    return height;
  };

  if (block.type === "rule") {
    skeletons.push({
      type: "rectangle",
      x,
      y: cursorY,
      width,
      height: Math.max(1, scaled(1)),
      backgroundColor: muted,
      fillStyle: "solid",
      strokeColor: muted,
      roughness: 0,
    });
    cursorY += scaled(24);
  } else if (block.type === "table") {
    const columnCount = Math.max(1, ...block.rows.map((row) => row.length));
    const cellWidth = width / columnCount;
    const fontSize = scaled(14);

    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
      const row = block.rows[rowIndex];
      const wrappedCells = Array.from({ length: columnCount }, (_, index) =>
        wrapText(
          row[index] || "",
          getFontString({ fontFamily: FONT_FAMILY.Helvetica, fontSize }),
          cellWidth - scaled(24),
        ),
      );
      const rowHeight = Math.max(
        scaled(44),
        ...wrappedCells.map(
          (cell) => cell.split("\n").length * fontSize * 1.25 + scaled(20),
        ),
      );

      for (
        let columnIndex = 0;
        columnIndex < wrappedCells.length;
        columnIndex++
      ) {
        skeletons.push({
          type: "rectangle",
          x: x + columnIndex * cellWidth,
          y: cursorY,
          width: cellWidth,
          height: rowHeight,
          backgroundColor: rowIndex === 0 ? blue : tableBackground,
          fillStyle: "solid",
          strokeColor: rowIndex === 0 ? blue : muted,
          customData:
            rowIndex === 0
              ? getFrankThemeColorData({
                  strokeColor: true,
                  backgroundColor: true,
                })
              : undefined,
          roughness: 0,
          label: {
            text: wrappedCells[columnIndex],
            fontFamily: FONT_FAMILY.Helvetica,
            fontSize,
            strokeColor: rowIndex === 0 ? white : ink,
            textAlign: "left",
            verticalAlign: "middle",
          },
        });
      }
      cursorY += rowHeight;
    }
    cursorY += scaled(22);
  } else if (block.type === "code") {
    const fontSize = scaled(14);
    const wrapped = wrapText(
      block.text || " ",
      getFontString({ fontFamily: FONT_FAMILY.Cascadia, fontSize }),
      width - scaled(32),
    );
    const height = Math.max(
      scaled(58),
      wrapped.split("\n").length * fontSize * 1.35 + scaled(28),
    );
    skeletons.push(
      {
        type: "rectangle",
        x,
        y: cursorY,
        width,
        height,
        backgroundColor: codeBackground,
        fillStyle: "solid",
        strokeColor: muted,
        roughness: 0,
      },
      {
        type: "text",
        x: x + scaled(16),
        y: cursorY + scaled(14),
        text: wrapped,
        fontFamily: FONT_FAMILY.Cascadia,
        fontSize,
        strokeColor: ink,
        roughness: 0,
      },
    );
    cursorY += height + scaled(22);
  } else if (block.type === "quote") {
    const startY = cursorY;
    const height = addText({
      text: block.text,
      fontSize: scaled(17),
      strokeColor: muted,
      indent: scaled(22),
      maxWidth: width - scaled(22),
      gap: scaled(22),
    });
    skeletons.push({
      type: "rectangle",
      x,
      y: startY,
      width: scaled(4),
      height,
      backgroundColor: blue,
      fillStyle: "solid",
      strokeColor: blue,
      customData: getFrankThemeColorData({
        strokeColor: true,
        backgroundColor: true,
      }),
      roughness: 0,
    });
  } else {
    const style = {
      h1: { fontSize: scaled(32), gap: scaled(22) },
      h2: { fontSize: scaled(24), gap: scaled(18) },
      h3: { fontSize: scaled(19), gap: scaled(14) },
      list: { fontSize: scaled(17), gap: scaled(9) },
      paragraph: { fontSize: scaled(17), gap: scaled(18) },
    }[block.type];
    addText({
      text: block.text,
      ...style,
      indent: block.type === "list" ? scaled(10) : 0,
    });
  }

  return { skeletons, height: cursorY - y };
};

export const measureCanvasBlockHeight = ({
  block,
  width,
  isDark,
}: {
  block: CanvasBlock;
  width: number;
  isDark: boolean;
}) => createCanvasBlockSkeletons({ block, x: 0, y: 0, width, isDark }).height;

export const paginateCanvasBlockHeights = ({
  heights,
  firstPageHeight,
  pageHeight,
}: {
  heights: readonly number[];
  firstPageHeight: number;
  pageHeight: number;
}) => {
  const pages: number[][] = [[]];
  let remaining = Math.max(0, firstPageHeight);

  heights.forEach((height, index) => {
    const page = pages[pages.length - 1];
    if (
      height > remaining &&
      (page.length > 0 || (pages.length === 1 && height <= pageHeight))
    ) {
      pages.push([]);
      remaining = Math.max(0, pageHeight);
    }
    pages[pages.length - 1].push(index);
    remaining -= height;
  });

  return pages;
};

export const createFormattedCanvasElements = ({
  markdown,
  provider,
  intent,
  x,
  y,
  isDark,
  width = 640,
  accentColor = "#000000",
}: {
  markdown: string;
  provider: string;
  intent: "ask" | "create";
  x: number;
  y: number;
  isDark: boolean;
  width?: number;
  accentColor?: string;
}) => {
  const scale = Math.min(2.5, Math.max(0.75, width / 640));
  const color = (value: string) =>
    isDark ? removeDarkModeFilter(value) : value;
  const ink = color(isDark ? "#f5f5f5" : "#171717");
  const blue = color(accentColor);
  const { blocks, mermaid } = parseCanvasMarkdown(markdown);
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [
    {
      type: "rectangle",
      x,
      y,
      width,
      height: 4 * scale,
      backgroundColor: blue,
      fillStyle: "solid",
      strokeColor: blue,
      customData: getFrankThemeColorData({
        strokeColor: true,
        backgroundColor: true,
      }),
      roughness: 0,
    },
  ];
  let cursorY = y + 18 * scale;

  const addText = ({
    text,
    fontSize,
    fontFamily = FONT_FAMILY.Helvetica,
    strokeColor = ink,
    indent = 0,
    maxWidth = width - indent,
    gap = 18,
    customData,
  }: {
    text: string;
    fontSize: number;
    fontFamily?: typeof FONT_FAMILY[keyof typeof FONT_FAMILY];
    strokeColor?: string;
    indent?: number;
    maxWidth?: number;
    gap?: number;
    customData?: ExcalidrawElement["customData"];
  }) => {
    const wrapped = wrapText(
      text,
      getFontString({ fontFamily, fontSize }),
      maxWidth,
    );
    const height = wrapped.split("\n").length * fontSize * 1.25;
    skeletons.push({
      type: "text",
      x: x + indent,
      y: cursorY,
      text: wrapped,
      fontFamily,
      fontSize,
      strokeColor,
      customData,
      roughness: 0,
    });
    cursorY += height + gap;
    return height;
  };

  addText({
    text: `FRANK AI / ${provider.toUpperCase()} / ${intent.toUpperCase()}`,
    fontSize: 11 * scale,
    strokeColor: blue,
    customData: getFrankThemeColorData({ strokeColor: true }),
    gap: 24 * scale,
  });

  for (const block of blocks) {
    const section = createCanvasBlockSkeletons({
      block,
      x,
      y: cursorY,
      width,
      isDark,
      accentColor,
    });
    skeletons.push(...section.skeletons);
    cursorY += section.height;
  }

  return {
    elements: convertToExcalidrawElements(skeletons),
    mermaid,
    width,
    height: cursorY - y,
  };
};

export const createStreamingCanvasBlockElements = ({
  block,
  idPrefix,
  x,
  y,
  width,
  isDark,
  previous = [],
  accentColor = "#000000",
}: {
  block: CanvasBlock;
  idPrefix: string;
  x: number;
  y: number;
  width: number;
  isDark: boolean;
  previous?: readonly NonDeletedExcalidrawElement[];
  accentColor?: string;
}) => {
  const section = createCanvasBlockSkeletons({
    block,
    x,
    y,
    width,
    isDark,
    accentColor,
  });
  const skeletons = section.skeletons.map((skeleton, index) => ({
    ...skeleton,
    id: `${idPrefix}-${index}`,
    ...("label" in skeleton && skeleton.label
      ? {
          label: {
            ...skeleton.label,
            id: `${idPrefix}-${index}-label`,
          },
        }
      : null),
  })) as CanvasSkeletons;
  const created = convertToExcalidrawElements(skeletons, {
    regenerateIds: false,
  });
  const previousById = new Map(
    previous.map((element) => [element.id, element]),
  );
  const elements = created.map((element) => {
    const previousElement = previousById.get(element.id);
    if (!previousElement || previousElement.type !== element.type) {
      return element;
    }
    const {
      id: _id,
      updated: _updated,
      version: _version,
      versionNonce: _versionNonce,
      ...updates
    } = element;
    return newElementWith(previousElement, updates as never);
  });

  return { elements, height: section.height };
};

export const createStreamingCanvasText = ({
  text,
  id,
  x,
  y,
  width,
  isDark,
  previous,
}: {
  text: string;
  id: string;
  x: number;
  y: number;
  width: number;
  isDark: boolean;
  previous?: NonDeleted<ExcalidrawTextElement>;
}) => {
  const fontSize = 16;
  const wrapped = wrapText(
    text,
    getFontString({ fontFamily: FONT_FAMILY.Helvetica, fontSize }),
    width,
  );
  const created = convertToExcalidrawElements(
    [
      {
        type: "text",
        id,
        x,
        y,
        text: wrapped,
        fontFamily: FONT_FAMILY.Helvetica,
        fontSize,
        strokeColor: isDark ? removeDarkModeFilter("#f5f5f5") : "#171717",
        roughness: 0,
      },
    ],
    { regenerateIds: false },
  )[0] as NonDeleted<ExcalidrawTextElement>;

  return previous
    ? newElementWith(previous, {
        text: created.text,
        originalText: created.originalText,
        width: created.width,
        height: created.height,
        x,
        y,
      })
    : created;
};

export const frameCanvasElements = ({
  elements,
  name,
  isDark,
  frame,
  bounds,
  accentColor = "#000000",
}: {
  elements: readonly NonDeletedExcalidrawElement[];
  name: string;
  isDark: boolean;
  frame?: NonDeleted<ExcalidrawFrameElement>;
  bounds?: { x: number; y: number; width: number; height: number };
  accentColor?: string;
}) => {
  const padding = 32;
  const [minX, minY, maxX, maxY] = bounds
    ? [
        bounds.x + padding,
        bounds.y + padding,
        bounds.x + bounds.width - padding,
        bounds.y + bounds.height - padding,
      ]
    : getCommonBounds(elements);
  const frameBounds = bounds || {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
  const blue = isDark ? removeDarkModeFilter(accentColor) : accentColor;
  const baseFrame =
    frame ||
    newFrameElement({
      ...frameBounds,
      name,
      strokeColor: blue,
      backgroundColor: "transparent",
      roughness: 0,
      customData: getFrankThemeColorData({ strokeColor: true }),
    });
  const nextFrame = newElementWith(baseFrame, {
    ...frameBounds,
    name,
    strokeColor: blue,
    customData: getFrankThemeColorData(
      { strokeColor: true },
      baseFrame.customData,
    ),
  });
  const children = elements.map((element) =>
    newElementWith(element, { frameId: nextFrame.id }),
  );

  return {
    elements: [...children, nextFrame],
    frame: nextFrame,
    bounds: {
      x: nextFrame.x,
      y: nextFrame.y,
      width: nextFrame.width,
      height: nextFrame.height,
    },
  };
};

type AIStreamMessage =
  | { type: "delta"; delta: string }
  | { type: "done" }
  | { type: "ignore" };

const parseAIStreamLine = (line: string): AIStreamMessage => {
  const value = line.startsWith("data:") ? line.slice(5).trim() : "";
  if (!value) {
    return { type: "ignore" };
  }
  if (value === "[DONE]") {
    return { type: "done" };
  }

  const data = JSON.parse(value) as { delta?: string; error?: string };
  if (data.error) {
    throw new Error(data.error);
  }
  return data.delta ? { type: "delta", delta: data.delta } : { type: "ignore" };
};

export const createAIStreamParser = (
  onText: (text: string, delta: string) => void,
) => {
  let buffer = "";
  let text = "";
  let done = false;

  const processLine = (line: string) => {
    const message = parseAIStreamLine(line.replace(/\r$/, ""));
    if (message.type === "delta") {
      text += message.delta;
      onText(text, message.delta);
    } else if (message.type === "done") {
      done = true;
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(processLine);
    },
    finish() {
      if (buffer.trim()) {
        processLine(buffer);
      }
      return { text, done };
    },
  };
};

export const readAIStream = async (
  response: Response,
  onText: (text: string, delta: string) => void,
) => {
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || "AI request failed");
  }
  if (!response.body) {
    throw new Error("AI response stream is unavailable");
  }

  const parser = createAIStreamParser(onText);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  const result = parser.finish();
  if (!result.text.trim()) {
    throw new Error("AI returned an empty response");
  }
  if (!result.done) {
    throw new Error("AI connection was interrupted. Please try again.");
  }
  return result.text;
};
