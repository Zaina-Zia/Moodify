import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("spotify_access_token")?.value;
  if (!token) return NextResponse.json({ ok: false, error: "Not logged in" }, { status: 200 });
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `Profile failed: ${res.status}`, details: txt }, { status: 200 });
  }
  const me = await res.json();
  return NextResponse.json({ ok: true, me });
}
