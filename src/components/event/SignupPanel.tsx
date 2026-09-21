import { useEffect, useState } from "react";
import {
  fetchMyFreeAgent,
  fetchMyInbox,
  parseLogins,
  registerTeam,
  respondToInvite,
  signUpSolo,
  withdrawSolo,
  type EventDetail,
  type FreeAgentRow,
  type InboxInvite,
  type TeamRow,
} from "../../lib/tournament/api";
import { isTwitchLoginConfigured, signInWithTwitch } from "../../lib/supabase";
import { accountName, type AccountProfile } from "../../hooks/useAuthProfile";
import { useT } from "../../lib/language";
import { MyTeamPanel } from "./MyTeamPanel";

interface Props {
  event: EventDetail;
  /** Every team the viewer may see - approved ones, plus their own pending team. */
  teams: TeamRow[];
  profile: AccountProfile | null;
  /** Re-reads the event's data. Called after anything that changes it. */
  reload: () => void;
}

/**
 * Everything a visitor can do about signing up, in whichever state they are in.
 *
 * Signing up needs a Twitch account: the site signs everyone in anonymously so the game works with no
 * account, and a roster of anonymous ids is a roster nobody can be held to. So an anonymous visitor
 * sees a prompt to sign in, and everything below it is for a signed-in player.
 *
 * The state a player is in decides what they see:
 *   an invitation waiting  ->  accept or decline it
 *   on a team              ->  their team (roster, invitations, entry code)
 *   waiting for a team     ->  their place in the pool
 *   none of those          ->  the ways to sign up
 * Only one of the last three ever shows at once, since a player can be in exactly one of them.
 */
export function SignupPanel({ event, teams, profile, reload }: Props) {
  const t = useT();

  if (!profile?.isTwitch) {
    return (
      <div className="panel stack">
        <h3>{t("Sign in to sign up", "Connectez-vous pour vous inscrire")}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "Entering an event needs a Twitch account, so your team and your results are really yours. It takes a moment, and you'll come straight back here.",
            "Participer à un événement demande un compte Twitch, afin que votre équipe et vos résultats vous appartiennent vraiment. Cela prend un instant, et vous reviendrez ici directement.",
          )}
        </p>
        <div>
          <button className="primary" disabled={!isTwitchLoginConfigured} onClick={() => void signInWithTwitch()}>
            {t("Sign in with Twitch", "Se connecter avec Twitch")}
          </button>
        </div>
      </div>
    );
  }
  return <SignedIn event={event} teams={teams} profile={profile} userId={profile.userId} reload={reload} />;
}

function SignedIn({
  event,
  teams,
  profile,
  userId,
  reload,
}: Omit<Props, "profile"> & { profile: AccountProfile; userId: string }) {
  const t = useT();
  const [invites, setInvites] = useState<InboxInvite[]>([]);
  const [agent, setAgent] = useState<FreeAgentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the player is waiting on besides their team: invitations to this event, and a place in the
  // solo pool. Re-read whenever the event's data is (the `teams` array is new on every reload).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [inbox, mine] = await Promise.all([fetchMyInbox(), fetchMyFreeAgent(event.id, userId)]);
        if (cancelled) return;
        setInvites(inbox.filter((i) => i.tournament_id === event.id));
        setAgent(mine);
      } catch {
        // Best effort: the sign-up controls below still work without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event.id, userId, teams]);

  /** Runs an action, shows the server's own words if it is refused, and refreshes either way. */
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      reload();
    }
  }

  const myTeam = teams.find(
    (team) => (team.status === "pending" || team.status === "approved") && team.roster.some((m) => m.user_id === userId),
  );

  return (
    <div className="stack">
      {error && <div className="panel error-text">{error}</div>}

      {!myTeam &&
        invites.map((invite) => (
          <div className="panel stack" key={invite.invite_id} style={{ borderColor: "rgba(159, 216, 255, 0.6)" }}>
            <strong>
              {t(
                `${invite.captain_name ?? "A captain"} invited you to join ${invite.team_name}`,
                `${invite.captain_name ?? "Un capitaine"} vous invite à rejoindre ${invite.team_name}`,
              )}
            </strong>
            <span className="muted">
              {t(
                `${invite.roster_count} of ${invite.team_size} players so far.`,
                `${invite.roster_count} joueur(s) sur ${invite.team_size} pour l'instant.`,
              )}
            </span>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void act(() => respondToInvite(invite.invite_id, true))}>
                {t("Join the team", "Rejoindre l'équipe")}
              </button>
              <button disabled={busy} onClick={() => void act(() => respondToInvite(invite.invite_id, false))}>
                {t("Decline", "Refuser")}
              </button>
            </div>
          </div>
        ))}

      {myTeam ? (
        <MyTeamPanel event={event} team={myTeam} userId={userId} reload={reload} />
      ) : agent && agent.status === "waiting" ? (
        <div className="panel stack">
          <h3>{t("You're on the list", "Vous êtes sur la liste")}</h3>
          <p style={{ margin: 0 }}>
            {t(
              "You've signed up without a team. An administrator will place you on one before the event starts - you'll see it here.",
              "Vous êtes inscrit sans équipe. Un administrateur vous placera dans une équipe avant le début de l'événement - vous le verrez ici.",
            )}
          </p>
          {agent.note && <p className="muted" style={{ margin: 0 }}>{t("Your note:", "Votre note :")} {agent.note}</p>}
          <div>
            <button disabled={busy} onClick={() => void act(() => withdrawSolo(event.id))}>
              {t("Withdraw", "Se retirer")}
            </button>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "A captain can also invite you by your Twitch name - if they do, it will appear above.",
              "Un capitaine peut aussi vous inviter avec votre nom Twitch - le cas échéant, l'invitation apparaîtra au-dessus.",
            )}
          </p>
        </div>
      ) : (
        <SignupForms event={event} profile={profile} busy={busy} act={act} />
      )}
    </div>
  );
}

function SignupForms({
  event,
  profile,
  busy,
  act,
}: {
  event: EventDetail;
  profile: AccountProfile;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT();
  const [teamName, setTeamName] = useState("");
  const [mates, setMates] = useState("");
  const [note, setNote] = useState("");

  const others = event.team_size - 1;
  const named = parseLogins(mates);
  const myName = accountName(profile) ?? "Player";

  // An individual event has no teams to build: you enter as yourself.
  if (event.team_size === 1) {
    return (
      <div className="panel stack">
        <h3>{t("Enter the event", "Participer à l'événement")}</h3>
        <p style={{ margin: 0 }}>
          {t("This is an individual event - you'll play as yourself, as", "C'est un événement individuel - vous jouerez sous votre nom, ")}{" "}
          <strong>{myName}</strong>.
        </p>
        <div>
          <button className="primary" disabled={busy} onClick={() => void act(() => registerTeam(event.id, myName, []))}>
            {t("Sign up", "S'inscrire")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="panel stack">
        <h3>{t("Sign up a team", "Inscrire une équipe")}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            `Teams here are ${event.team_size} players${event.max_roster > event.team_size ? `, with room for ${event.max_roster - event.team_size} substitute${event.max_roster - event.team_size === 1 ? "" : "s"}` : ""}. You're the captain and one of them - list the other ${others} by Twitch username, and they'll accept from the front page when they sign in.`,
            `Les équipes comptent ${event.team_size} joueurs${event.max_roster > event.team_size ? `, avec de la place pour ${event.max_roster - event.team_size} remplaçant(s)` : ""}. Vous êtes le capitaine et l'un d'eux - indiquez les ${others} autres par nom d'utilisateur Twitch ; ils accepteront depuis la page d'accueil en se connectant.`,
          )}
        </p>
        <label className="stack" style={{ gap: "0.3rem" }}>
          <span className="muted">{t("Team name", "Nom de l'équipe")}</span>
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={40} placeholder={t("The Salty Krakens", "Les Krakens Salés")} />
        </label>
        <label className="stack" style={{ gap: "0.3rem" }}>
          <span className="muted">{t("Your teammates' Twitch usernames", "Les noms Twitch de vos coéquipiers")}</span>
          <textarea
            rows={3}
            value={mates}
            onChange={(e) => setMates(e.target.value)}
            placeholder={t("one per line, or separated by commas", "un par ligne, ou séparés par des virgules")}
          />
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {t(`${named.length} named of ${others} needed`, `${named.length} indiqué(s) sur ${others} requis`)}
            {named.length < others && ` - ${t("you can add the rest later", "vous pourrez ajouter les autres plus tard")}`}
          </span>
        </label>
        <div>
          <button
            className="primary"
            disabled={busy || teamName.trim().length < 2}
            onClick={() => void act(() => registerTeam(event.id, teamName.trim(), named))}
          >
            {t("Sign up the team", "Inscrire l'équipe")}
          </button>
        </div>
      </div>

      <div className="panel stack">
        <h3>{t("No team? Sign up solo", "Pas d'équipe ? Inscrivez-vous seul")}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "Go on the list and an administrator will pair you with other solo players before the event starts.",
            "Inscrivez-vous sur la liste et un administrateur vous associera à d'autres joueurs solo avant le début de l'événement.",
          )}
        </p>
        <label className="stack" style={{ gap: "0.3rem" }}>
          <span className="muted">{t("A note for the organizers (optional)", "Un mot pour les organisateurs (facultatif)")}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t("Evenings in Europe, happy to play support", "Soirées en Europe, je joue volontiers en soutien")} />
        </label>
        <div>
          <button disabled={busy} onClick={() => void act(() => signUpSolo(event.id, note))}>
            {t("Sign up solo", "S'inscrire seul")}
          </button>
        </div>
      </div>
    </>
  );
}
