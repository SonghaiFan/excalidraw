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
  palette: FrankAccentPalette;
  darkPalette?: FrankAccentPalette;
  swatch: string;
};

export const FRANK_ACCENT_STORAGE_KEY = "frank-canvas-accent-color-v2";
export const FRANK_THEME_COLOR_DATA_KEY = "frankThemeColor";

export type FrankThemeColorBinding = {
  strokeColor?: string;
  backgroundColor?: string;
};

export const FRANK_ACCENT_COLORS: readonly FrankAccentColor[] = [
  {
    id: "black-white",
    name: "Black / white",
    palette: {
      color: "#000000",
      hover: "#242424",
      soft: "#ededed",
      ink: "#ffffff",
    },
    darkPalette: {
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
    palette: {
      color: "#002fa7",
      hover: "#00247f",
      soft: "#e7edff",
      ink: "#ffffff",
    },
    swatch: "#002fa7",
  },
  {
    id: "orange",
    name: "Red orange",
    palette: {
      color: "#ff8000",
      hover: "#cc6500",
      soft: "#fff0df",
      ink: "#171717",
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
) => (isDark && accent.darkPalette ? accent.darkPalette : accent.palette);

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
  nextAccent,
  isDark,
}: {
  elements: readonly ExcalidrawElement[];
  nextAccent: FrankAccentColor;
  isDark: boolean;
}) => {
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

    if (binding?.strokeColor === element.strokeColor) {
      updates.strokeColor = nextColor;
      nextBinding.strokeColor = nextColor;
    }
    if (binding?.backgroundColor === element.backgroundColor) {
      updates.backgroundColor = nextColor;
      nextBinding.backgroundColor = nextColor;
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
