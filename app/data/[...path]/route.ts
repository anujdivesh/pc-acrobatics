import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, isSignedIn } from "@/lib/auth/site";

/**
 * The only way to the survey data: /data/<path> -> $DATA_DIR/<path>.
 *
 * Nothing that renders in a browser can be made impossible to copy, but this
 * makes the raw files hard to take:
 *   - product files need a signed-in session (the viewer's data is public);
 *   - requests must come from this app's own pages (Sec-Fetch-Site), so the
 *     address typed into a browser, a hotlink or a bare script gets nothing;
 *   - the big files (COPC, PMTiles) are only ever served in pieces, never whole;
 *   - each session has a download budget, so bulk scraping is slow;
 *   - no listings, only known file types, and no path can leave DATA_DIR.
 */

export const runtime = "nodejs";

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "public"));
const MAX_RANGE = Number(process.env.DATA_MAX_RANGE_MB || 16) * 1024 * 1024;
const BUDGET = Number(process.env.DATA_RATE_MB || 600) * 1024 * 1024;
const WINDOW_MS = Number(process.env.DATA_RATE_WINDOW_S || 900) * 1000;

/** Only these need a session; the rest is what the public viewer loads. */
const PROTECTED = ["tonga/products/"];

const TYPES: Record<string, { type: string; rangeOnly: boolean }> = {
  ".laz": { type: "application/octet-stream", rangeOnly: true },
  ".pmtiles": { type: "application/octet-stream", rangeOnly: true },
  ".geojson": { type: "application/geo+json", rangeOnly: false },
  ".json": { type: "application/json", rangeOnly: false },
  ".png": { type: "image/png", rangeOnly: false },
};

// Bytes served per client in the current window. In-memory: one container.
const usage = new Map<string, { start: number; bytes: number }>();

function spend(client: string, bytes: number): number | null {
  const now = Date.now();
  let u = usage.get(client);
  if (!u || now - u.start > WINDOW_MS) {
    u = { start: now, bytes: 0 };
    usage.set(client, u);
  }
  if (u.bytes + bytes > BUDGET) return Math.ceil((u.start + WINDOW_MS - now) / 1000);
  u.bytes += bytes;
  if (usage.size > 10_000) {
    for (const [k, v] of usage) if (now - v.start > WINDOW_MS) usage.delete(k);
  }
  return null;
}

function deny(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain", ...headers } });
}

/** A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range, or null if unusable. */
function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : null;
}

export async function GET(request: NextRequest, ctx: RouteContext<"/data/[...path]">) {
  // Resolve first and judge the real path, so ".." can't dodge the checks below.
  const { path: parts } = await ctx.params;
  const file = path.resolve(DATA_DIR, ...parts);
  if (!file.startsWith(DATA_DIR + path.sep)) return deny(404, "Not found.");
  const relative = path.relative(DATA_DIR, file).split(path.sep).join("/");

  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const signedIn = await isSignedIn(session);
  if (!signedIn && PROTECTED.some((p) => relative.startsWith(p))) return deny(401, "Sign in first.");

  // Browsers mark every request with where it came from. Only this app's pages
  // may load data; typing the address or linking from elsewhere does not work.
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return deny(403, "Data can only be loaded by the viewer.");
  }

  const kind = TYPES[path.extname(file).toLowerCase()];
  if (!kind) return deny(404, "Not found.");

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return deny(404, "Not found.");
    size = info.size;
  } catch {
    return deny(404, "Not found.");
  }

  const headers: Record<string, string> = {
    "Content-Type": kind.type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };

  const rangeHeader = request.headers.get("range");
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (rangeHeader) {
    const r = parseRange(rangeHeader, size);
    if (!r) return deny(416, "Bad range.", { "Content-Range": `bytes */${size}` });
    [start, end] = r;
    status = 206;
  } else if (kind.rangeOnly) {
    return deny(403, "This file is only served in pieces.");
  }

  const length = end - start + 1;
  if (length > MAX_RANGE) return deny(416, "Range too large.", { "Content-Range": `bytes */${size}` });

  // Budget per session when signed in, per address otherwise.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
  const client = signedIn ? `session:${session}|${ip}` : `ip:${ip}`;
  const retry = spend(client, length);
  if (retry !== null) return deny(429, "Download limit reached; try again later.", { "Retry-After": String(retry) });

  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  headers["Content-Length"] = String(length);
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, { status, headers });
}
