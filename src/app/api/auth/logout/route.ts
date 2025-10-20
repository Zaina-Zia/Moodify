import { NextRequest, NextResponse } from "next/server";

function buildClearedResponse(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const res = NextResponse.redirect(new URL("/", origin));
  const secure = origin.startsWith("https://");
  const common = { httpOnly: true as const, secure, sameSite: secure ? ("none" as const) : ("lax" as const), path: "/", maxAge: 0 };
  // Clear tokens with attributes matching how they were set
  res.cookies.set("spotify_access_token", "", common);
  res.cookies.set("spotify_refresh_token", "", common);
  res.cookies.set("spotify_oauth_state", "", { ...common, httpOnly: true });
  // Extra safety: set Cache-Control to avoid caching redirects
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: NextRequest) {
  return buildClearedResponse(req);
}

export async function POST(req: NextRequest) {
  return buildClearedResponse(req);
}
