import { NextResponse, type NextRequest } from "next/server";
import { LOGIN, SESSION_COOKIE, authEnabled, isSignedIn } from "@/lib/auth/site";
import { BASE_PATH } from "@/lib/basePath";

// Matchers and request.nextUrl.pathname are relative to basePath (/pointcloud):
// "/" here is /pointcloud in the browser. With a login configured (Docker), every
// page needs a session; without one (local development), nothing does. /tonga is
// the old static data path under public/: closed outright, so the files can only
// ever be read through the guarded /data route.
export const config = {
  matcher: ["/", "/products", "/products/:path*", "/data/:path*", "/tonga/:path*"],
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/tonga/")) return new NextResponse("Not found", { status: 404 });

  if (!authEnabled() || (await isSignedIn(request.cookies.get(SESSION_COOKIE)?.value))) {
    return NextResponse.next();
  }

  // The data route answers for itself (401); pages go to the login screen.
  if (pathname.startsWith("/data/")) return NextResponse.next();
  const next = pathname === "/" ? BASE_PATH : `${BASE_PATH}${pathname}`;
  return NextResponse.redirect(publicUrl(request, `${LOGIN}?${new URLSearchParams({ next })}`));
}

/**
 * The address the visitor used. Behind Docker or a reverse proxy the server's
 * own (e.g. 0.0.0.0:3000) is wrong, and proxy redirects must be absolute.
 */
function publicUrl(request: NextRequest, path: string): URL {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  return new URL(path, `${proto}://${host.split(",")[0].trim()}`);
}
