import { removeDarkModeFilter } from "@excalidraw/common";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

export type FrankAccentPalette = {
  color: string;
  hover: string;
  soft: string;
  ink: string;
};

export type FrankAccentColor = {
  id: string;
  name: string;
  light: FrankAccentPalette;
  dark: FrankAccentPalette;
  swatch: string;
};

export const FRANK_ACCENT_STORAGE_KEY = "frank-canvas-accent-color-v2";
export const FRANK_THEME_COLOR_DATA_KEY = "frankThemeColor";

export type FrankThemeColorBinding = {
  strokeColor?: true;
  backgroundColor?: true;
};

export const FRANK_ACCENT_COLORS: readonly FrankAccentColor[] = [
  {
    id: "black-white",
    name: "Black / white",
    light: {
      color: "#000000",
      hover: "#242424",
      soft: "#ededed",
      ink: "#ffffff",
    },
    dark: {
      color: "#ffffff",
      hover: "#d8d8d8",
      soft: "#1b1b1b",
      ink: "#000000",
    },
    swatch: "linear-gradient(135deg, #000000 0 50%, #ffffff 50% 100%)",
  },
  {
    id: "klein",
    name: "Klein blue",
    light: {
      color: "#002fa7",
      hover: "#00247f",
      soft: "#e7edff",
      ink: "#ffffff",
    },
    dark: {
      color: "#5f7fff",
      hover: "#89a0ff",
      soft: "#151b2e",
      ink: "#000000",
    },
    swatch: "#002fa7",
  },
  {
    id: "orange",
    name: "Red orange",
    light: {
      color: "#ff8000",
      hover: "#cc6500",
      soft: "#fff0df",
      ink: "#171717",
    },
    dark: {
      color: "#ff8f1f",
      hover: "#ffab59",
      soft: "#2a1b0d",
      ink: "#000000",
    },
    swatch: "#ff8000",
  },
] as const;

export const DEFAULT_FRANK_ACCENT = FRANK_ACCENT_COLORS[0];

export const resolveFrankAccent = (id: string | null | undefined) =>
  FRANK_ACCENT_COLORS.find((accent) => accent.id === id) ||
  DEFAULT_FRANK_ACCENT;

export const getFrankAccentPalette = (
  accent: FrankAccentColor,
  isDark: boolean,
) => (isDark ? accent.dark : accent.light);

export const getFrankAccentElementColor = (
  accent: FrankAccentColor,
  isDark: boolean,
) => {
  const color = getFrankAccentPalette(accent, isDark).color;
  return isDark ? removeDarkModeFilter(color) : color;
};

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
  wasDark,
  isDark,
}: {
  elements: readonly ExcalidrawElement[];
  previousAccent: FrankAccentColor;
  nextAccent: FrankAccentColor;
  wasDark: boolean;
  isDark: boolean;
}) => {
  const previousColor = getFrankAccentElementColor(previousAccent, wasDark);
  const nextColor = getFrankAccentElementColor(nextAccent, isDark);
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

    if (binding?.strokeColor && element.strokeColor === previousColor) {
      updates.strokeColor = nextColor;
      nextBinding.strokeColor = true;
    }
    if (binding?.backgroundColor && element.backgroundColor === previousColor) {
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
