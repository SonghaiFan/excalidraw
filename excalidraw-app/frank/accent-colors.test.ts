import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  DEFAULT_FRANK_ACCENT,
  FRANK_ACCENT_COLORS,
  getFrankThemeColorData,
  rethemeFrankElements,
  resolveFrankAccent,
} from "./accent-colors";

describe("Frank accent colors", () => {
  it("defaults to International Klein Blue", () => {
    expect(DEFAULT_FRANK_ACCENT).toMatchObject({
      id: "klein",
      color: "#002fa7",
    });
    expect(resolveFrankAccent(null)).toBe(DEFAULT_FRANK_ACCENT);
    expect(resolveFrankAccent("unknown")).toBe(DEFAULT_FRANK_ACCENT);
  });

  it("resolves every curated accent", () => {
    FRANK_ACCENT_COLORS.forEach((accent) => {
      expect(resolveFrankAccent(accent.id)).toBe(accent);
    });
  });

  it("updates system-owned colors without touching user colors", () => {
    const elements = [
      {
        id: "ai-frame",
        type: "frame",
        name: "AI / RESPONSE / FRAME 1 OF 1",
        frameId: null,
        strokeColor: "#002fa7",
        backgroundColor: "transparent",
        customData: getFrankThemeColorData({ strokeColor: true }),
      },
      {
        id: "ai-accent",
        type: "rectangle",
        frameId: "ai-frame",
        strokeColor: "#002fa7",
        backgroundColor: "#002fa7",
        customData: getFrankThemeColorData({
          strokeColor: true,
          backgroundColor: true,
        }),
      },
      {
        id: "user-edited-ai-accent",
        type: "rectangle",
        frameId: "ai-frame",
        strokeColor: "#e03131",
        backgroundColor: "transparent",
        customData: getFrankThemeColorData({ strokeColor: true }),
      },
      {
        id: "user-blue",
        type: "rectangle",
        frameId: null,
        strokeColor: "#002fa7",
        backgroundColor: "transparent",
      },
    ] as unknown as ExcalidrawElement[];
    const result = rethemeFrankElements({
      elements,
      previousAccent: DEFAULT_FRANK_ACCENT,
      nextAccent: resolveFrankAccent("forest"),
      isDark: false,
    });

    expect(result.didChange).toBe(true);
    expect(result.elements[0].strokeColor).toBe("#146b4a");
    expect(result.elements[1]).toMatchObject({
      strokeColor: "#146b4a",
      backgroundColor: "#146b4a",
    });
    expect(result.elements[2].strokeColor).toBe("#e03131");
    expect(result.elements[3].strokeColor).toBe("#002fa7");
  });
});
