import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { isTwitchLoginConfigured, signInWithTwitch } from "../lib/supabase";
import { autoFireSupported, fetchIngestToken } from "../lib/autoFire";
import { useT } from "../lib/language";

/**
 * Whether the game is marking this player's squares for them, said in the room where it matters.
 *
 * -- Why it is in the match screen at all --------------------------------------------------------
 *
 * The setup lives on the profile page, but nobody goes looking for a feature they don't know exists.
 * This is where a player is when the question "why did that square not fill in?" occurs to them, and
 * where an anonymous player finds out that signing in would have marked it.
 *
 * -- Why it vanishes on the objectives boards ----------------------------------------------------
 *
 * Auto-marking can never work on them: their squares are counters and judgement calls that no event
 * flag can settle. So this renders nothing at all rather than a disabled control - an affordance
 * that will never become available is just something else to read on a screen that already has a
 * board, a feed and a clock on it.
 */
export function AutoFireStatus({ squareSet }: { squareSet: string | null | undefined }) {
  const profile = useAuthProfile();
  const t = useT();
  /** `undefined` while unread; only ever fetched for a signed-in player, who is the only one who can have one. */
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!profile?.isTwitch) {
      setToken(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const found = await fetchIngestToken();
        if (live) setToken(found);
      } catch {
        // Not worth a message in the match screen. A failed read shows the same "set it up" prompt
        // as having no token, and the profile page reports properly if something is actually wrong.
        if (live) setToken(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [profile?.isTwitch, profile?.userId]);

  if (!autoFireSupported(squareSet)) return null;

  const line = { fontSize: "0.72rem", lineHeight: 1.35 } as const;

  // Anonymous - the one case that is a pitch rather than a status. Framed as something to gain,
  // because it is: the account is free and the feature is the reason to make one.
  if (!profile?.isTwitch) {
    return (
      <div className="panel stack" style={{ gap: "0.35rem", padding: "0.5rem" }}>
        <span style={line}>
          <strong>{t("Auto-marking", "Le marquage automatique")}</strong> {t("fires a square the moment you kill its boss.", "tire sur une case dès que vous tuez son boss.")}
        </span>
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          {t(
            "Needs a Twitch sign-in: the game mod carries a token that has to outlive your browser cache. It asks for no permissions, not even your email.",
            "Nécessite une connexion Twitch : le mod de jeu porte un jeton qui doit survivre au cache de votre navigateur. Il ne demande aucune permission, pas même votre e-mail."
          )}
        </span>
        <button
          onClick={() => void signInWithTwitch()}
          disabled={!isTwitchLoginConfigured}
          style={{ fontSize: "0.74rem" }}
        >
          {t("Sign in to unlock it", "Connectez-vous pour le débloquer")}
        </button>
      </div>
    );
  }

  if (token === undefined) return null;

  if (token === null) {
    return (
      <div className="panel stack" style={{ gap: "0.35rem", padding: "0.5rem" }}>
        <span style={line}>
          <strong>{t("Auto-marking", "Le marquage automatique")}</strong> {t("works on this board.", "fonctionne sur ce plateau.")}
        </span>
        <Link to={`/player/${profile.userId}`} style={{ fontSize: "0.74rem" }}>
          {t("Set it up on your profile →", "Configurez-le sur votre profil →")}
        </Link>
      </div>
    );
  }

  // Armed. Deliberately not a promise that it is *working* - this only knows a token exists, not
  // that the mod is running or that the game is even open. The mod's own overlay is what confirms
  // shots are landing; this confirms the website's half is ready.
  return (
    <span className="muted" style={{ ...line, opacity: 0.85 }}>
      ⚔ {t("Auto-marking armed", "Marquage automatique activé")}
    </span>
  );
}
