import { useState } from "react";
import type { BarnacleMood } from "../lib/talkingPoints";
import { BARNACLE_MOODS, barnacleSrc } from "../lib/barnacles";
import { useT } from "../lib/language";

/** The longest announcement - about what still fits a speech bubble over the board in one breath. */
const ANNOUNCE_MAX = 200;

/** The last few announcements, kept in this browser so a running joke is one click. Best-effort. */
const RECENT_KEY = "eb_desk_announcements";
const RECENT_MAX = 5;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/**
 * Which barnacle says it: the four faces, as buttons showing the face itself, so the caster picks the
 * one they will see on stream rather than a word for it.
 */
export function MoodPicker({ mood, onChange }: { mood: BarnacleMood; onChange: (m: BarnacleMood) => void }) {
  const t = useT();
  const label: Record<BarnacleMood, string> = {
    happy: t("Happy", "Content"),
    smug: t("Smug", "Narquois"),
    grim: t("Grim", "Sombre"),
    angry: t("Angry", "Fâché"),
  };
  return (
    <div className="row" style={{ gap: "0.25rem" }} role="radiogroup" aria-label={t("Which barnacle says it", "Quel bernacle le dit")}>
      {BARNACLE_MOODS.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mood === m}
          className={mood === m ? "primary" : ""}
          onClick={() => onChange(m)}
          title={label[m]}
          style={{ padding: "0.15rem 0.3rem" }}
        >
          <img src={barnacleSrc(m)} alt={label[m]} style={{ width: "1.4rem", height: "1.4rem", objectFit: "contain", display: "block" }} />
        </button>
      ))}
    </div>
  );
}

/**
 * The caster's own line, said over the board by a barnacle - for whatever no talking point covers.
 *
 * Over the board because it is about nobody in particular, like a crew-wide point (BOARD_SLOT). The
 * barnacle is the happy one unless the caster picks another. The last few lines are kept under the box,
 * one click to say again.
 */
export function DeskAnnounce({ onSay }: { onSay: (text: string, mood: BarnacleMood) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [mood, setMood] = useState<BarnacleMood>("happy");
  const [recent, setRecent] = useState<string[]>(readRecent);

  const say = (line: string) => {
    const clean = line.trim();
    if (!clean) return;
    onSay(clean, mood);
    const next = [clean, ...recent.filter((r) => r !== clean)].slice(0, RECENT_MAX);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* just won't be remembered next time */
    }
  };

  return (
    <section>
      <h3>{t("Announce", "Annoncer")}</h3>
      <textarea
        value={text}
        maxLength={ANNOUNCE_MAX}
        rows={2}
        placeholder={t("Type something for the barnacle to say over the board", "Écrivez ce que le bernacle dira par-dessus le plateau")}
        aria-label={t("Announcement", "Annonce")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter says it; Shift+Enter is a new line.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            say(text);
            setText("");
          }
        }}
        style={{ width: "100%", resize: "vertical" }}
      />
      <div className="row" style={{ gap: "0.5rem", justifyContent: "space-between", flexWrap: "wrap" }}>
        <MoodPicker mood={mood} onChange={setMood} />
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {text.length}/{ANNOUNCE_MAX}
        </span>
        <button
          className="primary"
          disabled={!text.trim()}
          onClick={() => {
            say(text);
            setText("");
          }}
        >
          {t("Say it", "Le dire")}
        </button>
      </div>
      {recent.length > 0 && (
        <div className="stack" style={{ gap: "0.2rem" }}>
          {recent.map((r) => (
            <div key={r} className="row" style={{ gap: "0.4rem", fontSize: "0.78rem" }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r}>
                {r}
              </span>
              <button onClick={() => say(r)} style={{ fontSize: "0.68rem", padding: "0.1rem 0.4rem" }}>
                {t("Again", "Encore")}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
