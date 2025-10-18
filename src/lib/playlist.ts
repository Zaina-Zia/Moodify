export type Track = {
  title: string;
  artist: string;
  cover: string;
  previewUrl?: string | null;
  durationMs?: number;
};

export type PersonalizationMeta = {
  personalized?: boolean;
  username?: string;
};

const titles = [
  "Neon Dreams",
  "Midnight Coffee",
  "Gentle Rain",
  "Purple Skyline",
  "City Lights",
  "Cozy Corners",
  "Starlit Road",
];

const artists = [
  "Luna Vibe",
  "Echo Valley",
  "Astra Nova",
  "Velvet Wave",
  "Mono Bloom",
  "Quiet Parade",
];

function img(seed: string) {
  const s = encodeURIComponent(seed);
  return `https://picsum.photos/seed/${s}/200/200`;
}

function takeRandom<T>(arr: T[], n: number) {
  const res: T[] = [];
  const pool = [...arr];
  while (res.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    res.push(pool.splice(i, 1)[0]);
  }
  return res;
}

export function generatePlaylist(mood: string): Track[] {
  const count = 5;
  const selTitles = takeRandom(titles, count);
  const selArtists = takeRandom(artists, count);
  return Array.from({ length: count }).map((_, i) => ({
    title: `${selTitles[i]} (${mood})`,
    artist: selArtists[i % selArtists.length],
    cover: img(`${mood}-${i}`),
    previewUrl: null,
  }));
}

export function generatePlaylistFromPrompt(prompt: string): Track[] {
  const count = 4;
  const selTitles = takeRandom(titles, count);
  const selArtists = takeRandom(artists, count);
  return Array.from({ length: count }).map((_, i) => ({
    title: `${selTitles[i]} — Prompted` ,
    artist: selArtists[i % selArtists.length],
    cover: img(`${prompt}-${i}`),
    previewUrl: null,
  }));
}

// Simple keyword-based analyzer. Maps free-text to one of the app moods.
export function analyzePrompt(prompt: string):
  | "Happy"
  | "Chill"
  | "Sad"
  | "Energetic"
  | "Romantic"
  | "Focus" {
  const p = prompt.toLowerCase();
  if (/(rain|calm|lofi|cozy|chill|ambient)/.test(p)) return "Chill";
  if (/(sad|melancholy|blue|cry|ballad)/.test(p)) return "Sad";
  if (/(love|romance|date|heart|r&b|soul)/.test(p)) return "Romantic";
  if (/(study|focus|work|deep|instrumental)/.test(p)) return "Focus";
  if (/(party|upbeat|club|energy|energetic|edm|rock|dance)/.test(p)) return "Energetic";
  return "Happy";
}

// Client-side wrappers to call our API. Falls back to mock on failure.
export async function fetchPlaylistByMood(mood: string): Promise<{ tracks: Track[]; usedMock: boolean; meta?: PersonalizationMeta }> {
  try {
    const res = await fetch("/api/generatePlaylist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mood }),
    });
    const data = (await res.json()) as { ok: boolean; tracks?: Track[]; meta?: PersonalizationMeta; mood?: string };
    if (data.ok && data.tracks && data.tracks.length) {
      const enriched = await enrichTracksWithSpotifyPreview(data.tracks, data.mood);
      return { tracks: enriched, usedMock: false, meta: data.meta };
    }
    return { tracks: generatePlaylist(mood), usedMock: true, meta: undefined };
  } catch {
    return { tracks: generatePlaylist(mood), usedMock: true, meta: undefined };
  }
}

export async function fetchPlaylistByPrompt(prompt: string): Promise<{ tracks: Track[]; usedMock: boolean; meta?: PersonalizationMeta }> {
  try {
    const res = await fetch("/api/generatePlaylist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = (await res.json()) as { ok: boolean; tracks?: Track[]; meta?: PersonalizationMeta; mood?: string };
    if (data.ok && data.tracks && data.tracks.length) {
      const enriched = await enrichTracksWithSpotifyPreview(data.tracks, data.mood);
      return { tracks: enriched, usedMock: false, meta: data.meta };
    }
    return { tracks: generatePlaylistFromPrompt(prompt), usedMock: true, meta: undefined };
  } catch {
    return { tracks: generatePlaylistFromPrompt(prompt), usedMock: true, meta: undefined };
  }
}

async function enrichTracksWithSpotifyPreview(tracks: Track[], mood?: string): Promise<Track[]> {
  try {
    const body = {
      tracks: tracks.map((t) => ({ title: t.title, artist: t.artist })),
      limit_per_track_search: 3,
      concurrency_limit: 3,
      mood: mood ?? null,
      market: "US",
    };
    const res = await fetch("/api/spotifyPreview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      results?: Array<{
        title: string;
        artist: string;
        previews?: Array<{ name?: string; preview_url?: string | null; spotify_url?: string | null }>;
        error?: string;
      }>;
      error?: string;
    };
    if (!data.results) return tracks;

    // Server now only returns tracks that have previews. Build a new list from results.
    const norm = (s: string) => s.trim().toLowerCase();
    const mapped = data.results.map((r) => {
      const first = r?.previews && r.previews.length ? r.previews[0] : undefined;
      // Try to carry over cover/duration by matching original entries
      const match = tracks.find(
        (t) => norm(t.title) === norm(r.title) && norm(t.artist) === norm(r.artist)
      );
      return {
        title: r.title,
        artist: r.artist,
        cover: match?.cover || "",
        previewUrl: first?.preview_url ?? null,
        durationMs: match?.durationMs,
      } as Track;
    });

    return mapped.length ? mapped : tracks;
  } catch {
    return tracks;
  }
}
