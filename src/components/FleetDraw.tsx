import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { createScene, type PropKind, type Scene } from "../lib/fleetDrawScene";
import { rigShape } from "../lib/fleetDrawRigs";
import {
  DRIFT_MS,
  MAX_TEAMS,
  MIN_TEAMS,
  isDrawMessage,
  newSeed,
  planDraw,
  type DrawMessage,
  type DrawPlan,
} from "../lib/fleetDraw";
import { playSfx } from "../lib/sfx";
import { teamHex, teamName } from "../lib/teamColors";
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

type Mode = "wander" | "feint" | "commit" | "moored";

/** What washes up in a bottle. Nothing here is a hint; they are all jokes. */
const BOTTLE_NOTES = [
  "Try finger, but hole.",
  "Praise the message, ye who read.",
  "Behold, dog!",
  "Time for crab.",
  "Seek stronger foes elsewhere.",
  "Message from a drowned crew: still no land.",
  "I was here. It was wet.",
  "Turn back. The tentacles are worse further out.",
  "Whoever finds this owes me a rematch.",
  "No shot is wasted if you learn from it.",
  "Visions of grace, but mostly fog.",
  "Fort, night.",
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
  feintAt: number;
  nextFeint: number;
  wanderSeed: number;
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
  const [status, setStatus] = useState(isHost ? "Pick your teams, then draw." : "Waiting for the host to draw.");

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
      setStatus("Drawn. Watch them find their side.");
      onOpenChange(true);
      // The horn the room already knows as "something is about to happen" -
      // it opens the firing phase, and this is the same kind of moment.
      playSfx("prepare");
    },
    [onOpenChange],
  );

  useEffect(() => {
    const ch = supabase
      .channel(`fleet-draw-${roomId}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "draw" }, ({ payload }) => {
        if (isDrawMessage(payload)) applyMessage(payload);
      })
      .subscribe();
    channelRef.current = ch;
    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [roomId, applyMessage]);

  const startDraw = useCallback(() => {
    if (!isHost || sailing.length < 2 || sailing.length < teams) return;
    const message: DrawMessage = { seed: newSeed(), teams, names: sailing, startedAt: Date.now() };
    void channelRef.current?.send({ type: "broadcast", event: "draw", payload: message });
    applyMessage(message);
  }, [isHost, sailing, teams, applyMessage]);

  const reset = useCallback(() => {
    setDraw(null);
    setStatus(isHost ? "Back in open water." : "Waiting for the host to draw.");
  }, [isHost]);

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
          say(hit.x, hit.y - 34, BOTTLE_NOTES[bubbleId.current % BOTTLE_NOTES.length], "note");
        },
        tentacle: () => playSfx("tentacle"),
        // No cue of his own, and he does not get to borrow one - the joke is
        // that something enormous surfaces and it is only him.
        patches: () => say(hit.x, hit.y - 40, "SORRY!", "shout"),
        dutchman: () => {
          playSfx("dutchman");
          say(hit.x, hit.y - 66, "A sail, and nothing under it", "ghost");
        },
      };
      react[hit.kind]();
    },
    [say],
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

    const ships: Ship[] = names.map((name, i) => {
      const plan = draw?.plan.ships[i];
      const rng = rand(((plan?.commitAt ?? i * 7919) * 1000) | 0);
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
        mode: "wander",
        target: { x: 0, y: 0 },
        berth: null,
        anchor: null,
        feintAt: 0,
        nextFeint: 0,
        wanderSeed: (i * 2654435761) >>> 0,
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
      const top = Math.max(presenting ? 118 : 88, scene.horizon() + shipPx * 0.6);
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
        } else if (s.mode === "commit") {
          s.target = s.berth;
        }
      });
    };
    assignBerths();

    let raf = 0;
    let last = 0;

    const step = (ms: number) => {
      const dt = last === 0 ? 0.016 : Math.min((ms - last) / 1000, 0.05);
      last = ms;

      scene.draw(ms);

      const elapsed = draw === null ? -1 : ms - draw.startedAt;

      for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        const plan = draw?.plan.ships[i];

        if (plan !== undefined && elapsed >= 0 && s.mode !== "moored") {
          if (elapsed >= plan.commitAt && s.mode !== "commit") {
            s.mode = "commit";
            if (s.berth !== null) s.target = s.berth;
          } else if (s.mode === "feint") {
            if (Math.hypot(s.target.x - s.x, s.target.y - s.y) < 74 || ms > s.feintAt + 3400) {
              // Haul away from the side she just ran at, so the turn reads as
              // a decision rather than a bounce.
              s.mode = "wander";
              pickWander(s, i);
            }
          } else if (s.mode === "wander") {
            const next = plan.feints.find((f) => f.at > s.nextFeint && f.at <= elapsed);
            if (next !== undefined) {
              s.nextFeint = next.at;
              s.mode = "feint";
              s.feintAt = ms;
              const zoneW = geom.w / teams;
              s.target = {
                x: zoneW * (next.zone + 0.5),
                y: geom.top + (geom.bottom - geom.top) * 0.5,
              };
            }
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

        const base = s.mode === "commit" ? 96 : s.mode === "feint" ? 82 : s.mode === "moored" ? 16 : 24;
        let speed = base * speedScale;

        const dx = s.target.x - s.x;
        const dy = s.target.y - s.y;
        const dist = Math.hypot(dx, dy) || 1;

        if (s.mode === "commit" && dist < 3) {
          s.x = s.target.x;
          s.y = s.target.y;
          s.mode = "moored";
          s.anchor = { x: s.x, y: s.y };
          continue;
        }
        if (s.mode === "wander" && dist < 18) pickWander(s, i);
        if (s.mode === "commit" && dist < 100) speed *= Math.max(0.16, dist / 100);

        const turn = s.mode === "commit" ? 1.9 : s.mode === "feint" ? 1.5 : s.mode === "moored" ? 0.5 : 0.8;
        s.vx += ((dx / dist) * speed - s.vx) * Math.min(1, turn * dt);
        s.vy += ((dy / dist) * speed - s.vy) * Math.min(1, turn * dt);

        // Keep wandering ships out of each other's nameplates. Feinting and
        // committed ships are exempt, which is what lets them cut close.
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

        s.x += s.vx * dt;
        s.y += s.vy * dt;

        // Only ships out looking are penned in. A berth can sit outside the
        // wander box, and clamping would strand a ship just short of it.
        if (s.mode === "wander" || s.mode === "feint") {
          if (s.x < geom.left) { s.x = geom.left; s.vx = Math.abs(s.vx); }
          if (s.x > geom.right) { s.x = geom.right; s.vx = -Math.abs(s.vx); }
          if (s.y < geom.top) { s.y = geom.top; s.vy = Math.abs(s.vy); }
          if (s.y > geom.bottom) { s.y = geom.bottom; s.vy = -Math.abs(s.vy); }
        }

        if (s.mode !== "moored") {
          if (s.vx > 6) s.face = 1;
          else if (s.vx < -6) s.face = -1;
        }

        const node = shipRefs.current[i];
        if (node) {
          node.style.transform = `translate(calc(${s.x.toFixed(1)}px - 50%), calc(${s.y.toFixed(1)}px - 50%))`;
          node.style.zIndex = String(Math.round(s.y));
          node.dataset.face = String(s.face);
          if (s.mode === "moored") {
            node.dataset.moored = "1";
            node.style.setProperty("--sail", teamHex(s.team));
          }
        }
      }

      // The last hull to moor ends the draw. Announced from the frame loop
      // rather than on a timer, because the drift window says when ships are
      // RELEASED, not when they arrive - a ship let go at the very end of it
      // is still crossing the water for a second or two afterwards.
      if (draw !== null && cheeredFor.current !== draw && ships.every((s) => s.mode === "moored")) {
        cheeredFor.current = draw;
        setStatus("Teams set.");
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
  }, [names, draw, teams, presenting, open]);

  /* ---- chrome ------------------------------------------------------------ */

  const canDraw = isHost && sailing.length >= 2 && sailing.length >= teams;

  // Mounted for everyone in the lobby, rendered only once there is something
  // to see. The subscription above runs either way - that is what lets a draw
  // open this for the people who did not press anything.
  if (!open) return null;

  return (
    <div className={`fd-modal${presenting ? " presenting" : ""}`} role="dialog" aria-label="Fleet draw">
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
                <span className="fd-zone-rule" style={{ background: teamHex(i) }} />
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
              <div className="fd-bob" style={{ animationDelay: `-${(i * 0.41).toFixed(2)}s` }}>
                <div className="fd-hull">
                  <svg viewBox={shape.viewBox} aria-hidden="true">
                    {shape.parts.map((p, k) => (
                      <path key={k} className={`fd-${p.cls}`} d={p.d} />
                    ))}
                  </svg>
                </div>
                <div className="fd-plate" title={name}>{name}</div>
              </div>
            </div>
          );
        })}

        <div className="fd-bar" onClick={(e) => e.stopPropagation()}>
          {isHost ? (
            <>
              <button className="fd-act" onClick={startDraw} disabled={!canDraw}>
                {draw === null ? "Draw teams" : "Draw again"}
              </button>
              <button className="fd-act ghost" onClick={reset} disabled={draw === null}>
                Open water
              </button>
            </>
          ) : (
            <span className="fd-status">{status}</span>
          )}
          <button className="fd-act ghost" onClick={togglePresent}>
            {presenting ? "Exit full screen" : "Full screen"}
          </button>
          <button className="fd-act ghost" onClick={() => onOpenChange(false)}>Close</button>
        </div>
      </div>

      {isHost && !presenting && (
        <div className="fd-controls">
          <div className="fd-field">
            <span className="fd-label">Teams</span>
            <div className="fd-seg" role="group" aria-label="Number of teams">
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
            <span className="fd-label">Who sails — click to bench ({sailing.length} sailing)</span>
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
              ? `Drawn teams are shown here only — nobody is moved. Read them out and let the room pick. Takes about ${Math.round(DRIFT_MS / 1000)}s.`
              : `Standing draw: ${Array.from({ length: teams }, (_, t) =>
                  `${teamName(t)} ${draw.plan.assignment.filter((a) => a === t).length}`,
                ).join(" · ")}`}
          </p>
        </div>
      )}
    </div>
  );
}
