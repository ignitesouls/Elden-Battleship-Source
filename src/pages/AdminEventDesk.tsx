import { Link, useParams } from "react-router-dom";
import { LoadingScreen } from "../components/BrandMark";
import { DeskView } from "../components/admin/desk/DeskView";
import { useAdminStatus } from "../lib/admin";
import { useT } from "../lib/language";

/**
 * The running-event desk. Administrators only, guarded the way /admin and the start page are - and, as
 * with them, the guard is a courtesy: the form is only MOUNTED for an administrator, so it fetches
 * nothing for anyone else, but what actually refuses a non-administrator is the database function
 * behind every action on it.
 */
export function AdminEventDesk() {
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
  return <DeskView eventId={id} />;
}
