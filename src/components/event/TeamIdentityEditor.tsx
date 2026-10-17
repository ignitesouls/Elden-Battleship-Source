import { useEffect, useState } from "react";
import { clearTeamLogo, renameTeam, setTeamLogo, teamLogoUrl, type TeamRow } from "../../lib/tournament/api";
import { useT } from "../../lib/language";
import { LogoField } from "./TeamLogo";

/**
 * A captain's controls for their team's name and logo - on the signup page and in Crew Quarters, open
 * until the team's first match (see teamIdentityOpen). `act` is the page's action wrapper, which shows
 * errors and reloads. The database has the last word: a match that went live a moment ago is refused
 * there in its own words.
 */
export function TeamIdentityEditor({
  team,
  teamSize,
  busy,
  act,
}: {
  team: Pick<TeamRow, "id" | "name" | "logo_path">;
  teamSize: number;
  busy: boolean;
  act: (action: () => Promise<unknown>) => unknown;
}) {
  const t = useT();
  const [name, setName] = useState(team.name);

  // A rename typed and saved elsewhere should not be clobbered by a stale field.
  useEffect(() => setName(team.name), [team.name]);

  return (
    <>
      <div className="row">
        <input style={{ flex: 1, minWidth: "10rem" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <button disabled={busy || name.trim() === team.name || name.trim().length < 2} onClick={() => void act(() => renameTeam(team.id, name.trim()))}>
          {t("Rename", "Renommer")}
        </button>
      </div>
      {/* An individual event shows each player's Twitch avatar instead - there's no logo to choose. */}
      {teamSize > 1 && (
        <LogoField
          current={teamLogoUrl(team.logo_path)}
          disabled={busy}
          onPick={(image) => void act(() => setTeamLogo(team.id, image, team.logo_path))}
          onClear={team.logo_path ? () => void act(() => clearTeamLogo(team.id, team.logo_path!)) : undefined}
        />
      )}
    </>
  );
}
