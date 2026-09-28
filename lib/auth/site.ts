/**
 * Password gate for the whole site and its data.
 *
 * Checked on the server only (proxy.ts, the login route and the data route), so
 * the password never reaches the browser. In Docker set APP_PASSWORD and
 * AUTH_SECRET; the hardcoded values are only a fallback.
 */
export const SITE_PASSWORD = process.env.APP_PASSWORD || "Ocean1234";
const AUTH_SECRET = process.env.AUTH_SECRET || "pacific-ocean-portal";
export const SESSION_COOKIE = "pop_session";
import { BASE_PATH, withBase } from "@/lib/basePath";

/** Paths below are public paths, basePath included: what the browser sees. */
export const HOME = BASE_PATH;
export const LOGIN = withBase("/login");

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cookie value a correct login earns: never the password itself. */
export const sessionToken = () => sha256(`${AUTH_SECRET}:${SITE_PASSWORD}`);

export async function isSignedIn(cookie: string | undefined): Promise<boolean> {
  return !!cookie && cookie === (await sessionToken());
}

/** Only ever send people back to a page of this app. */
export function safeNext(next: unknown): string {
  if (typeof next !== "string") return HOME;
  const inside = next === BASE_PATH || next.startsWith(`${BASE_PATH}/`) || next.startsWith(`${BASE_PATH}?`);
  return inside && !next.startsWith("//") ? next : HOME;
}
