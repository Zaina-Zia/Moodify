import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs"; // Ensure Node runtime (Buffer + standard fetch)

// Minimal Track type to match frontend expectations
export type Track = {
  title: string;
  artist: string;
  cover: string;
  previewUrl?: string | null;
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
async function getAvailableGenreSeeds(token: string): Promise<string[]> {
  const now = Date.now();
  if (genreSeedsCache && now - genreSeedsCache.ts < 12 * 60 * 60 * 1000) {
    return genreSeedsCache.seeds;
  }
  const res = await fetch("https://api.spotify.com/v1/recommendations/available-genre-seeds", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[Spotify] Could not fetch available genre seeds:", res.status, body);
    return [];
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

    const topArtistIds: string[] = topArtistsRes.ok ? (((await topArtistsRes.json()) as any)?.items ?? []).map((a: any) => a.id) : [];
    const topTrackIds: string[] = topTracksRes.ok ? (((await topTracksRes.json()) as any)?.items ?? []).map((t: any) => t.id) : [];
    const recentTrackIds: string[] = recentRes.ok ? ((((await recentRes.json()) as any)?.items ?? []).map((it: any) => it?.track?.id).filter(Boolean)) : [];

    const seeds: PersonalSeeds = {
      userId,
      username: me?.display_name ?? undefined,
      topArtistIds,
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

    // Mood targets for valence/energy/danceability
    const MOOD_TARGETS: Record<string, Partial<Record<'target_valence' | 'target_energy' | 'target_danceability', number>>> = {
      Happy: { target_valence: 0.85, target_energy: 0.7, target_danceability: 0.7 },
      Sad: { target_valence: 0.3, target_energy: 0.35 },
      Chill: { target_energy: 0.4, target_valence: 0.5 },
      Energetic: { target_energy: 0.9, target_danceability: 0.85, target_valence: 0.7 },
      Romantic: { target_valence: 0.65, target_energy: 0.55 },
      Focus: { target_energy: 0.35, target_valence: 0.5 },
    };

    // Try Recommendations first with validated seeds (+ personalized seeds when available); on failure, fall back to Search
    let tracks: Track[] = [];
    try {
      // Validate configured seeds against account/region
      const requested = (MOOD_TO_SEEDS[selectedMood] ?? "pop").split(",").map((s) => s.trim());
      const available = await getAvailableGenreSeeds(token);
      const valid = available.length
        ? requested.filter((s) => available.includes(s))
        : requested; // If we couldn't fetch seeds, try anyway
      let seeds = valid.slice(0, 5);
      if (!seeds.length) {
        // Replace with random available seeds to avoid 404
        const pool = available.length ? available : ["pop", "rock", "dance", "edm", "chill"];
        while (seeds.length < 3 && pool.length) {
          const i = Math.floor(Math.random() * pool.length);
          seeds.push(pool.splice(i, 1)[0]);
        }
      }
      // Collect personalized seeds if user is logged in
      let seedArtists: string[] = [];
      let seedTracks: string[] = [];
      let personalizedUsername: string | undefined;
      let recentIds: string[] = [];
      if (userAccessToken) {
        try {
          const seeds = await fetchPersonalSeeds(userAccessToken);
          if (seeds) {
            personalizedUsername = seeds.username;
            seedArtists = (seeds.topArtistIds ?? []).slice(0, 2);
            seedTracks = (seeds.topTrackIds ?? []).slice(0, 2);
            recentIds = (seeds.recentTrackIds ?? []).slice(0, 2);
          }
          console.log("✅ Personalized seeds:", { artists: seedArtists.length, tracks: seedTracks.length, recents: recentIds.length });
        } catch (e) {
          console.warn("[Spotify] Could not fetch user tops:", e);
        }
      }
      // Compose up to 5 total seeds across genres/artists/tracks
      // Prefer user seeds first; Spotify allows up to 5 across artists/tracks/genres combined
      const roomForGenres = Math.max(0, 5 - seedArtists.length - seedTracks.length - recentIds.length);
      const seedCsv = seeds.slice(0, roomForGenres).join(",");
      tracks = await (async () => {
        const url = new URL("https://api.spotify.com/v1/recommendations");
        url.searchParams.set("seed_genres", seedCsv);
        if (seedArtists.length) url.searchParams.set("seed_artists", seedArtists.slice(0, 2).join(","));
        // Include some tracks from top and recent, respecting overall seed count
        const trackSeeds = [...seedTracks, ...recentIds].slice(0, Math.max(0, 5 - seedArtists.length - (seedCsv ? seedCsv.split(',').length : 0)));
        if (trackSeeds.length) url.searchParams.set("seed_tracks", trackSeeds.join(","));
        url.searchParams.set("limit", String(20));
        url.searchParams.set("market", "US");
        const targets = MOOD_TARGETS[selectedMood] ?? {};
        for (const [k, v] of Object.entries(targets)) url.searchParams.set(k, String(v));
        const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!res.ok) throw new Error(`Recommendations failed: ${res.status}`);
        const json = (await res.json()) as any;
        const items = (json?.tracks ?? []) as any[];
        return items.map((t) => ({
          title: t.name,
          artist: (t.artists?.map((a: any) => a.name) ?? []).join(", "),
          cover: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || "",
          previewUrl: t.preview_url || null,
        })) as Track[];
      })();
      if (!tracks.length) throw new Error("Recommendations empty");
      console.log("✅ Spotify personalized playlist fetched for mood:", selectedMood, "count:", tracks.length);
      return NextResponse.json({ ok: true, mood: selectedMood, tracks, meta: { personalized: Boolean(userAccessToken), username: personalizedUsername } });
    } catch (recErr) {
      console.warn("⚠️ Fallback to search:", MOOD_TO_QUERY[selectedMood] ?? "pop");
      // Pull a larger set then pick the best 5–7
      tracks = await searchTracks(token, selectedMood, 20, "US");
      // Prefer tracks that have an image and title/artist
      tracks = tracks.filter((t) => t.title && t.artist && t.cover);
      if (tracks.length > 7) tracks = tracks.slice(0, 7);
      if (!tracks.length) {
        console.warn("❌ No tracks found after fallback (mood:", selectedMood, ") — retrying generic query");
        // Last-resort generic search
        const genericQ = "pop OR rock OR edm OR chill";
        const url = new URL("https://api.spotify.com/v1/search");
        url.searchParams.set("q", genericQ);
        url.searchParams.set("type", "track");
        url.searchParams.set("limit", String(20));
        url.searchParams.set("market", "US");
        const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as any;
          const items = (json?.tracks?.items ?? []) as any[];
          tracks = items.map((t) => ({
            title: t.name,
            artist: (t.artists?.map((a: any) => a.name) ?? []).join(", "),
            cover: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || "",
            previewUrl: t.preview_url || null,
          }));
          if (tracks.length > 7) tracks = tracks.slice(0, 7);
        }
      }
    }
    console.log("✅ Spotify playlist fetched (fallback) for mood:", selectedMood, "count:", tracks.length);
    return NextResponse.json({ ok: true, message: "✅ Spotify playlist fetched", mood: selectedMood, tracks, meta: { personalized: false } });
  } catch (err: any) {
    console.error("[API /generatePlaylist] Error:", err);
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 200 });
  }
}
