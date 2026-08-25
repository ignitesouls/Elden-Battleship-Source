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
   * out of the way.
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

  let template = cache.get(name);
  if (!template) {
    template = new Audio(base + FILES[name]);
    template.preload = "auto";
    cache.set(name, template);
  }

  const audio = template.cloneNode() as HTMLAudioElement;
  audio.volume = volume;
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
