import type { NextRequest } from "next/server";
import { LOGIN, SESSION_COOKIE, SITE_PASSWORD, safeNext, sessionToken } from "@/lib/auth/site";
import { BASE_PATH } from "@/lib/basePath";

// A plain Response with a relative Location. Behind Docker or a reverse proxy
// the server's own idea of its address (e.g. 0.0.0.0:3000) is not the one the
// visitor used, and NextResponse would turn a relative Location into that.
function redirect(location: string, cookie?: string) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = safeNext(form.get("next"));

  if (form.get("password") !== SITE_PASSWORD) {
    return redirect(`${LOGIN}?${new URLSearchParams({ error: "1", next })}`);
  }

  const cookie = [
    `${SESSION_COOKIE}=${await sessionToken()}`,
    `Path=${BASE_PATH}`, // only sent to this app, not the rest of the domain
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${60 * 60 * 12}`, // signed in for 12 hours
    ...(process.env.COOKIE_SECURE === "true" ? ["Secure"] : []),
  ].join("; ");
  return redirect(next, cookie);
}
