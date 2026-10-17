import { extendDeadline } from "../../../lib/tournament/api";
import { useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";

const SMALL = { fontSize: "0.75rem", padding: "0.2rem 0.5rem" } as const;

/**
 * "This match +N days" and "Whole round +N days": an extension for one pair, or for everyone in the round
 * still to play. N is the panel's own days box, so the two buttons always say exactly what they will do.
 */
export function ExtendButtons({ matchId, days, act, busy }: { matchId: string; days: number; act: DeskAct; busy: boolean }) {
  const t = useT();
  const valid = Number.isInteger(days) && days >= 1 && days <= 60;
  return (
    <span className="row" style={{ gap: "0.3rem" }}>
      <button style={SMALL} disabled={busy || !valid} onClick={() => void act(() => extendDeadline(matchId, days, false))}
        title={t("Only this match gets the extra time.", "Seul ce match obtient le délai.")}>
        {t(`This match +${days}d`, `Ce match +${days} j`)}
      </button>
      <button style={SMALL} disabled={busy || !valid} onClick={() => void act(() => extendDeadline(matchId, days, true))}
        title={t("Every match in this round still to be decided gets the extra time.", "Tous les matchs non joués de ce tour obtiennent le délai.")}>
        {t(`Whole round +${days}d`, `Tout le tour +${days} j`)}
      </button>
    </span>
  );
}

/** The days box the extension buttons read: "Extensions add [3] days." */
export function ExtendDays({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const t = useT();
  return (
    <span className="row" style={{ gap: "0.4rem" }}>
      <span className="muted">{t("Extensions add", "Les prolongations ajoutent")}</span>
      <input type="number" min={1} max={60} value={days} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "4.5rem" }} />
      <span className="muted">{t("days.", "jours.")}</span>
    </span>
  );
}
