import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs"; // Ensure Node runtime (Buffer + standard fetch)

// Minimal Track type to match frontend expectations
export type Track = {
  title: string;
  artist: string;
  cover: string;
  previewUrl?: string | null;
  spotifyUrl?: string;
  spotifyId?: string;
  artistIds?: string[];
  primaryArtistId?: string;
  matchReason?: string;
};

type Payload = {
  mood?: string;
  prompt?: string;
  language?: 'any' | 'english' | 'urdu';
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
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

function scoreByFormula(params: { tracks: Track[]; features: Map<string, AudioFeatures>; taste: TasteProfile; mood: string; lang: 'any'|'english'|'urdu'; artistGenresMap: Map<string, string[]>; customTargets?: Partial<MoodTargets>; }): Track[] {
  const { tracks, features, taste, mood, lang, artistGenresMap, customTargets } = params;
  const base = getMoodTargets(mood);
  const t: MoodTargets = {
    valence: customTargets?.valence ?? base.valence,
    energy: customTargets?.energy ?? base.energy,
    danceability: customTargets?.danceability ?? base.danceability,
    tempo: customTargets?.tempo ?? base.tempo,
  };
  const has = (x: any) => typeof x === 'number' && !Number.isNaN(x);
  const getGenres = (tr: Track) => (tr.artistIds || []).flatMap((id) => artistGenresMap.get(id) || []);
  const tasteGenresSet = new Set(taste.genres.map((g) => g.toLowerCase()));

  type Scored = { tr: Track; score: number };
  const out: Scored[] = [];
  for (const tr of tracks) {
    const id = tr.spotifyId || '';
    const f = (id && features.get(id)) || undefined;
    // mood_match: 1 - weighted distance (0..1)
    let moodMatch = 0.5;
    if (f) {
      const dv = has(f.valence!) ? Math.abs((f.valence as number) - (t.valence ?? 0.6)) : 0.6;
      const de = has(f.energy!) ? Math.abs((f.energy as number) - (t.energy ?? 0.6)) : 0.6;
      const dd = has(f.danceability!) ? Math.abs((f.danceability as number) - (t.danceability ?? 0.6)) : 0.6;
      const dtempo = has(f.tempo!) && t.tempo ? Math.abs((f.tempo as number) - (t.tempo as number)) / 60 : 1.0;
      const dist = dv * 0.35 + de * 0.35 + dd * 0.2 + dtempo * 0.1;
      moodMatch = clamp01(1 - dist);
    }

    // taste_match
    let inLib = 0;
    if (id) {
      if (taste.topTrackIds.has(id)) inLib = 1.0; else if (taste.savedTrackIds.has(id)) inLib = 0.9; else if (taste.recentTrackIds.has(id)) inLib = 0.7;
    }
    let artistAff = 0;
    const pa = tr.primaryArtistId;
    if (pa && taste.artistIds.has(pa)) artistAff = 1.0; else if ((tr.artistIds || []).some((aid) => taste.artistIds.has(aid))) artistAff = 0.7;
    const g = getGenres(tr).map((x) => String(x || '').toLowerCase());
    const overlap = g.filter((gg) => tasteGenresSet.has(gg)).length;
    const genreRatio = g.length ? overlap / g.length : 0;
    const tasteMatch = clamp01(0.5 * inLib + 0.3 * artistAff + 0.2 * genreRatio);

    // language_match
    let langMatch = 1;
    if (lang !== 'any') {
      const ok = lang === 'english' ? isEnglishStrict(tr.title, tr.artist, g) : isUrduStrict(tr.title, tr.artist, g);
      langMatch = ok ? 1 : 0;
    }

    const final = 0.5 * tasteMatch + 0.4 * moodMatch + 0.1 * langMatch;
    out.push({ tr, score: final });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.tr);
}

// ---- Language helpers (enhanced) ----
async function fetchArtistsGenres(token: string, artistIds: string[], market = "US"): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = Array.from(new Set(artistIds.filter(Boolean)));
  const batch = 50;
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    const u = new URL("https://api.spotify.com/v1/artists");
    u.searchParams.set("ids", chunk.join(","));
    try {
      const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!res.ok) continue;
      const j = (await res.json()) as any;
      const arts: any[] = j?.artists ?? [];
      for (const a of arts) {
        const id = String(a?.id || "");
        if (!id) continue;
        const gens: string[] = Array.isArray(a?.genres) ? a.genres.map((g: any) => String(g || '').toLowerCase()) : [];
        out.set(id, gens);
      }
    } catch {}
  }
  return out;
}

// Hard mood predicate extracted for reuse without full ranking
function passesHardForMood(mood: string, f: AudioFeatures): boolean {
  const has = (x: any) => typeof x === 'number' && !Number.isNaN(x);
  const key = (mood || '').toLowerCase();
  const rules: { [k: string]: (f: AudioFeatures) => boolean } = {
    happy: (f) => has(f.valence!) && has(f.energy!) && has(f.tempo!) && f.valence! >= 0.6 && f.energy! >= 0.5 && f.tempo! >= 100,
    sad: (f) => has(f.valence!) && has(f.energy!) && has(f.tempo!) && f.valence! <= 0.4 && f.energy! <= 0.6 && f.tempo! <= 110,
    chill: (f) => has(f.energy!) && has(f.tempo!) && f.energy! <= 0.55 && f.tempo! <= 105,
    energetic: (f) => has(f.energy!) && has(f.tempo!) && f.energy! >= 0.75 && f.tempo! >= 118,
    romantic: (f) => has(f.valence!) && has(f.energy!) && f.valence! >= 0.5 && f.valence! <= 0.85 && f.energy! <= 0.65,
    focus: (f) => has(f.energy!) && has(f.tempo!) && f.energy! <= 0.5 && f.tempo! >= 60 && f.tempo! <= 110,
  };
  const pred = rules[key] || (() => true);
  return pred(f);
}

// Compute how many anchors match the mood strictly
async function assessMoodCoverage(token: string, tracks: Track[], mood: string): Promise<number> {
  if (!tracks.length) return 1;
  const ids = Array.from(new Set(tracks.map((t) => t.spotifyId).filter(Boolean))) as string[];
  if (!ids.length) return 0;
  const feats = await fetchAudioFeatures(token, ids);
  let ok = 0;
  for (const t of tracks) {
    const id = t.spotifyId || '';
    const f = id ? feats.get(id) : undefined;
    if (f && passesHardForMood(mood, f)) ok++;
  }
  return ok / tracks.length;
}

// Expand user seed space using Spotify related artists
async function fetchRelatedArtists(bearer: string, artistIds: string[], cap = 18): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of artistIds) {
    try {
      const u = new URL(`https://api.spotify.com/v1/artists/${encodeURIComponent(id)}/related-artists`);
      const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${bearer}` }, cache: 'no-store' });
      if (!res.ok) continue;
      const j = (await res.json()) as any;
      const items: any[] = j?.artists ?? [];
      for (const a of items) {
        const aid = String(a?.id || '');
        if (!aid || seen.has(aid)) continue;
        seen.add(aid);
        out.push(aid);
        if (out.length >= cap) return out;
      }
    } catch {}
  }
  return out;
}

function hasSouthAsianGenre(genres: string[]): boolean {
  const G = genres.join("|");
  return /(urdu|pakistan|pakistani|qawwali|ghazal|coke studio|punjabi|bollywood|hind(i|ustani)|desi|sufi)/i.test(G);
}

function isEnglishStrict(title: string, artist: string, artistGenres: string[]): boolean {
  const hay = `${title} ${artist}`;
  // Block obvious non-English/religious content
  if (/(quran|surah|ayat|azan|adhaan|nasheed|dua|supplication|islam(ic)?|qari|qawwali|ghazal|hamd|naat)/i.test(hay)) return false;
  if (hasSouthAsianGenre(artistGenres)) return false;
  // Require majority Latin characters in title+artist
  const letters = hay.replace(/[^A-Za-z\u0600-\u06FF]+/g, "");
  const latinCount = (letters.match(/[A-Za-z]/g) || []).length;
  const arabicCount = (letters.match(/[\u0600-\u06FF]/g) || []).length;
  const total = latinCount + arabicCount;
  if (total === 0) return false;
  const latinRatio = latinCount / total;
  if (arabicCount > 0) return false;
  return latinRatio >= 0.7; // at least 70% Latin
}

function isUrduStrict(title: string, artist: string, artistGenres: string[]): boolean {
  const hay = `${title} ${artist}`;
  // Positive signals
  const arabic = /[\u0600-\u06FF]/.test(hay);
  if (arabic) return true;
  if (hasSouthAsianGenre(artistGenres)) return true;
  if (/(qawwali|ghazal|coke studio|pakistan|urdu)/i.test(hay)) return true;
  // Exclude obvious English-only items
  if (/[A-Za-z]/.test(hay) && !/(qawwali|ghazal|coke studio|pakistan|urdu)/i.test(hay)) return false;
  return false;
}

// Build language-specific hint queries to bias search results if filtering is too strict
function buildLanguageHintQueries(lang: 'any' | 'english' | 'urdu', moodKey: string): string[] {
  const hints: string[] = [];
  if (lang === 'urdu') {
    // Keywords commonly tied to Urdu/Pakistani music
    const urduHints = [
      'qawwali',
      'ghazal',
      'coke studio',
      'pakistan',
      'urdu song',
      'nusrat fateh ali khan',
      'atif aslam',
      'rahat fateh ali khan',
      'junoon',
    ];
    for (const h of urduHints) hints.push(h);
  } else if (lang === 'english') {
    // Use generic English-leaning tokens; Spotify has no language operator
    const engHints = ['english song', 'pop', 'rock', 'indie', 'r&b'];
    for (const h of engHints) hints.push(h);
  }
  // Soften by mixing with mood keywords
  const moodQ = MOOD_TO_QUERY[moodKey] || '';
  const mixed = hints.map((h) => `${h} ${moodQ}`.trim());
  return Array.from(new Set([...mixed, ...hints]));
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

async function fetchUserSavedTracks(token: string, limit = 50): Promise<SimpleTrack[]> {
  const url = new URL("https://api.spotify.com/v1/me/tracks");
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
  const res = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as any;
  const items: any[] = j?.items ?? [];
  return items
    .map((it) => it?.track)
    .filter(Boolean)
    .map((t: any) => ({ id: String(t?.id || ""), title: String(t?.name || ""), artist: (t?.artists?.map((a: any) => a?.name) ?? []).join(", ") }))
    .filter((t: SimpleTrack) => t.id);
}

async function fetchUserRecentlyPlayed(token: string, limit = 50): Promise<SimpleTrack[]> {
  const url = new URL("https://api.spotify.com/v1/me/player/recently-played");
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
  const res = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as any;
  const items: any[] = j?.items ?? [];
  return items
    .map((it) => it?.track)
    .filter(Boolean)
    .map((t: any) => ({ id: String(t?.id || ""), title: String(t?.name || ""), artist: (t?.artists?.map((a: any) => a?.name) ?? []).join(", ") }))
    .filter((t: SimpleTrack) => t.id);
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

// (MOOD_TO_QUERY declared later near search fallback)

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

type TasteProfile = { artistNames: string[]; artistIds: Set<string>; genres: string[]; tags: string[]; topTrackIds: Set<string>; savedTrackIds: Set<string>; recentTrackIds: Set<string>; recentYears: number[] };
async function buildTasteProfile(userToken?: string): Promise<TasteProfile> {
  const artistNames: string[] = [];
  const artistIds = new Set<string>();
  const genresCounter = new Map<string, number>();
  const tagsCounter = new Map<string, number>();
  const topTrackIds = new Set<string>();
  const savedTrackIds = new Set<string>();
  const recentTrackIds = new Set<string>();
  const years: number[] = [];
  if (userToken) {
    const [artists, tracks, saved, recent] = await Promise.all([
      fetchUserTopArtists(userToken, 20),
      fetchUserTopTracks(userToken, 20),
      fetchUserSavedTracks(userToken, 50),
      fetchUserRecentlyPlayed(userToken, 50),
    ]);
    for (const a of artists) {
      artistNames.push(a.name);
      if (a.id) artistIds.add(a.id);
      for (const g of a.genres || []) genresCounter.set(g.toLowerCase(), (genresCounter.get(g.toLowerCase()) || 0) + 1);
    }
    for (const t of tracks) {
      topTrackIds.add(t.id);
    }
    for (const t of saved) savedTrackIds.add(t.id);
    for (const t of recent) recentTrackIds.add(t.id);
    // Fetch MB tags for top 8 artists (by name)
    const top8 = artistNames.slice(0, 8);
    const mbTagsLists = await runWithConcurrency(top8, 4, (n) => fetchMBArtistTagsByName(n));
    for (const list of mbTagsLists) {
      for (const tag of list || []) tagsCounter.set(tag, (tagsCounter.get(tag) || 0) + 1);
    }
  }
  const genres = Array.from(genresCounter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  const tags = Array.from(tagsCounter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  return { artistNames, artistIds, genres, tags, topTrackIds, savedTrackIds, recentTrackIds, recentYears: years };
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

type VibeSignals = { moodKey: string; energy: 'low' | 'mid' | 'high'; tone: string; keywords: string[]; targets?: Partial<MoodTargets>; confirmation: string };

function extractVibeSignals(text: string, fallbackMood = "Happy"): VibeSignals {
  const s = (text || "").toLowerCase();
  let moodKey = fallbackMood;
  let energy: 'low' | 'mid' | 'high' = 'mid';
  let tone = 'neutral';
  const keywords: string[] = [];
  const targets: Partial<MoodTargets> = {};
  const contexts: string[] = [];

  if (/(rain|raining|storm|monsoon)/.test(s)) {
    contexts.push('rainy');
    keywords.push('rain', 'lofi', 'ambient');
    targets.energy = 0.35; targets.tempo = 80; tone = tone === 'neutral' ? 'reflective' : tone;
  }
  if (/(break.?up|heartbreak|heartbroken|girlfriend .*mad|boyfriend .*mad|fight|argument|arguing|mad at me)/.test(s)) {
    moodKey = 'Sad';
    tone = 'heartbroken';
    keywords.push('heartbreak', 'emotional', 'ballad', 'r&b');
    targets.valence = 0.25; targets.energy = Math.min(targets.energy ?? 1, 0.45);
  }
  if (/(nostalgic|nostalgia|remember|missing|old times|retro|90s|80s|2000s)/.test(s)) {
    tone = 'nostalgic';
    keywords.push('nostalgia', 'retro', 'lofi', 'synthwave');
    if (moodKey === 'Energetic') moodKey = 'Chill';
    targets.energy = Math.min(targets.energy ?? 1, 0.5); targets.tempo = Math.min(targets.tempo ?? 999, 95);
  }
  if (/(angry|furious|rage|pissed)/.test(s)) {
    moodKey = 'Energetic'; energy = 'high'; tone = 'angry';
    keywords.push('rock', 'edm', 'trap');
    targets.energy = Math.max(targets.energy ?? 0, 0.85); targets.tempo = Math.max(targets.tempo ?? 0, 125);
  }
  if (/(study|focus|work|coding|deep work|concentrate|instrumental)/.test(s)) {
    moodKey = 'Focus'; energy = 'low'; tone = 'focused';
    keywords.push('instrumental', 'lofi', 'ambient');
    targets.energy = 0.35; targets.valence = 0.5; targets.tempo = Math.min(targets.tempo ?? 999, 100);
  }
  if (/(party|dance|club|celebrat|birthday|wedding)/.test(s)) {
    moodKey = 'Energetic'; energy = 'high'; tone = 'celebratory';
    keywords.push('dance', 'party');
    targets.valence = 0.8; targets.energy = 0.85; targets.tempo = Math.max(targets.tempo ?? 0, 120);
  }
  if (/(lonely|alone|cry|tears|blue|depress|sad)/.test(s)) {
    moodKey = 'Sad'; tone = tone === 'neutral' ? 'sad' : tone;
    keywords.push('piano', 'acoustic');
    targets.valence = Math.min(targets.valence ?? 1, 0.25); targets.energy = Math.min(targets.energy ?? 1, 0.45);
  }
  const exclam = (s.match(/!/g) || []).length;
  const intensifiers = (s.match(/\b(very|so|really|super|extremely)\b/g) || []).length;
  if (exclam + intensifiers >= 2) {
    if (moodKey === 'Sad') { targets.energy = 0.3; targets.tempo = 75; }
    if (moodKey === 'Energetic') { targets.energy = 0.92; targets.tempo = 132; }
  }
  const confirmation = `Got it. ${contexts.includes('rainy') ? 'Rainy ' : ''}${tone !== 'neutral' ? tone : moodKey.toLowerCase()} vibes, right?`;
  const uniq = Array.from(new Set(keywords)).slice(0, 8);
  return { moodKey, energy, tone, keywords: uniq, targets: Object.keys(targets).length ? targets : undefined, confirmation };
}

function buildVibeQueries(taste: TasteProfile, moodKey: string, signals: VibeSignals): string[] {
  const base = buildMoodQueries(taste, moodKey);
  const kw = (signals.keywords || []).map((s) => s.toLowerCase());
  const out: string[] = [];
  const pick = (arr: string[], n: number) => arr.slice(0, Math.max(0, n));
  for (const g of pick(taste.genres, 6)) {
    for (const k of pick(kw, 3)) out.push(`genre:"${g}" ${k}`);
  }
  for (const a of pick(taste.artistNames, 6)) {
    for (const k of pick(kw, 2)) out.push(`artist:"${a}" ${k}`);
  }
  for (const k of pick(kw, 3)) out.push(k);
  return Array.from(new Set([...out, ...base]));
}

// ---- Comfort/Uplift catalog ----
const COMFORT_MESSAGES: Record<string, string[]> = {
  sad: [
    "It's okay to feel heavy—let the music hold some of it for you.",
    "You’re not alone. Take a breath and ease into these gentle tracks.",
    "Soft songs for a soft heart—one step at a time.",
    "For when words are hard, let melodies speak.",
    "Be kind to yourself today. Here's something tender." ,
  ],
  reflective: [
    "Quiet moments deserve quiet music.",
    "A little space to think, a little sound to feel.",
    "Slow rain, slow thoughts—let it all flow.",
    "Breathe in, breathe out—settle into the calm.",
    "Low lights, warm soundscape—you’re safe here.",
  ],
  focus: [
    "No rush. One page, one task, one track at a time.",
    "You’ve got this. Gentle focus, steady rhythm.",
    "Deep work mode: on. The noise can wait.",
    "Small progress is still progress. Keep going.",
    "Focus first—everything else later.",
  ],
  nostalgic: [
    "A little time travel for the heart.",
    "Old feelings, new peace—let’s revisit gently.",
    "The past can be soft. Here’s a warm rewind.",
    "Memories in stereo—take it slow.",
    "Golden-hour echoes for tender recollection.",
  ],
  angry: [
    "Turn it up. Let the volume carry the weight.",
    "Channel the fire—burn clean, not out.",
    "Let it out, then let it go.",
    "Energy for the storm—ride it, don’t drown in it.",
    "Strong beats for strong feelings.",
  ],
  celebratory: [
    "Good things deserve loud music.",
    "Joy has a volume—let's turn it up.",
    "You made it—now dance a little.",
    "Smiles, basslines, and bright choruses.",
    "Let the room feel as alive as you do.",
  ],
  chill: [
    "Cozy corners, warm sound—settle in.",
    "Low tempo, high comfort.",
    "Soft lights and softer melodies.",
    "Sip something warm and exhale.",
    "This is your slow lane—welcome.",
  ],
  romantic: [
    "Something tender for the heart.",
    "Warm tones for warm feelings.",
    "Close your eyes—lean into it.",
    "For feelings that don’t need many words.",
    "Soft rhythms for softer moments.",
  ],
  energetic: [
    "Let the beat do the lifting.",
    "Momentum unlocked—move how you want.",
    "Energy on, doubts off.",
    "Your pulse, but louder.",
    "Hype without the hassle—go.",
  ],
  generic: [
    "Here’s a little soundtrack to carry you.",
    "A mix built for right now—press play when you’re ready.",
    "Lean into the moment—this one’s tuned for you.",
    "Music that meets you where you are.",
    "Take what you need and leave the rest—track by track.",
  ],
};

function pickComfortMessage(signals: VibeSignals | null, moodKey: string): string {
  const tone = signals?.tone || '';
  const m = (signals?.moodKey || moodKey || 'Happy').toLowerCase();
  let bucket = 'generic';
  if (tone === 'heartbroken' || m === 'sad') bucket = 'sad';
  else if (tone === 'nostalgic') bucket = 'nostalgic';
  else if (tone === 'focused' || m === 'focus') bucket = 'focus';
  else if (tone === 'angry') bucket = 'angry';
  else if (tone === 'celebratory') bucket = 'celebratory';
  else if (m === 'romantic') bucket = 'romantic';
  else if (m === 'energetic') bucket = 'energetic';
  else if (m === 'chill') bucket = 'chill';
  else if (m === 'happy') bucket = 'celebratory';
  const arr = COMFORT_MESSAGES[bucket] || COMFORT_MESSAGES.generic;
  return arr[Math.floor(Math.random() * arr.length)] || COMFORT_MESSAGES.generic[0];
}

async function searchSpotifyTracksMulti(token: string, queries: string[], limitEach = 8, capTotal = 100, market = "US"): Promise<any[]> {
  const out: any[] = [];
  const seenIds = new Set<string>();
  for (const q of queries) {
    if (out.length >= capTotal) break;
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", q);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", String(limitEach));
    url.searchParams.set("market", market);
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

function scoreAndMapCandidates(items: any[], taste: TasteProfile, moodKey: string, contextKeywords?: string[]): Track[] {
  const profile = MOOD_PROFILE[moodKey as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy;
  const kw = profile.keywords.map((s) => s.toLowerCase());
  const tasteGenres = new Set(taste.genres.map((g) => g.toLowerCase()));
  const tasteArtists = new Set(taste.artistNames.map((a) => a.toLowerCase()));
  const ctx = (contextKeywords || []).map((s) => s.toLowerCase());
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
    if (ctx.length) {
      let hits = 0; for (const c of ctx) if (c && hay.includes(c)) hits += 1; s += Math.min(3, hits);
    }
    if (year && nowYear - year <= 10) s += 1;
    const pop = Number(n?.popularity ?? 0) || 0;
    const track: Track = {
      title,
      artist: artistNames.join(", "),
      cover: n?.album?.images?.[1]?.url || n?.album?.images?.[0]?.url || "",
      previewUrl: n?.preview_url || null,
      spotifyUrl: n?.external_urls?.spotify || (n?.id ? `https://open.spotify.com/track/${n.id}` : undefined),
      spotifyId: n?.id || undefined,
      artistIds: (n?.artists?.map((a: any) => a?.id).filter(Boolean)) || [],
      primaryArtistId: n?.artists?.[0]?.id || undefined,
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

// ---- Audio Features helpers ----
type AudioFeatures = { id: string; valence?: number; energy?: number; danceability?: number; tempo?: number };
async function fetchAudioFeatures(token: string, ids: string[]): Promise<Map<string, AudioFeatures>> {
  const out = new Map<string, AudioFeatures>();
  const batchSize = 80;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    if (!chunk.length) continue;
    const u = new URL("https://api.spotify.com/v1/audio-features");
    u.searchParams.set("ids", chunk.join(","));
    try {
      const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!res.ok) continue;
      const j = (await res.json()) as any;
      const arr: any[] = j?.audio_features ?? [];
      for (const f of arr) {
        const id = String(f?.id || "").trim();
        if (!id) continue;
        out.set(id, { id, valence: f?.valence, energy: f?.energy, danceability: f?.danceability, tempo: f?.tempo });
      }
    } catch {}
  }
  return out;
}

function rankByMood(tracks: Track[], features: Map<string, AudioFeatures>, mood: string): Track[] {
  const t = getMoodTargets(mood);
  const has = (x: any) => typeof x === 'number' && !Number.isNaN(x);
  const within = (x: number, target: number, tol: number) => Math.abs(x - target) <= tol;
  const hard: { [k: string]: (f: AudioFeatures) => boolean } = {
    happy: (f) => has(f.valence!) && has(f.energy!) && has(f.tempo!) && f.valence! >= 0.6 && f.energy! >= 0.5 && f.tempo! >= 100,
    sad: (f) => has(f.valence!) && has(f.energy!) && has(f.tempo!) && f.valence! <= 0.4 && f.energy! <= 0.6 && f.tempo! <= 110,
    chill: (f) => has(f.energy!) && has(f.tempo!) && f.energy! <= 0.55 && f.tempo! <= 105,
    energetic: (f) => has(f.energy!) && has(f.tempo!) && f.energy! >= 0.75 && f.tempo! >= 118,
    romantic: (f) => has(f.valence!) && has(f.energy!) && f.valence! >= 0.5 && f.valence! <= 0.85 && f.energy! <= 0.65,
    focus: (f) => has(f.energy!) && has(f.tempo!) && f.energy! <= 0.5 && f.tempo! >= 60 && f.tempo! <= 110,
  };
  const key = (mood || '').toLowerCase();
  const passHard = hard[key] || (() => true);

  const scored = tracks.map((tr) => {
    const id = tr.spotifyId || (tr.spotifyUrl ? tr.spotifyUrl.split('/').pop() : undefined);
    const f = (id && features.get(id)) || undefined;
    let score = 9999; // lower is better
    let ok = false;
    if (f) {
      const dv = has(f.valence!) ? Math.abs((f.valence as number) - (t.valence ?? 0.6)) : 0.6;
      const de = has(f.energy!) ? Math.abs((f.energy as number) - (t.energy ?? 0.6)) : 0.6;
      const dd = has(f.danceability!) ? Math.abs((f.danceability as number) - (t.danceability ?? 0.6)) : 0.6;
      const dtempo = has(f.tempo!) && t.tempo ? Math.abs((f.tempo as number) - (t.tempo as number)) / 60 : 1.0;
      score = dv * 0.35 + de * 0.35 + dd * 0.2 + dtempo * 0.1;
      ok = passHard(f);
    }
    return { tr, score, ok };
  });

  // Prefer those that pass hard filters, then by score
  scored.sort((a, b) => (Number(b.ok) - Number(a.ok)) || (a.score - b.score));
  const keep = scored
    .filter((x) => x.ok)
    .map((x) => x.tr);
  // If too few strict matches, take best-scored to fill up
  let out = keep;
  if (out.length < 12) {
    for (const s of scored) {
      if (out.includes(s.tr)) continue;
      out.push(s.tr);
      if (out.length >= 15) break;
    }
  }
  return out;
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
          spotifyId: t?.id || undefined,
          artistIds: (t?.artists?.map((a: any) => a?.id).filter(Boolean)) || [],
          primaryArtistId: t?.artists?.[0]?.id || undefined,
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
async function fetchRecommendationsWithSeeds(
  bearer: string,
  seeds: { artists?: string[]; tracks?: string[]; genres?: string[] },
  limit = 10,
  market = "US",
  targets?: Partial<MoodTargets>
): Promise<Track[]> {
  const url = new URL("https://api.spotify.com/v1/recommendations");
  if (seeds.artists?.length) url.searchParams.set("seed_artists", seeds.artists.slice(0, 5).join(","));
  if (seeds.tracks?.length) url.searchParams.set("seed_tracks", seeds.tracks.slice(0, 5).join(","));
  if (seeds.genres?.length) url.searchParams.set("seed_genres", seeds.genres.slice(0, 5).join(","));
  url.searchParams.set("limit", String(Math.max(1, Math.min(20, limit))));
  url.searchParams.set("market", market);
  if (targets?.valence != null) url.searchParams.set("target_valence", String(targets.valence));
  if (targets?.energy != null) url.searchParams.set("target_energy", String(targets.energy));
  if (targets?.danceability != null) url.searchParams.set("target_danceability", String(targets.danceability));
  if (targets?.tempo != null) url.searchParams.set("target_tempo", String(targets.tempo));
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
    spotifyId: t?.id || undefined,
    artistIds: (t?.artists?.map((a: any) => a?.id).filter(Boolean)) || [],
    primaryArtistId: t?.artists?.[0]?.id || undefined,
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

async function searchSpotifySingle(token: string, title: string, artist: string, market = "US"): Promise<{ url?: string; id?: string; cover?: string; preview?: string | null; artistIds?: string[] } | null> {
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
    u.searchParams.set("market", market);
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
        artistIds: (item?.artists?.map((a: any) => a?.id).filter(Boolean)) || [],
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

// Cache for MusicBrainz artist tags to avoid repeated lookups per artist within session
const ARTIST_TAGS_CACHE = new Map<string, { tags: string[]; ts: number }>();

async function getArtistTagsCached(name: string, ttlMs = 12 * 60 * 60 * 1000): Promise<string[]> {
  const key = (name || "").trim().toLowerCase();
  if (!key) return [];
  const now = Date.now();
  const hit = ARTIST_TAGS_CACHE.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.tags;
  const tags = await fetchMBArtistTagsByName(name).catch(() => []);
  ARTIST_TAGS_CACHE.set(key, { tags, ts: now });
  return tags;
}

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
    spotifyId: t?.id || undefined,
    artistIds: (t?.artists?.map((a: any) => a?.id).filter(Boolean)) || [],
    primaryArtistId: t?.artists?.[0]?.id || undefined,
  }));
  return tracks;
}

export const POST = async (req: NextRequest) => {
  try {
    const payload = (await req.json()) as Payload;
    const mood = payload.mood?.trim();
    const prompt = payload.prompt?.trim();
    const lang = (payload.language || 'any');
    const market = lang === 'urdu' ? 'PK' : 'US';

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
    // Extract vibe signals early so they can guide recommendations too
    const signals = prompt ? extractVibeSignals(prompt, selectedMood) : null;
    if (signals?.moodKey) selectedMood = signals.moodKey;

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

    // Use user taste only as ANCHORS: fetch similar tracks via artist top tracks and recommendations (not direct reuse of user's top tracks)
    let anchorCandidates: Track[] = [];
    if (personal && userAccessToken) {
      try {
        if (personal.topArtistIds?.length) {
          const viaArtists = await fetchArtistsTopTracks(userAccessToken, personal.topArtistIds.slice(0, 6), market, 2, 10);
          anchorCandidates = anchorCandidates.concat(viaArtists);
        }
        const moodSeeds = (MOOD_TO_SEEDS[selectedMood] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const recs = await fetchRecommendationsWithSeeds(userAccessToken, {
          artists: personal.topArtistIds?.slice(0, 5),
          tracks: personal.topTrackIds?.slice(0, 5),
          genres: moodSeeds.slice(0, 3),
        }, 15, market, signals?.targets || getMoodTargets(selectedMood));
        anchorCandidates = anchorCandidates.concat(recs);

        // If user's anchors don't match the mood well, expand with related artists filtered by mood and retune
        try {
          const coverage = await assessMoodCoverage(userAccessToken || token, anchorCandidates, selectedMood);
          if (coverage < 0.35 && (personal.topArtistIds?.length || 0) > 0) {
            const related = await fetchRelatedArtists(userAccessToken || token, personal.topArtistIds.slice(0, 8), 20);
            if (related.length) {
              const profile = MOOD_PROFILE[selectedMood as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy;
              const moodGenSet = new Set((profile.exampleGenres || []).map((g) => g.toLowerCase()));
              const relGenresMap = await fetchArtistsGenres(userAccessToken || token, related, market);
              const filteredRelated = related.filter((id) => (relGenresMap.get(id) || []).some((g) => moodGenSet.has(String(g).toLowerCase())));
              const tunedTargets = signals?.targets || getMoodTargets(selectedMood);
              const moodSeeds2 = (MOOD_TO_SEEDS[selectedMood] || "").split(",").map((s) => s.trim()).filter(Boolean);
              const recs2 = await fetchRecommendationsWithSeeds(userAccessToken, { artists: filteredRelated.slice(0, 5), genres: moodSeeds2.slice(0, 3) }, 20, market, tunedTargets);
              // Keep only strict mood matches
              const ids2 = Array.from(new Set(recs2.map((t) => t.spotifyId).filter(Boolean))) as string[];
              const feats2 = await fetchAudioFeatures(userAccessToken || token, ids2);
              const strictRecs = recs2.filter((t) => {
                const f = t.spotifyId ? feats2.get(t.spotifyId) : undefined;
                return f ? passesHardForMood(selectedMood, f) : true;
              });
              anchorCandidates = anchorCandidates.concat(strictRecs);
            }
          }
        } catch {}
      } catch {}
    }

    // Build taste and mood queries, search for candidates (no recommendations/audio-features)
    const taste = await buildTasteProfile(userAccessToken);
    const queries = signals ? buildVibeQueries(taste, selectedMood, signals) : buildMoodQueries(taste, selectedMood);
    const candidatesRaw = await searchSpotifyTracksMulti(userAccessToken || token, queries, 8, 100, market);
    let candidates = scoreAndMapCandidates(candidatesRaw, taste, selectedMood, signals?.keywords);

    // Merge in anchor candidates (artist top tracks + recommendations) and de-dup
    const keyOf = (t: Track) => `${t.title}@@${t.artist}`;
    const merged: Track[] = [];
    const seenCand = new Set<string>();
    for (const t of [...anchorCandidates, ...candidates]) {
      const k = keyOf(t);
      if (seenCand.has(k)) continue;
      seenCand.add(k);
      merged.push(t);
    }
    candidates = merged;

    // Exclude user's top tracks unless they match mood keywords
    if (taste.topTrackIds.size) {
      const moodKw = (MOOD_PROFILE[selectedMood as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy).keywords.map((k) => k.toLowerCase());
      candidates = candidates.filter((t) => {
        const ok = !Array.from(taste.topTrackIds).some((id) => (t.spotifyUrl || "").endsWith(id)) || moodKw.some((k) => (`${t.title} ${t.artist}`).toLowerCase().includes(k));
        return ok;
      });
    }
    // Prefetch artist tags for candidates (primary artist only) using MusicBrainz, cached
    const primaryArtists = Array.from(new Set(candidates
      .map((t) => (t.artist || "").split(",")[0]?.trim())
      .filter(Boolean)
    ));
    const artistTagsMap = new Map<string, string[]>();
    if (primaryArtists.length) {
      const tagLists = await runWithConcurrency(primaryArtists, 5, (name) => getArtistTagsCached(name));
      tagLists.forEach((tags, i) => {
        const key = (primaryArtists[i] || "").toLowerCase();
        artistTagsMap.set(key, (tags || []).map((s) => s.toLowerCase()));
      });
    }
    // Score candidates with 60% mood alignment, 40% user taste alignment
    const moodProfile = MOOD_PROFILE[selectedMood as keyof typeof MOOD_PROFILE] || MOOD_PROFILE.Happy;
    const moodKw = moodProfile.keywords.map((s) => s.toLowerCase());
    const moodGenres = new Set((moodProfile.exampleGenres || []).map((g) => g.toLowerCase()));
    const moodTags = new Set<string>([...moodKw, ...moodGenres]);
    const tasteGenres = new Set((taste.genres || []).map((g) => g.toLowerCase()));
    const tasteArtists = new Set((taste.artistNames || []).map((a) => a.toLowerCase()));
    const tasteTags = new Set((taste.tags || []).map((t) => t.toLowerCase()));

    const scoredCandidates = candidates.map((t) => {
      const hay = `${t.title} ${t.artist}`.toLowerCase();
      const primary = (t.artist || "").split(",")[0]?.trim().toLowerCase();
      const artistTags = primary ? (artistTagsMap.get(primary) || []) : [];
      // moodScore: keyword hits + genre overlap with mood exampleGenres
      let moodScore = 0;
      for (const k of moodKw) if (hay.includes(k)) moodScore += 1;
      // Approx genre overlap using text; if cover/spotify data includes genres it's not present here, so infer via keywords in title/artist
      let moodGenreOverlap = 0;
      for (const g of moodGenres) if (hay.includes(g)) moodGenreOverlap += 1;
      moodScore += Math.min(2, moodGenreOverlap);
      // Tag overlap with mood tags (from MB artist tags)
      let moodTagOverlap = 0;
      for (const tag of artistTags) if (moodTags.has(tag)) moodTagOverlap += 1;
      moodScore += Math.min(2, moodTagOverlap);

      // tasteScore: artist name overlap + user genre tokens present in title/artist
      let tasteScore = 0;
      for (const a of tasteArtists) if (a && hay.includes(a)) tasteScore += 2; // strong boost if known artist
      let tasteGenreOverlap = 0;
      for (const g of tasteGenres) if (hay.includes(g)) tasteGenreOverlap += 1;
      tasteScore += Math.min(2, tasteGenreOverlap);
      // Tag overlap with user's taste tags (aggregated from their artists via MB)
      let tasteTagOverlap = 0;
      for (const tag of artistTags) if (tasteTags.has(tag)) tasteTagOverlap += 1;
      tasteScore += Math.min(2, tasteTagOverlap);

      // small popularity proxy: prefer entries with previewUrl present
      const pop = t.previewUrl ? 0.5 : 0;

      const final = 0.6 * moodScore + 0.4 * tasteScore + pop * 0.1;
      return { t, final };
    });
    scoredCandidates.sort((a, b) => b.final - a.final);

    for (const { t } of scoredCandidates) {
      const key = `${t.title}@@${t.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(t);
      if (results.length >= 25) break;
    }

    const searchResults = await runWithConcurrency(scored, 6, async (r) => {
      const key = `${r.title}@@${r.artist}`;
      if (seen.has(key)) return null as any;
      const found = await searchSpotifySingle(token, r.title, r.artist, market);
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
        const found = await searchSpotifySingle(token, r.title, r.artist, market);
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
      const moodSearchResults = await searchTracks(token, selectedMood, 10, market);
      for (const t of moodSearchResults) {
        const key = `${t.title}@@${t.artist}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ ...t, matchReason: "fallback mood search" });
        if (results.length >= 10) break;
      }
    }

    // Already sorted by weighted mood/taste; keep order

    const final = combinePersonalAndMoodTracks(results, [], new Set<string>(), 25);

    // Language filtering heuristics
    function textStats(s: string) {
      const arabic = (s.match(/[\u0600-\u06FF]/g) || []).length; // Arabic/Urdu script
      const latin = (s.match(/[A-Za-z]/g) || []).length;
      return { arabic, latin };
    }
    function isUrduTitleArtist(title: string, artist: string) {
      const hay = `${title} ${artist}`;
      const { arabic, latin } = textStats(hay);
      if (arabic >= 2) return true;
      // common Urdu/Pakistani markers in Latin script
      if (/(urdu|pak(istan)?|qawwali|nusrat|atif|rahat|ali|khan|noor|mehdi|ghazal)/i.test(hay)) return true;
      return false;
    }
    function isEnglishTitleArtist(title: string, artist: string) {
      const hay = `${title} ${artist}`;
      const { arabic, latin } = textStats(hay);
      return latin >= 2 && arabic === 0;
    }

    // Fetch artist genres for stricter language classification
    const allArtistIds = Array.from(new Set(final.flatMap((t) => t.artistIds || [])));
    const artistGenresMap = await fetchArtistsGenres(userAccessToken || token, allArtistIds, market);
    const getGenres = (t: Track) => {
      const ids = t.artistIds || [];
      const gens: string[] = [];
      for (const id of ids) {
        const g = artistGenresMap.get(id) || [];
        for (const gg of g) gens.push(gg);
      }
      return gens;
    };
    const filtered = final.filter((t) => {
      if (lang === 'any') return true;
      const gens = getGenres(t);
      if (lang === 'english') return isEnglishStrict(t.title, t.artist, gens);
      if (lang === 'urdu') return isUrduStrict(t.title, t.artist, gens);
      return true;
    });
    let list = filtered;

    // If filtering removed too much, actively fetch more language-hinted candidates
    if (list.length < 10) {
      try {
        const langQueries = buildLanguageHintQueries(lang, selectedMood);
        if (langQueries.length) {
          const langCandidatesRaw = await searchSpotifyTracksMulti(userAccessToken || token, langQueries, 8, 60, market);
          let langCandidates = scoreAndMapCandidates(langCandidatesRaw, taste, selectedMood, signals?.keywords);
          // Apply strict language filter on these candidates using genres
          const candArtistIds = Array.from(new Set(langCandidates.flatMap((t) => t.artistIds || [])));
          const candGenresMap = await fetchArtistsGenres(userAccessToken || token, candArtistIds, market);
          langCandidates = langCandidates.filter((t) => {
            const gens = (t.artistIds || []).flatMap((id) => candGenresMap.get(id) || []);
            if (lang === 'english') return isEnglishStrict(t.title, t.artist, gens);
            if (lang === 'urdu') return isUrduStrict(t.title, t.artist, gens);
            return true;
          });
          // Dedupe with existing list
          const k = (t: Track) => `${t.title}@@${t.artist}`;
          const seenK = new Set(list.map(k));
          for (const t of langCandidates) {
            const key = k(t);
            if (seenK.has(key)) continue;
            seenK.add(key);
            list.push(t);
            if (list.length >= 15) break;
          }
        }
      } catch {}
    }

    // Fetch audio features and compute final score = 0.5*taste + 0.4*mood + 0.1*language
    const ids = Array.from(new Set(list.map((t) => t.spotifyId).filter(Boolean))) as string[];
    const artistIdsForList = Array.from(new Set(list.flatMap((t) => t.artistIds || [])));
    let ranked: Track[] = list;
    try {
      const [feats, genresMap] = await Promise.all([
        ids.length ? fetchAudioFeatures(userAccessToken || token, ids) : Promise.resolve(new Map()),
        artistIdsForList.length ? fetchArtistsGenres(userAccessToken || token, artistIdsForList, market) : Promise.resolve(new Map()),
      ]);
      ranked = scoreByFormula({ tracks: list, features: feats as Map<string, any>, taste, mood: selectedMood, lang, artistGenresMap: genresMap as Map<string, string[]>, customTargets: signals?.targets });
    } catch {}
    const finalTracks = ranked.slice(0, Math.max(10, Math.min(15, ranked.length)));
    const comfort = pickComfortMessage(signals, selectedMood);
    return NextResponse.json({ ok: true, mood: tag, tracks: finalTracks, meta: { source: userAccessToken ? "personalized+scored" : "scored", confirmation: (signals?.confirmation || undefined), comfort } });
  } catch (err: any) {
    console.error("[API /generatePlaylist] Error:", err);
    const msg = String(err?.message || "Unknown error");
    const status = /unauthorized|401/i.test(msg) ? 401 : /invalid|bad request|400/i.test(msg) ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}


