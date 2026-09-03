import type { CastMessage, CastView } from "./overlayCast";

/**
 * The pure half of the cast protocol: what a frame IS, and when one needs sending.
 *
 * -- Why this is its own module ------------------------------------------------------------------
 *
 * overlayCast.ts owns the channel, so it imports the supabase client and React, and nothing that
 * imports it can be run outside a browser. That is fine for a hook and useless for the one piece of
 * this protocol that genuinely needs asserting: the decision to send a stamp instead of a frame.
 *
 * Getting that decision backwards does not throw and does not blank a source. It leaves a caster
 * moving controls that the stream does not follow. Same reason overlayMarkers.ts sits apart - see
 * scripts/check-cast-heartbeat.ts, which is only able to exist because of this split.
 *
 * Types come in type-only, so this module has no runtime dependency on overlayCast despite the
 * import - the same arrangement overlayMarkers.ts already uses.
 */

export const DEFAULT_VIEW: CastView = {
  mode: "results",
  zoom: 1,
  cx: 0.5,
  cy: 0.5,
  names: true,
  coords: true,
  opacity: 1,
  visible: true,
  markers: true,
  markerTeams: null,
  spot: null,
  text: 1,
  // Nobody has let go of the wheel. A source falling back to this default aims where it is told,
  // which is what every board did before the camera existed - see lib/overlayCamera.
  motion: null,
};

/**
 * The part of a frame a source actually draws, as a comparable string.
 *
 * `at` is deliberately absent. It changes on every send by definition, so including it would make
 * every frame look new and the heartbeat would go back to shipping every fleet's placements four
 * times a minute to every source - which is the entire thing this exists to stop.
 *
 * Stringified rather than compared field by field because `view` grows: half a dozen fields have
 * been added to it already, and a hand-written comparison that silently stops noticing the newest
 * one produces the worst possible failure here - a caster moves a control and the stream does not
 * follow, with no error anywhere.
 */
export function frameKey(message: CastMessage): string {
  return JSON.stringify({ view: message.view, fleets: message.fleets });
}

/**
 * What a send should put on the wire: the whole frame, or just a stamp.
 *
 * `force` is for `hello`. A source that has just announced itself is holding NOTHING, so the fact
 * that the other sources already have this frame is exactly the wrong reason to answer it with a
 * stamp - it would sit blank until the caster happened to touch something.
 *
 * Erring towards "state" costs bytes. Erring towards "ping" costs a caster their controls.
 */
export function castSendKind(sentFrame: string | null, key: string, force: boolean): "state" | "ping" {
  if (force || sentFrame === null) return "state";
  return key === sentFrame ? "ping" : "state";
}
