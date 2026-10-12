import { useEffect, useState } from "react";
import { useLanguage, useT } from "../lib/language";
import "./DionysusCard.css";

/**
 * Dionysus's GitHub repository, as "owner/repo". Null until the link is settled.
 *
 * While it is null the card still shows at full brightness, but the button reads "Coming soon" and
 * goes nowhere. That way the card can ship before the link does, and no player gets sent to a 404 or
 * to the wrong repository in the meantime. Setting this is the only change needed to switch it on.
 */
const DIONYSUS_REPO: string | null = "ignitesouls/DionysusArcade";

/**
 * The button opens the newest release's page rather than downloading a file: the page shows the
 * release notes and every file, and it keeps working if a file is renamed between versions. GitHub
 * redirects /releases/latest to whichever release is newest, so this link never needs updating.
 */
const RELEASE_PAGE = DIONYSUS_REPO ? `https://github.com/${DIONYSUS_REPO}/releases/latest` : null;

// Through BASE_URL like the site's other public images: the site is served from a subpath on Pages.
const LOGO = `${import.meta.env.BASE_URL}dionysus_logo.png`;

/**
 * GitHub allows about 60 unsigned API calls an hour per visitor's connection, so the answer is kept
 * in the browser for an hour and a refresh does not spend another.
 */
const CACHE_KEY = "eb.dionysusRelease";
const CACHE_MS = 60 * 60 * 1000;

type Release = { version: string; publishedAt: string };

/**
 * The newest published release of Dionysus, read straight from GitHub by the visitor's browser (no
 * Supabase request, so it costs nothing against the log budget). Drafts and pre-releases are skipped
 * by GitHub's "latest". Best-effort: any failure leaves it null and the card simply has no version line.
 */
function useLatestRelease(): Release | null {
  const [release, setRelease] = useState<Release | null>(() => readCache());

  useEffect(() => {
    if (!DIONYSUS_REPO || readCache()) return;
    let cancelled = false;
    fetch(`https://api.github.com/repos/${DIONYSUS_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { tag_name?: string; published_at?: string } | null) => {
        if (cancelled || !body?.tag_name || !body.published_at) return;
        const next = { version: body.tag_name, publishedAt: body.published_at };
        setRelease(next);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release: next }));
        } catch {
          // Storage blocked (private window etc.): fine, it just asks again next visit.
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return release;
}

function readCache(): Release | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, release } = JSON.parse(raw) as { at: number; release: Release };
    return Date.now() - at < CACHE_MS ? release : null;
  } catch {
    return null;
  }
}

/**
 * The front page's pointer to Dionysus, the launcher every match is played through.
 *
 * Without Dionysus nobody can play, so this is the most important link on the site for a new
 * player. It is drawn louder than anything else on the page so a first-time visitor sees it
 * before the join form.
 */
export function DionysusCard() {
  const t = useT();
  const lang = useLanguage();
  const release = useLatestRelease();

  return (
    <div className="panel dionysus-card">
      <div className="dionysus-card__head">
        <span className="dionysus-card__icon" aria-hidden="true">
          <img src={LOGO} alt="" width={48} height={48} className="dionysus-card__logo" />
        </span>
        <div className="dionysus-card__text">
          <h2 className="dionysus-card__title">{t("Get Dionysus Arcade Here", "Téléchargez Dionysus Arcade ici")}</h2>
          <span className="dionysus-card__blurb">
            {t(
              "The latest build of Dionysus Arcade is required to play Elden Battleship.",
              "La dernière version de Dionysus Arcade est requise pour jouer à Elden Battleship."
            )}
          </span>
          {release && (
            <span className="dionysus-card__version">
              {t("Latest", "Dernière version")}: <strong>{release.version}</strong> ·{" "}
              {t("released", "publiée le")}{" "}
              {new Date(release.publishedAt).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </div>
      </div>

      {RELEASE_PAGE ? (
        <a className="dionysus-card__cta" href={RELEASE_PAGE} target="_blank" rel="noopener noreferrer">
          <GitHubMark />
          <span>{t("Download on GitHub", "Télécharger sur GitHub")}</span>
        </a>
      ) : (
        <span className="dionysus-card__cta dionysus-card__cta--pending" aria-disabled="true">
          <GitHubMark />
          <span>{t("Download coming soon", "Téléchargement bientôt disponible")}</span>
        </span>
      )}
    </div>
  );
}

/** GitHub's octocat mark, so the button says where it leads before anyone reads the label. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="dionysus-card__gh" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
