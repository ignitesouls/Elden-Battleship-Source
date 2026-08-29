import { TEXT_SIZE_OPTIONS } from "../lib/overlayText";

/**
 * One overlay setting: what it is, where it stands, and what it changes.
 *
 * All three parts are here rather than left to each caller, because the failing this fixed was that
 * a streamer could not tell the controls apart. A bare track says nothing about what it does, and
 * the value it is at is the first thing you look for after dragging one.
 *
 * `--eb-fill` is the fraction of the track to paint up to the thumb; the styling behind it is in
 * index.css, along with the note on why a range input needs any of this.
 *
 * Lifted out of components/OverlayLinkBox when the setup page grew the same four sliders. They have
 * to behave identically in both places for a plain reason: they write the same query parameters into
 * the same overlay URLs, so a streamer who tunes their scene in one and rebuilds it in the other has
 * to land on the same look. One component is how that stays true.
 */
export function OverlaySetting({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  readout,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  readout: string;
}) {
  return (
    <div className="stack" style={{ gap: "0.25rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <span style={{ fontSize: "0.78rem" }}>{label}</span>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {readout}
        </span>
      </div>
      <input
        type="range"
        className="eb-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={{ ["--eb-fill" as string]: (value - min) / (max - min) }}
      />
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        {hint}
      </span>
    </div>
  );
}

/**
 * A text size, named.
 *
 * The named steps were the whole control once and are now the readout, which is the job they were
 * always best at: nobody needs "1.25" as a number, they need to know that where they have dragged to
 * is the one that is comfortable on a 1080p stream. The nearest step wins, so the name changes as
 * you drag past it rather than blinking out between the round values.
 */
export function textReadout(value: number): string {
  const nearest = TEXT_SIZE_OPTIONS.reduce((best, o) =>
    Math.abs(o.value - value) < Math.abs(best.value - value) ? o : best
  );
  return `${value.toFixed(2).replace(/0+$/, "").replace(/.$/, "")}x - ${nearest.label}`;
}
