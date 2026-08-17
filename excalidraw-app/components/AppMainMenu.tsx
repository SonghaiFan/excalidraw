import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { FRANK_ACCENT_COLORS } from "../frank/accent-colors";

export const AppMainMenu: React.FC<{
  theme: Theme | "system";
  accentId: string;
  onAccentChange: (accentId: string) => void;
}> = React.memo((props) => {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <div
          className="frank-accent-picker"
          role="group"
          aria-label="Accent color"
        >
          <span>Accent color</span>
          <div className="frank-accent-picker__options">
            {FRANK_ACCENT_COLORS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                title={accent.name}
                aria-label={accent.name}
                aria-pressed={props.accentId === accent.id}
                style={{ background: accent.swatch }}
                onClick={() => props.onAccentChange(accent.id)}
              />
            ))}
          </div>
        </div>
      </MainMenu.ItemCustom>
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
});
