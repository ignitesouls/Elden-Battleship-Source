import { useState, type ReactNode } from "react";
import { useT } from "../lib/language";

/**
 * A control's explanation, shut until somebody asks for it.
 *
 * The desk had about a dozen grey paragraphs on show at all times, read once and then in the way for
 * every show after. Warnings do not go through this: something the caster must not miss stays on the
 * page (.cast-warn).
 *
 * Opens inline rather than as a popover because the control column scrolls and clips, and `title` is
 * no use here since half of these are too long for a tooltip. Returns siblings, so its parent must be
 * a wrapping flex row - the note's `flex-basis: 100%` is what drops it onto a line of its own.
 */
export function DeskHelp({ help, label }: { help: ReactNode; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`cast-help-btn${label ? " cast-help-btn-label" : ""}${open ? " primary" : ""}`}
        aria-expanded={open}
        aria-label={label ? undefined : t("What does this do?", "À quoi ça sert ?")}
        title={label ? undefined : t("What does this do?", "À quoi ça sert ?")}
        onClick={() => setOpen((o) => !o)}
      >
        {label ?? "i"}
      </button>
      {open && <p className="cast-note muted cast-help-note">{help}</p>}
    </>
  );
}

/** A desk section's heading, with its explanation one click away. No help, no button. */
export function DeskHeading({ title, help, helpLabel }: { title: ReactNode; help?: ReactNode; helpLabel?: string }) {
  return (
    <div className="cast-heading">
      <h3>{title}</h3>
      {help ? <DeskHelp help={help} label={helpLabel} /> : null}
    </div>
  );
}
