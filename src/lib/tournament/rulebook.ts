import type { Language } from "../language";
import type { TournamentFormat } from "./format";
import type { MatchRules } from "./matchRules";

/**
 * The rulebook every event's rules page shows, with the event's own numbers written in.
 *
 * One text for every event, so a rule fixed here is fixed everywhere; what differs from event to event
 * (crew size, the clock, the board, the format) is read off the event rather than typed into a copy.
 * Anything an organizer wants on top goes in the event's own extra rules, shown above this and taking
 * precedence over it - this file is never edited for one event.
 *
 * English and French side by side in every line, so a rule changed in one language is in front of
 * whoever changes it in the other. Game names in French follow the site's own square sets (Sentinelle
 * Draconique de l'Arbre, Cavalier crépusculaire ...), so the rules and the board say the same thing.
 *
 * Rule numbers are fixed, because players and referees cite them: a rule that does not apply to an
 * event says so in its own words rather than dropping out and renumbering the rest.
 *
 * Pure, like the rest of lib/tournament: the caller resolves the square set to a label and says whether
 * it is a boss board, so the sets' JSON stays out.
 */

export interface RulebookContext {
  eventName: string;
  teamSize: number;
  rules: MatchRules;
  /** The fixed board's name as the lobby shows it, or null when each match's host picks the set. */
  setLabel: string | null;
  /** False only when the event fixes a set that auto-marking cannot fire into (an objectives board). */
  bossBoard: boolean;
  /** Null until the event starts - the format is chosen on the start screen. */
  format: TournamentFormat | null;
}

export type RuleBlock = string | { ordered: string[] } | { bullets: string[] };

export interface Rule {
  n: string;
  title: string;
  body: RuleBlock[];
}

export interface RuleSection {
  n: number;
  title: string;
  /** Text before the first rule, if any. */
  intro?: string;
  rules: Rule[];
}

type Tr = (en: string, fr: string) => string;

/** Series length as a phrase: "a best of 3", or "a single game" rather than the odd "best of 1". */
const bo = (n: number, tr: Tr) => (n === 1 ? tr("a single game", "en une seule manche") : tr(`a best of ${n}`, `au meilleur des ${n}`));

function duration(seconds: number, tr: Tr): string {
  if (seconds % 60 === 0) return tr(`${seconds / 60}-minute`, `${seconds / 60} minute${seconds === 60 ? "" : "s"}`);
  if (seconds < 60) return tr(`${seconds}-second`, `${seconds} secondes`);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return tr(clock, clock);
}

function formatRule(format: TournamentFormat | null, tr: Tr): string[] {
  if (!format) {
    return [
      tr(
        "The format - rounds, cut and series lengths - is set when the event starts, and will appear here.",
        "Le format - rondes, qualifiés et longueur des séries - est fixé au lancement de l'événement et apparaîtra ici.",
      ),
    ];
  }

  const q = format.qualifier;
  const k = format.knockout;
  const out: string[] = [];
  const knockoutKind = k
    ? k.format === "double"
      ? tr("double-elimination knockout", "phase finale à double élimination")
      : tr("single-elimination knockout", "phase finale à élimination directe")
    : "";

  if (q.format === "swiss") {
    const cut = k?.cutTo;
    const rounds = tr(`${q.rounds} ${q.rounds === 1 ? "round" : "rounds"}`, `${q.rounds} ${q.rounds === 1 ? "ronde" : "rondes"}`);
    out.push(
      tr(`The event opens with ${rounds} of Swiss, each ${bo(q.bestOf, tr)}`, `L'événement commence par ${rounds} de système suisse, chacune ${bo(q.bestOf, tr)}`) +
        (k && cut
          ? tr(`, then the top ${cut} advance to a ${knockoutKind}.`, `, puis les ${cut} premiers accèdent à une ${knockoutKind}.`)
          : tr(". The final Swiss table decides the winner.", ". Le classement final du système suisse désigne le vainqueur.")),
    );
    out.push(
      tr(
        "Swiss pairs you each round against an opponent with a similar record whom you have not yet played. You never meet the same opponent twice in Swiss.",
        "À chaque ronde, le système suisse vous oppose à un adversaire au bilan proche que vous n'avez pas encore affronté. Vous ne rencontrez jamais deux fois le même adversaire en suisse.",
      ),
    );
  } else if (q.format === "groups") {
    const groups = tr(
      `${q.groupCount} round-robin ${q.groupCount === 1 ? "group" : "groups"}`,
      `${q.groupCount} ${q.groupCount === 1 ? "poule" : "poules"} en toutes rondes`,
    );
    out.push(
      tr(
        `The event opens with ${groups}, everyone in a group meeting ${q.legs === 2 ? "twice" : "once"}, each ${bo(q.bestOf, tr)}`,
        `L'événement commence par ${groups}, chacun affrontant ${q.legs === 2 ? "deux fois" : "une fois"} tous les membres de sa poule, ${bo(q.bestOf, tr)}`,
      ) +
        (k && q.advancePerGroup
          ? tr(`. The top ${q.advancePerGroup} of each group advance to a ${knockoutKind}.`, `. Les ${q.advancePerGroup} premiers de chaque poule accèdent à une ${knockoutKind}.`)
          : tr(". The group tables decide the winner.", ". Les classements des poules désignent le vainqueur.")),
    );
  } else if (k) {
    out.push(tr(`The event is a ${knockoutKind} with everybody in it from the first round.`, `L'événement est une ${knockoutKind}, avec tout le monde dès le premier tour.`));
  }
  return out;
}

function knockoutRule(format: TournamentFormat | null, tr: Tr): string[] {
  if (!format) return [tr("Knockout details are set when the event starts.", "Les détails de la phase finale sont fixés au lancement de l'événement.")];
  const k = format.knockout;
  if (!k) return [tr("This event has no knockout.", "Cet événement n'a pas de phase finale.")];

  const out = [
    tr(
      "The top seed meets the lowest, the second meets the second-lowest, and so on, with no reseeding between rounds.",
      "La meilleure tête de série affronte la moins bonne, la deuxième l'avant-dernière, et ainsi de suite, sans nouveau classement entre les tours.",
    ),
  ];
  const series = [tr(`Every series is ${bo(k.bestOf, tr)}`, `Chaque série se joue ${bo(k.bestOf, tr)}`)];
  if (k.semifinalBestOf && k.semifinalBestOf !== k.bestOf) {
    series.push(
      k.format === "double"
        ? tr(`the winners' and losers' finals are a best of ${k.semifinalBestOf}`, `les finales des gagnants et des perdants au meilleur des ${k.semifinalBestOf}`)
        : tr(`the semifinals are a best of ${k.semifinalBestOf}`, `les demi-finales au meilleur des ${k.semifinalBestOf}`),
    );
  }
  if (k.finalBestOf && k.finalBestOf !== k.bestOf) {
    series.push(
      k.format === "double"
        ? tr(`the grand final is a best of ${k.finalBestOf}`, `la grande finale au meilleur des ${k.finalBestOf}`)
        : tr(`the final is a best of ${k.finalBestOf}`, `la finale au meilleur des ${k.finalBestOf}`),
    );
  }
  out.push(series.join(tr("; ", " ; ")) + ".");
  if (k.format === "double") {
    out.push(
      k.grandFinalReset
        ? tr(
            "If the losers' bracket finalist wins the grand final, a second grand final decides the title.",
            "Si le finaliste du tableau des perdants remporte la grande finale, une seconde grande finale décide du titre.",
          )
        : tr("The grand final is played once, with no bracket reset.", "La grande finale se joue une seule fois, sans remise à zéro du tableau."),
    );
  } else if (k.thirdPlace) {
    out.push(tr("The two beaten semifinalists play off for third place.", "Les deux demi-finalistes battus jouent un match pour la troisième place."));
  }
  return out;
}

/**
 * 4.1, the board. An event can fix the squares, the board size and the fleet each on its own (see
 * matchRules), so this says, for each one, either what the event set or that the host picks it - and
 * what happens to a room that is set up differently when it becomes official (link_official_room).
 */
function boardRule(ctx: RulebookContext, tr: Tr): string[] {
  const { board_size: size, fleet } = ctx.rules;
  // Hull names stay in English in both languages, as they read in the lobby's fleet settings.
  const ships = fleet
    ? tr(
        `${fleet.length} ${fleet.length === 1 ? "ship" : "ships"}: ${fleet.map((s) => `${s.name} (${s.size})`).join(", ")}`,
        `${fleet.length} ${fleet.length === 1 ? "navire" : "navires"} : ${fleet.map((s) => `${s.name} (${s.size})`).join(", ")}`,
      )
    : "";

  const out = [
    ctx.setLabel
      ? tr(`Every official match is played on ${ctx.setLabel}.`, `Chaque match officiel se joue sur ${ctx.setLabel}.`)
      : tr(
          "Matches are played on the boss board, a grid where every square is a boss, unless the rules for this event say otherwise. The host sets the squares in the room.",
          "Les matchs se jouent sur le plateau des boss, une grille où chaque case est un boss, sauf si les règles propres à cet événement en disposent autrement. L'hôte règle les cases dans la partie.",
        ),
  ];

  if (size && fleet) {
    out.push(tr(`The board is ${size}x${size}, and every fleet is ${ships}.`, `Le plateau fait ${size}x${size}, et chaque flotte compte ${ships}.`));
  } else if (size) {
    out.push(tr(`The board is ${size}x${size}. Each match's host chooses the fleet.`, `Le plateau fait ${size}x${size}. L'hôte de chaque match choisit la flotte.`));
  } else if (fleet) {
    out.push(
      tr(
        `Every fleet is ${ships}. Each match's host chooses the board size, which has to be big enough to hold it.`,
        `Chaque flotte compte ${ships}. L'hôte de chaque match choisit la taille du plateau, qui doit être assez grande pour l'accueillir.`,
      ),
    );
  } else {
    out.push(tr("Each match's host chooses the board size and the fleet.", "L'hôte de chaque match choisit la taille du plateau et la flotte."));
  }

  out.push(
    ctx.setLabel || size || fleet
      ? tr(
          "What the event sets is applied to the room when it becomes official, and the whole board - squares, size and fleet - is locked from then on. A room that cannot take it (a board too small for the fleet, squares too few for the board) is told what to change first.",
          "Ce que l'événement fixe est appliqué à la partie quand elle devient officielle, et tout le plateau - cases, taille et flotte - est alors verrouillé. Une partie qui ne peut pas s'y conformer (plateau trop petit pour la flotte, pas assez de cases pour le plateau) est d'abord invitée à corriger ce qui doit l'être.",
        )
      : tr("The board is locked once the room is official.", "Le plateau est verrouillé une fois la partie officielle."),
  );
  return out;
}

export function rulebook(ctx: RulebookContext, lang: Language = "en"): RuleSection[] {
  const tr: Tr = (en, fr) => (lang === "fr" ? fr : en);
  const name = ctx.eventName;
  const solo = ctx.teamSize === 1;

  return [
    {
      n: 1,
      title: tr("Overview", "Présentation"),
      intro: tr(
        `${name} is an Elden Battleship league. Its organizers have final authority on everything in this rulebook. Matches are played on the Elden Battleship website, in an official room linked to the event. Rules are numbered so referees and players can cite them.`,
        `${name} est une ligue Elden Battleship. Ses organisateurs ont le dernier mot sur tout ce que contient ce règlement. Les matchs se jouent sur le site Elden Battleship, dans une partie officielle liée à l'événement. Les règles sont numérotées pour que arbitres et joueurs puissent les citer.`,
      ),
      rules: [
        { n: "1.1", title: tr("Format", "Format"), body: formatRule(ctx.format, tr) },
        {
          n: "1.2",
          title: tr("Standings", "Classement"),
          body: [
            tr("The event page ranks entrants in this order:", "La page de l'événement classe les participants dans cet ordre :"),
            {
              ordered: [
                tr("Wins (a bye counts as a win, but not as a game played)", "Victoires (une exemption compte comme une victoire, mais pas comme un match joué)"),
                tr("Game difference (games won minus games lost across every series)", "Différence de manches (manches gagnées moins manches perdues, toutes séries confondues)"),
                tr("Strength of schedule (the combined wins of every opponent you played)", "Force du calendrier (le total des victoires de tous vos adversaires)"),
                tr("Head-to-head, only when exactly two entrants are level and have met", "Confrontation directe, seulement quand exactement deux participants sont à égalité et se sont affrontés"),
                tr("Original seed", "Tête de série d'origine"),
              ],
            },
            tr(
              "If the cut line falls between entrants tied on every tiebreak above seed, the organizers may order a playoff match instead.",
              "Si la ligne de qualification sépare des participants à égalité sur tous les critères avant la tête de série, les organisateurs peuvent imposer un match de barrage.",
            ),
          ],
        },
        { n: "1.3", title: tr("Knockouts", "Phase finale"), body: knockoutRule(ctx.format, tr) },
        {
          n: "1.4",
          title: tr("Referees", "Arbitres"),
          body: [
            tr(
              "Referees are encouraged in the qualifier and required in knockouts. Players arrange their own qualifier referee from the community first, and contact the organizers only if none is available.",
              "Un arbitre est conseillé pendant les qualifications et obligatoire en phase finale. En qualifications, les joueurs cherchent d'abord eux-mêmes un arbitre dans la communauté, et ne contactent les organisateurs que si personne n'est disponible.",
            ),
          ],
        },
        {
          n: "1.5",
          title: tr("Scheduling", "Planification"),
          body: [
            tr(
              "Play any time in the assigned week, at a time both sides agree. Schedule in your match channel and tag the organizers once it is set. Arriving more than 15 minutes late without notice forfeits the match. If a match goes unscheduled through one side's negligence, that side takes the loss; if both are negligent, both take a loss.",
              "Jouez quand vous voulez pendant la semaine attribuée, à une heure convenue par les deux camps. Planifiez dans le salon de votre match et mentionnez les organisateurs une fois l'heure fixée. Un retard de plus de 15 minutes sans prévenir vaut forfait. Si un match n'est pas planifié par la négligence d'un camp, ce camp perd ; si les deux sont négligents, les deux perdent.",
            ),
          ],
        },
        {
          n: "1.6",
          title: tr("Results", "Résultats"),
          body: [
            tr(
              "The official room records the result on the event page automatically. If the room fails to record it, post a screenshot of the final board in the event's results channel.",
              "La partie officielle enregistre automatiquement le résultat sur la page de l'événement. Si elle n'y parvient pas, publiez une capture du plateau final dans le salon des résultats de l'événement.",
            ),
          ],
        },
      ],
    },
    {
      n: 2,
      title: tr("Fleets, crews and conduct", "Flottes, équipages et conduite"),
      rules: [
        {
          n: "2.1",
          title: tr("Fleets", "Flottes"),
          body: [
            solo
              ? tr("Each entrant is one fleet, played by one player.", "Chaque participant est une flotte, jouée par un seul joueur.")
              : tr(
                  `Each entrant is one fleet with a crew of ${ctx.teamSize} players. Every rule in this book applies to every crew member, and a penalty on any crew member is a penalty on the fleet.`,
                  `Chaque participant est une flotte dont l'équipage compte ${ctx.teamSize} joueurs. Chaque règle s'applique à chaque membre de l'équipage, et une pénalité infligée à l'un d'eux s'applique à toute la flotte.`,
                ),
          ],
        },
        {
          n: "2.2",
          title: tr("Crews", "Équipages"),
          body: solo
            ? [tr("This is an individual event: you play alone (see 2.3).", "C'est un événement individuel : vous jouez seul (voir 2.3).")]
            : [
                tr(
                  "Crewmates may talk freely to each other during a match. Each crew member plays their own game; every kill they make fires for the fleet. Crew changes after sign-up need the organizers' approval before the match.",
                  "Les membres d'un équipage peuvent se parler librement pendant un match. Chacun joue sa propre partie ; chaque victoire de l'un tire pour toute la flotte. Tout changement d'équipage après l'inscription doit être approuvé par les organisateurs avant le match.",
                ),
                // How a crew comes together: the event page's signup options, and no bench (team_size is
                // the whole roster - see the event_board_and_pairs migration).
                ctx.teamSize === 3
                  ? tr(
                      "A crew is exactly 3 players; there are no substitutes. Sign up as a full crew, as a pair, or alone: the organizers complete each pair with a solo player, and form the remaining solo players into crews.",
                      "Un équipage compte exactement 3 joueurs ; il n'y a pas de remplaçants. Inscrivez-vous en équipage complet, en duo ou seul : les organisateurs complètent chaque duo avec un joueur solo et forment des équipages avec les autres joueurs solo.",
                    )
                  : tr(
                      `A crew is exactly ${ctx.teamSize} players; there are no substitutes. Sign up as a full crew, or alone and the organizers will place you in one.`,
                      `Un équipage compte exactement ${ctx.teamSize} joueurs ; il n'y a pas de remplaçants. Inscrivez-vous en équipage complet, ou seul et les organisateurs vous placeront dans un équipage.`,
                    ),
              ],
        },
        {
          n: "2.3",
          title: tr("Outside help", "Aide extérieure"),
          body: [
            solo
              ? tr(
                  "No help or information from anyone else during a match. That includes Twitch chat, Discord, and anyone in the room with you.",
                  "Aucune aide ni information de qui que ce soit pendant un match. Cela inclut le chat Twitch, Discord et toute personne présente dans la pièce.",
                )
              : tr(
                  "No help or information from anyone outside your crew during a match. That includes Twitch chat, Discord, and anyone in the room with you.",
                  "Aucune aide ni information de quiconque hors de votre équipage pendant un match. Cela inclut le chat Twitch, Discord et toute personne présente dans la pièce.",
                ),
          ],
        },
        {
          n: "2.4",
          title: tr("No watching the broadcast", "Interdiction de regarder la diffusion"),
          body: [
            tr(
              "Do not watch the caster broadcast or any opponent's stream during a match. Casters can see every fleet's ships, so either one can give away where your opponent's fleet is hidden. Doing so is outside help (2.3).",
              "Ne regardez ni la diffusion des commentateurs ni le stream d'un adversaire pendant un match. Les commentateurs voient les navires de toutes les flottes : l'un comme l'autre peut révéler où se cache la flotte adverse. Le faire est une aide extérieure (2.3).",
            ),
          ],
        },
        {
          n: "2.5",
          title: tr("Chat moderation", "Modération du chat"),
          body: [
            tr(
              "If you stream, your moderators must delete spoilers, hints and ship positions from chat. Anything your chat spoils is your responsibility, and can lead to penalties up to forfeiting the match.",
              "Si vous streamez, vos modérateurs doivent supprimer du chat les spoilers, les indices et les positions de navires. Tout ce que votre chat divulgue relève de votre responsabilité et peut entraîner des pénalités, jusqu'au forfait.",
            ),
          ],
        },
        {
          n: "2.6",
          title: tr("Code of conduct", "Code de conduite"),
          body: [
            tr(
              `${name} is for Elden Ring players of every level, and puts fun, inclusion and friendly competition first. Keep your communication positive, and keep your community the same way. Abuse of others, by you or your community, is not tolerated.`,
              `${name} s'adresse aux joueurs d'Elden Ring de tous niveaux et place le plaisir, l'inclusion et une compétition amicale avant tout. Communiquez de façon positive, et veillez à ce que votre communauté en fasse autant. Aucun abus envers autrui, de votre part ou de celle de votre communauté, n'est toléré.`,
            ),
          ],
        },
      ],
    },
    {
      n: 3,
      title: tr("Setup, tools and banned play", "Installation, outils et pratiques interdites"),
      rules: [
        {
          n: "3.1",
          title: tr("Required setup", "Installation requise"),
          body: [
            tr(
              "Play on the current Elden Ring patch through Dionysus, with the randomizer settings the event announces. Auto-marking is recommended (4.4). If the game is patched mid-event, the organizers will announce how to proceed.",
              "Jouez sur la version actuelle d'Elden Ring via Dionysus, avec les réglages du randomizer annoncés par l'événement. Le marquage automatique est recommandé (4.4). Si le jeu reçoit un patch en cours d'événement, les organisateurs annonceront la marche à suivre.",
            ),
          ],
        },
        {
          n: "3.2",
          title: tr("Allowed mods and tools", "Mods et outils autorisés"),
          body: [
            tr(
              "Only the mods Dionysus ships are allowed: the randomizer, Stutter Fix, the menu input-delay fix and the Ignite overlay (auto-marking). Map Genie, Fextralife and rune-level calculators are allowed. If you rely on an accessibility mod, contact the organizers before the event.",
              "Seuls les mods fournis avec Dionysus sont autorisés : le randomizer, Stutter Fix, le correctif de latence des menus et l'overlay Ignite (marquage automatique). Map Genie, Fextralife et les calculateurs de niveau de runes sont autorisés. Si vous dépendez d'un mod d'accessibilité, contactez les organisateurs avant l'événement.",
            ),
          ],
        },
        {
          n: "3.3",
          title: tr("Macros and scripts", "Macros et scripts"),
          body: [
            tr(
              "Every input must be made by you, on your own device. Banned examples: fast quit-outs, auto-dodge, auto-parry, moveset swaps and movement scripts.",
              "Chaque commande doit être faite par vous, sur votre propre périphérique. Exemples interdits : sorties rapides du jeu, esquive automatique, parade automatique, échanges de moveset et scripts de déplacement.",
            ),
          ],
        },
        {
          n: "3.4",
          title: tr("Streaming", "Diffusion"),
          body: [
            tr(
              "Matches with commentary must be streamed live on the Twitch account that you used to sign up for the tournament. Use the overlay the organizers provide, and put your facecam (if you are using one) in its marked spot.",
              "Les matchs commentés doivent être diffusés en direct sur le compte Twitch utilisé pour l'inscription au tournoi. Utilisez l'overlay fourni par les organisateurs, et placez votre facecam (si vous en avez une) à l'emplacement prévu.",
            ),
          ],
        },
        {
          n: "3.5",
          title: tr("Keep your fleet off your stream", "Gardez votre flotte hors de votre stream"),
          body: [
            tr(
              "Never show your Fleet overlay source or your own ship positions on stream during a match. Your rejoin code is private: anyone holding it can see your ships.",
              "Ne montrez jamais votre source Flotte ni la position de vos navires en stream pendant un match. Votre code de reconnexion est privé : quiconque le détient peut voir vos navires.",
            ),
          ],
        },
        {
          n: "3.6",
          title: tr("Skips and cheeses", "Skips et cheeses"),
          body: [
            tr(
              "The event is played without major skips or cheeses. Any action done on purpose, in a way clearly unintended to an informed player, is banned. That includes:",
              "L'événement se joue sans skips ni cheeses majeurs. Toute action volontaire, réalisée d'une façon manifestement non prévue aux yeux d'un joueur averti, est interdite. Notamment :",
            ),
            {
              ordered: [
                tr("Gravity kills, or running bosses into kill planes", "Faire tomber un ennemi dans le vide, ou attirer un boss dans une zone de mort"),
                tr("Stake skips, or skipping a boss the route requires", "Les skips par Pieu de Marika, ou éviter un boss obligatoire sur le chemin"),
                tr("Breaking enemy AI so it cannot meaningfully damage you", "Bloquer l'IA d'un ennemi pour qu'il ne puisse plus vraiment vous blesser"),
                tr("Fall-damage cancelling", "L'annulation des dégâts de chute"),
                tr("Clipping out of bounds", "Passer à travers le décor hors des limites"),
                tr("Glitching the game for an advantage, including infinite damage or infinite runes", "Exploiter un bug pour un avantage, y compris des dégâts ou des runes infinis"),
                tr("Quit-outs used to skip required dialogue or actions", "Quitter le jeu pour sauter un dialogue ou une action obligatoire"),
              ],
            },
          ],
        },
        {
          n: "3.7",
          title: tr("Banned skips (not limited to)", "Skips interdits (liste non exhaustive)"),
          body: [
            tr(
              "Noble skip, Radahn stake skip, critical hits or the explosive physick to cancel fall damage, zips, wrong warping.",
              "Skip du Noble, skip du Pieu de Radahn, coups critiques ou larme explosive de la Fiole de Miracle pour annuler les dégâts de chute, zips, wrong warp.",
            ),
          ],
        },
        {
          n: "3.8",
          title: tr("Banned cheeses (not limited to)", "Cheeses interdits (liste non exhaustive)"),
          body: [
            {
              bullets: [
                tr("Knocking the Draconic Tree Sentinel off a cliff", "Faire tomber la Sentinelle Draconique de l'Arbre d'une falaise"),
                tr("Making the Dragonbarrow Night's Cavalry jump off a cliff", "Faire sauter le Cavalier crépusculaire du Tertre draconique d'une falaise"),
                tr("Freezing Blue Loretta's AI", "Bloquer l'IA de Loretta (Esprit bleu)"),
                tr("Flying Dragon Greyll's T-pose death", "La mort en T-pose de Greyll, le Dragon volant"),
                tr("Making Radahn comet off the map", "Faire sortir Radahn de la carte avec sa comète"),
                tr("Quitting out to respawn Greyoll's baby dragons", "Quitter le jeu pour faire réapparaître les bébés dragons de Greyoll"),
                tr("Riposting the Omen Killer or Dragonbarrow Bell Bearing Hunter off a cliff", "Faire tomber d'une falaise, par une riposte, le Tueur de Présages ou le Chasseur de perles cinéraires du Tertre draconique"),
                tr("Running NPCs off cliffs", "Attirer des PNJ dans le vide"),
                tr(
                  "Standing on the tree branch above Commander O'Neil and banging a metal weapon on the tree",
                  "Se poster sur la branche au-dessus du Commandant O'Neil et frapper l'arbre avec une arme en métal",
                ),
                tr("Ghiza's wheel machine-gun glitch against Rykard", "Le bug de mitraillette de la Roue de Ghiza contre Rykard"),
                tr("Serpent Hunter moveset swaps", "Les échanges de moveset du Chasseur de serpents"),
                tr("Making the Stormveil Crucible Knight jump into the elevator hole", "Faire sauter le Chevalier du Creuset de Stormveil dans le puits de l'ascenseur"),
              ],
            },
            tr(
              "A kill made with a banned skip or cheese does not count, and the referee will deal with the shot it fired (6.5).",
              "Une victoire obtenue par un skip ou un cheese interdit ne compte pas, et l'arbitre traitera le tir qu'elle a déclenché (6.5).",
            ),
          ],
        },
      ],
    },
    {
      n: 4,
      title: tr("Battleship rules", "Règles de la bataille navale"),
      rules: [
        {
          n: "4.1",
          title: tr("The board", "Le plateau"),
          body: boardRule(ctx, tr),
        },
        {
          n: "4.2",
          title: tr("Placement", "Placement"),
          body: [
            tr(
              "Before battle, each fleet places its ships on the board, or presses Randomize, then confirms. Your placement is hidden from opponents by the site; keep it hidden yourself (3.5).",
              "Avant la bataille, chaque flotte place ses navires sur le plateau, ou appuie sur Aléatoire, puis confirme. Le site cache votre placement à vos adversaires ; gardez-le caché vous aussi (3.5).",
            ),
          ],
        },
        {
          n: "4.3",
          title: tr("Firing", "Tir"),
          body: [
            tr(
              "You fire at a square by killing the boss on it. One shot lands on every other fleet at that square and reports hit, miss or sunk. A ship sinks when every square it covers has been hit. The last fleet with a ship afloat wins the match.",
              "Vous tirez sur une case en tuant le boss qui s'y trouve. Un tir frappe toutes les autres flottes sur cette case et indique touché, raté ou coulé. Un navire coule quand toutes ses cases ont été touchées. La dernière flotte avec un navire à flot remporte le match.",
            ),
          ],
        },
        {
          n: "4.4",
          title: tr("Marking", "Marquage"),
          body: ctx.bossBoard
            ? [
                tr(
                  "You may mark squares with auto-marking or by hand. Auto-marking is recommended: the Ignite overlay, run with your own token from the site's OBS & auto-marking page, fires the square the moment the boss dies. If you click by hand, click the square within 30 seconds of the kill (4.8), and never before it.",
                  "Vous pouvez marquer les cases avec le marquage automatique ou à la main. Le marquage automatique est recommandé : l'overlay Ignite, utilisé avec votre propre jeton depuis la page OBS et marquage automatique du site, tire sur la case à l'instant où le boss meurt. Si vous cliquez à la main, cliquez sur la case dans les 30 secondes qui suivent la victoire (4.8), et jamais avant.",
                ),
              ]
            : [
                tr(
                  "This event's board is not a boss board, so auto-marking cannot fire its squares: click each one by hand within 30 seconds of completing it, and never before. What completes a square is set out in the rules for this event, above.",
                  "Le plateau de cet événement n'est pas un plateau de boss : le marquage automatique ne peut pas tirer sur ses cases. Cliquez sur chacune à la main dans les 30 secondes qui suivent sa réalisation, et jamais avant. Ce qui valide une case est précisé dans les règles propres à cet événement, plus haut.",
                ),
              ],
        },
        {
          n: "4.5",
          title: tr("Mismarks", "Erreurs de marquage"),
          body: [
            ctx.bossBoard
              ? tr(
                  "A mismark is a square clicked before its boss was killed, or one whose boss was never killed (a wrong square). The player quits out for 30 seconds, and the boss on the mismarked square must be the next boss they kill.",
                  "Une erreur de marquage est une case cliquée avant que son boss ne soit vaincu, ou dont le boss n'a jamais été vaincu (mauvaise case). Le joueur quitte le jeu pendant 30 secondes, puis le boss de la case mal marquée doit être le prochain boss qu'il tue.",
                )
              : tr(
                  "A mismark is a square clicked before it was completed, or one that was never completed (a wrong square). The player quits out for 30 seconds, and the mismarked square must be the next square they complete.",
                  "Une erreur de marquage est une case cliquée avant d'être réalisée, ou qui n'a jamais été réalisée (mauvaise case). Le joueur quitte le jeu pendant 30 secondes, puis la case mal marquée doit être la prochaine case qu'il réalise.",
                ),
            tr(
              "A click more than 30 seconds after the kill is a late mark: the player quits out for 30 seconds. Either way the shot itself stands (4.9).",
              "Un clic plus de 30 secondes après la victoire est un marquage tardif : le joueur quitte le jeu pendant 30 secondes. Dans tous les cas, le tir lui-même reste sur le plateau (4.9).",
            ),
          ],
        },
        {
          n: "4.6",
          title: tr("When auto-marking fails", "Si le marquage automatique ne fonctionne pas"),
          body: [
            tr(
              "If auto-marking stops working, mark by hand (4.4), or take a pause to fix it (5.4). The overlay shows [!] when your last kill did not land. Kills made while it was down fire on their own once it reconnects, unless you have already clicked them.",
              "Si le marquage automatique cesse de fonctionner, marquez à la main (4.4), ou prenez une pause pour le réparer (5.4). L'overlay affiche [!] quand votre dernière victoire n'a pas été transmise. Les victoires obtenues pendant la panne tirent d'elles-mêmes dès la reconnexion, sauf si vous les avez déjà cliquées.",
            ),
          ],
        },
        {
          n: "4.7",
          title: tr("Fresh character", "Nouveau personnage"),
          body: [
            tr(
              "Start every match on a new character. Auto-marking reads your save, so a save that already holds boss kills fires those squares the moment the match opens.",
              "Commencez chaque match avec un nouveau personnage. Le marquage automatique lit votre sauvegarde : une sauvegarde contenant déjà des boss vaincus tire sur ces cases dès l'ouverture du match.",
            ),
          ],
        },
        {
          n: "4.8",
          title: tr("When a kill counts", "Quand une victoire compte"),
          body: [
            tr(
              `A boss or invader is killed when "Enemy Felled" (or similar) appears on screen. An enemy without victory text is killed when you receive its runes. A duo fight on two squares counts for both when the fight is won.`,
              "Un boss ou un envahisseur est vaincu quand « Ennemi abattu » (ou équivalent) s'affiche à l'écran. Un ennemi sans texte de victoire est vaincu quand vous recevez ses runes. Un combat en duo occupant deux cases compte pour les deux une fois le combat gagné.",
            ),
          ],
        },
        {
          n: "4.9",
          title: tr("Shots are final", "Les tirs sont définitifs"),
          body: [
            tr(
              "A shot cannot be taken back, by you, an opponent or the site. Reloading a save or quitting out never un-fires a square.",
              "Un tir ne peut pas être annulé, ni par vous, ni par un adversaire, ni par le site. Recharger une sauvegarde ou quitter le jeu n'annule jamais un tir.",
            ),
          ],
        },
      ],
    },
    {
      n: 5,
      title: tr("Match flow", "Déroulement d'un match"),
      rules: [
        {
          n: "5.1",
          title: tr("Start time", "Heure de début"),
          body: [
            tr(
              "Matches begin at the agreed time. If you cannot start on time, tell your opponent. A player who does not show up without word gets a 15-minute grace period, then forfeits.",
              "Les matchs commencent à l'heure convenue. Si vous ne pouvez pas commencer à l'heure, prévenez votre adversaire. Un joueur absent sans prévenir dispose de 15 minutes de tolérance, puis perd par forfait.",
            ),
          ],
        },
        {
          n: "5.2",
          title: tr("Prep period", "Préparation"),
          body: [
            tr(
              `Once battle opens there is a ${duration(ctx.rules.prep_seconds, tr)} prep period, then a ${duration(ctx.rules.starting_seconds, tr)} countdown, both shown on the match clock. During prep you may read the board, pick your starting class and keepsake, load into Roundtable Hold, talk to Corhyn, buy things from shops and so on. You may not talk to any NPC to progress a quest (hugging Fia, for example), or leave Roundtable Hold. Breaking this earns a time penalty (6.3).`,
              `À l'ouverture de la bataille, une préparation de ${duration(ctx.rules.prep_seconds, tr)} précède un compte à rebours de ${duration(ctx.rules.starting_seconds, tr)}, tous deux affichés sur l'horloge du match. Pendant la préparation, vous pouvez lire le plateau, choisir votre classe et votre souvenir de départ, vous rendre à la Table Ronde, parler à Frère Corhyn, acheter dans les boutiques, etc. Vous ne pouvez pas parler à un PNJ pour faire avancer une quête (enlacer Fia, par exemple), ni quitter la Table Ronde. Enfreindre cette règle vaut une pénalité de temps (6.3).`,
            ),
          ],
        },
        {
          n: "5.3",
          title: tr("Victory", "Victoire"),
          body: [
            tr(
              "The last fleet afloat wins. There is no time limit: the match runs until one fleet's ships are all sunk.",
              "La dernière flotte à flot l'emporte. Il n'y a pas de limite de temps : le match dure jusqu'à ce que tous les navires d'une flotte soient coulés.",
            ),
          ],
        },
        {
          n: "5.4",
          title: tr("Pauses", "Pauses"),
          body: [
            tr(
              "Any player may press Request pause. With a referee, the referee hosts the official room as a spectator and runs every pause. Without one, the room host must grant every pause request, and both sides keep the pause fair: as short as the problem needs, and never used to plan or rest. The clock stops after a 5-second warning. Shots keep landing during a pause, so you may finish a boss fight already in progress; then stop at a safe point and leave your controller alone. Ready up on the pause screen; play resumes after a 5-second countdown. Taking control before it ends earns a time penalty.",
              "Tout joueur peut appuyer sur Demander une pause. Avec un arbitre, c'est lui qui héberge la partie officielle en tant que spectateur et gère chaque pause. Sans arbitre, l'hôte de la partie doit accepter chaque demande, et les deux camps gardent la pause équitable : aussi courte que le problème l'exige, et jamais utilisée pour planifier ou se reposer. L'horloge s'arrête après un avertissement de 5 secondes. Les tirs continuent d'arriver pendant une pause : vous pouvez donc finir un combat de boss déjà commencé, puis arrêtez-vous en lieu sûr et lâchez la manette. Appuyez sur Se préparer sur l'écran de pause ; le jeu reprend après un compte à rebours de 5 secondes. Reprendre la main avant la fin vaut une pénalité de temps.",
            ),
          ],
        },
        {
          n: "5.5",
          title: tr("Your crash", "Votre crash"),
          body: [
            tr(
              "Fixing it is your first priority, even mid-fight. A simple game crash does not pause the match. A severe PC or stream crash does: tell your referee (or your opponent, with no referee) immediately. Keep a phone or second device handy for this.",
              "Le réparer est votre priorité, même en plein combat. Un simple crash du jeu ne met pas le match en pause. Un crash grave du PC ou du stream, si : prévenez immédiatement votre arbitre (ou votre adversaire, sans arbitre). Gardez un téléphone ou un second appareil à portée de main pour cela.",
            ),
          ],
        },
        {
          n: "5.6",
          title: tr("Opponent's crash", "Crash de l'adversaire"),
          body: [
            tr(
              "You will get some advantage from it; you are asked to limit it. When the referee asks, reach a safe point and stop playing until the pause ends.",
              "Vous en tirerez un certain avantage ; il vous est demandé de le limiter. Quand l'arbitre le demande, rejoignez un lieu sûr et arrêtez de jouer jusqu'à la fin de la pause.",
            ),
          ],
        },
        {
          n: "5.7",
          title: tr("Site problems", "Problèmes du site"),
          body: [
            tr(
              "If the board stops updating or will not load, refresh the page, then rejoin with your rejoin code. Shots live on the server, so nothing fired is lost. If it persists, tell your referee, who may pause the match while it is fixed.",
              "Si le plateau ne se met plus à jour ou ne charge pas, actualisez la page, puis revenez avec votre code de reconnexion. Les tirs sont stockés sur le serveur : aucun tir n'est perdu. Si le problème persiste, prévenez votre arbitre, qui peut mettre le match en pause le temps de le régler.",
            ),
          ],
        },
        {
          n: "5.8",
          title: tr("Game glitches", "Bugs du jeu"),
          body: [
            tr(
              "Never glitch the game on purpose. If an accidental glitch can be undone (wrong warp, Torrent hover, item duplication, zipping), undo it immediately. If it cannot (an enemy falling off a cliff, frozen AI), carry on. A glitch that stops you playing (a grace you cannot touch, an area that will not load) warrants a restart of the game and, if that fails, a pause. Referees review every glitch.",
              "N'exploitez jamais un bug volontairement. Si un bug accidentel peut être annulé (wrong warp, Torrent en lévitation, duplication d'objet, zip), annulez-le immédiatement. S'il ne le peut pas (un ennemi qui tombe d'une falaise, une IA figée), continuez. Un bug qui vous empêche de jouer (une grâce inaccessible, une zone qui ne charge pas) justifie un redémarrage du jeu et, si cela échoue, une pause. Les arbitres examinent chaque bug.",
            ),
          ],
        },
      ],
    },
    {
      n: 6,
      title: tr("Referees, penalties and liability", "Arbitres, pénalités et responsabilité"),
      rules: [
        {
          n: "6.1",
          title: tr("Voice channels", "Salons vocaux"),
          body: [
            tr(
              "Streamed matches run in a temporary Discord with channels for commentary, each fleet, and the referees. Join the commentary channel at the start; once the organizers confirm everyone is ready, move to your fleet's channel. You may mute but never deafen. After the match you may be invited to an interview; it is encouraged, not required.",
              "Les matchs diffusés se déroulent sur un Discord temporaire avec des salons pour les commentateurs, chaque flotte et les arbitres. Rejoignez le salon des commentateurs au début ; une fois que les organisateurs confirment que tout le monde est prêt, passez dans le salon de votre flotte. Vous pouvez couper votre micro, mais jamais votre son. Après le match, vous pourrez être invité à une interview ; elle est encouragée, pas obligatoire.",
            ),
          ],
        },
        {
          n: "6.2",
          title: tr("Referee instructions", "Consignes de l'arbitre"),
          body: [
            solo
              ? tr(
                  "During a match, only your referee should contact you. Referee instructions are binding. Refusing them can mean a penalty or disqualification.",
                  "Pendant un match, seul votre arbitre doit vous contacter. Ses consignes s'imposent. Les refuser peut entraîner une pénalité ou une disqualification.",
                )
              : tr(
                  "During a match, only your referee and your crew should contact you. Referee instructions are binding. Refusing them can mean a penalty or disqualification.",
                  "Pendant un match, seuls votre arbitre et votre équipage doivent vous contacter. Les consignes de l'arbitre s'imposent. Les refuser peut entraîner une pénalité ou une disqualification.",
                ),
          ],
        },
        {
          n: "6.3",
          title: tr("Time penalty", "Pénalité de temps"),
          body: [
            tr(
              "You quit out of the game for roughly double the time you gained. Reasons include taking control before the clock, refusing to stop when asked, and resuming a paused match early.",
              "Vous quittez le jeu pendant environ le double du temps gagné. Motifs possibles : prendre la main avant l'horloge, refuser de s'arrêter quand on vous le demande, reprendre trop tôt un match en pause.",
            ),
          ],
        },
        {
          n: "6.4",
          title: tr("Position penalty", "Pénalité de position"),
          body: [
            tr(
              "You use a Memory of Grace immediately. Reasons include an illegal skip, an illegal cheese and deliberate glitching.",
              "Vous utilisez immédiatement un Souvenir de grâce (Memory of Grace). Motifs possibles : un skip interdit, un cheese interdit, l'exploitation volontaire d'un bug.",
            ),
          ],
        },
        {
          n: "6.5",
          title: tr("Illegal shots", "Tirs illégaux"),
          body: [
            tr(
              "A shot cannot be taken back (4.9), so a shot from a kill that does not count stands on the board. The referee offsets it with a time penalty. If the illegal shot sank a ship or decided the match, the organizers may award the match to the opponent.",
              "Un tir ne peut pas être annulé (4.9) : un tir issu d'une victoire qui ne compte pas reste donc sur le plateau. L'arbitre le compense par une pénalité de temps. Si ce tir a coulé un navire ou décidé du match, les organisateurs peuvent attribuer la victoire à l'adversaire.",
            ),
          ],
        },
        {
          n: "6.6",
          title: tr("Disputes", "Litiges"),
          body: [
            tr(
              "Raise disputes with your referee during the match, or the organizers after it. The organizers' ruling is final.",
              "Signalez un litige à votre arbitre pendant le match, ou aux organisateurs après. La décision des organisateurs est définitive.",
            ),
          ],
        },
        {
          n: "6.7",
          title: tr("Liability", "Responsabilité"),
          body: [
            tr(
              `The mods, site and tools used by ${name} are third-party, and you use them at your own risk. Neither ${name}, its organizers nor any community member is liable for damage from their use. By competing, you allow your gameplay to be rebroadcast, commentated and redistributed. Neither ${name}, its organizers, commentators, referees nor community members are liable for statements made about your gameplay or its rebroadcast.`,
              `Les mods, le site et les outils utilisés par ${name} sont des outils tiers, que vous utilisez à vos risques. Ni ${name}, ni ses organisateurs, ni aucun membre de la communauté ne sont responsables des dommages liés à leur utilisation. En participant, vous acceptez que vos parties soient rediffusées, commentées et redistribuées. Ni ${name}, ni ses organisateurs, commentateurs, arbitres ou membres de la communauté ne sont responsables des propos tenus sur vos parties ou leur rediffusion.`,
            ),
          ],
        },
      ],
    },
  ];
}
