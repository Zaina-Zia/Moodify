import { NextRequest, NextResponse } from "next/server";

function randomString(len = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  let redirectUri = process.env.SPOTIFY_REDIRECT_URI?.trim();
  if (!redirectUri) {
    // Fallback to computed origin; you must also add this URI in Spotify dashboard
    redirectUri = `${req.nextUrl.origin}/api/auth/callback`;
    if (!process.env.SPOTIFY_REDIRECT_URI) {
      console.warn("[Auth] SPOTIFY_REDIRECT_URI not set. Using:", redirectUri);
    }
  }
  if (!clientId) {
    return NextResponse.json({ ok: false, error: "Missing SPOTIFY_CLIENT_ID" }, { status: 500 });
  }

  const state = randomString(16);
  const scope = [
    "user-read-email",
    "user-read-private",
    "user-top-read",
    "playlist-read-private",
  ].join(" ");

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scope);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  console.log("Redirect URI used:", redirectUri);
  console.log("✅ Redirecting user to Spotify authorization");
  const res = NextResponse.redirect(url.toString());
  res.cookies.set("spotify_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return res;
}
