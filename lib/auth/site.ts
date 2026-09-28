import { BASE_PATH, withBase } from "@/lib/basePath";

/**
 * Login for the whole app, configured from the environment:
 *   APP_USERNAME + APP_PASSWORD set  -> every page and every data file needs a login
 *   either unset                     -> no login at all (local development)
 *
 * In Docker both come from docker/.env. Everything is checked on the server
 * (proxy.ts, the login route, the data route), so the credentials never reach
 * the browser. Values are read per call, at runtime, not baked in at build.
 */

export const SESSION_COOKIE = "pop_session";

/** Public paths, basePath included: what the browser sees. */
export const HOME = BASE_PATH;
export const LOGIN = withBase("/login");

const username = () => process.env.APP_USERNAME ?? "";
const password = () => process.env.APP_PASSWORD ?? "";
// Without a configured secret, fall back to one derived from the credentials:
// still unguessable without them, just not rotatable on its own.
const secret = () => process.env.AUTH_SECRET || `pop:${username()}:${password()}`;

export const authEnabled = () => username() !== "" && password() !== "";

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal-length digests compared in constant time, so timing reveals nothing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function checkCredentials(user: unknown, pass: unknown): Promise<boolean> {
  if (!authEnabled() || typeof user !== "string" || typeof pass !== "string") return false;
  const [u, p] = await Promise.all([sameSecret(user, username()), sameSecret(pass, password())]);
  return u && p;
}

/** The cookie value a correct login earns: never the credentials themselves. */
export const sessionToken = () => sha256(`${secret()}:${username()}:${password()}`);

/** True when no login is configured, or the cookie is a valid session. */
export async function isSignedIn(cookie: string | undefined): Promise<boolean> {
  if (!authEnabled()) return true;
  return !!cookie && (await sameSecret(cookie, await sessionToken()));
}

/** Only ever send people back to a page of this app. */
export function safeNext(next: unknown): string {
  if (typeof next !== "string") return HOME;
  const inside = next === BASE_PATH || next.startsWith(`${BASE_PATH}/`) || next.startsWith(`${BASE_PATH}?`);
  return inside && !next.startsWith("//") ? next : HOME;
}
