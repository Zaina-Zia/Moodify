import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI?.trim() || `${req.nextUrl.origin}/api/auth/callback`;
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json({ ok: false, error: "Missing Spotify envs" }, { status: 500 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("spotify_oauth_state")?.value;

  console.log("Redirect URI used:", redirectUri);
  console.log("Authorization code received:", Boolean(code));
  if (!code || !state || !cookieState || state !== cookieState) {
    return NextResponse.json({ ok: false, error: "Invalid OAuth state" }, { status: 400 });
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => "");
    console.error("❌ Token exchange failed:", tokenRes.status, txt);
    return NextResponse.json({ ok: false, error: `Token exchange failed: ${tokenRes.status}`, details: txt }, { status: 400 });
  }

  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
    scope: string;
  };

  console.log("✅ Token successfully received");
  const res = NextResponse.redirect("/");
  // Store tokens in httpOnly cookies; secure depends on protocol
  const secure = redirectUri.startsWith("https://");
  res.cookies.set("spotify_access_token", tokenJson.access_token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(3000, (tokenJson.expires_in ?? 3600) - 60),
  });
  if (tokenJson.refresh_token) {
    res.cookies.set("spotify_refresh_token", tokenJson.refresh_token, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  // Clear state cookie
  res.cookies.set("spotify_oauth_state", "", { path: "/", maxAge: 0 });
  return res;
}
