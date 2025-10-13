import { NextRequest, NextResponse } from "next/server";

export async function GET(_req: NextRequest) {
  const res = NextResponse.redirect("/");
  // Clear tokens
  res.cookies.set("spotify_access_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("spotify_refresh_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("spotify_oauth_state", "", { path: "/", maxAge: 0 });
  return res;
}
