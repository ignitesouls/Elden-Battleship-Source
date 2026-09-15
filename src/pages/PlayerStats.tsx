import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { rowSquareSet, busiestSquareSet, squareSet, DEFAULT_SQUARE_SET } from "../lib/challenges";
import { fetchParticipants, fetchProfiles, fetchPlayerEvents, profileName, type Profile } from "../lib/profiles";
import { playerPace, playerKills, playerBestKills, type MatchEventRow } from "../lib/almanac";
import { LoadingScreen } from "../components/BrandMark";
import { accountName, useAuthProfile } from "../hooks/useAuthProfile";
import {
  aggregateCareers,
  headToHeadRecords,
  teammateRecords,
  findNemesis,
  findBestTeammate,
  participantKey,
  type ParticipantRow,
} from "../lib/careerStats";
import { SiteFooter } from "../components/SiteFooter";
import { squarePace, MIN_GAPS_FOR_PACE } from "../lib/squarePace";
import { useT } from "../lib/language";

export function PlayerStats() {
  const t = useT();
  const { key: rawKey } = useParams<{ key: string }>();
  const playerKey = decodeURIComponent(rawKey ?? "");
  // Careers are keyed on user id for signed-in captains and on nickname for guests, so this only
  // ever matches on the former - which is correct: a guest has no durable identity to hang a
  // permanent token on, which is why auto-marking needs a sign-in.
  const viewer = useAuthProfile();
  const isMe = Boolean(viewer?.isTwitch && viewer.userId === playerKey);
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);
  const [events, setEvents] = useState<MatchEventRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());

  // Which board's career this is. Comes in on the link from the leaderboard so the two agree; on a
  // bare /player/<key> link it falls back to whichever set that player has played most.
  const [params] = useSearchParams();
  const [allRows, setAllRows] = useState<ParticipantRow[] | null>(null);
  const requestedSet = params.get("set");

  useEffect(() => {
    void (async () => {
      // Participants stay global: the head-to-head, teammate and nemesis panels are all about who
      // ELSE was in those matches, so one player's rows cannot answer them. The shot log is the
      // opposite - every panel fed by it reads this player and nobody else - so it asks for one
      // player's worth and the other ten thousand rows never leave the database.
      const [data, evs] = await Promise.all([fetchParticipants(), fetchPlayerEvents(playerKey)]);
      setAllRows(data);
      setEvents(evs as unknown as MatchEventRow[]);
      setProfiles(await fetchProfiles(data.map((r) => r.user_id).filter(Boolean) as string[]));
    })();
  }, [playerKey]);

  const shownSet = useMemo(() => {
    if (requestedSet && squareSet(requestedSet).id === requestedSet) return requestedSet;
    const mine = (allRows ?? []).filter((r) => participantKey(r) === playerKey);
    return mine.length > 0 ? busiestSquareSet(mine) : DEFAULT_SQUARE_SET;
  }, [requestedSet, allRows, playerKey]);

  // Everything below reads `rows`, which is now one board's worth. Mixing them would put an
  // objectives accuracy in the same average as a boss one and describe neither.
  useEffect(() => {
    if (allRows === null) return;
    setRows(allRows.filter((r) => rowSquareSet(r) === shownSet));
  }, [allRows, shownSet]);

  /**
   * The shot log for THIS board, which is what everything below reads.
   *
   * `rows` was filtered to one set and `events` was not, so the three panels fed from the shot log -
   * pace, personal bests and the square log - were quietly pooling every board this captain has
   * played while the header above them named one. An objectives pace and a boss pace are not the
   * same measurement, for exactly the reason the accuracy above them is not.
   */
  const boardEvents = useMemo(() => events.filter((e) => rowSquareSet(e) === shownSet), [events, shownSet]);

  // Per-square attribution: which bosses this player took, and how quickly.
  const myPace = useMemo(
    () => playerPace(boardEvents).find((p) => p.key === playerKey) ?? null,
    [boardEvents, playerKey]
  );
  /** The leaderboard's measure of the same thing - see the two pace stats below. */
  const myMedianPace = useMemo(() => squarePace(boardEvents).get(playerKey) ?? null, [boardEvents, playerKey]);
  const bestKills = useMemo(() => playerBestKills(boardEvents, playerKey, 5), [boardEvents, playerKey]);
  const killLog = useMemo(() => playerKills(boardEvents, playerKey).slice(0, 15), [boardEvents, playerKey]);

  const view = useMemo(() => {
    if (!rows) return null;
    const career = aggregateCareers(rows).find((c) => c.key === playerKey) ?? null;
    return {
      career,
      h2h: headToHeadRecords(rows, playerKey),
      mates: teammateRecords(rows, playerKey),
      nemesis: findNemesis(rows, playerKey),
      bestMate: findBestTeammate(rows, playerKey),
      recent: rows.filter((r) => participantKey(r) === playerKey).slice(0, 10),
    };
  }, [rows, playerKey]);

  if (rows === null) return <LoadingScreen>{t("Loading the log...", "Chargement du journal...")}</LoadingScreen>;
  /**
   * Nobody has played a match under this key yet.
   *
   * For a visitor that is the whole page: there is no career to read. For the signed-in owner it
   * is their FIRST visit, and the auto-marking panel is the reason they were sent here - the room
   * screen's "Set it up on your profile" link and the top bar's account link both point at exactly
   * this URL. Gating that panel on having a career made the feature unreachable for the only
   * people who need it before their first match: a new captain followed the link and was told they
   * did not exist. So the career sections drop away and the token panel stays.
   */
  if (!view?.career) {
    return (
      <div className="stack" style={{ width: "min(760px, 100%)", gap: "0.9rem" }}>
        <div className="panel row" style={{ gap: "0.75rem", alignItems: "center" }}>
          {isMe && viewer?.avatarUrl && (
            <img
              src={viewer.avatarUrl}
              alt=""
              width={56}
              height={56}
              style={{ borderRadius: "50%", border: "2px solid var(--accent)" }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: "1.5rem" }}>
              {isMe ? accountName(viewer) ?? t("Your record", "Votre historique") : t("No record found", "Aucun historique trouvé")}
            </h1>
            <span className="muted" style={{ fontSize: "0.82rem" }}>
              {isMe
                ? t("No matches yet. Your record starts with the first one.", "Aucun match pour l'instant. Votre historique commence avec le premier.")
                : t("No matches under this captain.", "Aucun match sous ce capitaine.")}
            </span>
          </div>
          <Link to="/leaderboard" style={{ fontSize: "0.8rem" }}>
            {t("Leaderboard", "Classement")}
          </Link>
        </div>

        <SiteFooter />
      </div>
    );
  }

  /**
   * A link to another captain, carrying the board being read.
   *
   * The leaderboard and the almanac's pace table both do this deliberately; these three links did
   * not, so following a nemesis off a boss-board page landed on whichever set THEY had played most
   * - a different board, silently, with no indication the ground had moved.
   */
  const captainLink = (key: string) =>
    `/player/${encodeURIComponent(key)}?set=${encodeURIComponent(shownSet)}`;

  const { career, h2h, nemesis, bestMate, recent } = view;
  const profile = career.userId ? profiles.get(career.userId) : undefined;
  const awardList = Object.entries(career.awards).sort((a, b) => b[1] - a[1]);
  const num = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };

  return (
    <div className="stack" style={{ width: "min(760px, 100%)", gap: "0.9rem" }}>
      <div className="panel row" style={{ gap: "0.75rem", alignItems: "center" }}>
        {profile?.avatar_url && (
          <img
            src={profile.avatar_url}
            alt=""
            width={56}
            height={56}
            style={{ borderRadius: "50%", border: "2px solid var(--accent)" }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{profileName(profile) ?? career.nickname}</h1>
          <span className="muted" style={{ fontSize: "0.82rem" }}>
            {career.wins}{t("W", "V")} - {career.losses}{t("L", "D")}{career.draws > 0 ? ` - ${career.draws}${t("D", "N")}` : ""} ·{" "}
            {Math.round(career.winRate * 100)}% {t("win rate", "taux de victoire")} · {career.matches} {t("matches", "matchs")}
            {!career.verified && ` · ${t("guest record", "historique invité")}`}
          </span>
          {/* Named explicitly: these numbers are one board's, and the same captain will have a
              different record on the other. */}
          <div className="muted" style={{ fontSize: "0.72rem" }}>
            {squareSet(shownSet).label} {t("board", "plateau")}
          </div>
        </div>
        <Link to="/leaderboard" style={{ fontSize: "0.8rem" }}>
          {t("Leaderboard", "Classement")}
        </Link>
      </div>

      <div className="panel stack" style={{ gap: "0.4rem" }}>
        <h3 style={{ margin: 0 }}>{t("Career", "Carrière")}</h3>
        <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
          <Stat label={t("Shots fired", "Tirs effectués")} value={career.shots} />
          <Stat label={t("Hits", "Touchés")} value={career.hits} color="var(--hit)" />
          <Stat label={t("Misses", "Manqués")} value={career.misses} color="var(--text-dim)" />
          <Stat label={t("Ships sunk", "Navires coulés")} value={career.sunk} color="var(--sunk)" />
          <Stat label={t("Accuracy", "Précision")} value={`${Math.round(career.accuracy * 100)}%`} />
          <Stat label={t("Ships lost", "Navires perdus")} value={career.shipsLost} />
          {/*
            Both measures, labelled as such, the way the almanac's pace table shows them.
            "Square pace" used to sit here alone on the MEAN, which is the leaderboard's name for
            the MEDIAN - so a captain's row and their own page showed different numbers under one
            name and neither said which it was. The gap between the two is worth reading: one long
            boss moves the average and leaves the median alone.
          */}
          {myMedianPace !== null && (
            <Stat
              label={t("Square pace (median)", "Rythme par case (médian)")}
              value={fmtTime(myMedianPace)}
              title={t(
                `The time from one square falling to the next, as a median. The same number the leaderboard ranks on. Needs ${MIN_GAPS_FOR_PACE} squares before it appears.`,
                `Le temps entre deux cases, en médiane. Le même chiffre que celui utilisé pour le classement. Nécessite ${MIN_GAPS_FOR_PACE} cases avant d'apparaître.`
              )}
            />
          )}
          {myPace && (
            <Stat
              label={t("Square pace (average)", "Rythme par case (moyen)")}
              value={fmtTime(myPace.secondsPerShot)}
              title={t(
                "The same figure as a mean, worked out inside each match and then averaged across matches. It counts every gap, including the pair a duo boss fills at once.",
                "Le même chiffre en moyenne, calculé match par match puis moyenné entre les matchs. Il compte chaque intervalle, y compris la paire qu'un boss en duo remplit d'un coup."
              )}
            />
          )}
          {myPace?.bestMatch && (
            <Stat
              label={t("Best match", "Meilleur match")}
              value={fmtTime(myPace.bestMatch.seconds)}
              color="var(--accent)"
              title={t("Their fastest single match, by that average.", "Leur match le plus rapide, selon cette moyenne.")}
            />
          )}
        </div>
      </div>

      {bestKills.length > 0 && (
        <div className="panel stack" style={{ gap: "0.25rem" }}>
          <h3 style={{ margin: 0 }}>{t("Personal bests", "Meilleurs temps")}</h3>
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            {t("Each timed from their previous square. Misses count.", "Chacun chronométré depuis la case précédente. Les tirs manqués comptent.")}
          </span>
          {bestKills.map((k, i) => (
            <div
              key={`${k.matchKey}-${k.challenge}-${i}`}
              className="row"
              style={{ justifyContent: "space-between", fontSize: "0.82rem", gap: "0.5rem" }}
            >
              <span style={{ minWidth: 0 }}>
                <span className="muted">{i + 1}. </span>
                <strong>{k.challenge ?? t("Unknown square", "Case inconnue")}</strong>
                {k.previous && <span className="muted"> · {t("after", "après")} {k.previous}</span>}
                {k.result === "sunk" && <span style={{ color: "var(--sunk)" }}> · {t("sank a ship", "a coulé un navire")}</span>}
                {k.result === "hit" && <span style={{ color: "var(--hit)" }}> · {t("hit", "touché")}</span>}
              </span>
              <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{fmtTime(k.seconds)}</strong>
            </div>
          ))}
        </div>
      )}

      {killLog.length > 0 && (
        <div className="panel stack" style={{ gap: "0.25rem" }}>
          <h3 style={{ margin: 0 }}>{t("Square log", "Journal des cases")}</h3>
          {/*
            Says which clock it is reading. These times are POSITIONS in a match - when each square
            fell - while the personal bests directly above are DURATIONS, how long each fight took.
            Identical m:ss either way, opposite meanings, and nothing on screen used to separate them.
          */}
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            {t(
              "Every square taken, most recent match first. The time is how far into that match the square fell, not how long the fight took.",
              "Chaque case prise, match le plus récent en premier. Le temps indique le moment du match où la case est tombée, pas la durée du combat."
            )}
          </span>
          <div style={{ maxHeight: "18rem", overflowY: "auto" }} className="stack">
            {killLog.map((k, i) => (
              <div
                key={`${k.matchKey}-${k.challenge}-${i}`}
                className="row"
                style={{ justifyContent: "space-between", fontSize: "0.8rem", gap: "0.5rem" }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong
                    style={{
                      color:
                        k.result === "sunk" ? "var(--sunk)" : k.result === "hit" ? "var(--hit)" : "var(--text-dim)",
                    }}
                  >
                    {k.result === "sunk" ? t("SANK", "COULÉ") : k.result === "hit" ? t("HIT", "TOUCHÉ") : t("miss", "manqué")}
                  </strong>
                  <span> {k.challenge ?? t("Unknown square", "Case inconnue")}</span>
                </span>
                <span className="muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {fmtTime(k.seconds)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(nemesis || bestMate) && (
        <div className="row" style={{ gap: "0.75rem", alignItems: "stretch" }}>
          {nemesis && (
            <div className="panel stack" style={{ flex: 1, minWidth: 0, gap: "0.2rem" }}>
              <span className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                ☠ {t("Nemesis", "Némésis")}
              </span>
              <Link to={captainLink(nemesis.key)} style={{ fontSize: "1.05rem", fontWeight: 700 }}>
                {nemesis.nickname}
              </Link>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                {t(
                  `You've lost ${nemesis.losses} of ${nemesis.played} with them in the game, with you or against you - you win ${Math.round(nemesis.winRate * 100)}%`,
                  `Vous avez perdu ${nemesis.losses} de vos ${nemesis.played} parties avec eux, avec vous ou contre vous - vous gagnez ${Math.round(nemesis.winRate * 100)}%`
                )}
              </span>
            </div>
          )}
          {bestMate && (
            <div className="panel stack" style={{ flex: 1, minWidth: 0, gap: "0.2rem" }}>
              <span className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                ⚓ {t("Best shipmate", "Meilleur coéquipier")}
              </span>
              <Link to={captainLink(bestMate.key)} style={{ fontSize: "1.05rem", fontWeight: 700 }}>
                {bestMate.nickname}
              </Link>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                {t(
                  `${bestMate.wins} wins together from ${bestMate.played} - ${Math.round(bestMate.winRate * 100)}%`,
                  `${bestMate.wins} victoires ensemble sur ${bestMate.played} - ${Math.round(bestMate.winRate * 100)}%`
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {awardList.length > 0 && (
        <div className="panel stack" style={{ gap: "0.3rem" }}>
          <h3 style={{ margin: 0 }}>{t("Honors", "Distinctions")}</h3>
          {awardList.map(([title, count]) => (
            <div key={title} className="row" style={{ justifyContent: "space-between", fontSize: "0.84rem" }}>
              <span>{title}</span>
              <strong style={{ color: "var(--accent)" }}>x{count}</strong>
            </div>
          ))}
        </div>
      )}

      {h2h.length > 0 && (
        <div className="panel stack" style={{ gap: "0.3rem" }}>
          <h3 style={{ margin: 0 }}>{t("Head to head", "Face à face")}</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 500, padding: "0.25rem 0.4rem" }}>{t("Opponent", "Adversaire")}</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>{t("Played", "Joués")}</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>{t("W-L", "V-D")}</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>{t("Win %", "% Victoires")}</th>
                </tr>
              </thead>
              <tbody>
                {h2h.map((h) => (
                  <tr key={h.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                    <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                      <Link to={captainLink(h.key)}>{h.nickname}</Link>
                    </td>
                    <td style={num}>{h.played}</td>
                    <td style={num}>
                      {h.wins}-{h.losses}
                    </td>
                    <td style={num}>{Math.round(h.winRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="panel stack" style={{ gap: "0.25rem" }}>
          <h3 style={{ margin: 0 }}>{t("Recent matches", "Matchs récents")}</h3>
          {recent.map((r) => (
            <div
              key={r.match_key}
              className="row"
              style={{ justifyContent: "space-between", fontSize: "0.8rem", gap: "0.5rem" }}
            >
              <span style={{ minWidth: 0 }}>
                <strong style={{ color: r.draw ? "var(--text-dim)" : r.won ? "var(--accent)" : "var(--danger)" }}>
                  {r.draw ? t("DRAW", "NUL") : r.won ? t("WIN", "VICTOIRE") : t("LOSS", "DÉFAITE")}
                </strong>
                <span className="muted">
                  {" "}
                  · {t(
                    `${r.shots} shots, ${r.hits} hits, ${r.sunk} sunk`,
                    `${r.shots} tirs, ${r.hits} touchés, ${r.sunk} coulés`
                  )}
                </span>
              </span>
              <span className="muted" style={{ whiteSpace: "nowrap", fontSize: "0.72rem" }}>
                {new Date(r.finished_at).toLocaleDateString([], { month: "short", day: "numeric" })}
              </span>
            </div>
          ))}
        </div>
      )}
      <SiteFooter />
    </div>
  );
}

/** m:ss - pace and kill times read as durations, not raw second counts. */
function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Stat({
  label,
  value,
  color,
  title,
}: {
  label: string;
  value: number | string;
  color?: string;
  /** Hover text, for the stats whose heading can't say what they measure in three words. */
  title?: string;
}) {
  return (
    <div className="stack" style={{ gap: 0, minWidth: "5.5rem" }} title={title}>
      <span style={{ fontSize: "1.3rem", fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span className="muted" style={{ fontSize: "0.7rem" }}>{label}</span>
    </div>
  );
}
