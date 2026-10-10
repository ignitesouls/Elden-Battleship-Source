/**
 * The mod's whole config file, handed over ready to paste.
 *
 * -- Why the entire file rather than the three lines that matter ---------------------------------
 *
 * Because "find the [ingest] section and replace it, but only that section, and don't leave the old
 * one behind" is four instructions, and every one of them is a way to end up with a file that TOML
 * refuses to parse and a mod that silently loads with no configuration. Select all, paste, save is
 * one instruction with no way to get it half right.
 *
 * The cost is that this template has to stay in step with what the mod ships. It is a copy of the
 * stock `overlay_config.toml`, comments and all, with two values filled in - so when the mod's
 * default config gains a setting, this file needs the same setting or pasting it will quietly
 * revert whoever pasted it to the old defaults. That trade is worth it: a stale default costs
 * somebody a setting they can set again, a mangled TOML costs them the whole overlay.
 *
 * Last copied from the Dionysus Arcade 0.2 (Automark and Clock Sync) config: [ingest] moved to the
 * end, the boss list is all_bosses.json, and [victory] is new.
 *
 * Nothing is imported here on purpose. The endpoint URL arrives as an argument so this stays a
 * plain description of a file rather than something that reaches into the app's config.
 */

/** The file to paste into. Compiled into the DLL, which looks only in its own folder. */
export const CONFIG_FILENAME = "overlay_config.toml";

/**
 * The stock config with `url` and `token` filled in.
 *
 * The token is interpolated rather than pasted in as a literal for what should be an obvious
 * reason: this file is in a public repository, and the config it was copied from was a real
 * install with a real working token in its [ingest] section.
 */
export function overlayConfigFile(token: string, url: string): string {
  return `[common]
# Reuse an inherited/ModEngine3 console when available. Otherwise the DLL
# attaches to its parent console or creates one as a last resort.
console=false

# set font file, which is located in \`data\` folder
# leave empty to use embedded font, which only supports Latin characters
font=""

# font size
font_size=32
# Runtime multiplier for the loaded font. Hot reloads while the game is open.
# Accepted range is 0.25 to 4.0.
font_scale=1

# accpeted charsets:
#  enUS, frFR, deDE, esES, esAR, itIT, ptBr -> Latin
#  jaJP -> Japanese
#  koKR -> Korean
#  plPL -> Latin with extra characters used by Polish
#  ruRU -> Cyrillic
#  thTH -> Thai
#  zhCN, zhTW -> CJK
# Leave empty to use engus
charset=""

# language used to load data file, if you set this to empty, engus will be used
language=""

[input]
# shortcut key to toggle full mode
toggle_full_mode="="
# shortcut key to trigger a mouse click
click_action="-"

[style]
text_color=[243,238,231,248]
check_mark_color=[86,184,148,230]
bg_color=[12,13,16,232]
border_color=[239,87,38,180]
button_color=[239,87,38,150]
button_hover_color=[255,117,64,170]
button_press_color=[169,54,22,230]
node_color=[23,23,28,160]
node_hover_color=[239,87,38,160]
node_press_color=[255,117,64,180]
scroll_bg_color=[12,13,16,160]
scroll_color=[239,87,38,160]
scroll_hover_color=[255,117,64,180]
scroll_press_color=[169,54,22,200]
border_width=2
rounding=4
panel_pos=[-10,10]
panel_dim=[0.30, 0.92]

[boss]
# data filename for boss list, which is located in \`data/<language>\` folder
data_file="all_bosses.json"

[overlay]
# Optional fixed compact-mode width in pixels. Remove this setting to size the
# compact window from its current text content.
# closed_width=320
# Show server-reported Automark status in the overlay when reporting is enabled.
show_ingest_tally = true
# how to display the text on the overlay
# display text = "IGT: {igt}$nBosses: {kills}/{total}$nGreat Runes: {runes}$nShards: {shards}$nDeaths: {deaths}"
#  $n = newline
#  {kills} = current kill count
#  {total} = total boss count
#  {deaths}= Death count in current game
#  {igt}   = In-game time
#  {shards}= Number of messmer's kindling shards acquired
#  {runes} = Number of great runes acquired
display_text = "Deaths: {deaths}"

[timer]
# Regular: elapsed IGT
# Timer: countdown from timer_minutes
# Prep: elapsed IGT offset by prep_minutes
# PrepTimer: preparation countdown followed by timer_minutes countdown
mode="Regular"
prep_minutes=2
timer_minutes=0

[victory]
# None: victory tracking is disabled.
# Checklist: complete after every boss in the selected [boss].data_file.
# BossIds: complete after every ID in boss_ids, whether or not listed in the checklist.
# OneBoss: complete after boss_id, whether or not listed in the checklist.
mode="None"

# BossIds example:
# mode="BossIds"
# boss_ids=[10000800,19000800]

# OneBoss example, Radagon and Elden Beast:
# mode="OneBoss"
# boss_id=19000800

[ingest]
# Reporting stays disabled until both values are supplied by a compatible
# generic webhook service.
url = "${url}"
token = "${token}"
interval_ms = 1000
heartbeat_s = 60
`;
}
