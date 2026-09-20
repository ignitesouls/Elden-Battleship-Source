import { teamName, teamHex } from "../lib/teamColors";
import { fleetByLength } from "../lib/fleetOrder";
import type { Player, ShipDefinition } from "../types/battleship";
import { useT } from "../lib/language";

interface Props {
  team: number;
  players: Player[];
  shipDefs: ShipDefinition[];
  /**
   * One flag per entry in `shipDefs`, true where that hull is down. Omit to hide the fleet section.
   *
   * By POSITION, never by name. This was a Set of sunk ship names, which cannot tell one Destroyer
   * from the other - and half of every board/preset combination fields a repeated name, so sinking
   * one of a pair struck through both and dropped the counter by two. See sunkHullFlags, which is
   * where every caller but the player's own fleet gets this from.
   */
  sunkHulls?: boolean[];
  eliminated?: boolean;
  isMine?: boolean;
  myPlayerId?: string;
}

export function TeamBox({ team, players, shipDefs, sunkHulls, eliminated, isMine, myPlayerId }: Props) {
  const t = useT();
  const members = players.filter((p) => p.team === team);
  const afloat = sunkHulls ? shipDefs.filter((_, i) => !sunkHulls[i]).length : null;

  return (
    <div
      className="panel stack"
      style={{ width: "100%", gap: "0.4rem", borderColor: isMine ? teamHex(team) : undefined }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <h3 style={{ color: teamHex(team), margin: 0, fontSize: "0.95rem" }}>
          {teamName(team)}
          {isMine && <span className="badge" style={{ marginLeft: "0.35rem" }}>{t("you", "vous")}</span>}
        </h3>
        {eliminated ? (
          <span className="badge">{t("eliminated", "éliminé")}</span>
        ) : (
          afloat !== null && (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {afloat}/{shipDefs.length} {t("afloat", "à flot")}
            </span>
          )
        )}
      </div>

      <div className="stack" style={{ gap: "0.1rem", fontSize: "0.8rem" }}>
        {members.length === 0 && <span className="muted">{t("empty", "vide")}</span>}
        {members.map((p) => (
          <span key={p.id}>
            {p.nickname}
            {p.is_host && <span className="badge" style={{ marginLeft: "0.3rem" }}>{t("host", "hôte")}</span>}
            {p.id === myPlayerId && !isMine && (
              <span className="badge" style={{ marginLeft: "0.3rem" }}>{t("you", "vous")}</span>
            )}
          </span>
        ))}
      </div>

      {sunkHulls && <HullStrip shipDefs={shipDefs} sunkHulls={sunkHulls} />}
    </div>
  );
}

/**
 * Longest hull first, each carrying its length - see lib/fleetOrder. A bare name asks the reader to
 * already know that a Cruiser is three squares, which is exactly what somebody watching their first
 * match doesn't, and the sizes are what the whole roster is read for: "they're down to a Destroyer"
 * only means something next to the 5 at the other end.
 *
 * Its own component because the roster scoreboard draws the same strip under each fleet's players.
 */
export function HullStrip({ shipDefs, sunkHulls }: { shipDefs: ShipDefinition[]; sunkHulls: boolean[] }) {
  return (
    <div className="row" style={{ gap: "0.3rem 0.6rem", fontSize: "0.75rem" }}>
      {fleetByLength(shipDefs).map(({ def, index }) => {
        const sunk = sunkHulls[index];
        return (
          <span
            key={index}
            style={{
              textDecoration: sunk ? "line-through" : undefined,
              color: sunk ? "var(--text-dim)" : "var(--text)",
            }}
          >
            {def.name} - {def.size}
          </span>
        );
      })}
    </div>
  );
}
