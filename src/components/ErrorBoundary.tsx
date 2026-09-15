import { Component, type ErrorInfo, type ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { getLanguage } from "../lib/language";

interface State {
  error: Error | null;
}

/**
 * Catches a render error and shows a way out instead of nothing at all.
 *
 * React unmounts the entire tree when a render throws, so without this the page goes completely
 * blank - which is what players saw when a room was deleted or they were kicked out from under a
 * screen that was still reading it. A blank page also hides the cause: the message is printed here
 * and logged, so a report can say what actually broke rather than "it went white".
 *
 * Recovery is a full reload rather than a state reset. Whatever threw did so with data this session
 * is still holding, and re-rendering the same tree would usually throw again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    // A class component can't call the useT() hook, so it reads the language store directly - the
    // same value the hook wraps, just without the re-render subscription this component never needs
    // (there's nothing to switch languages mid-render on the one screen that exists to say goodbye).
    const lang = getLanguage();
    const t = (en: string, fr: string) => (lang === "fr" ? fr : en);

    return (
      <div className="stack" style={{ width: "min(520px, 100%)", margin: "0 auto" }}>
        <div className="panel stack" style={{ alignItems: "center", textAlign: "center", gap: "0.6rem" }}>
          {/* Dimmed and decorative: the heading below already says what happened, and on the one
              screen that exists to deliver bad news the logo should not be the brightest thing
              in the panel. */}
          <BrandMark width="8rem" dim decorative />
          <h2 style={{ margin: 0 }}>{t("Something came loose", "Quelque chose s'est détaché")}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "This screen hit an error and stopped. Your fleet and the match are fine: they live on the server, not in this tab.",
              "Cet écran a rencontré une erreur et s'est arrêté. Votre flotte et la partie sont en sécurité : elles vivent sur le serveur, pas dans cet onglet."
            )}
          </p>
          <code style={{ fontSize: "0.72rem", color: "var(--text-dim)", overflowWrap: "anywhere" }}>
            {this.state.error.message}
          </code>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button
              className="primary"
              onClick={() => {
                window.location.hash = "#/";
                window.location.reload();
              }}
            >
              {t("Return to harbor", "Retour au port")}
            </button>
            <button onClick={() => window.location.reload()}>{t("Reload this screen", "Recharger cet écran")}</button>
          </div>
        </div>
      </div>
    );
  }
}
