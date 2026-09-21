import { COUNTDOWNS, PREP_MINUTES, type MatchRules } from "../../lib/tournament/matchRules";
import { useT } from "../../lib/language";

/**
 * The rules an official match is played by: how long fleets have to place their ships, and the countdown
 * before the first shot. An official room takes these when it is linked and keeps them - the host cannot
 * change them - so every match in the event is played to the same clock.
 *
 * The board size is not here on purpose. It is the host's to choose and is locked once the room is
 * official; offering it would mean rebuilding the fleet to match, which the lobby's own settings do in
 * one write and this cannot.
 */
export function MatchRulesEditor({ rules, onChange }: { rules: MatchRules; onChange: (rules: MatchRules) => void }) {
  const t = useT();
  // A saved value the menus don't offer is kept as an extra entry rather than silently rewritten.
  const prepMinutes = Math.round(rules.prep_seconds / 60);
  const prepChoices = PREP_MINUTES.includes(prepMinutes) ? PREP_MINUTES : [...PREP_MINUTES, prepMinutes].sort((a, b) => a - b);
  const countChoices = COUNTDOWNS.includes(rules.starting_seconds) ? COUNTDOWNS : [...COUNTDOWNS, rules.starting_seconds].sort((a, b) => a - b);

  return (
    <div className="row" style={{ alignItems: "flex-end" }}>
      <label className="stack" style={{ gap: "0.25rem" }}>
        <span className="muted">{t("Time to place ships", "Temps pour placer les navires")}</span>
        <select value={prepMinutes} onChange={(e) => onChange({ ...rules, prep_seconds: Number(e.target.value) * 60 })}>
          {prepChoices.map((m) => (
            <option key={m} value={m}>{t(`${m} min`, `${m} min`)}</option>
          ))}
        </select>
      </label>
      <label className="stack" style={{ gap: "0.25rem" }}>
        <span className="muted">{t("Countdown before the first shot", "Compte à rebours avant le premier tir")}</span>
        <select value={rules.starting_seconds} onChange={(e) => onChange({ ...rules, starting_seconds: Number(e.target.value) })}>
          {countChoices.map((s) => (
            <option key={s} value={s}>{t(`${s} s`, `${s} s`)}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
