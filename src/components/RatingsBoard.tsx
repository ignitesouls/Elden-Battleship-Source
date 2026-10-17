import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { cached } from "../lib/archiveCache";
import { SortHeader, useSortColumns, type SortColumn } from "./SortHeader";
import { useT } from "../lib/language";

/** One player as the battle-ratings function's `{ board: true }` mode hands them back. */
interface RatedPlayer {
  key: string;
  name: string;
  avatar: string | null;
  /** Signed in with Twitch, so the row is one account rather than everyone who used the name. */
  verified: boolean;
  elo: number;
  /** Two-fleet games behind the Elo. 0 means none: the Elo is just the 1500 everyone starts on. */
  games: number;
  /** The shrunk battle-rating average (see lib/tournament/teamPower), or null with no rated game. */
  battle: number | null;
}

/**
 * Every rated player, in one request.
 *
 * Through the shared cache so a visitor bouncing between the home page and a room doesn't ask again
 * each time - the home page is the most-visited page on the site, and every request is a log line.
 */
function fetchRatedPlayers(): Promise<RatedPlayer[]> {
  return cached("ratings-board", async () => {
    const { data, error } = await supabase.functions.invoke("battle-ratings", { body: { board: true } });
    if (error || !data || !Array.isArray(data.players)) return [];
    return data.players as RatedPlayer[];
  });
}

/**
 * All-time Elo and battle rating, as two separate lists.
 *
 * Two lists rather than one table with both columns, because they answer different questions - Elo
 * "who wins", battle "who plays well" - and each has its own field: a player who has only ever played
 * crew games of three fleets has a battle rating but no Elo, and one who only plays 1v1s the reverse.
 * One table would fill half of every such row with dashes.
 *
 * Unlike the leaderboard, these are NOT per board: both are worked out across every board at once,
 * the same numbers the tournament pages' team power is built from.
 */
export function RatingsBoard() {
  const t = useT();
  const [players, setPlayers] = useState<RatedPlayer[] | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    fetchRatedPlayers()
      .then((p) => !cancelled && setPlayers(p))
      .catch(() => !cancelled && setPlayers([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const eloPlayers = useMemo(() => (players ?? []).filter((p) => p.games > 0), [players]);
  const battlePlayers = useMemo(() => (players ?? []).filter((p) => p.battle !== null), [players]);

  // Nothing at all while loading or with nothing to show: an empty panel is a bigger thing on the
  // front page than the fact deserves - the same rule as Current battles.
  if (eloPlayers.length === 0 && battlePlayers.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.8rem" }}>
      <div className="stack" style={{ gap: "0.15rem" }}>
        <h3 style={{ margin: 0, textAlign: "center" }}>{t("Ratings", "Classements")}</h3>
        <span className="muted" style={{ fontSize: "0.7rem", textAlign: "center" }}>
          {t(
            "All time, across every board. Practice matches never count.",
            "Depuis toujours, sur tous les plateaux. Les parties d'entraînement ne comptent jamais."
          )}
        </span>
      </div>
      {eloPlayers.length > 0 && <EloList players={eloPlayers} />}
      {battlePlayers.length > 0 && <BattleList players={battlePlayers} />}
      <Link to="/leaderboard" style={{ fontSize: "0.75rem", textAlign: "center" }}>
        {t("Full leaderboard, board by board →", "Classement complet, plateau par plateau →")}
      </Link>
    </div>
  );
}

type EloKey = "name" | "elo" | "games";

function eloColumns(t: (en: string, fr: string) => string): SortColumn<EloKey>[] {
  return [
    {
      key: "name",
      label: t("Captain", "Capitaine"),
      align: "left",
      firstDirection: "asc",
      title: t(
        "Signed-in captains are one account; guests are grouped by nickname. Click a name for their career.",
        "Les capitaines connectés sont un compte ; les invités sont regroupés par pseudo. Cliquez sur un nom pour sa carrière."
      ),
    },
    {
      key: "elo",
      label: "Elo",
      align: "right",
      firstDirection: "desc",
      title: t(
        "From results. Everyone starts at 1500; every two-fleet game moves it, and beating a stronger crew gains more than beating a weaker one. A crew wins or loses together. 1v1s count.",
        "Selon les résultats. Tout le monde commence à 1500 ; chaque partie à deux flottes le fait bouger, et battre un équipage plus fort rapporte plus qu'en battre un plus faible. Un équipage gagne ou perd ensemble. Les 1v1 comptent."
      ),
    },
    {
      key: "games",
      label: t("Games", "Parties"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Two-fleet games behind the Elo. Games of three or more fleets have no single winner to rate, so they don't count here.",
        "Parties à deux flottes derrière l'Elo. Les parties à trois flottes ou plus n'ont pas de vainqueur unique à noter, elles ne comptent donc pas ici."
      ),
    },
  ];
}

function EloList({ players }: { players: RatedPlayer[] }) {
  const t = useT();
  const columns = eloColumns(t);
  const { sort, direction, sortBy } = useSortColumns(columns, "elo");

  const sorted = useMemo(() => {
    const cmp = (a: RatedPlayer, b: RatedPlayer) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "elo":
          return a.elo - b.elo || a.games - b.games;
        case "games":
          return a.games - b.games || a.elo - b.elo;
      }
    };
    return [...players].sort((a, b) => (direction === "asc" ? cmp(a, b) : -cmp(a, b)));
  }, [players, sort, direction]);

  return (
    <RatingTable title={t("Elo", "Elo")} columns={columns} sort={sort} direction={direction} onSort={sortBy}>
      {sorted.map((p, i) => (
        <tr key={p.key} style={ROW}>
          <td style={RANK}>{i + 1}</td>
          <NameCell player={p} />
          <td style={NUM}>{Math.round(p.elo)}</td>
          <td style={{ ...NUM, color: "var(--text-dim)" }}>{p.games}</td>
        </tr>
      ))}
    </RatingTable>
  );
}

type BattleKey = "name" | "battle";

function battleColumns(t: (en: string, fr: string) => string): SortColumn<BattleKey>[] {
  return [
    {
      key: "name",
      label: t("Captain", "Capitaine"),
      align: "left",
      firstDirection: "asc",
      title: t(
        "Signed-in captains are one account; guests are grouped by nickname. Click a name for their career.",
        "Les capitaines connectés sont un compte ; les invités sont regroupés par pseudo. Cliquez sur un nom pour sa carrière."
      ),
    },
    {
      key: "battle",
      label: t("Battle", "Combat"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "The Hall of Fame battle rating (0-100), averaged over every rated game on every board - how a captain plays: squares taken, hard squares, sinks. Pulled slightly towards 50 so one great night isn't a great player. 1v1s and practice never count.",
        "La note de combat du Panthéon (0-100), en moyenne sur toutes les parties notées de tous les plateaux - la façon dont un capitaine joue : cases prises, cases difficiles, navires coulés. Légèrement ramenée vers 50 pour qu'une grande soirée ne fasse pas un grand joueur. Les 1v1 et l'entraînement ne comptent jamais."
      ),
    },
  ];
}

function BattleList({ players }: { players: RatedPlayer[] }) {
  const t = useT();
  const columns = battleColumns(t);
  const { sort, direction, sortBy } = useSortColumns(columns, "battle");

  const sorted = useMemo(() => {
    const cmp = (a: RatedPlayer, b: RatedPlayer) =>
      sort === "name" ? a.name.localeCompare(b.name) : (a.battle ?? 0) - (b.battle ?? 0) || a.elo - b.elo;
    return [...players].sort((a, b) => (direction === "asc" ? cmp(a, b) : -cmp(a, b)));
  }, [players, sort, direction]);

  return (
    <RatingTable title={t("Battle rating", "Note de combat")} columns={columns} sort={sort} direction={direction} onSort={sortBy}>
      {sorted.map((p, i) => (
        <tr key={p.key} style={ROW}>
          <td style={RANK}>{i + 1}</td>
          <NameCell player={p} />
          <td style={NUM}>{Math.round(p.battle ?? 0)}</td>
        </tr>
      ))}
    </RatingTable>
  );
}

const ROW = { textAlign: "right" as const, borderTop: "1px solid var(--panel-border)" };
const RANK = { textAlign: "left" as const, padding: "0.25rem 0.4rem", color: "var(--text-dim)" };
const NUM = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };

/** A list's heading and its scrolling table - scrolling inside the panel so the whole field doesn't push the footer off the page. */
function RatingTable<K extends string>({
  title,
  columns,
  sort,
  direction,
  onSort,
  children,
}: {
  title: string;
  columns: SortColumn<K>[];
  sort: K;
  direction: "asc" | "desc";
  onSort: (key: K) => void;
  children: ReactNode;
}) {
  return (
    <div className="stack" style={{ gap: "0.3rem" }}>
      <h4 style={{ margin: 0 }}>{title}</h4>
      <div style={{ overflowX: "auto", maxHeight: "18rem", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <SortHeader columns={columns} sort={sort} direction={direction} onSort={onSort} leading="#" />
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function NameCell({ player }: { player: RatedPlayer }) {
  const t = useT();
  return (
    <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
      <Link
        to={`/player/${encodeURIComponent(player.key)}`}
        style={{ display: "flex", alignItems: "center", gap: "0.4rem", textDecoration: "none", color: "var(--text)" }}
      >
        {player.avatar && <img src={player.avatar} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{player.name}</span>
        {!player.verified && (
          <span className="badge" title={t("Not signed in - grouped by nickname only", "Non connecté - regroupé par pseudo uniquement")}>
            {t("guest", "invité")}
          </span>
        )}
      </Link>
    </td>
  );
}
