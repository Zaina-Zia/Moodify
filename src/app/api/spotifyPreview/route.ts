import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

const PER_FETCH_TIMEOUT_MS = 3000; // cap each Spotify HTTP call to avoid 504s
const PER_TRACK_DEADLINE_MS = 6000; // cap total work per input track

// -------- Types --------
export type InputTrack = {
  title: string;
  artist: string;
  recording_mbid?: string;
};

type Payload = {
  tracks: InputTrack[];
  spotify_token?: string;
  limit_per_track_search?: number; // default 1
  concurrency_limit?: number; // default 4
  mood?: string | null; // passthrough to response
  market?: string; // optional market (e.g., "US")
};

// -------- Env token (client credentials) --------
async function getSpotifyTokenFromEnv(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Missing SPOTIFY_CLIENT_ID/SECRET in env");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: body.toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

// ---- MusicBrainz helpers (for better identity + cover art) ----
async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = PER_FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { ...(init || {}), cache: "no-store", signal: ctrl.signal });
    clearTimeout(to);
    return res;
  } catch (e) {
    clearTimeout(to);
    throw e;
  }
}

type MBDetails = { isrcs: string[]; coverUrl?: string };
async function fetchMBRecordingDetails(mbid: string): Promise<MBDetails | null> {
  try {
    const u = new URL(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(mbid)}`);
    u.searchParams.set("fmt", "json");
    u.searchParams.set("inc", "isrcs+releases");
    const res = await fetchWithTimeout(u.toString(), { headers: { Accept: "application/json", "User-Agent": "Moodify/1.0 (playlist)" } });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    const isrcs: string[] = Array.isArray(j?.isrcs) ? j.isrcs.filter((x: any) => typeof x === 'string') : [];
    // pick first release with coverart
    let coverUrl: string | undefined;
    const rels: any[] = Array.isArray(j?.releases) ? j.releases : [];
    for (const r of rels) {
      if (r?.id && r?.['cover-art-archive']?.front) {
        coverUrl = `https://coverartarchive.org/release/${encodeURIComponent(r.id)}/front-500`;
        break;
      }
    }
    return { isrcs, coverUrl };
  } catch {
    return null;
  }
}

async function searchByISRC(bearer: string, isrc: string, market?: string) {
  const u = new URL("https://api.spotify.com/v1/search");
  u.searchParams.set("q", `isrc:${isrc}`);
  u.searchParams.set("type", "track");
  u.searchParams.set("limit", "1");
  if (market) u.searchParams.set("market", market);
  const res = await fetchSpotify(u.toString(), bearer);
  if (!res.ok) return [] as any[];
  const j = (await res.json()) as any;
  return (j?.tracks?.items ?? []) as any[];
}

// -------- Spotify fetch with retry & 429 handling --------
async function fetchSpotify(url: string, bearer: string, init?: RequestInit, retries = 2): Promise<Response> {
  let attempt = 0;
  let lastErr: any = null;
  while (attempt <= retries) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort("timeout"), PER_FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        ...(init || {}),
        headers: {
          ...(init?.headers || {}),
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
        } as any,
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(to);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") || "1");
        await new Promise((r) => setTimeout(r, Math.max(0, retryAfter) * 1000));
        attempt++;
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        // 5xx retry with backoff
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 300));
        attempt++;
        continue;
      }

      return res; // return even if not ok; caller decides
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 300));
      attempt++;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("Spotify fetch failed");
}

// -------- Helpers --------
function pickAlbumImage(images: any[] | undefined): string | undefined {
  if (!Array.isArray(images) || !images.length) return undefined;
  // Prefer index 1 (medium), then 0
  return images?.[1]?.url || images?.[0]?.url || images?.[images.length - 1]?.url;
}

function buildTrackObject(t: any, mbid?: string) {
  const title = t?.name ?? "";
  const artists = Array.isArray(t?.artists) ? t.artists.map((a: any) => a?.name).filter(Boolean).join(", ") : "";
  const albumName = t?.album?.name ?? "";
  const cover = pickAlbumImage(t?.album?.images) || "";
  const previewUrl = t?.preview_url ?? null;
  const spotifyId = t?.id ?? undefined;
  const spotifyUrl = t?.external_urls?.spotify || (spotifyId ? `https://open.spotify.com/track/${spotifyId}` : undefined);
  const duration_ms = typeof t?.duration_ms === "number" ? t.duration_ms : undefined;

  return {
    title,
    artist: artists,
    spotify_id: spotifyId,
    spotify_url: spotifyUrl,
    album: albumName,
    cover,
    preview_available: Boolean(previewUrl),
    preview_url: previewUrl,
    duration_ms,
    listenbrainz_mbid: mbid || undefined,
  };
}

function sanitizeText(s: string): string {
  // remove (feat. ..), [..], extra punctuation commonly harming search
  let out = s.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "");
  out = out.replace(/\bfeat\.?\b.*$/i, "").replace(/\bft\.?\b.*$/i, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

async function searchByMBID(bearer: string, mbid: string, limit: number, market?: string) {
  const u = new URL("https://api.spotify.com/v1/search");
  u.searchParams.set("q", `mbid:${mbid}`);
  u.searchParams.set("type", "track");
  u.searchParams.set("limit", String(Math.max(1, limit)));
  if (market) u.searchParams.set("market", market);
  const res = await fetchSpotify(u.toString(), bearer);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const items = (json?.tracks?.items ?? []) as any[];
  return items;
}

async function searchByText(bearer: string, title: string, artist: string, limit: number, market?: string) {
  const make = async (q: string, lim: number) => {
    const u = new URL("https://api.spotify.com/v1/search");
    u.searchParams.set("q", q);
    u.searchParams.set("type", "track");
    u.searchParams.set("limit", String(Math.max(1, lim)));
    if (market) u.searchParams.set("market", market);
    const res = await fetchSpotify(u.toString(), bearer);
    if (!res.ok) return [] as any[];
    const json = (await res.json()) as any;
    return (json?.tracks?.items ?? []) as any[];
  };

  const exact = await make(`track:"${title.replace(/"/g, "")}" artist:"${artist.replace(/"/g, "")}"`, limit);
  if (exact.length) return exact;

  // Relaxed in order
  const q1 = await make(`track:"${title.replace(/"/g, "")}"`, limit);
  if (q1.length) return q1;
  const q2 = await make(`artist:"${artist.replace(/"/g, "")}"`, limit);
  if (q2.length) return q2;
  const q3 = await make(`${title} ${artist}`, limit);
  return q3;
}

async function getTrackById(bearer: string, id: string, market?: string) {
  const u = new URL(`https://api.spotify.com/v1/tracks/${encodeURIComponent(id)}`);
  if (market) u.searchParams.set("market", market);
  const res = await fetchSpotify(u.toString(), bearer);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  return json;
}

async function searchAlbumAndTryPreview(bearer: string, albumName: string, market?: string) {
  if (!albumName) return null;
  const u = new URL("https://api.spotify.com/v1/search");
  u.searchParams.set("q", `album:\"${albumName.replace(/\"/g, "")}\"`);
  u.searchParams.set("type", "album");
  u.searchParams.set("limit", "1");
  if (market) u.searchParams.set("market", market);
  const res = await fetchSpotify(u.toString(), bearer);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const album = (json?.albums?.items ?? [])[0];
  if (!album?.id) return null;

  const u2 = new URL(`https://api.spotify.com/v1/albums/${encodeURIComponent(album.id)}/tracks`);
  if (market) u2.searchParams.set("market", market);
  const res2 = await fetchSpotify(u2.toString(), bearer);
  if (!res2.ok) return null;
  const json2 = (await res2.json()) as any;
  const tracks = (json2?.items ?? []) as any[];
  for (const t of tracks) {
    const full = await getTrackById(bearer, t?.id, market);
    if (full?.preview_url) return full;
  }
  return null;
}

// Simple concurrency limiter
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let nextIndex = 0;
  let running: Promise<void>[] = [];

  const run = async (i: number) => {
    try {
      results[i] = await worker(items[i], i);
    } catch (e: any) {
      results[i] = e as any;
    }
  };

  while (nextIndex < items.length || running.length) {
    while (nextIndex < items.length && running.length < limit) {
      const idx = nextIndex++;
      const p = run(idx).finally(() => {
        running = running.filter((r) => r !== p);
      });
      running.push(p);
    }
    if (running.length) await Promise.race(running);
  }

  return results;
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as Payload;
    const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
    const limitPer = Math.max(1, payload.limit_per_track_search ?? 3);
    const market = (payload.market?.trim() || 'US');
    if (!tracks.length) return NextResponse.json({ results: [] });

    // Dynamically import the finder to avoid build-time resolution issues
    let finderMod: any = null;
    try {
      finderMod = await import('spotify-preview-finder');
    } catch {}
    const finder: any = finderMod?.default || finderMod?.findPreview || finderMod?.searchPreview || finderMod;

    if (typeof finder !== 'function') {
      const results = tracks.map((t) => ({ title: t?.title || '', artist: t?.artist || '', previews: [], error: 'spotify-preview-finder_unavailable' }));
      return NextResponse.json({ results });
    }

    const CONCURRENCY = 4;
    const PER_TRACK_TIMEOUT_MS = 6000;

    async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)) as any,
      ]);
    }

    function normalizeFromFinder(raw: any): Array<{ name: string; preview_url: string | null; spotify_url: string | null }> {
      // The package returns: { success: boolean, searchQuery: string, results: [{ name, albumName, trackId, previewUrls: [url...] }] }
      // Fallback: If raw is already an array, attempt simple normalization.
      const out: Array<{ name: string; preview_url: string | null; spotify_url: string | null }> = [];
      if (raw && typeof raw === 'object' && Array.isArray(raw.results)) {
        for (const r of raw.results) {
          const baseName = String(r?.name || '').trim();
          const trackId = r?.trackId ? String(r.trackId) : undefined;
          const spotUrl = trackId ? `https://open.spotify.com/track/${trackId}` : null;
          const urls: string[] = Array.isArray(r?.previewUrls) ? r.previewUrls.filter((u: any) => typeof u === 'string') : [];
          if (urls.length) {
            for (const u of urls) out.push({ name: baseName, preview_url: u, spotify_url: spotUrl });
          } else {
            out.push({ name: baseName, preview_url: null, spotify_url: spotUrl });
          }
        }
        return out;
      }
      if (Array.isArray(raw)) {
        return raw
          .map((it) => {
            const name = String(it?.name || it?.title || '').trim();
            const preview_url = it?.preview_url || it?.previewUrl || null;
            const spotify_url = it?.spotify_url || it?.external_urls?.spotify || (it?.id ? `https://open.spotify.com/track/${it.id}` : null);
            if (!name && !preview_url && !spotify_url) return null;
            return { name, preview_url, spotify_url };
          })
          .filter(Boolean) as any;
      }
      return [];
    }

    let next = 0;
    const out = new Array(tracks.length);
    async function worker() {
      while (next < tracks.length) {
        const i = next++;
        const t = tracks[i] || {};
        const title = String(t?.title || '').trim();
        const artist = String(t?.artist || '').trim();
        if (!title && !artist) {
          out[i] = { title, artist, previews: [], error: 'missing_title_or_artist' };
          continue;
        }
        try {
          // The library expects positional args: (title, artist, limit, market)
          const call = async () => {
            try { return await finder(title, artist, limitPer, market); } catch {}
            try { return await finder(title, artist, limitPer); } catch {}
            // Try alternative shapes if exported differently
            if (typeof finder.findPreview === 'function') return await finder.findPreview(title, artist, limitPer, market);
            if (typeof finder.searchPreview === 'function') return await finder.searchPreview(title, artist, limitPer, market);
            throw new Error('finder_no_callable');
          };

          const raw = await withTimeout(call(), PER_TRACK_TIMEOUT_MS, `preview_finder ${title} — ${artist}`);
          const previews = normalizeFromFinder(raw);
          out[i] = { title, artist, previews: previews.slice(0, limitPer) };
          if (!previews.length) (out[i] as any).error = 'no_preview_found';
        } catch (e: any) {
          out[i] = { title, artist, previews: [], error: String(e?.message || 'finder_error') };
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, () => worker());
    await Promise.all(workers);

    const filtered = out.filter((r) => Array.isArray(r?.previews) && r.previews.length > 0);
    return NextResponse.json({ results: filtered });
  } catch (err: any) {
    return NextResponse.json({ results: [], error: err?.message || 'server_error' }, { status: 200 });
  }
}
