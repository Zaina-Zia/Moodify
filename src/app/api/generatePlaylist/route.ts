import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs"; // Ensure Node runtime (Buffer + standard fetch)

// Minimal Track type to match frontend expectations
export type Track = {
  title: string;
  artist: string;
  cover: string;
  previewUrl?: string | null;
  spotifyUrl?: string;
  matchReason?: string;
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

// Utility helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(p: Promise<T>, ms = 10000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    // @ts-ignore add signal only if fetch-like
    const res = await (async () => p)();
    clearTimeout(t);
    return res as T;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
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
      await sleep(backoffMs * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

async function runWithConcurrency<TIn, TOut>(items: TIn[], limit: number, worker: (it: TIn, idx: number) => Promise<TOut>): Promise<TOut[]> {
  const results: TOut[] = new Array(items.length) as any;
  let i = 0;
  const runners: Promise<void>[] = [];
  const next = async () => {
    const idx = i++;
    if (idx >= items.length) return;
    try {
      results[idx] = await worker(items[idx], idx);
    } catch (e) {
      // @ts-ignore
      results[idx] = undefined;
    }
    await next();
  };
  const n = Math.max(1, Math.min(limit, items.length));
  for (let k = 0; k < n; k++) runners.push(next());
  await Promise.all(runners);
  return results;
}

function getUserAccessToken(req: NextRequest): string | undefined {
  return req.cookies.get("spotify_access_token")?.value?.trim();
}

type MoodTargets = { valence: number; energy: number; danceability: number; tempo?: number };
function getMoodTargets(mood: string): MoodTargets {
  const m = (mood || "").toLowerCase();
  if (m.includes("happy")) return { valence: 0.8, energy: 0.7, danceability: 0.6, tempo: 110 };
  if (m.includes("sad")) return { valence: 0.2, energy: 0.3, danceability: 0.3, tempo: 80 };
  if (m.includes("chill")) return { valence: 0.4, energy: 0.4, danceability: 0.4, tempo: 90 };
  if (m.includes("energetic")) return { valence: 0.7, energy: 0.9, danceability: 0.7, tempo: 125 };
  if (m.includes("romantic")) return { valence: 0.6, energy: 0.5, danceability: 0.5, tempo: 95 };
  if (m.includes("angry")) return { valence: 0.3, energy: 0.9, danceability: 0.5, tempo: 135 };
  return { valence: 0.6, energy: 0.6, danceability: 0.6, tempo: 110 };
}

type SimpleArtist = { id: string; name: string; genres: string[] };
async function fetchUserTopArtists(token: string, limit = 10): Promise<SimpleArtist[]> {
  const res = await fetchWithRetry(`https://api.spotify.com/v1/me/top/artists?limit=${limit}&time_range=medium_term`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as any;
  const items: any[] = j?.items ?? [];
  return items.map((a) => ({ id: String(a?.id || ""), name: String(a?.name || ""), genres: Array.isArray(a?.genres) ? a.genres : [] })).filter((a) => a.id && a.name);
}

type SimpleTrack = { id: string; title: string; artist: string };
async function fetchUserTopTracks(token: string, limit = 20): Promise<SimpleTrack[]> {
  const res = await fetchWithRetry(`https://api.spotify.com/v1/me/top/tracks?limit=${limit}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as any;
  const items: any[] = j?.items ?? [];
  return items.map((t) => ({ id: String(t?.id || ""), title: String(t?.name || ""), artist: (t?.artists?.map((a: any) => a?.name) ?? []).join(", ") })).filter((t) => t.id);
}

type Seeds = { artists?: string[]; tracks?: string[] };
// Mood profiles for heuristic (no audio-features usage)
const MOOD_PROFILE: Record<string, { keywords: string[]; exampleGenres: string[] }> = {
  Happy: { keywords: ["upbeat", "joyful", "bright", "lively", "feel good"], exampleGenres: ["pop", "indie pop", "funk", "dance"] },
  Sad: { keywords: ["emotional", "mellow", "soft", "slow", "ballad"], exampleGenres: ["acoustic", "piano", "soul", "emo"] },
  Chill: { keywords: ["relaxing", "calm", "ambient", "lo-fi", "downtempo"], exampleGenres: ["chillhop", "downtempo", "electronic", "lofi"] },
  Energetic: { keywords: ["fast", "driving", "hype", "intense", "club"], exampleGenres: ["edm", "rock", "trap", "punk"] },
  Focus: { keywords: ["minimal", "instrumental", "ambient", "smooth", "study"], exampleGenres: ["lo-fi", "classical", "soft electronic", "piano"] },
  Romantic: { keywords: ["soft", "warm", "melodic", "heartfelt", "love"], exampleGenres: ["r&b", "soul", "acoustic pop", "romance"] },
};

// MusicBrainz: fetch artist tags by name to expand genre profile
async function fetchMBArtistTagsByName(name: string): Promise<string[]> {
  try {
    const search = new URL(`${MB_BASE}/artist`);
    search.searchParams.set("query", `artist:${name}`);
    search.searchParams.set("limit", "1");
    search.searchParams.set("fmt", "json");
    const sres = await fetchWithRetry(search.toString(), { headers: { Accept: "application/json", "User-Agent": "Moodify/1.0 (playlist generator)" }, cache: "no-store" });
    if (!sres.ok) return [];
    const sjson = (await sres.json()) as any;
    const aid = sjson?.artists?.[0]?.id;
    if (!aid) return [];
    const arUrl = new URL(`${MB_BASE}/artist/${encodeURIComponent(aid)}`);
    arUrl.searchParams.set("inc", "tags");
    arUrl.searchParams.set("fmt", "json");
    const ares = await fetchWithRetry(arUrl.toString(), { headers: { Accept: "application/json", "User-Agent": "Moodify/1.0 (playlist generator)" }, cache: "no-store" });
    if (!ares.ok) return [];
    const aj = (await ares.json()) as any;
    const tags: any[] = aj?.tags ?? [];
    return tags.map((t: any) => String(t?.name || "").toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

type TasteProfile = { artistNames: string[]; genres: string[]; tags: string[]; topTrackIds: Set<string>; recentYears: number[] };
async function buildTasteProfile(userToken?: string): Promise<TasteProfile> {
  const artistNames: string[] = [];
  const genresCounter = new Map<string, number>();
  const tagsCounter = new Map<string, number>();
  const topTrackIds = new Set<string>();
  const years: number[] = [];
  if (userToken) {
    const [artists, tracks] = await Promise.all([fetchUserTopArtists(userToken, 20), fetchUserTopTracks(userToken, 20)]);
    for (const a of artists) {
      artistNames.push(a.name);
      for (const g of a.genres || []) genresCounter.set(g.toLowerCase(), (genresCounter.get(g.toLowerCase()) || 0) + 1);
    }
    for (const t of tracks) {
      topTrackIds.add(t.id);
    }
    // Fetch MB tags for top 8 artists (by name)
    const top8 = artistNames.slice(0, 8);
    const mbTagsLists = await runWithConcurrency(top8, 4, (n) => fetchMBArtistTagsByName(n));
    for (const list of mbTagsLists) {
      for (const tag of list || []) tagsCounter.set(tag, (tagsCounter.get(tag) || 0) + 1);
    }
  }
  const genres = Array.from(genresCounter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  const tags = Array.from(tagsCounter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  return { artistNames, genres, tags, topTrackIds, recentYears: years };
}

function buildMoodQueries(taste: TasteProfile, moodKey: string): string[] {
  const profile = MOOD_PROFILE[moodKey as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy;
  const genrePool = new Set<string>([...taste.genres, ...profile.exampleGenres].map((g) => g.toLowerCase()));
  const kw = profile.keywords;
  const queries: string[] = [];
  const pick = (arr: string[], n: number) => arr.slice(0, Math.max(0, n));
  // Genre + keyword combos
  for (const g of pick(Array.from(genrePool), 8)) {
    for (const k of pick(kw, 3)) {
      queries.push(`genre:"${g}" ${k}`);
    }
  }
  // Artist + keyword combos for similarity
  for (const a of pick(taste.artistNames, 6)) {
    for (const k of pick(kw, 2)) {
      queries.push(`artist:"${a}" ${k}`);
    }
  }
  // Mood-only generic queries
  for (const k of pick(kw, 3)) queries.push(k);
  return Array.from(new Set(queries));
}

async function searchSpotifyTracksMulti(token: string, queries: string[], limitEach = 8, capTotal = 100): Promise<any[]> {
  const out: any[] = [];
  const seenIds = new Set<string>();
  for (const q of queries) {
    if (out.length >= capTotal) break;
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", q);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", String(limitEach));
    url.searchParams.set("market", "US");
    try {
      const res = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!res.ok) continue;
      const j = (await res.json()) as any;
      const items: any[] = j?.tracks?.items ?? [];
      for (const t of items) {
        const id = String(t?.id || "");
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        out.push(t);
        if (out.length >= capTotal) break;
      }
    } catch {}
  }
  return out;
}

function scoreAndMapCandidates(items: any[], taste: TasteProfile, moodKey: string): Track[] {
  const profile = MOOD_PROFILE[moodKey as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy;
  const kw = profile.keywords.map((s) => s.toLowerCase());
  const tasteGenres = new Set(taste.genres.map((g) => g.toLowerCase()));
  const tasteArtists = new Set(taste.artistNames.map((a) => a.toLowerCase()));
  const nowYear = new Date().getFullYear();
  const tracks: Array<{ t: Track; score: number; pop: number }> = [];
  const keyOf = (n: any) => `${n?.name}@@${(n?.artists?.map((a: any) => a?.name) ?? []).join(', ')}`;
  const seen = new Set<string>();
  for (const n of items) {
    const k = keyOf(n);
    if (seen.has(k)) continue;
    seen.add(k);
    const title = String(n?.name || "");
    const artistNames = (n?.artists?.map((a: any) => a?.name) ?? []) as string[];
    const albumName = String(n?.album?.name || "");
    const release = String(n?.album?.release_date || "");
    const year = release ? Number((release || "").slice(0, 4)) : 0;
    const hay = `${title} ${albumName}`.toLowerCase();
    let s = 0;
    if (artistNames.some((a) => tasteArtists.has((a || "").toLowerCase()))) s += 1;
    if (kw.some((w) => hay.includes(w))) s += 2;
    if (Array.from(tasteGenres).some((g) => hay.includes(g))) s += 1;
    if (year && nowYear - year <= 10) s += 1;
    const pop = Number(n?.popularity ?? 0) || 0;
    const track: Track = {
      title,
      artist: artistNames.join(", "),
      cover: n?.album?.images?.[1]?.url || n?.album?.images?.[0]?.url || "",
      previewUrl: n?.preview_url || null,
      spotifyUrl: n?.external_urls?.spotify || (n?.id ? `https://open.spotify.com/track/${n.id}` : undefined),
      matchReason: buildMatchReason({ artistNames, hay, kw, tasteGenres }),
    };
    tracks.push({ t: track, score: s, pop });
  }
  tracks.sort((a, b) => (b.score - a.score) || (b.pop - a.pop));
  return tracks.map((x) => x.t);
}

function buildMatchReason(args: { artistNames: string[]; hay: string; kw: string[]; tasteGenres: Set<string> }): string {
  const { artistNames, hay, kw, tasteGenres } = args;
  const reasons: string[] = [];
  if (artistNames.length) reasons.push("similar to your artists");
  if (kw.some((w) => hay.includes(w))) reasons.push("fits the mood keywords");
  if (Array.from(tasteGenres).some((g) => hay.includes(g))) reasons.push("matches your genres");
  return reasons.length ? reasons.join(", ") : "discovery for your mood";
}

function combinePersonalAndMoodTracks(personal: Track[], moodTracks: Track[], excludeKeys: Set<string>, total = 25): Track[] {
  const key = (t: Track) => `${t.title}@@${t.artist}`;
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const list of [personal, moodTracks]) {
    for (const t of list) {
      const k = key(t);
      if (excludeKeys.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= total) return out;
    }
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

async function fetchMusicBrainzByTag(tag: string, limit = 25): Promise<MBRecording[]> {
  const url = new URL(`${MB_BASE}/recording`);
  url.searchParams.set("query", `tag:${tag}`);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", String(limit));
  const res = await fetchWithRetry(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "Moodify/1.0 (playlist generator)" },
    cache: "no-store",
    timeoutMs: 12000,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[MusicBrainz] search failed:", res.status, body);
    return [];
  }
  const json = (await res.json().catch(() => null)) as any;
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

// Fetch top tracks for a list of artists using the user token
async function fetchArtistsTopTracks(userToken: string, artistIds: string[], market = "US", perArtist = 2, cap = 8): Promise<Track[]> {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const id of artistIds) {
    try {
      const u = new URL(`https://api.spotify.com/v1/artists/${encodeURIComponent(id)}/top-tracks`);
      u.searchParams.set("market", market);
      const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" });
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
  const res = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store" });
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

async function fetchListenBrainzRecordingPopularity(mbid: string): Promise<number> {
  try {
    const res = await fetchWithRetry(`${LB_BASE}/recording/${encodeURIComponent(mbid)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
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
    const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
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
        const res = await fetchWithRetry(buildUrl(kind, range).toString(), { headers, cache: "no-store" });
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
      const res = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
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
        const res2 = await fetchWithRetry(loose.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
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
        const res3 = await fetchWithRetry(loose2.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
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

  const res = await fetchWithRetry("https://accounts.spotify.com/api/token", {
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
    const res = await fetchWithRetry("https://api.spotify.com/v1/recommendations/available-genre-seeds", {
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
    const meRes = await fetchWithRetry("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" });
    if (!meRes.ok) return null;
    const me = (await meRes.json()) as any;
    const userId = String(me?.id ?? "");
    if (!userId) return null;

    // Cache hit?
    const cached = PERSONAL_CACHE.get(userId);
    const now = Date.now();
    if (cached && now - cached.ts < 10 * 60 * 1000) return cached;

    const [topArtistsRes, topTracksRes, recentRes] = await Promise.all([
      fetchWithRetry("https://api.spotify.com/v1/me/top/artists?limit=10&time_range=medium_term", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" }),
      fetchWithRetry("https://api.spotify.com/v1/me/top/tracks?limit=20", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" }),
      fetchWithRetry("https://api.spotify.com/v1/me/player/recently-played?limit=10", { headers: { Authorization: `Bearer ${userToken}` }, cache: "no-store" }),
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

  const res = await fetchWithRetry(url.toString(), {
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
    spotifyUrl: t?.external_urls?.spotify || (t?.id ? `https://open.spotify.com/track/${t.id}` : undefined),
  }));
  return tracks;
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as Payload;
    const mood = payload.mood?.trim();
    const prompt = payload.prompt?.trim();

    const token = await getSpotifyToken();
    const userAccessToken = getUserAccessToken(req);

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
    const pops = await runWithConcurrency(mb, 5, async (r) => fetchListenBrainzRecordingPopularity(r.id));
    const scored: Array<MBRecording & { popularity: number }> = mb.map((r, i) => ({ ...r, popularity: pops[i] ?? 0 }));
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
          const resTop = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${userAccessToken}` }, cache: "no-store" });
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

    // Build taste and mood queries, search for candidates (no recommendations/audio-features)
    const taste = await buildTasteProfile(userAccessToken);
    const queries = buildMoodQueries(taste, selectedMood);
    const candidatesRaw = await searchSpotifyTracksMulti(userAccessToken || token, queries, 8, 100);
    let candidates = scoreAndMapCandidates(candidatesRaw, taste, selectedMood);

    // Exclude user's top tracks unless they match mood keywords
    if (taste.topTrackIds.size) {
      const moodKw = (MOOD_PROFILE[selectedMood as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy).keywords.map((k) => k.toLowerCase());
      candidates = candidates.filter((t) => {
        const ok = !Array.from(taste.topTrackIds).some((id) => (t.spotifyUrl || "").endsWith(id)) || moodKw.some((k) => (`${t.title} ${t.artist}`).toLowerCase().includes(k));
        return ok;
      });
    }
    for (const t of candidates) {
      const key = `${t.title}@@${t.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(t);
      if (results.length >= 25) break;
    }

    const searchResults = await runWithConcurrency(scored, 6, async (r) => {
      const key = `${r.title}@@${r.artist}`;
      if (seen.has(key)) return null as any;
      const found = await searchSpotifySingle(token, r.title, r.artist);
      if (found?.url) {
        return { title: r.title, artist: r.artist, cover: found.cover || "", previewUrl: found.preview ?? null, spotifyUrl: found.url } as Track;
      }
      return null as any;
    });
    for (const t of searchResults) {
      if (!t) continue;
      const key = `${t.title}@@${t.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(t);
      if (results.length >= 20) break;
    }
    // If too few, try unscored MB set to pad
    if (results.length < 10) {
      const padResults = await runWithConcurrency(mb, 6, async (r) => {
        const key = `${r.title}@@${r.artist}`;
        if (seen.has(key)) return null as any;
        const found = await searchSpotifySingle(token, r.title, r.artist);
        if (found?.url) return { title: r.title, artist: r.artist, cover: found.cover || "", previewUrl: found.preview ?? null, spotifyUrl: found.url } as Track;
        return null as any;
      });
      for (const t of padResults) {
        if (!t) continue;
        const key = `${t.title}@@${t.artist}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(t);
        if (results.length >= 10) break;
      }
    }

    // Fallback to Spotify mood search when results are still low, with dedupe
    if (results.length < 10) {
      const moodSearchResults = await searchTracks(token, selectedMood, 10);
      for (const t of moodSearchResults) {
        const key = `${t.title}@@${t.artist}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ ...t, matchReason: "fallback mood search" });
        if (results.length >= 10) break;
      }
    }

    // Mood relevance re-weighting
    const keys = MOOD_KEYWORDS[selectedMood] ?? [];
    const score = (t: Track) => {
      const hay = `${t.title} ${t.artist}`.toLowerCase();
      let s = 0;
      for (const k of keys) if (hay.includes(k)) s += 1;
      return s;
    };
    results.sort((a, b) => score(b) - score(a));

    const final = combinePersonalAndMoodTracks(results, [], new Set<string>(), 25);
    const finalTracks = final.slice(0, Math.max(10, Math.min(15, final.length)));
    return NextResponse.json({ ok: true, mood: tag, tracks: finalTracks, meta: { source: userAccessToken ? "personalized+search+musicbrainz" : "search+musicbrainz" } });
  } catch (err: any) {
    console.error("[API /generatePlaylist] Error:", err);
    const msg = String(err?.message || "Unknown error");
    const status = /unauthorized|401/i.test(msg) ? 401 : /invalid|bad request|400/i.test(msg) ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

