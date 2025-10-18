import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs"; // Ensure Node runtime (Buffer + standard fetch)

// Minimal Track type to match frontend expectations
export type Track = {
  title: string;
  artist: string;
  cover: string;
  previewUrl?: string | null;
  spotifyUrl?: string;
};

type Payload = {
  mood?: string;
  prompt?: string;
};

// Map moods to Spotify recommendations seed genres (VALID seeds only)
// Reference: https://api.spotify.com/v1/recommendations/available-genre-seeds
const MOOD_TO_SEEDS: Record<string, string> = {
  Happy: "pop,dance,party",
  Chill: "chill,ambient,study,sleep",
  Sad: "sad,acoustic,piano",
  Energetic: "edm,rock,work-out,dance",
  Romantic: "romance,soul,r-n-b",
  Focus: "study,ambient,piano",
};

const SAFE_GENRE_SEEDS = [
  "pop",
  "rock",
  "dance",
  "edm",
  "chill",
  "hip-hop",
  "indie",
  "acoustic",
  "soul",
  "r-n-b",
];

// ListenBrainz integration
const LB_BASE = "https://api.listenbrainz.org/1";
const LB_RANGES = ["month", "year", "all_time"] as const;
const LB_MAX = 100; // upper bound to fetch before filtering

const MOOD_KEYWORDS: Record<string, string[]> = {
  Happy: ["happy", "party", "dance", "upbeat"],
  Chill: ["chill", "ambient", "lofi", "calm", "relax"],
  Sad: ["sad", "melancholy", "blue", "ballad", "tear"],
  Energetic: ["energy", "edm", "rock", "club", "hype"],
  Romantic: ["love", "romance", "kiss", "heart"],
  Focus: ["instrumental", "study", "piano", "ambient"],
};

// MusicBrainz integration
const MB_BASE = "https://musicbrainz.org/ws/2";
type MBRecording = { id: string; title: string; artist: string };

async function fetchMusicBrainzByTag(tag: string, limit = 25): Promise<MBRecording[]> {
  const url = new URL(`${MB_BASE}/recording`);
  url.searchParams.set("query", `tag:${tag}`);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "Moodify/1.0 (playlist generator)" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[MusicBrainz] search failed:", res.status, body);
    return [];
  }

// Fetch top tracks for a list of artists using the user token
async function fetchArtistsTopTracks(userToken: string, artistIds: string[], market = "US", perArtist = 2, cap = 8): Promise<Track[]> {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const id of artistIds) {
    try {
      const u = new URL(`https://api.spotify.com/v1/artists/${encodeURIComponent(id)}/top-tracks`);
      u.searchParams.set("market", market);
      const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" });
      if (!res.ok) continue;
      const j = (await res.json()) as any;
      const tracks: any[] = j?.tracks ?? [];
      let added = 0;
      for (const t of tracks) {
        const key = `${t?.name}@@${(t?.artists?.map((a: any) => a?.name) ?? []).join(', ')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          title: t?.name ?? "",
          artist: (t?.artists?.map((a: any) => a?.name) ?? []).join(", "),
          cover: t?.album?.images?.[1]?.url || t?.album?.images?.[0]?.url || "",
          previewUrl: t?.preview_url || null,
          spotifyUrl: t?.external_urls?.spotify || (t?.id ? `https://open.spotify.com/track/${t.id}` : undefined),
        });
        added++;
        if (added >= perArtist) break;
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    } catch {}
  }
  return out;
}

// Add Spotify recommendations using user's top artists/tracks + mood seeds (if logged-in)
// ... (rest of the code remains the same)
// Fetch recommendations seeded by user's top artists/tracks and mood seeds
async function fetchRecommendationsWithSeeds(bearer: string, seeds: { artists?: string[]; tracks?: string[]; genres?: string[] }, limit = 10, market = "US"): Promise<Track[]> {
  const url = new URL("https://api.spotify.com/v1/recommendations");
  if (seeds.artists?.length) url.searchParams.set("seed_artists", seeds.artists.slice(0, 5).join(","));
  if (seeds.tracks?.length) url.searchParams.set("seed_tracks", seeds.tracks.slice(0, 5).join(","));
  if (seeds.genres?.length) url.searchParams.set("seed_genres", seeds.genres.slice(0, 5).join(","));
  url.searchParams.set("limit", String(Math.max(1, Math.min(20, limit))));
  url.searchParams.set("market", market);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store" });
  if (!res.ok) return [];
  const json = (await res.json()) as any;
  const items: any[] = json?.tracks ?? [];
  return items.map((t) => ({
    title: t?.name ?? "",
    artist: (t?.artists?.map((a: any) => a?.name) ?? []).join(", "),
    cover: t?.album?.images?.[1]?.url || t?.album?.images?.[0]?.url || "",
    previewUrl: t?.preview_url || null,
    spotifyUrl: t?.external_urls?.spotify || (t?.id ? `https://open.spotify.com/track/${t.id}` : undefined),
  }));
}
  const json = (await res.json()) as any;
  const recs = (json?.recordings ?? []) as any[];
  const out: MBRecording[] = [];
  for (const r of recs) {
    const title = String(r?.title ?? "").trim();
    const artists = Array.isArray(r?.["artist-credit"]) ? r["artist-credit"] : [];
    const artistName = String(artists?.[0]?.name ?? artists?.[0]?.artist?.name ?? r?.artist ?? "").trim();
    const id = String(r?.id ?? "").trim();
    if (title && artistName && id) out.push({ id, title, artist: artistName });
  }
  return out;
}

async function fetchListenBrainzRecordingPopularity(mbid: string): Promise<number> {
  try {
    const res = await fetch(`${LB_BASE}/recording/${encodeURIComponent(mbid)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return 0;
    const json = (await res.json()) as any;
    // Try a few plausible popularity fields
    const pop = Number(json?.listen_count ?? json?.count ?? json?.score ?? json?.payload?.count ?? 0) || 0;
    return pop;
  } catch {
    return 0;
  }
}

async function searchSpotifySingle(token: string, title: string, artist: string): Promise<{ url?: string; id?: string; cover?: string; preview?: string | null } | null> {
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
    const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!res.ok) continue;
    const json = (await res.json()) as any;
    const item = (json?.tracks?.items ?? [])[0];
    if (item) {
      return {
        id: item.id,
        url: item.external_urls?.spotify || (item.id ? `https://open.spotify.com/track/${item.id}` : undefined),
        cover: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || "",
        preview: item.preview_url || null,
      };
    }
  }
  return null;
}

function getListenBrainzToken() {
  return process.env.LISTENBRAINZ_TOKEN?.trim();
}

function getListenBrainzUsername() {
  return process.env.LISTENBRAINZ_USERNAME?.trim();
}

type LBRecording = { recording_name?: string; artist_name?: string; plays?: number };

async function fetchListenBrainzRecordings(mood: string): Promise<LBRecording[]> {
  const token = getListenBrainzToken();
  const username = getListenBrainzUsername();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Token ${token}`;

  const buildUrl = (kind: "user" | "sitewide", range: string) => {
    if (kind === "user" && username) {
      const u = new URL(`${LB_BASE}/stats/user/${encodeURIComponent(username)}/top-recordings`);
      u.searchParams.set("range", range);
      u.searchParams.set("count", String(LB_MAX));
      return u;
    }
    const u = new URL(`${LB_BASE}/stats/sitewide/top-recordings`);
    u.searchParams.set("range", range);
    u.searchParams.set("count", String(LB_MAX));
    return u;
  };

  // Try user top recordings, then sitewide as fallback
  const tryKinds: ("user" | "sitewide")[] = username ? ["user", "sitewide"] : ["sitewide"];
  let merged: Map<string, LBRecording> = new Map();
  for (const range of LB_RANGES) {
    for (const kind of tryKinds) {
      try {
        const res = await fetch(buildUrl(kind, range).toString(), { headers, cache: "no-store" });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.warn(`[ListenBrainz] ${kind} top-recordings failed (${range}):`, res.status, body);
          continue;
        }
        const json = (await res.json()) as any;
        const items: any[] = json?.payload?.recordings ?? json?.recordings ?? [];
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          const rec: LBRecording = {
            recording_name: it?.recording_name ?? it?.recording?.name ?? it?.title ?? it?.name,
            artist_name: it?.artist_name ?? it?.artist_credit_name ?? it?.artist ?? it?.artist_credit,
            plays: Number(it?.listen_count ?? it?.count ?? it?.score ?? 0) || 0,
          };
          const key = `${rec.recording_name}@@${rec.artist_name}`;
          if (!rec.recording_name || !rec.artist_name) continue;
          const prev = merged.get(key);
          if (!prev || (rec.plays ?? 0) > (prev.plays ?? 0)) merged.set(key, rec);
        }
      } catch (e) {
        console.warn(`[ListenBrainz] Fetch error (${kind}, ${range}):`, e);
      }
    }
    // If we have enough after this range, stop early
    if (merged.size >= 30) break;
  }
  let recs = Array.from(merged.values());
  // Mood filter: keep it soft; if filtering drops too much, revert to unfiltered
  const keys = MOOD_KEYWORDS[mood] ?? [];
  if (keys.length) {
    const lc = (s?: string) => (s || "").toLowerCase();
    const filtered = recs.filter((r) => {
      const hay = `${lc(r.recording_name)} ${lc(r.artist_name)}`;
      return keys.some((k) => hay.includes(k));
    });
    if (filtered.length >= Math.min(15, recs.length)) recs = filtered;
  }
  recs.sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0));
  return recs.slice(0, 50);
}

async function searchSpotifyByRecordingList(token: string, recs: LBRecording[], market = "US", max = 12): Promise<Track[]> {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const r of recs.slice(0, max)) {
    const title = (r.recording_name || "").trim();
    const artist = (r.artist_name || "").trim();
    if (!title || !artist) continue;
    const url = new URL("https://api.spotify.com/v1/search");
    // Prefer precise match; fall back to loose query
    const q = `track:"${title.replace(/"/g, '')}" artist:"${artist.replace(/"/g, '')}"`;
    url.searchParams.set("q", q);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", "3");
    url.searchParams.set("market", market);
    try {
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      let items: any[] = [];
      if (res.ok) {
        const json = (await res.json()) as any;
        items = (json?.tracks?.items ?? []) as any[];
      }
      // If strict query produced nothing, try a looser query
      if (!items.length) {
        const loose = new URL("https://api.spotify.com/v1/search");
        loose.searchParams.set("q", `${title} ${artist}`);
        loose.searchParams.set("type", "track");
        loose.searchParams.set("limit", "3");
        loose.searchParams.set("market", market);
        const res2 = await fetch(loose.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (res2.ok) {
          const json2 = (await res2.json()) as any;
          items = (json2?.tracks?.items ?? []) as any[];
        }
      }
      // If still nothing, try title-only
      if (!items.length) {
        const loose2 = new URL("https://api.spotify.com/v1/search");
        loose2.searchParams.set("q", `${title}`);
        loose2.searchParams.set("type", "track");
        loose2.searchParams.set("limit", "2");
        loose2.searchParams.set("market", market);
        const res3 = await fetch(loose2.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (res3.ok) {
          const json3 = (await res3.json()) as any;
          items = (json3?.tracks?.items ?? []) as any[];
        }
      }
      for (const t of items) {
        const key = `${t.name}@@${(t.artists?.map((a: any) => a.name) ?? []).join(', ')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          title: t.name,
          artist: (t.artists?.map((a: any) => a.name) ?? []).join(", "),
          cover: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || "",
          previewUrl: t.preview_url || null,
        });
        if (out.length >= max) break;
      }
      if (out.length >= max) break;
    } catch {
      // ignore per-item failures
    }
  }
  return out;
}

async function getSpotifyToken() {
  // Read and trim to avoid whitespace issues from .env.local
  const rawClientId = process.env.SPOTIFY_CLIENT_ID;
  const rawClientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const clientId = rawClientId?.trim();
  const clientSecret = rawClientSecret?.trim();
  if (!clientId || !clientSecret) {
    console.error("[Spotify] Missing env:", {
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      clientIdLen: clientId?.length ?? 0,
      clientSecretLen: clientSecret?.length ?? 0,
    });
    throw new Error("Missing SPOTIFY_CLIENT_ID/SECRET in env");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: body.toString(),
    // Force server-side fetch
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Token failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

// Cache for available genre seeds to avoid calling on every request
let genreSeedsCache: { seeds: string[]; ts: number } | null = null;
async function getAvailableGenreSeeds(token: string, userToken?: string): Promise<string[]> {
  const now = Date.now();
  if (genreSeedsCache && now - genreSeedsCache.ts < 12 * 60 * 60 * 1000) {
    return genreSeedsCache.seeds;
  }
  const doFetch = async (bearer: string) => {
    const res = await fetch("https://api.spotify.com/v1/recommendations/available-genre-seeds", {
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      cache: "no-store",
    });
    return res;
  };
  let res = await doFetch(token);
  if (!res.ok && userToken) {
    res = await doFetch(userToken);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[Spotify] Could not fetch available genre seeds:", res.status, body);
    return SAFE_GENRE_SEEDS;
  }
  const json = (await res.json()) as any;
  const seeds = (json?.genres ?? []) as string[];
  genreSeedsCache = { seeds, ts: now };
  return seeds;
}

// In-memory, per-user cache for personalization seeds to reduce API calls (TTL 10 minutes)
type PersonalSeeds = {
  userId: string;
  username?: string;
  topArtistIds: string[];
  topArtistNames: string[];
  topTrackIds: string[];
  recentTrackIds: string[];
  ts: number;
};
const PERSONAL_CACHE = new Map<string, PersonalSeeds>();

async function fetchPersonalSeeds(userToken: string): Promise<PersonalSeeds | null> {
  try {
    // Identify user
    const meRes = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" });
    if (!meRes.ok) return null;
    const me = (await meRes.json()) as any;
    const userId = String(me?.id ?? "");
    if (!userId) return null;

    // Cache hit?
    const cached = PERSONAL_CACHE.get(userId);
    const now = Date.now();
    if (cached && now - cached.ts < 10 * 60 * 1000) return cached;

    const [topArtistsRes, topTracksRes, recentRes] = await Promise.all([
      fetch("https://api.spotify.com/v1/me/top/artists?limit=5&time_range=medium_term", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" }),
      fetch("https://api.spotify.com/v1/me/top/tracks?limit=5", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" }),
      fetch("https://api.spotify.com/v1/me/player/recently-played?limit=10", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" }),
    ]);

    const topArtistsJson: any = topArtistsRes.ok ? await topArtistsRes.json() : { items: [] };
    const topArtistIds: string[] = (topArtistsJson?.items ?? []).map((a: any) => a.id);
    const topArtistNames: string[] = (topArtistsJson?.items ?? []).map((a: any) => a?.name).filter(Boolean);
    const topTrackIds: string[] = topTracksRes.ok ? (((await topTracksRes.json()) as any)?.items ?? []).map((t: any) => t.id) : [];
    const recentTrackIds: string[] = recentRes.ok ? ((((await recentRes.json()) as any)?.items ?? []).map((it: any) => it?.track?.id).filter(Boolean)) : [];

    const seeds: PersonalSeeds = {
      userId,
      username: me?.display_name ?? undefined,
      topArtistIds,
      topArtistNames,
      topTrackIds,
      recentTrackIds,
      ts: now,
    };
    PERSONAL_CACHE.set(userId, seeds);
    return seeds;
  } catch {
    return null;
  }
}

// Search API fallback that is more tolerant to genre wording
const MOOD_TO_QUERY: Record<string, string> = {
  Happy: 'pop OR dance OR party',
  Chill: 'chill OR ambient OR lofi OR study OR sleep',
  Sad: 'sad OR acoustic OR piano OR ballad',
  Energetic: 'edm OR rock OR dance OR upbeat OR workout',
  Romantic: 'romance OR "love song" OR soul OR "r&b"',
  Focus: 'study OR instrumental OR ambient OR piano',
};

async function searchTracks(token: string, mood: string, limit = 6, market = "US") {
  const q = MOOD_TO_QUERY[mood] ?? 'genre:"pop"';
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("market", market);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[Spotify] Search failed", res.status, body);
    throw new Error(`Search failed: ${res.status}`);
  }
  const json = (await res.json()) as any;
  const items = (json?.tracks?.items ?? []) as any[];
  const tracks: Track[] = items.map((t) => ({
    title: t.name,
    artist: (t.artists?.map((a: any) => a.name) ?? []).join(", "),
    cover: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || "",
    previewUrl: t.preview_url || null,
  }));
  return tracks;
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as Payload;
    const mood = payload.mood?.trim();
    const prompt = payload.prompt?.trim();

    const token = await getSpotifyToken();
    const userAccessToken = req.cookies.get("spotify_access_token")?.value?.trim();

    // Decide seeds from mood or prompt keywords
    let selectedMood = mood ?? "Happy";
    if (!mood && prompt) {
      const p = prompt.toLowerCase();
      if (/(rain|calm|lofi|cozy|chill|ambient)/.test(p)) selectedMood = "Chill";
      else if (/(sad|melancholy|blue|cry|ballad)/.test(p)) selectedMood = "Sad";
      else if (/(love|romance|date|heart)/.test(p)) selectedMood = "Romantic";
      else if (/(study|focus|work|deep|instrumental)/.test(p)) selectedMood = "Focus";
      else if (/(party|upbeat|club|energy|energetic|edm|rock|dance)/.test(p)) selectedMood = "Energetic";
      else selectedMood = "Happy";
    }

    // Optional personalization (requires logged-in user token via cookies)
    let personal: PersonalSeeds | null = null;
    if (userAccessToken) {
      personal = await fetchPersonalSeeds(userAccessToken).catch(() => null);
    }

    // MusicBrainz -> ListenBrainz popularity -> Spotify mapping (biased by user top artists when available)
    const tag = (selectedMood || "").toLowerCase();
    // Pull 25 MB recordings, then enrich with LB popularity
    const mb = await fetchMusicBrainzByTag(tag, 25);
    // For each, request LB popularity (in parallel with caps by batching 10 at a time)
    const batches: MBRecording[][] = [];
    const batchSize = 10;
    for (let i = 0; i < mb.length; i += batchSize) batches.push(mb.slice(i, i + batchSize));
    const scored: Array<MBRecording & { popularity: number }> = [];
    for (const b of batches) {
      const pops = await Promise.all(b.map((r) => fetchListenBrainzRecordingPopularity(r.id)));
      for (let i = 0; i < b.length; i++) scored.push({ ...b[i], popularity: pops[i] ?? 0 });
    }
    // Sort by popularity, then boost entries by user's top artists (if any)
    scored.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    if (personal?.topArtistNames?.length) {
      const topSet = new Set(personal.topArtistNames.map((s) => s.toLowerCase()));
      scored.sort((a, b) => {
        const ab = topSet.has((a.artist || '').toLowerCase()) ? 1 : 0;
        const bb = topSet.has((b.artist || '').toLowerCase()) ? 1 : 0;
        if (ab !== bb) return bb - ab; // put boosted first
        return 0;
      });
    }
    // Map to Spotify
    const results: Track[] = [];
    const seen = new Set<string>();

    // Prepend user's top tracks (if any), preserving mood context but prioritizing user's taste
    if (personal?.topTrackIds?.length) {
      try {
        const ids = Array.from(new Set(personal.topTrackIds)).slice(0, 10);
        if (ids.length) {
          const url = new URL("https://api.spotify.com/v1/tracks");
          url.searchParams.set("ids", ids.join(","));
          const resTop = await fetch(url.toString(), { headers: { Authorization: `Bearer ${userAccessToken}` }, cache: "no-store" });
          if (resTop.ok) {
            const jTop = (await resTop.json()) as any;
            const items: any[] = jTop?.tracks ?? [];
            for (const t of items) {
              const key = `${t?.name}@@${(t?.artists?.map((a: any) => a?.name) ?? []).join(', ')}`;
              if (seen.has(key)) continue;
              seen.add(key);
              results.push({
                title: t?.name ?? "",
                artist: (t?.artists?.map((a: any) => a?.name) ?? []).join(", "),
                cover: t?.album?.images?.[1]?.url || t?.album?.images?.[0]?.url || "",
                previewUrl: t?.preview_url || null,
                spotifyUrl: t?.external_urls?.spotify || (t?.id ? `https://open.spotify.com/track/${t.id}` : undefined),
              });
              if (results.length >= 10) break;
            }
          }
        }
      } catch {}
    }
    for (const r of scored) {
      const key = `${r.title}@@${r.artist}`;
      if (seen.has(key)) continue;
      const found = await searchSpotifySingle(token, r.title, r.artist);
      if (found?.url) {
        seen.add(key);
        results.push({ title: r.title, artist: r.artist, cover: found.cover || "", previewUrl: found.preview ?? null, spotifyUrl: found.url });
      }
      if (results.length >= 20) break;
    }
    // If too few, try unscored MB set to pad
    if (results.length < 10) {
      for (const r of mb) {
        const key = `${r.title}@@${r.artist}`;
        if (seen.has(key)) continue;
        const found = await searchSpotifySingle(token, r.title, r.artist);
        if (found?.url) {
          seen.add(key);
          results.push({ title: r.title, artist: r.artist, cover: found.cover || "", previewUrl: found.preview ?? null, spotifyUrl: found.url });
        }
        if (results.length >= 10) break;
      }
    }
    const finalTracks = results.slice(0, Math.max(10, Math.min(20, results.length)));
    return NextResponse.json({ ok: true, mood: tag, tracks: finalTracks, meta: { source: "musicbrainz_listenbrainz" } });
  } catch (err: any) {
    console.error("[API /generatePlaylist] Error:", err);
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 200 });
  }
}
