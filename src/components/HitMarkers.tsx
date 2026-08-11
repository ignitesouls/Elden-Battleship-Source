/** Small per-cell result markers, drawn in place of a flat hit/miss/sunk background wash. */

/**
 * The burst star, grown from an outer radius of 40 to 48 (and its inner radius from 17 to 20.4) so
 * it reaches the edges of its square instead of floating in the middle of one. Players were reading
 * a board of a hundred named squares and simply not registering the smaller marker.
 */
export function HitMark() {
  return (
    <svg viewBox="0 0 100 100" className="hit-mark" aria-hidden="true">
      <circle cx="50" cy="50" r="38" className="hit-mark-glow" />
      <polygon
        className="hit-mark-burst"
        points="50,2 57.8,31.2 83.9,16.1 68.9,42.2 98,50 68.9,57.8 83.9,83.9 57.8,68.9 50,98 42.2,68.9 16.1,83.9 31.2,57.8 2,50 31.2,42.2 16.1,16.1 42.2,31.2"
      />
    </svg>
  );
}

/** Spray on water: the square behind this is already filled blue, so the rings spread across it. */
export function MissMark() {
  return (
    <svg viewBox="0 0 100 100" className="miss-mark" aria-hidden="true">
      <circle cx="50" cy="50" r="44" className="miss-ring miss-ring-1" />
      <circle cx="50" cy="50" r="30" className="miss-ring miss-ring-2" />
      <circle cx="50" cy="50" r="16" className="miss-ring miss-ring-3" />
      <circle cx="50" cy="50" r="7" className="miss-dot" />
    </svg>
  );
}

/**
 * Dead water: a square no ship still afloat can be sitting on (see lib/deduction).
 *
 * A single X across the square, not a badge in a corner. The two corners are already spoken for -
 * results top-left, the pinned-guess star top-right, tallies along the bottom - and a third small
 * glyph competing with those would be one more thing to decode on a board that is mostly text. An X
 * over the whole square reads at a glance and can't be mistaken for a result, because no result is
 * drawn as straight lines.
 *
 * One X, drawn one way. There used to be two: a bold red cross the player made by hand and a thin
 * dashed grey one the board suggested, on the theory that a deduction offered should never look like
 * a decision taken. Now that the deduction is on by default it IS the feature, and drawing the thing
 * everybody sees in the quiet style meant the marker most players would ever meet was the one
 * designed to be easy to ignore.
 */
export function RuledOutMark() {
  return (
    <svg viewBox="0 0 100 100" className="ruled-mark" aria-hidden="true">
      <line x1="18" y1="18" x2="82" y2="82" />
      <line x1="82" y1="18" x2="18" y2="82" />
    </svg>
  );
}

/**
 * The white whale, belly-up.
 *
 * Drawn rather than dropped in as a sprite for the same reason every other marker here is: it has to
 * survive being scaled from a 20px overlay cell to a full-screen board, and it has to sit on a
 * square that still needs to be readable underneath it.
 *
 * It is a bowhead, and specifically the etched-ink kind: a head taking up a third of the animal, the
 * long bowed jaw line that gives the species its name, hatching for shading and no solid fills
 * anywhere. Two earlier passes read as a fish, and the reason was always the same - a whale is mostly
 * head, and anything with an evenly tapered body in a rounded outline is a fish no matter what you
 * put on its face.
 *
 * The whole animal is drawn the right way up and then flipped once, in the single transform below.
 * Reasoning about a bowhead's anatomy upside down is how you get a fish; and the flip is what puts
 * the pale belly and its hatching to the sky, drops the jaw open, and curls the flukes upward.
 *
 * The halo hangs OUTSIDE that flip, because it is the one thing here that isn't upside down. It, the
 * single X eye and the lolling tongue are doing all the "dead" work: this has to read as sad-cute at
 * a glance and never as gore, because it is an easter egg on a game board and somebody is going to
 * screenshot it. Colours live in BoardGrid.css.
 */
/**
 * The bowhead outline both whales are drawn from, head to the left.
 *
 * Shared on purpose: Laboon is the same animal seen alive, and drawing him a second time by hand
 * would guarantee the two drift into being two different species.
 */
const BOWHEAD =
  "M9,50 C9,35 20,27 35,27 C50,27 62,31 72,37 C79,41 84,44 87,45 " +
  "C90,39 95,34 98,31 C95,40 95,53 98,63 C95,60 90,55 87,50 " +
  "C83,52 78,55 71,57 C58,63 48,67 35,67 C20,67 9,64 9,50 Z";

export function WhaleMark() {
  return (
    <svg viewBox="0 0 100 100" className="whale-mark" aria-hidden="true">
      {/* Over the head, which after the flip is bottom-left. */}
      <ellipse className="whale-halo" cx="24" cy="20" rx="11" ry="3.4" />

      <g className="whale-body">
        {/* Belly to the sky. Everything inside here is drawn right way up. */}
        <g transform="translate(0 100) scale(1 -1)">
          <path className="whale-hull" d={BOWHEAD} />
          {/* Pectoral fin, waving at nobody. */}
          <path className="whale-fin" d="M42,64 C45,73 53,75 58,70 C52,69 47,67 44,63 Z" />
          {/* The bow in bowhead: one long arc from the snout to the corner of the mouth. */}
          <path className="whale-jaw" d="M10,54 C15,62 24,66 37,65" />
          {/* Shading, ink-sketch style - along the belly, so the flip puts it on top. */}
          <path className="whale-hatch" d="M45,62 l-2,5 M52,61 l-2,5 M59,60 l-2,5" />
          <path className="whale-hatch" d="M66,58 l-2,5 M73,56 l-2,4 M80,53 l-2,4" />
          <path className="whale-hatch" d="M89,36 l3,3 M90,58 l3,3" />
          {/* Eye, in profile, so there is only one of it. */}
          <path className="whale-eye" d="M30,54 L37,61 M37,54 L30,61" />
          {/* Lolling over the jaw, which is what sells the whole thing. */}
          <ellipse className="whale-tongue" cx="22" cy="66" rx="3.4" ry="2.6" />
        </g>
      </g>

      {/* Last breath. */}
      <circle className="whale-bubble whale-bubble-1" cx="72" cy="20" r="3" />
      <circle className="whale-bubble whale-bubble-2" cx="80" cy="13" r="2" />
      <circle className="whale-bubble whale-bubble-3" cx="66" cy="11" r="1.5" />
    </svg>
  );
}

/**
 * Laboon: the same whale, alive, unbothered, and the wrong one.
 *
 * Everything that made the other one dead is simply absent - no flip, no halo, no X eye, no tongue.
 * He is the right way up with a smile and an open eye, which is all it takes to read as "that whale
 * is fine" from across a room, and he keeps the scar down his brow because that scar is the entire
 * reason anybody recognises him. Blue rather than white, so the two can never be confused at 20px.
 */
export function LaboonMark() {
  return (
    <svg viewBox="0 0 100 100" className="laboon-mark" aria-hidden="true">
      <g className="laboon-body">
        <path className="laboon-hull" d={BOWHEAD} />
        <path className="laboon-fin" d="M42,64 C45,73 53,75 58,70 C52,69 47,67 44,63 Z" />
        <path className="laboon-jaw" d="M10,54 C15,62 24,66 37,65" />
        {/*
          The scars, and there have to be a lot of them.
          A whale who has spent a decade headbutting a cliff does not have a scar, he has a lattice -
          so these cross, in two opposing sets, over the brow and the crown. It is also the only thing
          identifying him once the drawing shrinks: at 20px the mesh reads as a pale patch on a blue
          head, which is exactly right, while two neat ticks read as a rendering fault.
          Kept clear of the eye and the mouth, which have their own work to do.
        */}
        <path className="laboon-scar" d="M14,36 L20,46 M19,31 L26,43 M25,29 L32,41 M31,29 L37,39 M38,31 L44,40" />
        <path className="laboon-scar" d="M22,30 L15,41 M28,30 L21,42 M34,31 L27,43 M40,33 L34,44 M46,36 L41,45" />
        {/* Open eye, and a mouth turned up at the corner. He took a cannonball and thought little of it. */}
        <circle className="laboon-eye" cx="33" cy="52" r="3.2" />
        <circle className="laboon-glint" cx="34.2" cy="50.8" r="1" />
        <path className="laboon-smile" d="M14,58 C19,63 27,63 32,59" />
        <path className="laboon-hatch" d="M52,61 l-2,5 M59,60 l-2,5 M66,58 l-2,5 M73,56 l-2,4" />
      </g>
      {/* Spout. The one on the dead whale is bubbles; this is a whale that is still breathing. */}
      <path className="laboon-spout" d="M27,24 C25,17 26,12 29,9" />
      <path className="laboon-spout" d="M30,24 C31,17 34,13 37,11" />
    </svg>
  );
}

/**
 * One of Cthulhu's tentacles, breaking the surface.
 *
 * Deliberately not a whole creature: four squares of a hundred hold something, they are scattered
 * with no pattern between them, and what a crew gets to see is one arm at a time with no idea how many
 * more there are. So this has to read as a PART - it runs off the bottom edge of its square, because
 * the thing it belongs to is bigger than the board can show.
 *
 * `awake` is the fourth one landing. Same arm, roused: the suckers catch the light, and the eye that
 * had been shut is not any more.
 */
export function TentacleMark({ awake }: { awake?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      /**
       * Anchored to the BOTTOM of its square rather than centred in it.
       *
       * Every other marker here is a thing sitting in the middle of a square and is happy to be
       * centred when a cell isn't square (the match canvas lets a player drag one to any shape - see
       * .bg-grid-fill). This one is drawn running off the bottom edge on purpose, and centred in a
       * wide, short cell it floats above that edge with a gap under it, which turns "something is
       * coming up out of the water" into "something is hovering". YMax keeps the uniform fit - no
       * stretching, no cropping - and pins the base where the drawing assumes it is.
       */
      preserveAspectRatio="xMidYMax meet"
      className={`tentacle-mark${awake ? " tentacle-mark-awake" : ""}`}
      aria-hidden="true"
    >
      <g className="tentacle-body">
        {/* One arm, curling up out of the water and tapering to a point. */}
        <path
          className="tentacle-limb"
          d="M38,100 C34,80 36,62 46,48 C54,37 66,32 72,22 C74,17 73,12 69,9
             C75,10 79,15 78,22 C77,32 66,41 58,52 C50,63 47,80 50,100 Z"
        />
        {/*
          Wet highlight down the leading edge.
          Something this dark on a square of mid-blue water needs its silhouette carried by a LIGHT
          line rather than a darker one - a black outline on a black arm is nothing at all. This is
          also the only thing saying the skin is wet.
        */}
        <path className="tentacle-sheen" d="M40,96 C37,78 39,62 48,49 C55,39 66,33 72,24" />
        {/* Suckers, biggest at the base where the arm is thickest. */}
        <circle className="tentacle-sucker" cx="43" cy="86" r="3.4" />
        <circle className="tentacle-sucker" cx="42" cy="73" r="3" />
        <circle className="tentacle-sucker" cx="45" cy="61" r="2.6" />
        <circle className="tentacle-sucker" cx="52" cy="50" r="2.2" />
        <circle className="tentacle-sucker" cx="61" cy="41" r="1.7" />
        <circle className="tentacle-sucker" cx="69" cy="30" r="1.3" />
      </g>

      {/* Shut until the last one is found. */}
      {awake ? (
        <g className="tentacle-eye">
          <ellipse className="tentacle-eye-white" cx="76" cy="62" rx="12" ry="8.5" />
          <ellipse className="tentacle-pupil" cx="76" cy="62" rx="3.6" ry="7" />
        </g>
      ) : (
        <path className="tentacle-lid" d="M65,62 C70,57 82,57 87,62" />
      )}
    </svg>
  );
}

/**
 * The Flying Dutchman.
 *
 * The one drawing here with a real hazard attached: a ship-shaped marker on a game made of ship
 * sprites. Two things answer it, and both have to hold at 20px.
 *
 * He is the only TRANSLUCENT thing on the board - the water reads straight through his timbers, which
 * no sprite and no other marker does - and he is a luminous sea-green, where --ship is a cold solid
 * grey. Beyond that the silhouette is carried by the sails being torn: three chewed shapes stacked
 * over a hull, where a living ship is three clean rectangles.
 *
 * He also fades in and out rather than sitting still. Every other marker here asserts a fact; this is
 * the only one that should look unsure it is there.
 */
export function DutchmanMark() {
  return (
    <svg viewBox="0 0 100 100" className="dutchman-mark" aria-hidden="true">
      <ellipse className="dutchman-aura" cx="50" cy="52" rx="46" ry="40" />
      <g className="dutchman-body">
        {/* Wake, trailing off astern - the only thing saying he is under way. */}
        <path className="dutchman-wake" d="M4,80 C14,78 24,79 32,81" />
        <path className="dutchman-wake" d="M2,86 C12,84 22,85 28,87" />
        <path className="dutchman-spar" d="M32,66 L32,16 M52,66 L52,6 M70,66 L70,20" />
        <path className="dutchman-spar" d="M20,20 L44,20 M38,12 L66,12 M60,24 L80,24" />
        <path className="dutchman-sail" d="M21,21 L43,21 L42,41 L38,34 L34,43 L29,33 L25,42 L22,33 Z" />
        <path className="dutchman-sail" d="M39,13 L65,13 L64,37 L59,29 L54,40 L48,30 L43,39 L40,29 Z" />
        <path className="dutchman-sail" d="M61,25 L79,25 L78,43 L74,36 L70,45 L65,35 L62,43 Z" />
        <path className="dutchman-rip" d="M31,24 L34,31 M50,17 L47,25 M57,20 L60,27 M69,29 L72,35" />
        <path className="dutchman-hull" d="M8,66 L93,66 C91,78 79,86 51,86 C25,86 12,78 8,66 Z" />
        {/* Stern castle and bowsprit: the two shapes that stop a hull reading as a banana. */}
        <path className="dutchman-hull" d="M8,66 L8,53 L22,53 L22,66 Z" />
        <path className="dutchman-spar" d="M91,64 L100,55" />
        <path className="dutchman-rip" d="M30,68 L30,80 M46,68 L46,83 M62,68 L62,81" />
        {/* Stern lamp, still lit after all this time. */}
        <circle className="dutchman-lamp" cx="15" cy="47" r="3" />
      </g>
    </svg>
  );
}

/**
 * A message in a bottle.
 *
 * The only manufactured object in the water, and it is allowed to look like one: hard edges and a
 * straight line through it, where every other mark here is an animal defending an organic silhouette.
 * That alone separates it at any size.
 *
 * Cream scroll on bottle-green is the highest-contrast pair in the whole set, which is what survives
 * the shrink - at 20px this is a green pill with a pale core and a red tie, and it still reads. Lying
 * at -58 degrees rather than upright, because a bottle standing to attention in open water looks like
 * an icon and one lying over looks like it is floating.
 */
export function BottleMark() {
  return (
    <svg viewBox="0 0 100 100" className="bottle-mark" aria-hidden="true">
      <g className="bottle-body">
        <path className="bottle-ripple" d="M8,84 C20,80 34,80 46,84" />
        <path className="bottle-ripple bottle-ripple-2" d="M52,88 C64,84 78,84 92,88" />
        <g transform="rotate(-58 50 56)">
          <path className="bottle-cork" d="M43,7 L57,7 C58,7 58,8 58,9 L57,23 L43,23 L42,9 C42,8 42,7 43,7 Z" />
          <path
            className="bottle-glass"
            d="M45,23 L55,23 L55,38 C64,42 69,50 69,62 C69,78 61,88 50,88 C39,88 31,78 31,62 C31,50 36,42 45,38 Z"
          />
          <path
            className="bottle-scroll"
            d="M39,57 L61,57 C64,57 66,60 66,63 C66,66 64,69 61,69 L39,69 C36,69 34,66 34,63 C34,60 36,57 39,57 Z"
          />
          <path className="bottle-scroll-line" d="M42,61 L58,61 M42,65 L54,65" />
          <path className="bottle-ribbon" d="M50,55 L50,71" />
          <path className="bottle-shine" d="M38,45 C34,52 33,62 34,72" />
          <path className="bottle-shine" d="M47,26 L47,36" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Alexander, in whichever of his two situations applies.
 *
 * Pale glazed ceramic, crimson contents, thin dark stick limbs. Lavender is the only cool-but-not-blue
 * thing in the water, so it separates from the miss wash without shouting the way a terracotta pot
 * did; and being a LIGHT body against DARK limbs is what carries him down to 20px, where a
 * single-tone marker goes to mush.
 *
 * The limbs are strokes rather than filled shapes on purpose. They are meant to be a line or two
 * wide, and a filled sliver that thin either disappears at 20px or thickens into a sausage at full
 * screen; a stroke keeps its weight at both ends.
 *
 * The two states are DRAWN SEPARATELY rather than being one pot at two angles. Rotating the whole jar
 * was the first attempt and it was worse in both directions: upside down it put the crimson mouth
 * below the cell (see the clip note in BoardGrid.css) and it read as a diagram of a pot rather than as
 * something in trouble. Stuck is now its own sprite - the dome of an upended jar, cut off by the
 * waterline, legs kicking in the air - which is the actual joke and needs no rotation at all.
 */
export function JarMark({ freed }: { freed?: boolean }) {
  return freed ? <JarFreed /> : <JarStuck />;
}

/**
 * Wedged in mouth-first: half an upside-down pot, and a pair of legs having a very bad time.
 *
 * The dome runs off the bottom edge of the square on purpose and is clipped there (see
 * `.jar-mark-stuck`), so the cut lands on the square's own gridline and reads as "the rest of him is
 * under the surface" rather than as a cropped drawing.
 *
 * No crimson anywhere, because the mouth is the end that is buried - so the two-tone job falls to the
 * dark hoops and the dark kicking legs against the pale ceramic, which is a stronger contrast at a
 * small size than the crimson was. His legs sit high on the dome because they attach near the jar's
 * base, and the base is the part now pointing at the sky.
 */
function JarStuck() {
  return (
    <svg viewBox="0 0 100 100" className="jar-mark jar-mark-stuck" aria-hidden="true">
      {/* The disturbance he made going in. */}
      <path className="jar-ripple" d="M3,86 C17,80 33,80 45,86" />
      <path className="jar-ripple" d="M55,93 C67,88 83,88 97,93" />
      <g className="jar-body">
        <g className="jar-flail">
          <path className="jar-limb" d="M32,55 C23,49 18,36 22,25" />
          <path className="jar-limb jar-digit" d="M22,25 L15,21" />
          <path className="jar-limb" d="M68,57 C77,53 83,40 79,29" />
          <path className="jar-limb jar-digit" d="M79,29 L86,26" />
        </g>
        <path className="jar-pot" d="M19,100 C18,60 32,38 50,38 C68,38 82,60 81,100 Z" />
        {/* Inverted, the hoops bow UPWARD across the dome - the same trick as the freed pot, flipped. */}
        <path className="jar-band" d="M25,64 C33,59 67,59 75,64" />
        <path className="jar-band" d="M22,77 C32,71 68,71 78,77" />
        <path className="jar-shine" d="M33,86 C30,70 34,54 42,45" />
        <circle className="jar-speck" cx="60" cy="58" r="1.7" />
        <circle className="jar-speck" cx="66" cy="73" r="1.4" />
        <circle className="jar-speck" cx="44" cy="85" r="1.5" />
      </g>
    </svg>
  );
}

/** Out, upright, and one fist in the air. */
function JarFreed() {
  return (
    <svg viewBox="0 0 100 100" className="jar-mark jar-mark-free" aria-hidden="true">
      <path className="jar-ripple" d="M10,86 C24,81 40,81 52,86" />
      <path className="jar-ripple" d="M52,92 C64,88 80,88 92,92" />
      <circle className="jar-spark" cx="16" cy="18" r="3" />
      <circle className="jar-spark jar-spark-2" cx="85" cy="13" r="2.4" />
      <g className="jar-body">
        {/* One fist up, the other arm hanging out like the pot handle it is. The asymmetry is what
            makes the pose read as a cheer instead of as the stuck pose the right way up. */}
        <path className="jar-limb" d="M29,46 C19,38 15,23 21,12" />
        <path className="jar-limb jar-digit" d="M21,12 L14,7 M21,12 L19,3 M21,12 L28,7" />
        <path className="jar-limb" d="M72,48 C85,51 88,63 80,69" />
        <path className="jar-limb jar-digit" d="M80,69 L75,73 M80,69 L84,74" />
        <path className="jar-limb" d="M42,78 C39,86 35,90 31,95" />
        <path className="jar-limb jar-digit" d="M31,95 L25,96" />
        <path className="jar-limb" d="M58,78 C61,86 65,90 69,95" />
        <path className="jar-limb jar-digit" d="M69,95 L75,96" />
        <ellipse className="jar-collar" cx="50" cy="31" rx="26" ry="11" />
        <path className="jar-pot" d="M26,32 C22,47 23,63 29,72 C34,78 42,81 50,81 C58,81 66,78 71,72 C77,63 78,47 74,32 Z" />
        {/* Upright, the hoops bow DOWN across the belly - a band on a round pot seen from slightly
            above does, and it is most of what says this is a cylinder and not a disc. */}
        <path className="jar-band" d="M25,57 C33,62 67,62 75,57" />
        <path className="jar-band" d="M26,65 C34,70 66,70 74,65" />
        <path className="jar-shine" d="M33,40 C29,50 29,60 32,68" />
        <circle className="jar-speck" cx="60" cy="47" r="1.7" />
        <circle className="jar-speck" cx="66" cy="55" r="1.3" />
        <circle className="jar-speck" cx="44" cy="72" r="1.5" />
        {/* What is in the jar. Nobody asks. */}
        <ellipse className="jar-meat" cx="50" cy="25" rx="26" ry="12" />
        <ellipse className="jar-meat-inner" cx="50" cy="23.5" rx="21.5" ry="9.5" />
        <ellipse className="jar-meat-shine" cx="42" cy="20.5" rx="6.5" ry="2.6" />
        <ellipse className="jar-meat-shine" cx="58" cy="25" rx="4.5" ry="1.9" />
      </g>
    </svg>
  );
}

/**
 * Patches, crouched in the water and not sorry.
 *
 * The hard one in this file, because he is a PERSON: a whale is a silhouette and a tentacle is a
 * stripe, but at 20px a face is three dots of mush. So he is built around a shape that survives
 * rather than around a likeness - a big pale dome on a dark crouched mass, head about a third of the
 * figure.
 *
 * That structure is deliberately the exact inverse of Alexander, who is a pale body under a dark cap.
 * The two arrived in the same patch and both sit on open water, so they had to be each other's
 * negative or they would be each other's twin.
 *
 * The heavy asymmetric brows are doing the work the rest of the face can't: they are the dark mark
 * across a pale circle that keeps it reading as a face rather than a pebble, and along with the
 * raised hand they are the last things standing when everything else stops resolving. Anchored to the
 * bottom of the square like the tentacle, because he is coming up out of the water. The wave is from
 * the wrist only - a full arm-wave reads as pleased to see you.
 */
export function PatchesMark() {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMax meet" className="patches-mark" aria-hidden="true">
      <path className="patches-ripple" d="M2,90 C16,85 32,85 44,90" />
      <path className="patches-ripple" d="M56,95 C68,91 84,91 98,95" />
      <g className="patches-body">
        <path className="patches-armor" d="M30,58 C25,72 26,88 30,100 L70,100 C74,88 75,72 70,58 C62,53 38,53 30,58 Z" />
        <path className="patches-leather" d="M27,77 C38,82 62,82 73,77 L74,85 C62,90 38,90 26,85 Z" />
        <path className="patches-boot" d="M22,83 C30,79 43,79 47,86 C49,92 47,100 47,100 L19,100 C17,93 18,86 22,83 Z" />
        <path className="patches-boot" d="M78,83 C70,79 57,79 53,86 C51,92 53,100 53,100 L81,100 C83,93 82,86 78,83 Z" />
        <path className="patches-skin" d="M31,62 C21,68 18,81 24,89 C27,93 34,91 32,86 C29,79 32,71 38,67 Z" />
        <g className="patches-wave">
          <path className="patches-skin" d="M69,60 C77,56 83,47 81,38 C80,34 74,34 74,39 C75,46 71,53 65,56 Z" />
          <path className="patches-skin" d="M81,38 C87,34 89,25 85,20 C83,18 78,19 79,24 C80,29 78,33 75,35 Z" />
        </g>
        <path className="patches-leather" d="M27,56 C31,50 41,49 45,54 C38,56 31,58 27,61 Z" />
        <path className="patches-leather" d="M73,56 C69,50 59,49 55,54 C62,56 69,58 73,61 Z" />
        <ellipse className="patches-skin" cx="49" cy="31" rx="20" ry="21" />
        <path className="patches-skin" d="M29,31 C25,30 24,36 28,39" />
        <path className="patches-brow" d="M35,22 C39,17 45,18 48,23" />
        <path className="patches-brow" d="M55,24 C59,21 65,22 67,26" />
        <circle className="patches-eye" cx="41" cy="30" r="3" />
        <circle className="patches-eye" cx="60" cy="32" r="2.8" />
        <path className="patches-lid" d="M37,28 C40,25 45,25 47,28" />
        <path className="patches-lid" d="M56,30 C59,27 64,28 65,30" />
        <path className="patches-nose" d="M48,33 C52,37 53,40 49,41" />
        <path className="patches-smirk" d="M37,44 C43,50 54,52 63,43" />
      </g>
    </svg>
  );
}

interface SunkMarkProps {
  /** Matches the ship's own orientation (see the ship sprite rotation in BoardGrid) so the fire
   * rises from the hull's deck rather than always pointing toward the top of the cell. */
  horizontal?: boolean;
}

export function SunkMark({ horizontal = true }: SunkMarkProps) {
  return (
    <svg viewBox="0 0 100 100" className="sunk-mark" aria-hidden="true">
      <g transform={horizontal ? undefined : "rotate(90 50 50)"}>
        <circle className="sunk-smoke sunk-smoke-1" cx="42" cy="26" r="9" />
        <circle className="sunk-smoke sunk-smoke-2" cx="58" cy="18" r="7" />
        <path
          className="sunk-flame-outer"
          d="M50 15 C34 34 29 54 41 70 C35 60 39 49 50 58 C61 49 65 60 59 70 C71 54 66 34 50 15 Z"
        />
        <path
          className="sunk-flame-inner"
          d="M50 32 C42 43 40 54 47 63 C44 56 47 50 50 55 C53 50 56 56 53 63 C60 54 58 43 50 32 Z"
        />
      </g>
    </svg>
  );
}
