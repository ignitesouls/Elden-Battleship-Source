import { useRef, useState, type ReactNode } from "react";
import { LogoImageError, makeLogo } from "../../lib/tournament/logoImage";
import { clearTeamLogo, setTeamLogo } from "../../lib/tournament/api";
import { useT } from "../../lib/language";

/**
 * What a team without a logo of its own shows: the IgniteSouls logo. Only ever drawn, never stored - a
 * team's logo_path stays null - so a team that uploads one replaces it, and one that removes theirs gets
 * it back. A single small file shared by every such team, so a page of them downloads it once.
 * Built from the base path because the site is served from a subpath on Pages (see OutreachLinks).
 */
export const DEFAULT_TEAM_LOGO = `${import.meta.env.BASE_URL}ignite_logo.png`;

/**
 * A team's logo, sized in rem so it scales with the text beside it: its own if it has one, the default if
 * not (or if its own fails to load). `empty` is for a slot with no team in it yet - a "TBD" in the bracket -
 * which keeps the logo's space, blank, so the names in a column still line up.
 */
export function TeamLogo({ url, size = 1.3, empty = false }: { url: string | null | undefined; size?: number; empty?: boolean }) {
  // Every address that has failed to load, so a broken logo falls back to the default and a broken default
  // to a blank - never back and forth between the two.
  const [failed, setFailed] = useState<string[]>([]);
  const style = { width: `${size}rem`, height: `${size}rem` };
  const src = [url, DEFAULT_TEAM_LOGO].find((s): s is string => !!s && !failed.includes(s));
  if (empty || !src) return <span className="team-logo team-logo--empty" style={style} aria-hidden />;
  // Decorative: the team's name always sits right beside it.
  return <img className="team-logo" style={style} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed((f) => [...f, src])} />;
}

/** A team's name with its logo in front, on one line. `empty` for a slot with no team yet (see TeamLogo). */
export function TeamLabel({ name, logo, size, empty, className }: { name: ReactNode; logo: string | null | undefined; size?: number; empty?: boolean; className?: string }) {
  return (
    <span className="team-label">
      <TeamLogo url={logo} size={size} empty={empty} />
      <span className={`team-label__name${className ? ` ${className}` : ""}`}>{name}</span>
    </span>
  );
}

/**
 * An administrator's logo controls for one team: change it (any time - captains are locked out once
 * signup closes, administrators are not) or take it down. Small buttons for a row in a team list; the
 * picture is shrunk exactly as a captain's would be. `run` is the page's action wrapper, which shows
 * errors and reloads.
 */
export function AdminLogoButtons({
  teamId,
  teamName,
  logoPath,
  busy,
  run,
}: {
  teamId: string;
  teamName: string;
  logoPath: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => unknown;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const small = { fontSize: "0.72rem", padding: "0.15rem 0.45rem" };
  return (
    <span className="row" style={{ gap: "0.3rem", display: "inline-flex" }}>
      <button style={small} disabled={busy} onClick={() => input.current?.click()}>
        {logoPath ? t("Change logo", "Changer le logo") : t("Add logo", "Ajouter un logo")}
      </button>
      {logoPath && (
        <button
          style={small}
          disabled={busy}
          onClick={() => {
            if (window.confirm(t(`Remove ${teamName}'s logo?`, `Retirer le logo de ${teamName} ?`))) void run(() => clearTeamLogo(teamId, logoPath));
          }}
        >
          {t("Remove logo", "Retirer le logo")}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void run(async () => setTeamLogo(teamId, await makeLogo(file), logoPath));
        }}
      />
    </span>
  );
}

/**
 * Choosing a logo: a preview, a button that opens the file picker, and a way to take the logo off.
 * The picked file is shrunk to a 256px square here (see makeLogo) and handed on as the image that will
 * be uploaded - what the preview shows is exactly what everyone else will see.
 */
export function LogoField({
  current,
  disabled,
  onPick,
  onClear,
}: {
  /** The address of the logo to show: the saved one, or a preview of one about to be saved. */
  current: string | null;
  disabled?: boolean;
  onPick: (image: Blob) => void;
  onClear?: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function picked(file: File | undefined) {
    if (!file) return;
    setWorking(true);
    setError(null);
    try {
      onPick(await makeLogo(file));
    } catch (e) {
      const why = e instanceof LogoImageError ? e.message : "unreadable";
      setError(
        why === "too-big"
          ? t("That picture is too large - pick one under 15 MB.", "Cette image est trop lourde - choisissez-en une de moins de 15 Mo.")
          : t("That file couldn't be read as a picture. Try a PNG or JPEG.", "Ce fichier n'a pas pu être lu comme une image. Essayez un PNG ou un JPEG."),
      );
    } finally {
      setWorking(false);
      // Choosing the same file twice in a row should still fire.
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="stack" style={{ gap: "0.3rem" }}>
      <div className="logo-field">
        {/* With no logo chosen the preview is the default, since that is what everyone else will see. */}
        <div className="stack" style={{ gap: "0.15rem", alignItems: "center" }}>
          <div className="logo-field__preview">
            <TeamLogo url={current} size={4} />
          </div>
          {!current && <span className="muted" style={{ fontSize: "0.68rem" }}>{t("default", "par défaut")}</span>}
        </div>
        <div className="row" style={{ gap: "0.4rem" }}>
          <button type="button" disabled={disabled || working} onClick={() => input.current?.click()}>
            {working ? t("Preparing...", "Préparation...") : current ? t("Change logo", "Changer le logo") : t("Choose a logo", "Choisir un logo")}
          </button>
          {current && onClear && (
            <button type="button" disabled={disabled || working} onClick={onClear}>
              {t("Remove", "Retirer")}
            </button>
          )}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => void picked(e.target.files?.[0])} />
      </div>
      <span className="muted" style={{ fontSize: "0.75rem" }}>
        {t(
          "Square pictures look best. It's shrunk to 256 px and shown beside your team's name in the standings and bracket. Without one, your team shows the IgniteSouls logo.",
          "Les images carrées rendent le mieux. Elle est réduite à 256 px et affichée à côté du nom de votre équipe dans le classement et le tableau. Sans logo, votre équipe affiche celui d'IgniteSouls.",
        )}
      </span>
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
