import { Link, useParams } from "react-router-dom";
import { LoadingScreen } from "../components/BrandMark";
import { StartEventForm } from "../components/admin/StartEventForm";
import { useAdminStatus } from "../lib/admin";
import { useT } from "../lib/language";

/**
 * Where an administrator starts an event. Administrators only.
 *
 * Guarded the way the Admin page is, and for the same reason it is not a redirect: the route has to
 * exist for everyone so an admin following a link into a fresh tab lands here before the session has
 * been checked, and bouncing a non-admin elsewhere would imply the page doesn't exist when the honest
 * answer is that it does and isn't theirs.
 *
 * Note what this guard is and is not. It stops the form being shown, and - because the form is only
 * MOUNTED for an administrator - it stops the form fetching anything. It is not what stops a
 * non-administrator starting an event: the database function that does the starting checks for an
 * administrator itself, and would refuse them whatever this page did. A guard in the browser is a
 * courtesy; the refusal in the database is the rule.
 */
export function AdminStartEvent({ mode }: { mode: "plan" | "start" }) {
  const t = useT();
  const { id = "" } = useParams();
  const { isAdmin, loading } = useAdminStatus();

  if (loading) return <LoadingScreen>{t("Checking...", "Vérification...")}</LoadingScreen>;

  if (!isAdmin) {
    return (
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>
          {t("Nothing here for you. These controls are for administrators.", "Rien ici pour vous. Ces commandes sont réservées aux administrateurs.")}
        </p>
        <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
      </div>
    );
  }

  return <StartEventForm eventId={id} mode={mode} />;
}
