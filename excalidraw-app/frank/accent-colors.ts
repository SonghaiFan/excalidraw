import { removeDarkModeFilter } from "@excalidraw/common";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

export type FrankAccentColor = {
  id: string;
  name: string;
  color: string;
  dark: string;
  soft: string;
  ink: string;
};

export const FRANK_ACCENT_STORAGE_KEY = "frank-canvas-accent-color";
export const FRANK_THEME_COLOR_DATA_KEY = "frankThemeColor";

export type FrankThemeColorBinding = {
  strokeColor?: true;
  backgroundColor?: true;
};

export const FRANK_ACCENT_COLORS: readonly FrankAccentColor[] = [
  {
    id: "klein",
    name: "Klein blue",
    color: "#002fa7",
    dark: "#00247f",
    soft: "#e7edff",
    ink: "#ffffff",
  },
  {
    id: "orange",
    name: "Red orange",
    color: "#ff8000",
    dark: "#cc6500",
    soft: "#fff0df",
    ink: "#171717",
  },
] as const;

export const DEFAULT_FRANK_ACCENT = FRANK_ACCENT_COLORS[0];

export const resolveFrankAccent = (id: string | null | undefined) =>
  FRANK_ACCENT_COLORS.find((accent) => accent.id === id) ||
  DEFAULT_FRANK_ACCENT;

export const getFrankThemeColorData = (
  binding: FrankThemeColorBinding,
  customData?: ExcalidrawElement["customData"],
) => ({
  ...customData,
  [FRANK_THEME_COLOR_DATA_KEY]: binding,
});

export const rethemeFrankElements = ({
  elements,
  previousAccent,
  nextAccent,
  isDark,
}: {
  elements: readonly ExcalidrawElement[];
  previousAccent: FrankAccentColor;
  nextAccent: FrankAccentColor;
  isDark: boolean;
}) => {
  const previousColors = new Set([
    previousAccent.color,
    removeDarkModeFilter(previousAccent.color),
  ]);
  const nextColor = isDark
    ? removeDarkModeFilter(nextAccent.color)
    : nextAccent.color;
  let didChange = false;
  const nextElements = elements.map((element) => {
    if (element.isDeleted) {
      return element;
    }
    const binding = element.customData?.[FRANK_THEME_COLOR_DATA_KEY] as
      | FrankThemeColorBinding
      | undefined;
    const updates: {
      strokeColor?: string;
      backgroundColor?: string;
    } = {};
    const nextBinding: FrankThemeColorBinding = { ...binding };

    if (
      binding?.strokeColor &&
      previousColors.has(element.strokeColor)
    ) {
      updates.strokeColor = nextColor;
      nextBinding.strokeColor = true;
    }
    if (
      binding?.backgroundColor &&
      previousColors.has(element.backgroundColor)
    ) {
      updates.backgroundColor = nextColor;
      nextBinding.backgroundColor = true;
    }
    if (!updates.strokeColor && !updates.backgroundColor) {
      return element;
    }
    didChange = true;
    return newElementWith(element, {
      ...updates,
      customData: getFrankThemeColorData(nextBinding, element.customData),
    });
  });

  return { elements: nextElements, didChange };
};
