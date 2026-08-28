import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

export const FRAME_PRESETS = {
  portrait: { label: "Portrait · 4:5", width: 1080, height: 1350 },
  square: { label: "Square · 1:1", width: 1080, height: 1080 },
  story: { label: "Story · 9:16", width: 1080, height: 1920 },
  landscape: { label: "Landscape · 16:9", width: 1600, height: 900 },
} as const;

export type FramePreset = keyof typeof FRAME_PRESETS | "custom";

export const isKeyboardInputTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  );

export const getFrameNavigationDelta = ({
  key,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
}: Pick<
  KeyboardEvent,
  "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>) => {
  if (altKey || ctrlKey || metaKey || shiftKey) {
    return 0;
  }
  return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
};

export const clampFrameDimension = (value: string, fallback: number) =>
  Math.min(3000, Math.max(480, Number(value) || fallback));

export const sortFramesForPlayback = (
  frames: readonly NonDeleted<ExcalidrawFrameElement>[],
) =>
  [...frames].sort((a, b) => {
    const sameRow = Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.25;
    return sameRow ? a.x - b.x : a.y - b.y;
  });

export const resolveSelectedFrameId = (
  elements: readonly ExcalidrawElement[],
  selectedElementIds: Readonly<Record<string, true>>,
) =>
  resolveSelectedFrameIds(elements, selectedElementIds).values().next().value ||
  null;

export const resolveSelectedFrameIds = (
  elements: readonly ExcalidrawElement[],
  selectedElementIds: Readonly<Record<string, true>>,
) => {
  const frameIds = new Set<string>();
  for (const element of elements) {
    if (!element.isDeleted && selectedElementIds[element.id]) {
      const frameId = element.type === "frame" ? element.id : element.frameId;
      if (frameId) {
        frameIds.add(frameId);
      }
    }
  }
  return frameIds;
};

export const getNextFramePosition = (
  frames: readonly NonDeleted<ExcalidrawFrameElement>[],
  currentFrame: NonDeleted<ExcalidrawFrameElement>,
  gap = 96,
) => {
  const framesInRow = frames.filter(
    (frame) =>
      Math.abs(frame.y - currentFrame.y) <
      Math.min(frame.height, currentFrame.height) * 0.25,
  );
  const rightEdge = Math.max(
    currentFrame.x + currentFrame.width,
    ...framesInRow.map((frame) => frame.x + frame.width),
  );
  return { x: rightEdge + gap, y: currentFrame.y };
};
