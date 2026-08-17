import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  DEFAULT_FRANK_ACCENT,
  FRANK_ACCENT_COLORS,
  getFrankAccentElementColor,
  getFrankAccentPalette,
  getFrankThemeColorData,
  rethemeFrankElements,
  resolveFrankAccent,
} from "./accent-colors";

describe("Frank accent colors", () => {
  it("defaults to one adaptive black and white accent", () => {
    expect(DEFAULT_FRANK_ACCENT).toMatchObject({
      id: "black-white",
      palette: { color: "#000000", ink: "#ffffff" },
      darkPalette: { color: "#ffffff", ink: "#000000" },
    });
    expect(getFrankAccentPalette(DEFAULT_FRANK_ACCENT, false).color).toBe(
      "#000000",
    );
    expect(getFrankAccentPalette(DEFAULT_FRANK_ACCENT, true).color).toBe(
      "#ffffff",
    );
    expect(resolveFrankAccent(null)).toBe(DEFAULT_FRANK_ACCENT);
    expect(resolveFrankAccent("unknown")).toBe(DEFAULT_FRANK_ACCENT);
  });

  it("resolves every curated accent", () => {
    expect(FRANK_ACCENT_COLORS).toHaveLength(3);
    expect(resolveFrankAccent("orange")).toMatchObject({
      palette: { color: "#ff8000", ink: "#171717" },
    });
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
        customData: getFrankThemeColorData({ strokeColor: "#002fa7" }),
      },
      {
        id: "ai-accent",
        type: "rectangle",
        frameId: "ai-frame",
        strokeColor: "#002fa7",
        backgroundColor: "#002fa7",
        customData: getFrankThemeColorData({
          strokeColor: "#002fa7",
          backgroundColor: "#002fa7",
        }),
      },
      {
        id: "user-edited-ai-accent",
        type: "rectangle",
        frameId: "ai-frame",
        strokeColor: "#e03131",
        backgroundColor: "transparent",
        customData: getFrankThemeColorData({ strokeColor: "#002fa7" }),
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
      nextAccent: resolveFrankAccent("orange"),
      isDark: false,
    });

    expect(result.didChange).toBe(true);
    expect(result.elements[0].strokeColor).toBe("#ff8000");
    expect(result.elements[1]).toMatchObject({
      strokeColor: "#ff8000",
      backgroundColor: "#ff8000",
      customData: {
        frankThemeColor: {
          strokeColor: "#ff8000",
          backgroundColor: "#ff8000",
        },
      },
    });
    expect(result.elements[2].strokeColor).toBe("#e03131");
    expect(result.elements[3].strokeColor).toBe("#002fa7");
  });

  it("switches system-owned black to white with the editor theme", () => {
    const elements = [
      {
        id: "ai-heading",
        type: "text",
        frameId: null,
        strokeColor: "#000000",
        backgroundColor: "transparent",
        customData: getFrankThemeColorData({ strokeColor: "#000000" }),
      },
      {
        id: "user-black",
        type: "text",
        frameId: null,
        strokeColor: "#000000",
        backgroundColor: "transparent",
      },
    ] as unknown as ExcalidrawElement[];
    const result = rethemeFrankElements({
      elements,
      nextAccent: DEFAULT_FRANK_ACCENT,
      isDark: true,
    });

    expect(result.elements[0].strokeColor).toBe(
      getFrankAccentElementColor(DEFAULT_FRANK_ACCENT, true),
    );
    expect(result.elements[1].strokeColor).toBe("#000000");
  });

  it("uses the recorded system color instead of guessing the prior accent", () => {
    const elements = [
      {
        id: "ai-accent",
        type: "rectangle",
        frameId: null,
        strokeColor: "#002fa7",
        backgroundColor: "#002fa7",
        customData: getFrankThemeColorData({
          strokeColor: "#002fa7",
          backgroundColor: "#002fa7",
        }),
      },
      {
        id: "user-edited-ai-accent",
        type: "rectangle",
        frameId: null,
        strokeColor: "#e03131",
        backgroundColor: "transparent",
        customData: getFrankThemeColorData({ strokeColor: "#002fa7" }),
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
      nextAccent: DEFAULT_FRANK_ACCENT,
      isDark: false,
    });

    expect(result.elements[0]).toMatchObject({
      strokeColor: "#000000",
      backgroundColor: "#000000",
      customData: {
        frankThemeColor: {
          strokeColor: "#000000",
          backgroundColor: "#000000",
        },
      },
    });
    expect(result.elements[1].strokeColor).toBe("#e03131");
    expect(result.elements[2].strokeColor).toBe("#002fa7");
  });

  it("keeps colored accents visually stable across editor themes", () => {
    for (const accentId of ["klein", "orange"]) {
      const accent = resolveFrankAccent(accentId);
      expect(getFrankAccentPalette(accent, true).color).toBe(
        getFrankAccentPalette(accent, false).color,
      );
    }
  });
});
