import { useI18n } from "@excalidraw/excalidraw/i18n";
import { WelcomeScreen } from "@excalidraw/excalidraw/index";
import React from "react";
import frankSignature from "../assets/frank-signature.svg";

export const AppWelcomeScreen: React.FC = React.memo(() => {
  const { t } = useI18n();

  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo>
          <img
            className="frank-brand-logo"
            src={frankSignature}
            alt="Frank Canvas"
          />
        </WelcomeScreen.Center.Logo>
        <WelcomeScreen.Center.Heading>
          Think clearly.
          <br />
          Draw simply.
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
