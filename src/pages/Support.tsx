import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CATEGORIES,
  MAX_MESSAGE,
  prepareScreenshot,
  submitSupportReport,
  type CategoryId,
  type Screenshot,
} from "../lib/support";
import { SiteFooter } from "../components/SiteFooter";

/**
 * Report a bug, or ask for help.
 *
 * -- Why a form rather than "message me on Discord" ----------------------------------------------
 *
 * Because a report needs context the reporter would never think to include, and a chat message
 * arrives without any of it. The room code, the build id and the browser answer most of what would
 * otherwise be three rounds of questions, and the form can attach all three without asking.
 *
 * The Discord invite stays on the front page and is still the better place for a conversation. This
 * is for the report itself.
 *
 * -- Why it asks for a Discord handle and not an email -------------------------------------------
 *
 * Collecting other people's email addresses means being responsible for them. A Discord handle is a
 * public name, it is where the reply was going to happen anyway, and losing one to a breach costs
 * nobody anything. It is optional, because a report worth sending is worth receiving whether or not
 * the sender wants a conversation about it.
 *
 * -- Why the screenshot is the effort it is ------------------------------------------------------
 *
 * Half of all bug reports are a screenshot with three words attached, and that is fine: a picture of
 * a wrong board is worth more than a paragraph describing one. So it takes a paste, a drop or a
 * click, because a player who has just hit PrintScreen should not then have to find a file.
 */
export function Support() {
  const [category, setCategory] = useState<CategoryId>("auto-marking");
  const [message, setMessage] = useState("");
  const [discord, setDiscord] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Object URLs outlive the component unless revoked, and this page is a route somebody can bounce
  // in and out of while trying several screenshots.
  useEffect(() => () => void (shot && URL.revokeObjectURL(shot.previewUrl)), [shot]);

  /**
   * Paste anywhere on the page, because that is what somebody who just pressed PrintScreen will
   * try. Bound to the document rather than to a drop zone: aiming a paste at a particular box is a
   * thing people who have done it before know to do.
   */
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) void attach(file);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  async function attach(file: File) {
    setShotError(null);
    try {
      setShot(await prepareScreenshot(file));
    } catch (err) {
      setShotError(err instanceof Error ? err.message : String(err));
    }
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await submitSupportReport({ category, message, discord, screenshot: shot, website });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="stack" style={{ width: "min(560px, 100%)", gap: "0.8rem" }}>
        <div className="panel stack" style={{ gap: "0.5rem", padding: "0.9rem" }}>
          <strong>Sent.</strong>
          <span className="muted" style={{ fontSize: "0.78rem", lineHeight: 1.5 }}>
            {discord.trim()
              ? "I'll get back to you on Discord if I need more."
              : "No handle given, so I can't reply. Thanks for taking the time."}
          </span>
          <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
            <Link to="/">
              <button style={{ fontSize: "0.8rem" }}>Back to the menu</button>
            </Link>
            <button
              style={{ fontSize: "0.8rem" }}
              onClick={() => {
                setSent(false);
                setMessage("");
                setShot(null);
              }}
            >
              Report something else
            </button>
          </div>
        </div>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className="stack" style={{ width: "min(560px, 100%)", gap: "0.8rem" }}>
      <div className="panel stack" style={{ gap: "0.7rem", padding: "0.9rem" }}>
        <div className="stack" style={{ gap: "0.25rem" }}>
          <strong style={{ fontSize: "1rem" }}>Report a bug</strong>
          <span className="muted" style={{ fontSize: "0.75rem", lineHeight: 1.45 }}>
            Bugs, and anything you can't work out. This goes straight to me.
          </span>
        </div>

        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as CategoryId)}
            style={{ fontSize: "0.82rem", width: "100%" }}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="What happened"
          hint="What you did, and what happened instead. Include the room code if you have it."
        >
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE))}
            rows={7}
            placeholder="I killed Margit and the square didn't fill in..."
            style={{ width: "100%", fontSize: "0.82rem", lineHeight: 1.5, resize: "vertical" }}
          />
        </Field>

        <Field label="Your Discord" hint="Optional, but it's the only way I can reply. Username or ID.">
          <input
            value={discord}
            onChange={(e) => setDiscord(e.target.value)}
            placeholder="yourname"
            autoComplete="off"
            spellCheck={false}
            style={{ width: "100%", fontSize: "0.82rem" }}
          />
        </Field>

        <Field label="Screenshot" hint="Optional. Paste one anywhere on this page, drop it below, or choose a file.">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
              if (file) void attach(file);
            }}
            style={{
              border: "1px dashed var(--panel-border)",
              borderRadius: "6px",
              padding: "0.6rem",
              textAlign: "center",
            }}
          >
            {shot ? (
              <div className="stack" style={{ gap: "0.4rem", alignItems: "center" }}>
                <img
                  src={shot.previewUrl}
                  alt="Attached screenshot"
                  style={{ maxWidth: "100%", maxHeight: "11rem", borderRadius: "4px" }}
                />
                <div className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                  <span className="muted" style={{ fontSize: "0.68rem" }}>
                    {Math.round(shot.bytes / 1024)} KB
                  </span>
                  <button onClick={() => setShot(null)} style={{ fontSize: "0.72rem" }}>
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => fileInput.current?.click()} style={{ fontSize: "0.78rem" }}>
                Choose an image
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void attach(file);
                e.target.value = "";
              }}
            />
          </div>
          {shotError && (
            <span className="error-text" style={{ fontSize: "0.72rem" }}>
              {shotError}
            </span>
          )}
        </Field>

        {/* The honeypot. Hidden from sight, from screen readers and from tab order, so nothing that
            reads the form the way a person does will ever put anything in it. */}
        <input
          type="text"
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px" }}
        />

        <button
          onClick={() => void send()}
          disabled={busy || message.trim().length === 0}
          style={{ fontSize: "0.85rem" }}
        >
          {busy ? "Sending..." : "Send report"}
        </button>

        {error && (
          <span className="error-text" style={{ fontSize: "0.76rem" }}>
            {error}
          </span>
        )}

        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
          Also sent: your build number, browser, screen size, and the room you're in if you're in one.
          No email address is asked for or stored.
        </span>
      </div>

      <SiteFooter />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="stack" style={{ gap: "0.25rem" }}>
      <strong style={{ fontSize: "0.78rem" }}>{label}</strong>
      {hint && (
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          {hint}
        </span>
      )}
      {children}
    </label>
  );
}
