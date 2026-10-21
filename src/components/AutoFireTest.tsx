import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  AUTOFIRE_TEST_PREP_SECONDS,
  AUTOFIRE_TEST_SQUARES,
  autoFireTestPhaseAt,
  type AutoFireTestKill,
} from "../lib/autoFireTest";
import { useT } from "../lib/language";

/**
 * A fake two-square game that proves auto-marking works before a real match depends on it.
 *
 * -- Why a test at all ----------------------------------------------------------------------------
 *
 * "Auto-marking armed" only knows a token exists. Whether Dionysus has that token, whether Elden Ring
 * was relaunched since, and whether the kill actually reaches us were all things a player found out
 * mid-match, by a square not filling in. This runs the real path - the mod, the token lookup, the
 * flag -> square lookup - against a fixed board where nothing counts.
 *
 * -- How it works ---------------------------------------------------------------------------------
 *
 * Start writes one autofire_tests row. While it is under ten minutes old and the player is in no live
 * match, the auto-fire edge function answers the mod from it instead of saying `not_in_match`, and
 * records each test boss the first time it sees it. This page polls that row. The preparation
 * countdown is there so the mod's first polls land before the go: anything reported during it was
 * already dead on the save, which is the one failure a player can't otherwise tell from "broken".
 *
 * Polled, not Realtime: two seconds, for at most ten minutes, stopping as soon as both squares are
 * settled - a few hundred requests a test, against a channel that would sit open on a setup page.
 */

const POLL_MS = 2000;
/** How long after the go to wait before saying the game hasn't been heard from. */
const SILENCE_WARN_SECONDS = 15;

interface TestRow {
  started_at: string;
  last_seen_at: string | null;
  kills: Record<string, AutoFireTestKill>;
}

/** Supabase's errors are plain objects with a `message`, not Error instances, so String() gives "[object Object]". */
function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AutoFireTest() {
  const t = useT();
  /** `undefined` while the first read is out; `null` when no test has been run (or it was stopped). */
  const [row, setRow] = useState<TestRow | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    const { data, error } = await supabase
      .from("autofire_tests")
      .select("started_at, last_seen_at, kills")
      .maybeSingle();
    if (error) throw error;
    const found = data as TestRow | null;
    // A malformed kills value reads as none yet, same as the edge function treats it.
    if (found && (typeof found.kills !== "object" || found.kills === null || Array.isArray(found.kills))) found.kills = {};
    setRow(found ?? null);
  }, []);

  useEffect(() => {
    read().catch(() => setRow(null));
  }, [read]);

  const startedMs = row ? Date.parse(row.started_at) : null;
  const { phase, seconds } = startedMs !== null ? autoFireTestPhaseAt(startedMs, now) : { phase: "over" as const, seconds: 0 };
  const settled = row ? AUTOFIRE_TEST_SQUARES.every((s) => row.kills[s.tooltip]) : false;
  const running = row !== null && row !== undefined && phase !== "over";

  // The clock ticks on its own; the row is re-read until both squares are settled or time runs out.
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 500);
    const poll = settled ? null : setInterval(() => void read().catch(() => {}), POLL_MS);
    return () => {
      clearInterval(tick);
      if (poll) clearInterval(poll);
    };
  }, [running, settled, read]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.rpc("start_autofire_test");
      if (error) throw error;
      setNow(Date.now());
      await read();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.rpc("stop_autofire_test");
      if (error) throw error;
      setRow(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (row === undefined) return null;

  const fired = row ? AUTOFIRE_TEST_SQUARES.filter((s) => row.kills[s.tooltip]?.phase === "match").length : 0;
  const deadBefore = row ? AUTOFIRE_TEST_SQUARES.some((s) => row.kills[s.tooltip]?.phase === "preparation") : false;
  const heardAgo = row?.last_seen_at ? Math.max(0, Math.round((now - Date.parse(row.last_seen_at)) / 1000)) : null;
  const silent = running && phase === "match" && seconds >= SILENCE_WARN_SECONDS && heardAgo === null;
  const small = { fontSize: "0.7rem", lineHeight: 1.45, margin: 0 } as const;

  return (
    <div className="stack" style={{ gap: "0.5rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
      <strong style={{ fontSize: "0.8rem" }}>{t("Test it", "Testez-le")}</strong>
      <p className="muted" style={small}>
        {t(
          "A fake two-square game. Kill both bosses and watch their squares fire. Nothing counts and nobody else sees it.",
          "Une fausse partie à deux cases. Tuez les deux boss et regardez leurs cases se marquer. Rien ne compte et personne d'autre ne le voit."
        )}
      </p>
      <ol style={{ ...small, paddingLeft: "1.2rem" }}>
        <li>
          {t(
            "Start a new character. Both bosses must still be alive - one already dead on your save can't fire.",
            "Créez un nouveau personnage. Les deux boss doivent être en vie - un boss déjà mort sur votre sauvegarde ne peut pas se marquer."
          )}
        </li>
        <li>
          {t(
            "Open a training tool (like ERTool or Tarnished Tool, for example) and play offline. Use it to warp to each boss and one-shot it.",
            "Ouvrez un outil d'entraînement (comme ERTool ou Tarnished Tool, par exemple) et jouez hors ligne. Servez-vous-en pour vous téléporter à chaque boss et le tuer en un coup."
          )}
        </li>
        <li>
          {t(
            `Press Start test, wait out the ${AUTOFIRE_TEST_PREP_SECONDS}-second preparation, then kill them. You have 10 minutes.`,
            `Appuyez sur Lancer le test, attendez la fin des ${AUTOFIRE_TEST_PREP_SECONDS} secondes de préparation, puis tuez-les. Vous avez 10 minutes.`
          )}
        </li>
      </ol>

      <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void start()} disabled={busy} style={{ fontSize: "0.76rem" }}>
          {running ? t("Restart test", "Relancer le test") : t("Start test", "Lancer le test")}
        </button>
        {running && (
          <button onClick={() => void stop()} disabled={busy} style={{ fontSize: "0.76rem" }}>
            {t("Stop", "Arrêter")}
          </button>
        )}
        {running && (
          <span style={{ fontSize: "0.76rem", fontVariantNumeric: "tabular-nums" }}>
            {phase === "preparation"
              ? `${t("Preparation", "Préparation")} ${seconds}`
              : `${t("Live", "En cours")} ${clock(seconds)}`}
          </span>
        )}
        {row && !running && (
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {t("Test over.", "Test terminé.")}
          </span>
        )}
      </div>

      {row && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 9rem))", gap: "3px" }}>
            {AUTOFIRE_TEST_SQUARES.map((square, i) => {
              const kill = row.kills[square.tooltip];
              const bg = !kill ? (i % 2 ? "var(--cell-alt)" : "var(--cell)") : kill.phase === "match" ? "var(--hit-fill)" : "var(--miss-fill)";
              const at = kill && startedMs !== null ? (Date.parse(kill.at) - startedMs) / 1000 - AUTOFIRE_TEST_PREP_SECONDS : 0;
              return (
                <div
                  key={square.tooltip}
                  title={square.tooltip}
                  style={{
                    background: bg,
                    border: `1px solid ${kill?.phase === "match" ? "var(--hit)" : "var(--panel-border)"}`,
                    borderRadius: "4px",
                    padding: "0.5rem 0.4rem",
                    aspectRatio: "1",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    alignItems: "center",
                    textAlign: "center",
                    gap: "0.25rem",
                    color: "var(--cell-text)",
                  }}
                >
                  <strong style={{ fontSize: "0.8rem" }}>{square.name}</strong>
                  <span style={{ fontSize: "0.62rem", lineHeight: 1.3 }}>
                    {!kill
                      ? t("Waiting", "En attente")
                      : kill.phase === "match"
                        ? `${t("Fired at", "Marquée à")} ${clock(at)}`
                        : t("Already dead on this save", "Déjà mort sur cette sauvegarde")}
                  </span>
                </div>
              );
            })}
          </div>

          {running && <span className="muted" style={{ fontSize: "0.68rem" }}>
            {heardAgo === null
              ? t("Waiting to hear from the game...", "En attente du jeu...")
              : `${t("Game connected - last heard", "Jeu connecté - dernier signal il y a")} ${heardAgo}s${t(" ago", "")}`}
          </span>}

          {fired === AUTOFIRE_TEST_SQUARES.length && (
            <span style={{ fontSize: "0.74rem", color: "var(--accent)" }}>
              ✓ {t("Auto-marking works. You're ready for a real match.", "Le marquage automatique fonctionne. Vous êtes prêt pour une vraie partie.")}
            </span>
          )}
          {deadBefore && (
            <span style={{ fontSize: "0.7rem", lineHeight: 1.4, color: "var(--hit)" }}>
              {t(
                "The game is connected, but a boss was already dead when the test started. Load a new character and restart the test.",
                "Le jeu est connecté, mais un boss était déjà mort au début du test. Chargez un nouveau personnage et relancez le test."
              )}
            </span>
          )}
          {silent && (
            <span style={{ fontSize: "0.7rem", lineHeight: 1.4, color: "var(--hit)" }}>
              {t(
                "Nothing from the game yet. Check that Dionysus Arcade has this token saved and that Elden Ring was launched after you saved it. If you're seated in a match that's live on the site, that match gets your kills instead.",
                "Rien du jeu pour l'instant. Vérifiez que le token est enregistré dans Dionysus Arcade et qu'Elden Ring a été lancé après l'enregistrement. Si vous êtes inscrit dans une partie en cours sur le site, c'est elle qui reçoit vos kills."
              )}
            </span>
          )}
        </>
      )}

      {error && (
        <span className="error-text" style={{ fontSize: "0.7rem" }}>
          {error}
        </span>
      )}
    </div>
  );
}
