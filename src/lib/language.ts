import { useCallback, useSyncExternalStore } from "react";

/**
 * The two languages the app can render in. Stored and read the same way colorblind mode is (see
 * teamColors.ts) - a plain localStorage flag, not a server-side preference, since it's a rendering
 * choice for this browser and not part of any match's state.
 */
export type Language = "en" | "fr";

const LANG_KEY = "eb_language";

/**
 * Every mounted useLanguage() call, so setLanguage() can wake all of them at once. A plain
 * module-level Set rather than React Context: this codebase already prefers a get/set pair backed
 * by localStorage (teamColors, sfx) over provider nesting, and useSyncExternalStore gives the same
 * "every subscriber re-renders together" guarantee a Context would, without wrapping the tree.
 */
const listeners = new Set<() => void>();

let current: Language = readStored();

function readStored(): Language {
  try {
    return localStorage.getItem(LANG_KEY) === "fr" ? "fr" : "en";
  } catch {
    return "en";
  }
}

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Preference just won't persist; the language still switches for this session.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the calling component whenever setLanguage() is called anywhere in the app. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/**
 * `t("English", "Français")` - no key, no central dictionary. Every UI string is translated at the
 * call site with its own French text right next to it, the same way title="..." already reads at a
 * glance; a key-based dictionary would just be a second place every string could go out of sync
 * with the one actually on screen.
 */
export function useT(): (en: string, fr: string) => string {
  const lang = useLanguage();
  // Memoized on `lang` alone, so `t` is stable across a render that didn't change language - which
  // is what lets callers put `t` in a useMemo/useCallback/useEffect dependency array and have it
  // recompute exactly when the language actually flips, not on every unrelated re-render.
  return useCallback((en: string, fr: string) => (lang === "fr" ? fr : en), [lang]);
}
