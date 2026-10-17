import { useEffect, useState } from "react";
import { setMatchTime, type MatchRow, type TeamRow } from "../../lib/tournament/api";
import { fromLocalInput, toLocalInput } from "../../lib/tournament/localTime";
import { useLanguage, useT } from "../../lib/language";

interface Props {
  match: MatchRow;
  /** A captain of one of the two teams: the only player who may set the time. */
  isCaptain: boolean;
  /** Who last set the time, already worded ("your captain", "their captain", "an administrator"). */
  setBy?: string | null;
  reload: () => void;
}

/**
 * Who set a match's time, worded for a player on `mine`: you, your captain, the other team's captain,
 * or - anyone on neither roster - an administrator. Null when nobody has set one.
 */
export function agreedByLabel(
  match: MatchRow,
  userId: string,
  mine: TeamRow,
  them: TeamRow | undefined,
  t: (en: string, fr: string) => string,
): string | null {
  const by = match.agreed_by;
  if (!match.agreed_at || !by) return null;
  if (by === userId) return t("you", "vous");
  if (mine.roster.some((m) => m.user_id === by)) return t("your captain", "votre capitaine");
  if (them?.roster.some((m) => m.user_id === by)) return t(`${them.name}'s captain`, `le capitaine de ${them.name}`);
  return t("an administrator", "un administrateur");
}

/** A timestamp in the reader's own time zone and language, the way every match time on the site reads. */
export function useMatchWhen() {
  const lang = useLanguage();
  return (iso: string) =>
    new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * When a match is being played: the agreed time, and - for a captain - the control that records it.
 *
 * The teams agree the time in Discord; this is where it is written down, so watch links and Multitwitch
 * links can go out and the front page can list the match. Shared by the event page's "Your next match"
 * card and a crew's quarters, so both record a time the same way.
 *
 * What a captain may set is the database's rule (set_match_time): their own match, while it is waiting
 * to be played, inside the round's window. The picker is bounded to that window too, so the usual
 * mistake is caught before it is sent; any refusal still comes back in the database's own words.
 */
export function MatchTimeField({ match, isCaptain, setBy, reload }: Props) {
  const t = useT();
  const lang = useLanguage();
  const when = useMatchWhen();
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { weekday: "short", month: "short", day: "numeric" });

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setValue(toLocalInput(match.agreed_at)), [match.id, match.agreed_at]);

  async function save(iso: string | null) {
    setBusy(true);
    setError(null);
    try {
      await setMatchTime(match.id, iso);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const changed = value !== toLocalInput(match.agreed_at);

  return (
    <div className="stack" style={{ gap: "0.35rem" }}>
      <span>
        {match.agreed_at ? (
          <>
            <span className="badge badge--good" style={{ marginRight: "0.4rem" }}>{t("confirmed", "confirmé")}</span>
            <strong>{when(match.agreed_at)}</strong>
            {setBy && <span className="muted" style={{ fontSize: "0.78rem" }}> · {t(`set by ${setBy}`, `fixé par ${setBy}`)}</span>}
          </>
        ) : (
          <span className="muted">{t("No time confirmed yet.", "Pas encore d'heure confirmée.")}</span>
        )}
      </span>
      {(match.opens_at || match.due_at) && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {match.opens_at && match.due_at
            ? t(`Play between ${day(match.opens_at)} and ${day(match.due_at)}`, `À jouer entre le ${day(match.opens_at)} et le ${day(match.due_at)}`)
            : match.due_at
              ? t(`Due by ${day(match.due_at)}`, `À jouer avant le ${day(match.due_at)}`)
              : t(`Opens ${day(match.opens_at!)}`, `Ouvre le ${day(match.opens_at!)}`)}
        </span>
      )}

      {isCaptain ? (
        <div className="stack" style={{ gap: "0.3rem" }}>
          <div className="row" style={{ gap: "0.4rem" }}>
            <input
              type="datetime-local"
              value={value}
              min={toLocalInput(match.opens_at) || undefined}
              max={toLocalInput(match.due_at) || undefined}
              onChange={(e) => setValue(e.target.value)}
              aria-label={t("Agreed match time", "Heure convenue")}
            />
            <button className="primary" disabled={busy || !value || !changed} onClick={() => void save(fromLocalInput(value))}>
              {match.agreed_at ? t("Change time", "Changer l'heure") : t("Confirm time", "Confirmer l'heure")}
            </button>
            {match.agreed_at && (
              <button disabled={busy} onClick={() => void save(null)}>
                {t("Clear", "Effacer")}
              </button>
            )}
          </div>
          {changed && value && (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {t(`That's ${when(fromLocalInput(value)!)} in your time zone.`, `Soit ${when(fromLocalInput(value)!)} dans votre fuseau horaire.`)}
            </span>
          )}
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {t(
              "Agree the time with the other captain in Discord first, then record it here. Either captain can set or change it. Everyone sees it in their own time zone, and it goes on the front page so anyone can come and watch.",
              "Convenez d'abord de l'heure avec l'autre capitaine sur Discord, puis enregistrez-la ici. Chaque capitaine peut la fixer ou la changer. Chacun la voit dans son propre fuseau horaire, et elle s'affiche en page d'accueil pour que chacun puisse venir regarder.",
            )}
          </span>
          {error && <span className="error-text">{error}</span>}
        </div>
      ) : (
        <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Your captain confirms the match time.", "Votre capitaine confirme l'heure du match.")}</span>
      )}
    </div>
  );
}
