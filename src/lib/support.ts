import { supabase } from "./supabase";

declare const __BUILD_ID__: string;

/**
 * The browser's half of the support form: what to send, and how to make a screenshot small enough
 * to send it with.
 *
 * Nothing here decides anything. The endpoint re-checks every cap and ignores every claim the
 * client makes about itself, because a public endpoint has to assume the browser is not the only
 * thing calling it. These limits exist so an honest player gets a useful error before uploading
 * four megabytes rather than after.
 */

export const CATEGORIES = [
  { id: "auto-marking", label: "Auto-marking" },
  { id: "match", label: "Match bug" },
  { id: "account", label: "Account or sign-in" },
  { id: "other", label: "Something else" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const MAX_MESSAGE = 4000;

/** Longest edge a screenshot is scaled down to. Wide enough to still read a board's square text. */
const MAX_EDGE = 1920;

/** Above this, PNG is abandoned for JPEG. Roughly where an email attachment stops being polite. */
const PNG_BUDGET_BYTES = 1_200_000;

/** The endpoint's own ceiling, checked here so the failure arrives before the upload does. */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export interface Screenshot {
  filename: string;
  /** base64, no `data:` prefix - what Resend wants for an attachment. */
  content: string;
  /** For the preview thumbnail. */
  previewUrl: string;
  bytes: number;
}

/**
 * Turns a pasted or picked image into an attachment.
 *
 * PNG first and JPEG only as a fallback, because most screenshots worth sending are of *text* - a
 * board full of square names, an overlay line, an error message - and JPEG at any quality turns
 * small text into mush. The size check picks the format rather than a quality slider, so a small
 * screenshot stays lossless and a huge one still arrives.
 *
 * Re-encoded through a canvas rather than forwarded as-is on purpose: it drops EXIF, which on a
 * phone photo of a monitor carries GPS coordinates. Nobody sending a bug report expects to send
 * their address with it.
 */
export async function prepareScreenshot(file: File): Promise<Screenshot> {
  if (!file.type.startsWith("image/")) throw new Error("That isn't an image.");

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read that image.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let blob = await toBlob(canvas, "image/png");
  let extension = "png";
  if (blob.size > PNG_BUDGET_BYTES) {
    blob = await toBlob(canvas, "image/jpeg", 0.85);
    extension = "jpg";
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error("That image is too big to send.");

  return {
    filename: `screenshot.${extension}`,
    content: await toBase64(blob),
    previewUrl: URL.createObjectURL(blob),
    bytes: blob.size,
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't read that image."))),
      type,
      quality
    );
  });
}

/** FileReader rather than a byte loop: a 4MB `String.fromCharCode(...)` blows the argument limit. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that image."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

/**
 * What the browser knows about itself that a reporter would never think to type.
 *
 * `room` is the point of it. Most reports are about a specific match, and the room code is both the
 * first thing needed to look into one and the last thing anybody remembers to include.
 */
function collectContext(): Record<string, string> {
  const room = /#\/(?:room|cast|overlay[a-z-]*)\/([^/?]+)/i.exec(window.location.hash)?.[1];
  return {
    build: typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "unknown",
    ...(room ? { room: decodeURIComponent(room) } : {}),
    browser: navigator.userAgent,
    screen: `${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}x`,
    language: navigator.language,
  };
}

export interface SupportSubmission {
  category: CategoryId;
  message: string;
  discord: string;
  screenshot: Screenshot | null;
  /** The honeypot. Always empty when a human filled the form in. */
  website: string;
}

/**
 * Sends the report.
 *
 * Invoked through `supabase.functions.invoke` so the caller's access token rides along in the
 * Authorization header when there is one. There need not be: the endpoint runs with JWT
 * verification off precisely so that somebody whose sign-in is broken can report that it is.
 */
export async function submitSupportReport(submission: SupportSubmission): Promise<void> {
  const { data, error } = await supabase.functions.invoke("support", {
    body: {
      category: submission.category,
      message: submission.message,
      discord: submission.discord,
      website: submission.website,
      context: collectContext(),
      screenshot: submission.screenshot
        ? { filename: submission.screenshot.filename, content: submission.screenshot.content }
        : null,
    },
  });

  if (error) throw new Error(readableError(error));
  if (data && data.ok === false) throw new Error(readableError(data.error));
}

/** Endpoint codes are for logs. These are for the person who just lost what they typed. */
function readableError(err: unknown): string {
  const code = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  if (code.includes("rate_limited")) return "That's a lot of reports in one hour. Try again later.";
  if (code.includes("screenshot_too_large")) return "That screenshot is too big to send.";
  if (code.includes("empty_message")) return "Tell me what happened first.";
  return "Couldn't send that. Check your connection and try again.";
}
