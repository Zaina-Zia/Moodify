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
      if (userAccessToken) {
        try {
          const [topArtistsRes, topTracksRes] = await Promise.all([
            fetch("https://api.spotify.com/v1/me/top/artists?limit=5", { headers: { Authorization: `Bearer ${userAccessToken}` }, cache: "no-store" }),
            fetch("https://api.spotify.com/v1/me/top/tracks?limit=5", { headers: { Authorization: `Bearer ${userAccessToken}` }, cache: "no-store" }),
          ]);
          if (topArtistsRes.ok) {
            const ja = (await topArtistsRes.json()) as any;
            seedArtists = (ja?.items ?? []).slice(0, 2).map((a: any) => a.id);
          }
          if (topTracksRes.ok) {
            const jt = (await topTracksRes.json()) as any;
            seedTracks = (jt?.items ?? []).slice(0, 2).map((t: any) => t.id);
          }
          console.log("✅ Personalized seeds:", { artists: seedArtists.length, tracks: seedTracks.length });
        } catch (e) {
          console.warn("[Spotify] Could not fetch user tops:", e);
        }
      }
      // Compose up to 5 total seeds across genres/artists/tracks
      const seedCsv = seeds.slice(0, Math.max(0, 5 - seedArtists.length - seedTracks.length)).join(",");
      tracks = await (async () => {
        const url = new URL("https://api.spotify.com/v1/recommendations");
        url.searchParams.set("seed_genres", seedCsv);
        if (seedArtists.length) url.searchParams.set("seed_artists", seedArtists.slice(0, 2).join(","));
        if (seedTracks.length) url.searchParams.set("seed_tracks", seedTracks.slice(0, 2).join(","));
        url.searchParams.set("limit", String(7));
        url.searchParams.set("market", "US");
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
    console.log("✅ Spotify playlist fetched for mood:", selectedMood, "count:", tracks.length);
    return NextResponse.json({ ok: true, message: "✅ Spotify playlist fetched", mood: selectedMood, tracks });
  } catch (err: any) {
    console.error("[API /generatePlaylist] Error:", err);
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 200 });
  }
}
