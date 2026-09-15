import { FIRE_HOLD_OPTIONS, FIRE_HOLD_HINT } from "../lib/fireHold";
import { useT } from "../lib/language";
import "./FireHoldSelect.css";

/**
 * Picks how long a square must be held before it fires. See lib/fireHold for why it is a choice.
 *
 * A select rather than a button that cycles: six lengths is too many to step through, and a native
 * one brings its keyboard and screen-reader behaviour with it. The label sits inside the control's
 * hit area so the whole thing raises one tooltip - which is where the rule about misfiring is
 * written, and worth being easy to land on.
 *
 * Rendered by both layouts (the dock along the bottom of the canvas, and the fixed layout's
 * sidebar), because this is not a setting anyone should have to switch layouts to reach.
 */
export function FireHoldSelect({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const t = useT();
  return (
    <label className="fire-hold-select" title={FIRE_HOLD_HINT}>
      <span>{t("Fire", "Tir")}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {FIRE_HOLD_OPTIONS.map((o) => (
          <option key={o.ms} value={o.ms}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
