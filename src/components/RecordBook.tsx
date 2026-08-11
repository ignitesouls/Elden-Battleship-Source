import { Link } from "react-router-dom";
import { profileName, type Profile } from "../lib/profiles";
import type { RecordEntry, RecordHolder } from "../lib/recordBook";
import type { SquareSetId } from "../lib/challenges";

interface Props {
  records: RecordEntry[];
  profiles: Map<string, Profile>;
  /** Carried into the captain links, so a click lands on the same board's numbers. */
  squareSet: SquareSetId;
  /** True while the archived shots are still on the way - see the note about partial records. */
  loadingShots?: boolean;
}

/**
 * The record book.
 *
 * Laid out as a stack of one-line records rather than a table, because the columns a table would want
 * aren't the same for every row: some records are counts, some are percentages, some are clock times,
 * and one of them is the words "not a scratch". What every row does share is the shape of the
 * sentence - what the record is, the number, and who holds it - so that is what the layout enforces.
 *
 * The number leads, in the accent colour, because that is the thing people come back to check.
 */
export function RecordBook({ records, profiles, squareSet, loadingShots }: Props) {
  const held = records.filter((r) => r.holder !== null);
  if (held.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Record Book</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          Best single game on this board. Ties go to whoever did it first.
        </span>
      </div>

      <div className="stack" style={{ gap: "0.55rem" }}>
        {held.map((record) => (
          <RecordRow key={record.id} record={record} profiles={profiles} squareSet={squareSet} />
        ))}
      </div>

      {loadingShots && (
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          Reading the shot log for the streak and timing records...
        </span>
      )}
    </div>
  );
}

function RecordRow({
  record,
  profiles,
  squareSet,
}: {
  record: RecordEntry;
  profiles: Map<string, Profile>;
  squareSet: SquareSetId;
}) {
  const holder = record.holder!;

  return (
    <div className="row" style={{ gap: "0.6rem", alignItems: "baseline" }}>
      <span style={{ fontSize: "1.1rem", flexShrink: 0 }} aria-hidden>
        {record.emoji}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="row" style={{ gap: "0.45rem", alignItems: "baseline", flexWrap: "wrap" }}>
          <strong
            className="display"
            style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums", fontSize: "0.98rem" }}
          >
            {holder.display}
          </strong>
          {/* Same treatment as the number: the two together are the record's headline, and splitting
              them across two weights read as the number mattering and the name of it not. */}
          <strong className="display" style={{ color: "var(--accent)", fontSize: "0.98rem" }}>
            {record.label}
          </strong>
          <Name holder={holder} profiles={profiles} squareSet={squareSet} />
        </span>

        <div className="muted" style={{ fontSize: "0.72rem" }}>
          {[
            holder.detail,
            holder.roomCode ? `room ${holder.roomCode}` : null,
            new Date(holder.finishedAt).toLocaleDateString(),
            record.note,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>

        {/* Whoever is closest to taking it. Names only - the numbers are what the holder's line is
            for, and three numbers in a row reads as a table nobody asked for. */}
        {record.chasers.length > 0 && (
          <div className="muted" style={{ fontSize: "0.7rem" }}>
            chased by{" "}
            {record.chasers.map((c, i) => (
              <span key={`${c.key}-${c.matchKey}`}>
                {i > 0 && ", "}
                <Name holder={c} profiles={profiles} squareSet={squareSet} quiet /> ({c.display})
              </span>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}

function Name({
  holder,
  profiles,
  squareSet,
  quiet,
}: {
  holder: RecordHolder;
  profiles: Map<string, Profile>;
  squareSet: SquareSetId;
  quiet?: boolean;
}) {
  const profile = holder.userId ? profiles.get(holder.userId) : undefined;
  return (
    <Link
      to={`/player/${encodeURIComponent(holder.key)}?set=${encodeURIComponent(squareSet)}`}
      style={{
        color: quiet ? "var(--text-dim)" : "var(--text)",
        textDecoration: "none",
        fontWeight: quiet ? 400 : 600,
        fontSize: quiet ? "0.7rem" : "0.85rem",
      }}
    >
      {profileName(profile) ?? holder.nickname}
    </Link>
  );
}
