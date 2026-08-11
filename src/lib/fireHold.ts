/**
 * How long the fire board makes you hold a square down before it commits the shot.
 *
 * -- Why this is a setting ------------------------------------------------------------------------
 *
 * A shot cannot be taken back. It reveals what the square was hiding, wounds a hull, and is on every
 * spectator's screen before the attacker has let go of the mouse - and there is deliberately no way
 * to undo one, because any correction that gave the attacker their shot back would also hand them
 * free reconnaissance for the price of saying "misclick".
 *
 * So the only real defence is not firing by accident, and a press that has to be held is the
 * cheapest one there is. But it is not free: under fire-on-kill the click is timestamped as the
 * kill, and somebody chasing a time does not want to be told to wait. Both concerns are legitimate
 * and different players weigh them differently, so the LENGTH is theirs to pick. Nobody else is
 * affected either way - this is local input handling, and one player's caution changes no part of
 * anyone else's match.
 *
 * -- Why there is no longer an "instant" ----------------------------------------------------------
 *
 * Whether to hold at all is not theirs to pick, and used to be: the list opened with 0ms, a plain
 * click. Mismarks were the result, often enough to be the reason this list changed - a board of a
 * hundred small squares, read at speed, under a rule that makes every slip permanent, is precisely
 * the input a bare click is worst at. The option cost nothing to choose and could not be undone
 * afterwards, which is the shape of a trap rather than a preference.
 *
 * A stored 0 from before this is not honoured. FIRE_HOLD_VALUES is what useStoredNumber validates
 * against, so a browser still holding one falls back to FIRE_HOLD_DEFAULT rather than keeping an
 * instant click nobody can now select.
 *
 * -- And when it happens anyway -------------------------------------------------------------------
 *
 * The rule is that a misfire stands, and you must go and kill the boss whose square you hit in order
 * to win. Nothing here enforces that, and nothing can: kills are entered by hand, so the app has no
 * independent knowledge of what anybody killed and no way to tell a slip from a shot. It is a rule
 * players keep, which is why it is written into the hint below rather than into a code path.
 */
export const FIRE_HOLD_OPTIONS: readonly { ms: number; label: string }[] = [
  { ms: 150, label: "Feather · 150ms" },
  { ms: 250, label: "Light · 250ms" },
  { ms: 400, label: "Steady · 400ms" },
  { ms: 600, label: "Heavy · 600ms" },
  { ms: 1000, label: "Deliberate · 1s" },
];

/**
 * The lengths a stored preference may take.
 *
 * useStoredNumber validates against this, so a value dropped from the list above stops being
 * honoured rather than lingering in somebody's browser as a hold nobody can explain.
 */
export const FIRE_HOLD_VALUES: readonly number[] = FIRE_HOLD_OPTIONS.map((o) => o.ms);

/** Long enough to catch a slipped click, short enough not to feel like waiting. */
export const FIRE_HOLD_DEFAULT = 400;

/** Per browser, not per room: it is how somebody plays, not something about a match. */
export const FIRE_HOLD_KEY = "eb_fire_hold_ms";

export const FIRE_HOLD_HINT =
  "How long to hold a square before it fires. Every shot needs a hold - a shot can never be taken back, and if you do hit the wrong square, you must go and kill that boss to win.";
