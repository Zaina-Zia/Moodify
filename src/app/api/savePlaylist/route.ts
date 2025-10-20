import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type InTrack = { title: string; artist: string; spotifyUrl?: string };

function getUserAccessToken(req: NextRequest): string | undefined {
  return req.cookies.get("spotify_access_token")?.value?.trim();
}

function extractTrackIdFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    // Expect https://open.spotify.com/track/{id}
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p === "track");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {}
  return undefined;
}

async function fetchWithRetry(input: string | URL, init: RequestInit & { timeoutMs?: number } = {}, retries = 2, backoffMs = 400): Promise<Response> {
  let attempt = 0;
  let lastErr: any;
  const timeoutMs = init.timeoutMs ?? 10000;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(typeof input === "string" ? input : input.toString(), { ...init, signal: ctrl.signal });
      clearTimeout(id);
      return res;
    } catch (e) {
      clearTimeout(id);
      lastErr = e;
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
      attempt++;
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

async function searchSpotifySingle(token: string, title: string, artist: string): Promise<{ id?: string } | null> {
  const tryQueries = [
    `track:"${title.replace(/"/g, '')}" artist:"${artist.replace(/"/g, '')}"`,
    `${title} ${artist}`,
    `${title}`,
  ];
  for (const q of tryQueries) {
    const u = new URL("https://api.spotify.com/v1/search");
    u.searchParams.set("q", q);
    u.searchParams.set("type", "track");
    u.searchParams.set("limit", "1");
    u.searchParams.set("market", "US");
    const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!res.ok) continue;
    const json = (await res.json()) as any;
    const item = (json?.tracks?.items ?? [])[0];
    if (item?.id) return { id: item.id };
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const token = getUserAccessToken(req);
    if (!token) return NextResponse.json({ ok: false, error: "Not logged in" }, { status: 401 });

    const body = (await req.json()) as {
      name?: string;
      description?: string;
      tracks: InTrack[];
      isPublic?: boolean;
    };

    const name = (body.name || "Moodify Playlist").slice(0, 100);
    const description = (body.description || "Created with Moodify").slice(0, 300);
    const isPublic = Boolean(body.isPublic);
    const items = Array.isArray(body.tracks) ? body.tracks : [];
    if (!items.length) return NextResponse.json({ ok: false, error: "No tracks provided" }, { status: 400 });

    const meRes = await fetchWithRetry("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!meRes.ok) {
      const txt = await meRes.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Profile failed: ${meRes.status}`, details: txt }, { status: 400 });
    }
    const me = (await meRes.json()) as any;
    const userId = String(me?.id || "");
    if (!userId) return NextResponse.json({ ok: false, error: "User id not found" }, { status: 400 });

    const ids: string[] = [];
    for (const t of items) {
      const byUrl = extractTrackIdFromUrl(t.spotifyUrl);
      if (byUrl) {
        ids.push(byUrl);
        continue;
      }
      const found = await searchSpotifySingle(token, t.title, t.artist);
      if (found?.id) ids.push(found.id);
    }
    const uris = ids.map((id) => `spotify:track:${id}`);
    if (!uris.length) return NextResponse.json({ ok: false, error: "Could not resolve any tracks on Spotify" }, { status: 400 });

    const createRes = await fetchWithRetry(`https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, description, public: isPublic }),
      cache: "no-store",
    });
    if (!createRes.ok) {
      const txt = await createRes.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Create playlist failed: ${createRes.status}`, details: txt }, { status: 400 });
    }
    const playlist = (await createRes.json()) as any;
    const playlistId = String(playlist?.id || "");
    const playlistUrl = String(playlist?.external_urls?.spotify || (playlistId ? `https://open.spotify.com/playlist/${playlistId}` : ""));
    if (!playlistId) return NextResponse.json({ ok: false, error: "No playlist id returned" }, { status: 400 });

    // Spotify limits to 100 per request
    const chunk = (arr: string[], size: number) => arr.reduce<string[][]>((acc, _, i) => (i % size ? acc : [...acc, arr.slice(i, i + size)]), []);
    const chunks = chunk(uris, 100);
    for (const part of chunks) {
      const addRes = await fetchWithRetry(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: part }),
        cache: "no-store",
      });
      if (!addRes.ok) {
        const txt = await addRes.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Add tracks failed: ${addRes.status}`, details: txt }, { status: 400 });
      }
    }

    return NextResponse.json({ ok: true, playlistId, playlistUrl });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
