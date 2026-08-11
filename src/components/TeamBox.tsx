import { teamName, teamHex } from "../lib/teamColors";
import type { Player, ShipDefinition } from "../types/battleship";

interface Props {
  team: number;
  players: Player[];
  shipDefs: ShipDefinition[];
  /** Which of this team's ships are sunk, by name. Omit to hide the fleet section. */
  sunkShipNames?: Set<string | null>;
  eliminated?: boolean;
  isMine?: boolean;
  myPlayerId?: string;
}

export function TeamBox({ team, players, shipDefs, sunkShipNames, eliminated, isMine, myPlayerId }: Props) {
  const members = players.filter((p) => p.team === team);
  const afloat = sunkShipNames ? shipDefs.filter((s) => !sunkShipNames.has(s.name)).length : null;

  return (
    <div
      className="panel stack"
      style={{ width: "100%", gap: "0.4rem", borderColor: isMine ? teamHex(team) : undefined }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <h3 style={{ color: teamHex(team), margin: 0, fontSize: "0.95rem" }}>
          {teamName(team)}
          {isMine && <span className="badge" style={{ marginLeft: "0.35rem" }}>you</span>}
        </h3>
        {eliminated ? (
          <span className="badge">eliminated</span>
        ) : (
          afloat !== null && (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {afloat}/{shipDefs.length} afloat
            </span>
          )
        )}
      </div>

      <div className="stack" style={{ gap: "0.1rem", fontSize: "0.8rem" }}>
        {members.length === 0 && <span className="muted">empty</span>}
        {members.map((p) => (
          <span key={p.id}>
            {p.nickname}
            {p.is_host && <span className="badge" style={{ marginLeft: "0.3rem" }}>host</span>}
            {p.id === myPlayerId && !isMine && <span className="badge" style={{ marginLeft: "0.3rem" }}>you</span>}
          </span>
        ))}
      </div>

      {sunkShipNames && (
        <div className="row" style={{ gap: "0.3rem 0.6rem", fontSize: "0.75rem" }}>
          {shipDefs.map((s, i) => {
            const sunk = sunkShipNames.has(s.name);
            return (
              <span
                key={i}
                style={{
                  textDecoration: sunk ? "line-through" : undefined,
                  color: sunk ? "var(--text-dim)" : "var(--text)",
                }}
              >
                {s.name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
