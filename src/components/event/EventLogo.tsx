import { useState } from "react";
import { eventLogoUrl } from "../../lib/tournament/api";

/**
 * An event's logo, sized in rem (or any CSS length, for one that must also shrink on a phone). Unlike a
 * team's there is no stand-in: an event without a logo (or whose logo fails to load) shows nothing at
 * all, so the banner or header reads exactly as it did before.
 * Decorative - the event's name is always right beside it.
 */
export function EventLogo({ path, size, className }: { path: string | null | undefined; size: number | string; className?: string }) {
  const url = eventLogoUrl(path);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return null;
  const side = typeof size === "number" ? `${size}rem` : size;
  return (
    <img
      className={`event-logo${className ? ` ${className}` : ""}`}
      style={{ width: side, height: side }}
      src={url}
      alt=""
      decoding="async"
      onError={() => setFailed(url)}
    />
  );
}
