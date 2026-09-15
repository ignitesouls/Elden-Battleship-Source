import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { createScene, SQUASH, SWIRL, type PropKind, type Scene } from "../lib/fleetDrawScene";
import { rigShape } from "../lib/fleetDrawRigs";
import {
  MAX_TEAMS,
  MIN_TEAMS,
  DRAW_TEAM_COLORS,
  DRAW_VERSION,
  estimateDrawMs,
  isDrawMessage,
  isStaleDrawMessage,
  newSeed,
  planDraw,
  type DrawMessage,
  type DrawPlan,
} from "../lib/fleetDraw";
import { playSfx } from "../lib/sfx";
import { teamHex, teamName } from "../lib/teamColors";
import { useT } from "../lib/language";
import type { Player } from "../types/battleship";
import "./FleetDraw.css";

interface Props {
  roomId: string;
  players: Player[];
  isHost: boolean;
  open: boolean;
  /**
   * Called with true when a draw arrives for somebody who had not opened
   * anything, and with false when the viewer closes it. The host opens their
   * own; everyone else is opened BY the draw, so nobody gets a modal thrown
   * over their lobby until there is actually something to watch.
   */
  onOpenChange: (open: boolean) => void;
}

/** A ship plus her nameplate is about this tall; berths are spaced by it. */
const ROW_PX = 98;
const ROW_PX_BIG = 140;
const SHIP_PX = 62;
const SHIP_PX_BIG = 92;

/** A berth is a hull with a name under it, so half again wider than tall. */
const BERTH_ASPECT = 1.5;
const RAGGED_COST = 0.18;
const MAX_FILES = 4;

type Mode = "wander" | "descend" | "under" | "fling" | "moored";

/**
 * What washes up in a bottle. Nothing here is a hint; they are all jokes.
 *
 * Each entry is an [en, fr] pair rather than a plain string, since this list lives outside the
 * component and has no hook to call t() with - the pair is picked apart at the call site instead,
 * where t() is in scope.
 */
const BOTTLE_NOTES: [string, string][] = [
  ["Try finger, but hole.", "Essaie doigt, mais trou."],
  ["Praise the message, ye who read.", "Loué soit le message, ô lecteur."],
  ["Behold, dog!", "Admirez, chien !"],
  ["Time for crab.", "L'heure du crabe."],
  ["Seek stronger foes elsewhere.", "Cherchez des ennemis plus forts ailleurs."],
  ["Message from a drowned crew: still no land.", "Message d'un équipage noyé : toujours pas de terre en vue."],
  ["I was here. It was wet.", "J'étais ici. C'était mouillé."],
  ["Turn back. The tentacles are worse further out.", "Faites demi-tour. Les tentacules empirent plus loin."],
  ["Whoever finds this owes me a rematch.", "Quiconque trouve ceci me doit une revanche."],
  ["No shot is wasted if you learn from it.", "Aucun tir n'est perdu si on en tire une leçon."],
  ["Visions of grace, but mostly fog.", "Visions de grâce, mais surtout du brouillard."],
  ["Fort, night.", "Fort, la nuit."],
];

interface Ship {
  name: string;
  team: number;
  hull: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  mode: Mode;
  target: { x: number; y: number };
  berth: { x: number; y: number } | null;
  anchor: { x: number; y: number } | null;
  wanderSeed: number;
  /** Seconds spent in the current scripted mode. */
  t: number;
  /** Where on the funnel she was caught, in the eye's own polar frame. */
  a0: number;
  r0: number;
  /** Control point for the arc back out. */
  cp: { x: number; y: number };
  /** How far over she is leaning, and how small the funnel has made her. */
  tilt: number;
  scale: number;
  alpha: number;
  plate: number;
}

/**
 * The team randomiser, run in the lobby.
 *
 * The host draws; everyone watches the same draw. What travels is a seed and
 * the roster it was drawn against - see lib/fleetDraw for why that is enough,
 * and why the choreography is shared while the layout is not.
 *
 * Nothing here writes to the database. The draw is a thing the room WATCHES,
 * and the teams are still picked by hand afterwards, so a re-roll costs
 * nothing and an accidental press costs nothing either.
 */
export function FleetDraw({ roomId, players, isHost, open, onOpenChange }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shipRefs = useRef<(HTMLDivElement | null)[]>([]);

  /**
   * Which draw has already had its fanfare.
   *
   * Held as the draw object itself rather than a boolean, because the
   * animation effect re-runs whenever the viewer resizes or goes full screen -
   * which rebuilds the fleet, moors everybody instantly if the draw has
   * already finished, and would otherwise sound the fanfare a second time for
   * a result the room heard minutes ago.
   */
  const cheeredFor = useRef<unknown>(null);

  /** Live scene, so the click handler can ask it what is under the pointer. */
  const sceneRef = useRef<Scene | null>(null);

  const roster = useMemo(() => players.map((p) => p.nickname), [players]);

  const [benched, setBenched] = useState<Record<string, boolean>>({});
  const [teams, setTeams] = useState(2);
  const [presenting, setPresenting] = useState(false);
  const [draw, setDraw] = useState<{ plan: DrawPlan; names: string[]; startedAt: number } | null>(null);
  const t = useT();
  const [status, setStatus] = useState(
    isHost ? t("Pick your teams, then draw.", "Choisissez vos équipes, puis tirez.") : t("Waiting for the host to draw.", "En attente du tirage de l'hôte."),
  );

  const sailing = useMemo(() => roster.filter((n) => !benched[n]), [roster, benched]);

  /* ---- the wire ---------------------------------------------------------- */

  /**
   * Its own channel rather than the room's.
   *
   * A draw is ephemeral - there is no row to write and nothing to catch up on
   * once it has finished - so it has no business on the channel that carries
   * the match. It also means this component can be opened and closed without
   * touching useRoom's subscriptions at all.
   */
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const applyMessage = useCallback(
    (m: DrawMessage) => {
      setDraw({ plan: planDraw(m.seed, m.names.length, m.teams), names: m.names, startedAt: performance.now() });
      setTeams(m.teams);
      setStatus(t("The sea opens amidships.", "La mer s'ouvre en son centre."));
      onOpenChange(true);
      // The horn the room already knows as "something is about to happen" -
      // it opens the firing phase, and this is the same kind of moment.
      playSfx("prepare");
    },
    [onOpenChange, t],
  );

  useEffect(() => {
    const ch = supabase
      .channel(`fleet-draw-${roomId}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "draw" }, ({ payload }) => {
        if (isDrawMessage(payload)) applyMessage(payload);
        // A real draw from a build that tells it differently. Replaying it
        // here would show the right teams to the wrong picture, so say what
        // is wrong instead - a reload is the whole fix, this being a static
        // site with no state to migrate.
        else if (isStaleDrawMessage(payload)) {
          setStatus(
            t(
              "That draw came from a different version. Both of you reload the page.",
              "Ce tirage vient d'une version différente. Rechargez la page tous les deux.",
            ),
          );
        }
      })
      .subscribe();
    channelRef.current = ch;
    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [roomId, applyMessage, t]);

  const startDraw = useCallback(() => {
    if (!isHost || sailing.length < 2 || sailing.length < teams) return;
    const message: DrawMessage = {
      v: DRAW_VERSION,
      seed: newSeed(),
      teams,
      names: sailing,
      startedAt: Date.now(),
    };
    void channelRef.current?.send({ type: "broadcast", event: "draw", payload: message });
    applyMessage(message);
  }, [isHost, sailing, teams, applyMessage]);

  const reset = useCallback(() => {
    setDraw(null);
    setStatus(isHost ? t("Back in open water.", "De retour en pleine mer.") : t("Waiting for the host to draw.", "En attente du tirage de l'hôte."));
  }, [isHost, t]);

  /* ---- things you can poke ----------------------------------------------- */

  const [bubbles, setBubbles] = useState<{ id: number; x: number; y: number; text: string; tone: string }[]>([]);
  const bubbleId = useRef(0);

  const say = useCallback((x: number, y: number, text: string, tone: string) => {
    const id = ++bubbleId.current;
    setBubbles((b) => [...b, { id, x, y, text, tone }]);
    window.setTimeout(() => setBubbles((b) => b.filter((n) => n.id !== id)), 3200);
  }, []);

  const onStageClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const scene = sceneRef.current;
      const host = stageRef.current;
      if (scene === null || host === null) return;
      const r = host.getBoundingClientRect();
      const hit = scene.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit === null) return;

      const react: Record<PropKind, () => void> = {
        bottle: () => {
          playSfx("bottle");
          const [en, fr] = BOTTLE_NOTES[bubbleId.current % BOTTLE_NOTES.length];
          say(hit.x, hit.y - 34, t(en, fr), "note");
        },
        tentacle: () => playSfx("tentacle"),
        // No cue of his own, and he does not get to borrow one - the joke is
        // that something enormous surfaces and it is only him.
        patches: () => say(hit.x, hit.y - 40, t("SORRY!", "DÉSOLÉ !"), "shout"),
        dutchman: () => {
          playSfx("dutchman");
          say(hit.x, hit.y - 66, t("A sail, and nothing under it", "Une voile, et rien dessous."), "ghost");
        },
      };
      react[hit.kind]();
    },
    [say, t],
  );

  /* ---- full screen ------------------------------------------------------- */

  const togglePresent = useCallback(() => {
    setPresenting((was) => {
      const on = !was;
      try {
        if (on) void document.documentElement.requestFullscreen?.()?.catch(() => {});
        else if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});
      } catch {
        // The browser's own fullscreen is a bonus; the CSS mode stands alone.
      }
      return on;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (presenting) setPresenting(false);
      else onOpenChange(false);
    };
    const onFs = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [presenting, onOpenChange]);

  /* ---- the fleet --------------------------------------------------------- */

  /**
   * Memoised on identity, not just value. The animation effect keys on this,
   * and a fresh array every render would tear the fleet down and rebuild it
   * mid-draw - ships snapping back to their starting positions every time any
   * unrelated state changed.
   *
   * Once a draw is running its own roster wins, so somebody joining the lobby
   * cannot add a ship to a draw already under way.
   */
  const names = useMemo(() => draw?.names ?? sailing, [draw, sailing]);

  useEffect(() => {
    shipRefs.current = shipRefs.current.slice(0, names.length);
  }, [names.length]);

  useEffect(() => {
    if (!open) return;
    const host = stageRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;

    const scene = createScene(canvas, host);
    sceneRef.current = scene;
    scene.setPresenting(presenting);
    scene.resize();

    const shipPx = presenting ? SHIP_PX_BIG : SHIP_PX;
    const rowPx = presenting ? ROW_PX_BIG : ROW_PX;
    const sep = presenting ? 300 : 215;
    const speedScale = presenting ? 1.35 : 1;

    // A private generator per ship for wandering, so a ship that is only
    // milling about does not have to agree with anybody - only the parts the
    // draw decides are shared.
    const rand = (s: number) => {
      let a = s >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    let geom = { w: 0, h: 0, top: 0, bottom: 0, left: 0, right: 0 };
    const measure = () => {
      const r = host.getBoundingClientRect();
      const inset = shipPx * 1.15;
      geom = {
        w: r.width,
        h: r.height,
        top: scene.horizon() + shipPx * 0.75,
        bottom: r.height - shipPx * 0.75,
        left: inset,
        right: r.width - inset,
      };
    };
    measure();

    /**
     * A ship the funnel has already taken by the time the fleet is built.
     *
     * This effect re-runs on every resize and on going full screen, which
     * rebuilds every ship from scratch. Replaying the descent from there
     * would drop the whole fleet back down a funnel the room watched minutes
     * ago - and all at once, since they are all past their pullAt. She is put
     * straight in her berth instead, the same way the old script put a ship
     * past her commit straight onto her side.
     */
    const alreadyTaken = (plan: DrawPlan["ships"][number] | undefined): boolean =>
      draw !== null && plan !== undefined && performance.now() - draw.startedAt >= plan.pullAt;

    const ships: Ship[] = names.map((name, i) => {
      const plan = draw?.plan.ships[i];
      const rng = rand(((plan?.pullAt ?? i * 7919) * 1000) | 0);
      const sx = plan ? plan.start.x : rng();
      const sy = plan ? plan.start.y : rng();
      return {
        name,
        team: plan?.team ?? 0,
        hull: plan?.hull ?? i % 5,
        x: geom.left + sx * (geom.right - geom.left),
        y: geom.top + sy * (geom.bottom - geom.top),
        vx: 0,
        vy: 0,
        face: plan?.face ?? 1,
        mode: alreadyTaken(plan) ? "moored" : "wander",
        target: { x: 0, y: 0 },
        berth: null,
        anchor: null,
        wanderSeed: (i * 2654435761) >>> 0,
        t: 0,
        a0: 0,
        r0: 0,
        cp: { x: 0, y: 0 },
        tilt: 0,
        scale: 1,
        alpha: 1,
        plate: 1,
      };
    });

    const wanderers = ships.map((s) => rand(s.wanderSeed));
    const pickWander = (s: Ship, i: number) => {
      const r = wanderers[i];
      s.target = {
        x: geom.left + r() * (geom.right - geom.left),
        y: geom.top + r() * (geom.bottom - geom.top),
      };
    };
    ships.forEach(pickWander);

    /**
     * Berths for one team. Vertical fit is the floor; below it the side runs
     * off the water. Above it the zone's SHAPE decides, scored on how far the
     * cells land from BERTH_ASPECT plus a cost per empty berth in the last
     * row - otherwise a tall projector puts every fleet in one long queue.
     */
    const berthsFor = (teamIdx: number, count: number): { x: number; y: number }[] => {
      const zoneW = geom.w / teams;
      const zx0 = zoneW * teamIdx;
      const padX = 14;
      // Clear of the funnel: berths are in the near half of the water, which
      // is where a nameplate is readable anyway.
      const vor = scene.vortex();
      const top = Math.max(
        presenting ? 118 : 88,
        scene.horizon() + shipPx * 0.6,
        vor.cy + vor.r * SQUASH + shipPx * 0.45,
      );
      const bot = geom.h - shipPx * 0.6;
      const span = bot - top;
      const innerW = zoneW - padX * 2;

      let need = 1;
      while (need < MAX_FILES && Math.ceil(count / need) * rowPx > span) need++;
      const afford = Math.max(1, Math.floor(innerW / (152 * 1.15)));
      const most = Math.min(MAX_FILES, afford, count);

      let files = need;
      let best = Infinity;
      for (let c = need; c <= most; c++) {
        const cRows = Math.ceil(count / c);
        const cellH = Math.min(rowPx + 10, (span - (c > 1 ? rowPx * 0.5 : 0)) / cRows);
        const score = Math.abs(Math.log(innerW / c / cellH / BERTH_ASPECT)) + (cRows * c - count) * RAGGED_COST;
        if (score < best) {
          best = score;
          files = c;
        }
      }

      const rows = Math.ceil(count / files);
      const stagger = files > 1;
      const usable = span - (stagger ? rowPx * 0.5 : 0);
      const rowH = Math.min(rowPx + 10, usable / rows);
      const fileW = innerW / files;
      const startY = top + (usable - rowH * rows) / 2;

      const out: { x: number; y: number }[] = [];
      for (let i = 0; i < count; i++) {
        const f = i % files;
        const row = Math.floor(i / files);
        out.push({
          x: zx0 + padX + fileW * (f + 0.5),
          y: startY + rowH * (row + 0.5) + (stagger && f % 2 === 1 ? rowH * 0.5 : 0),
        });
      }
      return out;
    };

    const assignBerths = () => {
      if (draw === null) return;
      const totals = new Array(teams).fill(0);
      for (const s of draw.plan.ships) totals[s.team]++;
      const byTeam = totals.map((n, t) => berthsFor(t, n));
      const used = new Array(teams).fill(0);
      ships.forEach((s, i) => {
        const p = draw.plan.ships[i];
        const slot = byTeam[p.team][used[p.team]++];
        s.berth = {
          x: slot.x + p.berthJitter.x * geom.w,
          y: slot.y + p.berthJitter.y * geom.h,
        };
        if (s.mode === "moored") {
          s.anchor = { ...s.berth };
          s.x = s.berth.x;
          s.y = s.berth.y;
        }
        // A ship the funnel currently holds needs nothing here: she is flown
        // from the eye to wherever her berth has just moved to, and reads the
        // new one on the frame she lands.
      });
    };
    assignBerths();

    let raf = 0;
    let last = 0;

    const step = (ms: number) => {
      const dt = last === 0 ? 0.016 : Math.min((ms - last) / 1000, 0.05);
      last = ms;

      // The funnel is open for exactly as long as it has work to do: from the
      // moment the draw lands until the last hull is in her berth.
      const settled = draw !== null && ships.every((s) => s.mode === "moored");
      scene.setVortex(draw !== null && !settled ? 1 : 0);

      scene.draw(ms);

      const elapsed = draw === null ? -1 : ms - draw.startedAt;

      for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        const plan = draw?.plan.ships[i];
        // Set once the funnel is flying her, so the steering below leaves her
        // alone - but she still reaches the node write at the bottom.
        let scripted = false;

        /**
         * The maelstrom, in four scripted beats.
         *
         * All four are driven off the plan's own clock rather than off where
         * the ship has got to, so every viewer sees the same ship taken at
         * the same moment even though she is crossing a different number of
         * pixels to get there.
         */
        if (plan !== undefined && elapsed >= 0 && s.mode !== "moored") {
          const vor = scene.vortex();

          if (s.mode === "wander" && elapsed >= plan.pullAt) {
            // Caught. Remember where on the funnel she was, in the eye's own
            // frame, and spiral in from exactly there.
            const dx0 = s.x - vor.cx;
            const dy0 = (s.y - vor.cy) / SQUASH;
            s.a0 = Math.atan2(dy0, dx0);
            s.r0 = Math.max(Math.hypot(dx0, dy0), vor.r * 0.35);
            s.mode = "descend";
            s.t = 0;
            s.plate = 0;
          }

          if (s.mode === "descend") {
            s.t += dt;
            const u = Math.min(1, s.t / (plan.descentMs / 1000));
            // Radius falls away faster than linearly and the turn accelerates
            // as it tightens, which is what a funnel does to anything in it.
            const rr = s.r0 * (1 - u * u);
            const ang = s.a0 + SWIRL * plan.turns * Math.PI * 2 * Math.pow(u, 1.45);
            s.x = vor.cx + Math.cos(ang) * rr;
            s.y = vor.cy + Math.sin(ang) * rr * SQUASH;
            s.vx = 0;
            s.vy = 0;
            s.scale = 1 - 0.78 * Math.pow(u, 1.2);
            s.tilt = SWIRL * -46 * Math.pow(u, 1.3);
            s.alpha = u < 0.72 ? 1 : 1 - (u - 0.72) / 0.28;
            s.face = Math.cos(ang + SWIRL * (Math.PI / 2)) >= 0 ? 1 : -1;
            if (u >= 1) {
              s.mode = "under";
              s.t = 0;
              s.alpha = 0;
            }
            scripted = true;
          } else if (s.mode === "under") {
            s.t += dt;
            if (s.t >= plan.underMs / 1000) {
              const b = s.berth ?? { x: vor.cx, y: geom.bottom };
              // Up and over, then down into the berth - a real arc rather
              // than a slide, so being thrown reads as being thrown.
              s.cp = {
                x: vor.cx + (b.x - vor.cx) * 0.55,
                y: Math.min(vor.cy, b.y) - Math.max(70, Math.abs(b.x - vor.cx) * 0.34),
              };
              s.mode = "fling";
              s.t = 0;
              s.face = b.x >= vor.cx ? 1 : -1;
            }
            scripted = true;
          } else if (s.mode === "fling" && s.berth !== null) {
            s.t += dt;
            const u = Math.min(1, s.t / (plan.flingMs / 1000));
            const k = 1 - Math.pow(1 - u, 2.2);
            const v = 1 - k;
            s.x = v * v * vor.cx + 2 * v * k * s.cp.x + k * k * s.berth.x;
            s.y = v * v * vor.cy + 2 * v * k * s.cp.y + k * k * s.berth.y;
            s.scale = 0.2 + 0.8 * Math.min(1, k * 1.5) + Math.sin(Math.PI * k) * 0.1;
            s.alpha = Math.min(1, k * 4);
            s.tilt = SWIRL * 34 * (1 - k);
            s.plate = k > 0.7 ? (k - 0.7) / 0.3 : 0;
            if (u >= 1) {
              s.mode = "moored";
              s.anchor = { ...s.berth };
              s.x = s.berth.x;
              s.y = s.berth.y;
              s.vx = 0;
              s.vy = 0;
              s.scale = 1;
              s.tilt = 0;
              s.alpha = 1;
              s.plate = 1;
            }
            scripted = true;
          }
        }

        if (s.mode === "moored" && s.anchor !== null && plan !== undefined) {
          // She keeps station rather than stopping: a slow private circle, so
          // the side reads as a fleet riding at anchor instead of a list.
          const ph = ms / 1000;
          s.target = {
            x: s.anchor.x + Math.cos(ph * plan.orbit.speed + plan.orbit.phase) * plan.orbit.rx,
            y: s.anchor.y + Math.sin(ph * plan.orbit.speed * 0.78 + plan.orbit.phase * 1.4) * plan.orbit.ry,
          };
        }

        if (!scripted) {
          const speed = (s.mode === "moored" ? 16 : 24) * speedScale;

          const dx = s.target.x - s.x;
          const dy = s.target.y - s.y;
          const dist = Math.hypot(dx, dy) || 1;

          if (s.mode === "wander" && dist < 18) pickWander(s, i);

          const turn = s.mode === "moored" ? 0.5 : 0.8;
          s.vx += ((dx / dist) * speed - s.vx) * Math.min(1, turn * dt);
          s.vy += ((dy / dist) * speed - s.vy) * Math.min(1, turn * dt);

          // Keep wandering ships out of each other's nameplates.
          if (s.mode === "wander") {
            for (let j = 0; j < ships.length; j++) {
              if (j === i || ships[j].mode !== "wander") continue;
              const ox = s.x - ships[j].x;
              const oy = s.y - ships[j].y;
              const d2 = ox * ox + oy * oy;
              if (d2 > 1 && d2 < sep * sep) {
                const d1 = Math.sqrt(d2);
                const push = (sep - d1) * 0.75;
                s.vx += (ox / d1) * push * dt;
                s.vy += (oy / d1) * push * dt * 1.15;
              }
            }
          }

          // Everything still on the water leans toward an open funnel. Not
          // enough to drag her in - the plan decides who goes and when - just
          // enough that the ships waiting their turn are visibly in trouble.
          if (s.mode === "wander" && draw !== null) {
            const vor = scene.vortex();
            const px = vor.cx - s.x;
            const py = (vor.cy - s.y) / SQUASH;
            const pd = Math.max(Math.hypot(px, py), vor.r * 0.8);
            const pull = 1800 / pd;
            s.vx += ((px / pd) * pull + (-py / pd) * pull * 0.85 * SWIRL) * dt;
            s.vy += ((py / pd) * pull + (px / pd) * pull * 0.85 * SWIRL) * dt * SQUASH;
          }

          s.x += s.vx * dt;
          s.y += s.vy * dt;

          // Only ships out looking are penned in. A berth can sit outside the
          // wander box, and clamping would strand a ship just short of it.
          if (s.mode === "wander") {
            if (s.x < geom.left) { s.x = geom.left; s.vx = Math.abs(s.vx); }
            if (s.x > geom.right) { s.x = geom.right; s.vx = -Math.abs(s.vx); }
            if (s.y < geom.top) { s.y = geom.top; s.vy = Math.abs(s.vy); }
            if (s.y > geom.bottom) { s.y = geom.bottom; s.vy = -Math.abs(s.vy); }
          }

          if (s.mode !== "moored") {
            if (s.vx > 6) s.face = 1;
            else if (s.vx < -6) s.face = -1;
          }
        }

        const node = shipRefs.current[i];
        if (node) {
          node.style.transform = `translate(calc(${s.x.toFixed(1)}px - 50%), calc(${s.y.toFixed(1)}px - 50%))`;
          // Anything the funnel has hold of goes UNDER the ships still on the
          // water, whatever its y says - it is below the surface.
          node.style.zIndex = String(s.scale < 1 ? 0 : Math.round(s.y));
          node.dataset.face = String(s.face);
          node.style.opacity = s.alpha.toFixed(3);
          // Lean and size go on their own node: .fd-bob owns a keyframe
          // animation and a second transform here would cancel it.
          const spin = node.firstElementChild as HTMLElement | null;
          if (spin !== null) {
            spin.style.transform = `rotate(${s.tilt.toFixed(2)}deg) scale(${s.scale.toFixed(3)})`;
          }
          node.style.setProperty("--plate", s.plate.toFixed(2));
          if (s.mode === "moored") {
            node.dataset.moored = "1";
            node.style.setProperty("--sail", teamHex(DRAW_TEAM_COLORS[s.team]));
          }
        }
      }

      // The last hull to moor ends the draw. Announced from the frame loop
      // rather than on a timer, because the drift window says when ships are
      // RELEASED, not when they arrive - a ship let go at the very end of it
      // is still crossing the water for a second or two afterwards.
      if (draw !== null && cheeredFor.current !== draw && ships.every((s) => s.mode === "moored")) {
        cheeredFor.current = draw;
        setStatus(t("Teams set.", "Équipes définies."));
        playSfx("victory");
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const onResize = () => {
      scene.resize();
      measure();
      assignBerths();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      sceneRef.current = null;
    };
  }, [names, draw, teams, presenting, open, t]);

  /* ---- chrome ------------------------------------------------------------ */

  const canDraw = isHost && sailing.length >= 2 && sailing.length >= teams;

  // Mounted for everyone in the lobby, rendered only once there is something
  // to see. The subscription above runs either way - that is what lets a draw
  // open this for the people who did not press anything.
  if (!open) return null;

  return (
    <div className={`fd-modal${presenting ? " presenting" : ""}`} role="dialog" aria-label={t("Fleet draw", "Tirage des flottes")}>
      <div className="fd-stage" ref={stageRef} onClick={onStageClick}>
        <canvas ref={canvasRef} className="fd-sea" />

        {bubbles.map((b) => (
          <div key={b.id} className={`fd-bubble ${b.tone}`} style={{ left: b.x, top: b.y }}>
            {b.text}
          </div>
        ))}

        {draw !== null && (
          <div className="fd-zones">
            {Array.from({ length: teams }, (_, i) => (
              <div
                key={i}
                className="fd-zone"
                style={{ left: `${(100 / teams) * i}%`, width: `${100 / teams}%` }}
              >
                <span className="fd-zone-rule" style={{ background: teamHex(DRAW_TEAM_COLORS[i]) }} />
              </div>
            ))}
          </div>
        )}

        {names.map((name, i) => {
          const shape = rigShape(draw?.plan.ships[i]?.hull ?? i);
          return (
            <div
              className="fd-ship"
              key={`${name}-${i}`}
              ref={(el) => {
                shipRefs.current[i] = el;
              }}
            >
              <div className="fd-spin">
                <div className="fd-bob" style={{ animationDelay: `-${(i * 0.41).toFixed(2)}s` }}>
                  <div className="fd-hullwrap">
                    <svg viewBox={shape.viewBox} aria-hidden="true">
                      {shape.parts.map((p, k) => (
                        <path key={k} className={`fd-${p.cls}`} d={p.d} />
                      ))}
                    </svg>
                  </div>
                  <div className="fd-plate" title={name}>{name}</div>
                </div>
              </div>
            </div>
          );
        })}

        <div className="fd-bar" onClick={(e) => e.stopPropagation()}>
          {isHost ? (
            <>
              <button className="fd-act" onClick={startDraw} disabled={!canDraw}>
                {draw === null ? t("Draw teams", "Tirer les équipes") : t("Draw again", "Tirer à nouveau")}
              </button>
              <button className="fd-act ghost" onClick={reset} disabled={draw === null}>
                {t("Open water", "Pleine mer")}
              </button>
            </>
          ) : (
            <span className="fd-status">{status}</span>
          )}
          <button className="fd-act ghost" onClick={togglePresent}>
            {presenting ? t("Exit full screen", "Quitter le plein écran") : t("Full screen", "Plein écran")}
          </button>
          <button className="fd-act ghost" onClick={() => onOpenChange(false)}>{t("Close", "Fermer")}</button>
        </div>
      </div>

      {isHost && !presenting && (
        <div className="fd-controls">
          <div className="fd-field">
            <span className="fd-label">{t("Teams", "Équipes")}</span>
            <div className="fd-seg" role="group" aria-label={t("Number of teams", "Nombre d'équipes")}>
              {Array.from({ length: MAX_TEAMS - MIN_TEAMS + 1 }, (_, i) => i + MIN_TEAMS).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={t === teams}
                  disabled={t > sailing.length}
                  onClick={() => { setTeams(t); setDraw(null); }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="fd-field fd-grow">
            <span className="fd-label">
              {t("Who sails — click to bench", "Qui navigue — cliquez pour mettre sur la touche")} ({sailing.length} {t("sailing", "en mer")})
            </span>
            <div className="fd-chips">
              {roster.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="fd-chip"
                  aria-pressed={!benched[n]}
                  onClick={() => {
                    setBenched((b) => ({ ...b, [n]: !b[n] }));
                    setDraw(null);
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <p className="fd-note">
            {draw === null
              ? `${t(
                  "Drawn teams are shown here only — nobody is moved. Read them out and let the room pick. Takes about",
                  "Les équipes tirées sont affichées ici seulement — personne n'est déplacé. Annoncez-les et laissez la table choisir. Environ",
                )} ${Math.round(estimateDrawMs(sailing.length) / 1000)}s.`
              : `${t("Standing draw:", "Tirage en cours :")} ${Array.from({ length: teams }, (_, ti) =>
                  `${teamName(DRAW_TEAM_COLORS[ti])} ${draw.plan.assignment.filter((a) => a === ti).length}`,
                ).join(" · ")}`}
          </p>
        </div>
      )}
    </div>
  );
}
