import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  getSelectedFrameContexts,
  MAX_AI_CONTEXT_CHARS_PER_FRAME,
  MAX_AI_CONTEXT_FRAMES,
} from "./frame-context";

const element = (value: Record<string, unknown>) =>
  value as unknown as ExcalidrawElement;

const frame = (id: string, x: number, y: number, name = id) =>
  element({
    id,
    type: "frame",
    x,
    y,
    width: 1080,
    height: 1350,
    name,
    isDeleted: false,
    frameId: null,
  });

const text = (
  id: string,
  frameId: string,
  value: string,
  x: number,
  y: number,
) =>
  element({
    id,
    type: "text",
    x,
    y,
    width: 100,
    height: 20,
    text: value,
    originalText: value,
    fontSize: 20,
    link: null,
    isDeleted: false,
    frameId,
  });

describe("Frank Frame context", () => {
  it("deduplicates a selected frame and its child and preserves reading order", () => {
    const elements = [
      frame("frame-a", 0, 0, "Research"),
      text("second", "frame-a", "Second", 20, 80),
      text("first", "frame-a", "First", 20, 20),
      element({
        id: "shape",
        type: "rectangle",
        x: 10,
        y: 10,
        isDeleted: false,
        frameId: "frame-a",
      }),
    ];

    const [context] = getSelectedFrameContexts(elements, {
      "frame-a": true,
      first: true,
    });

    expect(context).toMatchObject({
      id: "frame-a",
      name: "Research",
      width: 1080,
      height: 1350,
    });
    expect(context.content.indexOf("First")).toBeLessThan(
      context.content.indexOf("Second"),
    );
    expect(context.content).toContain("Visual elements: 1 rectangles");
    expect(context.content).not.toContain("frame-a");
    expect(context.content).not.toContain("versionNonce");
  });

  it("orders frames spatially and limits the request to four", () => {
    const elements = [
      frame("third", 0, 2000),
      frame("second", 1200, 0),
      frame("first", 0, 0),
      frame("fourth", 1200, 2000),
      frame("fifth", 0, 4000),
    ];
    const selected = Object.fromEntries(
      elements.map(({ id }) => [id, true]),
    ) as Record<string, true>;

    expect(
      getSelectedFrameContexts(elements, selected).map(({ id }) => id),
    ).toEqual(["first", "second", "third", "fourth"]);
    expect(getSelectedFrameContexts(elements, selected)).toHaveLength(
      MAX_AI_CONTEXT_FRAMES,
    );
  });

  it("truncates large frame text deterministically", () => {
    const elements = [
      frame("frame-a", 0, 0),
      text("large", "frame-a", "A".repeat(8_000), 0, 0),
    ];
    const [context] = getSelectedFrameContexts(elements, { "frame-a": true });

    expect(context.content).toHaveLength(MAX_AI_CONTEXT_CHARS_PER_FRAME);
    expect(context.content.endsWith("…")).toBe(true);
  });
});
