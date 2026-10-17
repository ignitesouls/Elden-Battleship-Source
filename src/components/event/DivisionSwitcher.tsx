import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDivisions, type DivisionLink, type EventDetail } from "../../lib/tournament/api";
import { useT } from "../../lib/language";

/**
 * The divisions of a split tournament, as a row of links with this one marked: each division is its own
 * event (see split_division), and this is how a visitor gets from one to the other. Nothing for an event
 * that was never split. `to` builds each division's address - its event page by default, or the same
 * admin page for the other division.
 */
export function DivisionSwitcher({ event, to = (id) => `/event/${id}` }: { event: Pick<EventDetail, "id" | "division_of">; to?: (id: string) => string }) {
  const t = useT();
  const [divisions, setDivisions] = useState<DivisionLink[]>([]);
  const { id, division_of } = event;

  useEffect(() => {
    let cancelled = false;
    fetchDivisions({ id, division_of })
      .then((found) => !cancelled && setDivisions(found))
      // A switcher that can't load is just absent; the page it sits on still works.
      .catch(() => !cancelled && setDivisions([]));
    return () => {
      cancelled = true;
    };
  }, [id, division_of]);

  if (divisions.length < 2) return null;
  return (
    <nav className="row" style={{ justifyContent: "center", gap: "0.4rem" }} aria-label={t("Divisions", "Divisions")}>
      {divisions.map((d) => (
        <Link key={d.id} to={to(d.id)} className={`link-button${d.id === event.id ? " primary" : ""}`} aria-current={d.id === event.id ? "page" : undefined}>
          {d.division_name || d.name}
        </Link>
      ))}
    </nav>
  );
}
