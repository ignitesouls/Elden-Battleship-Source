import { useEffect, useState } from "react";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { createOverlayToken, fetchOverlayToken, maskOverlayToken, rotateOverlayToken } from "../lib/streamOverlay";
import { useT } from "../lib/language";
import "../pages/Streaming.css";

/**
 * The signed-in streamer's overlay token, and the one way to change it.
 *
 * Shared by the OBS page and a crew's quarters, so the two can never disagree about who may have a
 * token or what making one does. A Twitch account, or nothing: an anonymous session's user id lives in
 * one browser's storage, so a scene built against it would stop resolving the moment somebody cleared
 * their cache - with no error anywhere, in the middle of a stream.
 */
export function useMyOverlayToken() {
  const viewer = useAuthProfile();
  const signedIn = Boolean(viewer?.isTwitch);

  /** `undefined` while loading, `null` when they have never made one. Mirrors AutoFireSetup. */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setToken(null);
      return;
    }
    void (async () => {
      try {
        setToken(await fetchOverlayToken());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setToken(null);
      }
    })();
  }, [signedIn]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setToken(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return { signedIn, token, busy, error, run };
}

export type MyOverlayToken = ReturnType<typeof useMyOverlayToken>;

/** Before there is a token: why they must sign in, or the button that makes one. Nothing once it exists. */
export function OverlayTokenStart({ mine }: { mine: MyOverlayToken }) {
  const t = useT();
  if (!mine.signedIn) {
    return (
      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
        {t(
          "Sign in with Twitch first. Without an account you exist only in this browser, so clearing your cache would leave your whole scene pointing at nobody.",
          "Connectez-vous d'abord avec Twitch. Sans compte, vous n'existez que dans ce navigateur, donc vider votre cache laisserait toute votre scène pointer vers personne."
        )}
      </span>
    );
  }
  if (mine.token !== null) return null;
  return (
    <>
      <button onClick={() => void mine.run(createOverlayToken)} disabled={mine.busy} style={{ fontSize: "0.8rem" }}>
        {mine.busy ? t("Setting up...", "Configuration...") : t("Set up overlay", "Configurer l'overlay")}
      </button>
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        {t(
          "Makes a read-only token. It can't fire shots, take your seat, or read your account.",
          "Crée un jeton en lecture seule. Il ne peut pas tirer, prendre votre place, ni lire votre compte."
        )}
      </span>
    </>
  );
}

/** The token itself, masked, with Reveal and a confirmed Rotate. */
export function OverlayTokenBox({ mine, token }: { mine: MyOverlayToken; token: string }) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  return (
    <div className="stack" style={{ gap: "0.3rem" }}>
      <span style={{ fontSize: "0.78rem" }}>{t("Your overlay token", "Votre jeton d'overlay")}</span>
      <code className="obs-token">{revealed ? token : maskOverlayToken(token)}</code>
      <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
        <button onClick={() => setRevealed((r) => !r)} style={{ fontSize: "0.74rem" }}>
          {revealed ? t("Hide", "Masquer") : t("Reveal", "Révéler")}
        </button>
        {confirmingRotate ? (
          <>
            <button
              onClick={() => void mine.run(rotateOverlayToken).finally(() => setConfirmingRotate(false))}
              disabled={mine.busy}
              style={{ fontSize: "0.74rem", color: "var(--hit)" }}
            >
              {mine.busy ? t("Rotating...", "Rotation...") : t("Yes, rotate it", "Oui, le régénérer")}
            </button>
            <button onClick={() => setConfirmingRotate(false)} style={{ fontSize: "0.74rem" }}>
              {t("Cancel", "Annuler")}
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmingRotate(true)} style={{ fontSize: "0.74rem" }}>
            {t("Rotate token", "Régénérer le jeton")}
          </button>
        )}
      </div>
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
        {confirmingRotate
          ? t(
              "Kills the old token at once: every source in your scene goes blank until you download and import again.",
              "Annule le jeton actuel immédiatement : toutes les sources de votre scène deviennent vides jusqu'à ce que vous retéléchargiez et réimportiez."
            )
          : t(
              "There's nothing to paste anywhere - it's already inside the scene file. Masked because people screenshot this page; rotate it if it leaks, then import the scene again.",
              "Il n'y a rien à coller nulle part - il est déjà dans le fichier de scène. Masqué parce que les gens font des captures d'écran de cette page ; régénérez-le s'il fuite, puis réimportez la scène."
            )}
      </span>
    </div>
  );
}

/** A failed load, create or rotate, in the page's error red. */
export function OverlayTokenError({ mine }: { mine: MyOverlayToken }) {
  if (!mine.error) return null;
  return (
    <span style={{ fontSize: "0.72rem", color: "var(--hit)" }} role="alert">
      {mine.error}
    </span>
  );
}
