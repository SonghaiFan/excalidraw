import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { resolveSelectedFrameIds, sortFramesForPlayback } from "./frame-utils";

export const MAX_AI_CONTEXT_FRAMES = 4;
export const MAX_AI_CONTEXT_CHARS_PER_FRAME = 6_000;
export const MAX_AI_CONTEXT_CHARS_TOTAL = 20_000;

export type AIFrameContext = {
  id: string;
  name: string;
  width: number;
  height: number;
  content: string;
};

const VISUAL_LABELS: Partial<Record<ExcalidrawElement["type"], string>> = {
  arrow: "arrows",
  diamond: "diamonds",
  ellipse: "ellipses",
  embeddable: "embeds",
  freedraw: "freehand drawings",
  iframe: "embeds",
  image: "images",
  line: "lines",
  magicframe: "magic frames",
  rectangle: "rectangles",
};

const truncate = (value: string, limit: number) => {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

const serializeFrameContent = (
  elements: readonly ExcalidrawElement[],
  frame: NonDeleted<ExcalidrawFrameElement>,
) => {
  const children = elements.filter(
    (element) => !element.isDeleted && element.frameId === frame.id,
  );
  const textLines = children
    .filter((element) => element.type === "text")
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((element) => {
      const text = (element.originalText || element.text).trim();
      const link = element.link?.trim();
      return text
        ? `Text (${Math.round(element.fontSize)}px): ${text}${
            link ? `\nLink: ${link}` : ""
          }`
        : "";
    })
    .filter(Boolean);

  const visualCounts = new Map<string, number>();
  for (const element of children) {
    if (element.type === "text") {
      continue;
    }
    const label = VISUAL_LABELS[element.type] || `${element.type} elements`;
    visualCounts.set(label, (visualCounts.get(label) || 0) + 1);
  }
  const visualSummary = [...visualCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");

  const sections = [
    textLines.join("\n\n"),
    visualSummary ? `Visual elements: ${visualSummary}` : "",
  ].filter(Boolean);
  return truncate(
    sections.join("\n\n") || "[Empty frame]",
    MAX_AI_CONTEXT_CHARS_PER_FRAME,
  );
};

export const getSelectedFrameContexts = (
  elements: readonly ExcalidrawElement[],
  selectedElementIds: Readonly<Record<string, true>>,
) => {
  const selectedFrameIds = resolveSelectedFrameIds(
    elements,
    selectedElementIds,
  );
  const frames = sortFramesForPlayback(
    elements.filter(
      (element): element is NonDeleted<ExcalidrawFrameElement> =>
        !element.isDeleted &&
        element.type === "frame" &&
        selectedFrameIds.has(element.id),
    ),
  ).slice(0, MAX_AI_CONTEXT_FRAMES);

  const contexts: AIFrameContext[] = [];
  let remainingCharacters = MAX_AI_CONTEXT_CHARS_TOTAL;
  for (const [index, frame] of frames.entries()) {
    if (remainingCharacters <= 0) {
      break;
    }
    const content = truncate(
      serializeFrameContent(elements, frame),
      remainingCharacters,
    );
    contexts.push({
      id: frame.id,
      name: truncate(frame.name?.trim() || `Frame ${index + 1}`, 100),
      width: Math.round(frame.width),
      height: Math.round(frame.height),
      content,
    });
    remainingCharacters -= content.length;
  }
  return contexts;
};

export const areFrameContextsEqual = (
  left: readonly AIFrameContext[],
  right: readonly AIFrameContext[],
) =>
  left.length === right.length &&
  left.every(
    (context, index) =>
      context.id === right[index]?.id &&
      context.name === right[index]?.name &&
      context.width === right[index]?.width &&
      context.height === right[index]?.height &&
      context.content === right[index]?.content,
  );
