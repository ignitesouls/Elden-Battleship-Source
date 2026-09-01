const base = import.meta.env.BASE_URL;
const cache = new Map<string, HTMLAudioElement>();

const FILES = {
  hit: "sfx/battleship_hit.wav",
  miss: "sfx/battleship_miss.wav",
  sunk: "sfx/battleship_sunk.wav",
  prepare: "sfx/battleship_prepare.wav",
  /**
   * A humpback, for the moment the white whale is found (see lib/deepWater).
   *
   * MP3 rather than WAV purely because that is how it arrived, and there is no reason to convert: the
   * element decodes either, and at 3 seconds nothing here depends on the sample-accurate start that a
   * WAV would buy. It plays only for people the whale has actually been revealed to - the crew that
   * found it and anyone spectating - so most matches never load the file at all.
   */
  whale: "sfx/battleship_whale.mp3",
  /**
   * The Flying Dutchman, sighted. Heard by the crew that found her and anyone spectating.
   *
   * Synthesised rather than sampled (scripts/synth-dutchman.mjs): a swell of wind and sea, the
   * ship's bell tolling twice, timber groaning under her, and a long hall tail. The bell is built
   * from inharmonic partials rather than whole multiples, which is the whole difference between a
   * bell and an organ chord.
   *
   * She spent a long time borrowing the whale call, and the argument for that was sound as far as
   * register goes - a mournful horn out of the fog. What it got wrong is that the whale call is the
   * noise of an animal, and the thing about the Dutchman is that there is nothing aboard to make a
   * noise at all. A bell ringing itself says that; a living horn says the opposite. The tail is
   * long and the level is low on purpose - she is a sighting on the horizon, not something that has
   * arrived, and the cue has to sit behind a caster still talking.
   *
   * Normalised to the same RMS as the tentacle rather than to the same peak, so it lands at the
   * same loudness as the other long find and not merely at the same ceiling.
   */
  dutchman: "sfx/battleship_dutchman.wav",
  /**
   * Somebody's THIRD sighting of the Dutchman - the moment Fates Confirmed is earned. See
   * fatesConfirmed in lib/deepWater for whose third, and why it is per person rather than per crew.
   *
   * Authored rather than synthesised, which makes it the odd one out among the cues that were built
   * by a script - there is no generator for this one and nothing to regenerate it from. 6.3s,
   * stereo, and the only stereo file here; everything else is mono. Both are fine for an element
   * that is cloned and played, and neither is worth converting away.
   *
   * It is the only cue that is not announcing a find of its own. It rides on a sighting, scheduled
   * 1.2s behind the bell it belongs to (FATES_DELAY_MS in useSpectatorSfx) so the two read as one
   * event rather than as a find and then an announcement about it.
   *
   * LEVEL IS THE OPEN QUESTION HERE and it is deliberately left alone. It renders at -15.8 dBFS
   * RMS with a peak of 0.996, which is a hair louder than the Dutchman's own bell at -15.6 - so the
   * thing riding on top is as loud as the thing it is riding on. If it turns out to bury her rather
   * than resolve over her, the fix is a line in TRIM below and not a re-render.
   */
  fates: "sfx/battleship_fates.wav",
  /**
   * One tentacle found. Heard only by the crew that found it - see deepMarks.
   *
   * Synthesised rather than sampled (scratchpad/synth-cthulhu.mjs): sub-bass sweeps, two voices beating
   * a couple of hertz apart, filtered noise and two damped resonances. Deliberately not a roar - this
   * is the sound of something shifting in its sleep, and it has to be able to happen up to four times
   * in a match without wearing out.
   */
  tentacle: "sfx/battleship_tentacle.wav",
  /**
   * The last tentacle. He is awake, and this one plays for EVERYBODY in the room.
   *
   * The only sound in the game the whole room hears at once, which is the entire point: four squares
   * found by up to four people who were never told about each other, and then one shot makes it
   * everyone's business. Ten seconds long, and it only ever happens once in a match.
   */
  awaken: "sfx/battleship_awaken.mp3",
  /**
   * Breaking glass, for the message in a bottle.
   *
   * Under a second, on purpose. The sounds down here scale with what was found - ten
   * seconds for the sleeper, three for the whale - and the bottle is a curio rather than an event. A
   * three-second find would be claiming to be a whale.
   */
  bottle: "sfx/battleship_bottle.mp3",
  /**
   * A dull thud, for Alexander - both when he is turned up wedged and when he comes loose.
   *
   * One file for two moments on purpose. They are the same object in two situations, the way the
   * tentacle and the sleeper are, and a pot knocking about is the right noise for either; if the two
   * ever want to sound different it should be the freed one that changes, since that is the payoff.
   */
  jar: "sfx/battleship_jar.wav",
  /**
   * Igon, handing over his furled finger. His own voice, from the game.
   *
   * Ten and a half seconds, which is the longest thing here bar the sleeper, and it plays for every
   * crew that fires at his square rather than once a match - so on a busy board it can land several
   * times. That is a real cost and it is taken deliberately: the line IS the find. A trimmed version
   * would be a man saying half a sentence, which is worse than a long one.
   *
   * Kept at the name it arrived under rather than renamed into the battleship_ convention, because it
   * is a recording of a specific line and the filename is the only place that is written down.
   */
  igonFinger: "sfx/Igon-Finger.wav",
  /**
   * Igon, avenged. Fifteen seconds, and longer than the sleeper on purpose.
   *
   * The one sound here allowed to outrun Cthulhu, because what it needs is length rather than volume:
   * this only happens when a crew carrying his finger goes and kills one of the most expensive bosses
   * on the board, which most matches never see at all.
   */
  igonHappy: "sfx/Igon-Happy.wav",
  /**
   * The match is over and your fleet is the one still afloat.
   *
   * Plays once, on the moment the room flips to `finished`, and only for someone who watched it
   * happen - see the effect in pages/Room. Loading a finished room's page later is a recap, not a
   * result, and a fanfare over a recap is just noise.
   */
  victory: "sfx/battleship_victory.mp3",
  /**
   * The other side of the same moment: your fleet is gone, or every fleet is.
   *
   * A draw takes this rather than the fanfare. Nobody won a mutual destruction, and the losing crew
   * hearing a fanfare for a match they didn't win would read as the game congratulating them.
   */
  defeat: "sfx/battleship_defeat.mp3",
  /**
   * Somebody is asking the room to stop - and, five seconds later, the moment it actually does.
   *
   * Synthesised rather than sampled (scratchpad/synth-pause.mjs): two struck bell tones a fourth
   * apart, B5 under E6, with inharmonic partials so it rings rather than beeps. Deliberately the
   * quietest and shortest cue here. It is the only sound in the game that can fire while nothing has
   * happened on the board, it can be asked for repeatedly by somebody the host hasn't got to yet,
   * and it must never be mistaken for a hit - so it sits in a register nothing else uses and gets
   * out of the way. The register was always right and the LEVEL was not; the trim that finally
   * makes this paragraph true is in TRIM below.
   *
   * There is no matching resume sound: coming back takes the prepare horn, which is already what the
   * room hears when a match is about to open fire. A restart IS that moment, so it should not need a
   * second vocabulary.
   */
  pause: "sfx/battleship_pause.wav",
} as const;

export type SfxName = keyof typeof FILES;

const VOLUME_KEY = "eb_sfx_volume";

/**
 * A level set by the page rather than by the person listening, which beats the stored one.
 *
 * Exists for the audio browser source (pages/OverlayAudio), where the ordinary route to this number
 * does not exist: the slider lives in the top bar, which every overlay route deliberately does not
 * render, and the storage behind it belongs to a browser nobody is sitting at. A streamer's only
 * way to say "quieter" is the URL they pasted into OBS, so that is what this carries.
 *
 * In memory only, and never written to storage. An OBS install runs its browser sources out of one
 * shared profile, so persisting it would let one source's ?vol= silently redefine the default for
 * every other source pointed at this site.
 *
 * null means "nobody has overruled anything", which is every page but that one.
 */
let volumeOverride: number | null = null;

export function setVolumeOverride(v: number | null): void {
  volumeOverride = v === null || !Number.isFinite(v) ? null : Math.min(1, Math.max(0, v));
}

/** 0-1. Defaults to 0.7 rather than full blast on a fresh browser. */
export function getVolume(): number {
  if (volumeOverride !== null) return volumeOverride;
  const stored = localStorage.getItem(VOLUME_KEY);
  if (stored === null) return 0.7;
  const n = Number(stored);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
}

export function setVolume(v: number): void {
  const clamped = Math.min(1, Math.max(0, v));
  localStorage.setItem(VOLUME_KEY, String(clamped));
  // Nothing to update on the cached elements: they are only ever templates now, and every clone
  // reads the level at the moment it plays.
}

/**
 * The sounds that belong to The Deep, as opposed to the ones the match itself makes.
 *
 * Everything in here is a FIND - lib/deepWater's eleven DeepMarks resolve onto these nine files.
 * What is left out is the board's own vocabulary: the two horns, the pause chime, hit, miss, sunk
 * and the closing sting. That split is the whole of what the top bar's second sound toggle turns
 * off, and it is drawn HERE rather than at the two dozen call sites because a find can reach
 * playSfx from three of them - a player's board, a spectator's queue and the audio browser source -
 * and a rule enforced in three places is a rule that will eventually disagree with itself.
 *
 * Igon's two lines are in it and are most of the reason the toggle exists: ten and fifteen seconds
 * of a man shouting, played once per crew that fires at his square, is the one thing down here that
 * can genuinely be too much on a busy board.
 *
 * The Dutchman and her sting are both in it, and `fates` is the one entry here that is not a find in
 * its own right - it rides on a sighting. It has to be gated with her regardless: somebody who has
 * turned the finds off and then hears a chord arrive out of the sea has been told there is something
 * down there, which is the exact thing the toggle promised to stop saying.
 */
const DEEP: ReadonlySet<SfxName> = new Set<SfxName>([
  "whale",
  "dutchman",
  "fates",
  "tentacle",
  "awaken",
  "bottle",
  "jar",
  "igonFinger",
  "igonHappy",
]);

/**
 * Per-sound trims, for the few files whose level does not match their job.
 *
 * The set is otherwise well matched: measured with ffmpeg's ebur128, twelve of the fourteen files
 * land between -14.7 and -18.3 LUFS-M, which for one-shots is healthy variety rather than a defect
 * - a hit and a fifteen-second speech SHOULD NOT sit at the same loudness, since one of them
 * arrives several times a volley. So only the outliers are listed here, and anything absent plays
 * at the level it was recorded or rendered at.
 *
 * A multiplier rather than a re-rendered file, for two reasons: the mp3s would take generational
 * loss on every pass, and these same files are inlined by hand into the Fleet Draw page, which
 * carries its own multipliers - a level baked into the asset would silently move that page's mix
 * too, in a direction nobody there asked for.
 *
 * Applied on top of whatever the listener has chosen, so a trim shifts one sound WITHIN the mix
 * without changing what the slider means.
 */
const TRIM: Partial<Record<SfxName, number>> = {
  /**
   * -7.6 dB, which puts the chime level with `hit` - the quietest thing in the game, and what the
   * note on the file above always claimed this was.
   *
   * As rendered it measured -10.7 LUFS-M: the LOUDEST sound here, nearly 8 dB above the quietest.
   * The one cue that can fire while nothing has happened on the board, that can be asked for
   * repeatedly by somebody the host hasn't got to yet, and that must never be taken for a hit, was
   * also the one that shouted. It is a struck bell in a register nothing else uses, so it stays
   * easy to pick out down here; being audible was never the thing it was short of.
   *
   * The Dutchman is wired in now and takes no trim. She renders at -15.6 dBFS RMS, which is
   * battleship_tentacle.wav to the decimal - the normalisation in synth-dutchman.mjs is aimed there
   * on purpose - so she is already where this table would have put her.
   *
   * `fates` is the one to watch. At -15.8 it is level with her, and it PLAYS OVER her rather than
   * instead of her, which is the one relationship nothing else in this table has to think about. It
   * has no entry yet because that is a judgement to make listening to it, not from the numbers; if
   * it buries the bell, this is where the fix goes.
   */
  pause: 0.42,
};

const DEEP_KEY = "eb_deep_sfx";

/**
 * A page's answer about the finds, beating the stored one.
 *
 * The same arrangement volumeOverride has, for the same page and the same reason - see the note
 * there. An OBS browser source renders no top bar and its browser has nobody sitting at it, so
 * `?deep=0` in the pasted URL is a streamer's only way to say this.
 *
 * In memory only, never written to storage: OBS runs every browser source out of one shared
 * profile, and persisting it would let one source's query string silently redefine the default for
 * every other source pointed at this site.
 */
let deepOverride: boolean | null = null;

export function setDeepOverride(on: boolean | null): void {
  deepOverride = on;
}

/**
 * Whether finds are audible. On unless somebody has said otherwise.
 *
 * Absent storage reads as on, so this is only ever off for a browser that has been told to turn it
 * off - a fresh one, or one that has had its site data cleared, hears the whale.
 */
export function isDeepSfx(): boolean {
  if (deepOverride !== null) return deepOverride;
  return localStorage.getItem(DEEP_KEY) !== "off";
}

export function setDeepSfx(on: boolean): void {
  localStorage.setItem(DEEP_KEY, on ? "on" : "off");
}

/**
 * Plays a sound effect, layering rather than interrupting.
 *
 * The cache holds one element per sound purely as a preloaded TEMPLATE, and playback happens on a
 * clone of it. Playing the cached element directly meant two effects of the same kind arriving
 * close together shared one HTMLAudioElement, and the second `currentTime = 0` restarted the first
 * instead of sounding alongside it - so a volley that should have been two hits was heard as one.
 * That is the normal case rather than an edge one: a single trigger-pull writes an attack row per
 * opposing team, and both fleets tend to fire in bursts.
 */
export function playSfx(name: SfxName): void {
  const volume = getVolume();
  if (volume === 0) return;
  // A find, for somebody who has asked not to hear them. This one only ever takes away: the master
  // toggle above still governs both kinds, so silencing the app silences these too.
  if (DEEP.has(name) && !isDeepSfx()) return;

  let template = cache.get(name);
  if (!template) {
    template = new Audio(base + FILES[name]);
    template.preload = "auto";
    cache.set(name, template);
  }

  const audio = template.cloneNode() as HTMLAudioElement;
  audio.volume = volume * (TRIM[name] ?? 1);
  void audio.play().catch(() => {
    // Autoplay can be blocked before the first user gesture - not worth surfacing to the player,
    // who will hear the next sound the moment they click anything. It IS worth surfacing to a
    // browser source nobody is going to click, which is what the handler below is for.
    blockedHandler?.();
  });
}

/**
 * Told when a sound was refused, for a page that has no listener to click anything.
 *
 * Deliberately a single handler rather than a subscriber list: the only page that wants this is the
 * audio browser source (pages/OverlayAudio), and one page can only be mounted once. A second caller
 * replacing the first is the correct outcome, not a leak.
 *
 * Nothing else registers one, which is why an ordinary player still sees no error for a blocked
 * sound - they are about to click something, and then it works.
 */
let blockedHandler: (() => void) | null = null;

export function onAudioBlocked(fn: (() => void) | null): void {
  blockedHandler = fn;
}

/**
 * Asks the browser whether it will let this page make a noise, without making one.
 *
 * Plays the shortest file here at zero volume and immediately stops it. A page that waits to find
 * out the ordinary way learns it on the first hit of the match, having already swallowed that hit -
 * which on a stream means the failure is discovered by the audience, in the form of nothing.
 *
 * Also serves as the click handler when a real gesture arrives: the gesture is what lifts the
 * policy, so simply asking again after one is the whole of the recovery.
 *
 * Resolves true when sound is allowed. Never rejects - a refusal is an answer, not a fault.
 */
export function primeAudio(): Promise<boolean> {
  const probe = new Audio(base + FILES.miss);
  probe.volume = 0;
  return probe
    .play()
    .then(() => {
      probe.pause();
      probe.currentTime = 0;
      return true;
    })
    .catch(() => false);
}
