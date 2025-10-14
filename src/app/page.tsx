"use client";

import { useEffect, useState } from "react";
import { MoodSelection } from "@/components/mood-selection";
import { CustomMoodInput } from "@/components/custom-mood-input";
import { Separator } from "@/components/ui/separator";
import { Headphones } from "lucide-react";
import { fetchPlaylistByMood, fetchPlaylistByPrompt, analyzePrompt, type Track, type PersonalizationMeta } from "@/lib/playlist";
import { PlaylistResult, LoadingPlaylist } from "@/components/playlist-result";

export default function Page() {
  const [customMood, setCustomMood] = useState("");
  const [loading, setLoading] = useState(false);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [meta, setMeta] = useState<PersonalizationMeta | undefined>(undefined);
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const [me, setMe] = useState<{ display_name?: string; images?: { url: string }[] } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        const data = await res.json();
        if (data?.ok && data.me) setMe(data.me);
        else setMe(null);
      } catch {
        setMe(null);
      }
    })();
  }, []);

  const handleMoodClick = (mood: string) => {
    console.log("Selected mood:", mood);
    setLastQuery(mood);
    setLoading(true);
    setTracks(null);
    setTimeout(async () => {
      const { tracks: list, usedMock, meta } = await fetchPlaylistByMood(mood);
      if (usedMock) {
        // Minimal friendly notice
        console.warn("Couldn’t fetch Spotify playlist, showing mock vibes instead 🎧");
        if (typeof window !== "undefined") alert("Couldn’t fetch playlist, showing mock vibes instead 🎧");
      }
      setTracks(list);
      setMeta(meta);
      setLoading(false);
    }, 1000);
  };

  const handleGenerate = () => {
    if (!customMood.trim()) return;
    console.log("Custom vibe:", customMood.trim());
    const prompt = customMood.trim();
    setLastQuery(prompt);
    setLoading(true);
    setTracks(null);
    setTimeout(async () => {
      const derivedMood = analyzePrompt(prompt);
      const { tracks: list, usedMock, meta } = await fetchPlaylistByMood(derivedMood);
      if (usedMock) {
        console.warn("Couldn’t fetch Spotify playlist, showing mock vibes instead 🎧");
        if (typeof window !== "undefined") alert("Couldn’t fetch playlist, showing mock vibes instead 🎧");
      }
      setTracks(list);
      setMeta(meta);
      setLoading(false);
    }, 1000);
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-14">
      <div className="mx-auto w-full max-w-4xl text-center">
        <div className="mb-6 flex items-center justify-end gap-3">
          {me ? (
            <div className="flex items-center gap-3">
              {me.images?.[0]?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={me.images[0].url} alt="avatar" className="h-7 w-7 rounded-full" />
              ) : null}
              <span className="text-sm text-[hsl(var(--muted-foreground))]">{me.display_name ?? "Spotify User"}</span>
              <a href="/api/auth/logout" className="text-xs text-[hsl(var(--primary))] hover:underline">
                Log out
              </a>
            </div>
          ) : (
            <a
              href="/api/auth/login"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[#1DB954] px-4 text-sm font-medium text-white shadow hover:opacity-90"
            >
              Log in with Spotify
            </a>
          )}
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight text-[hsl(var(--primary))] sm:text-6xl">
          Moodify — Feel the Music
        </h1>
        <div className="mx-auto mt-3 flex h-10 w-10 items-center justify-center rounded-full bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]">
          <Headphones className="h-6 w-6" />
        </div>
        <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground sm:text-xl">
          Select your mood or describe your vibe to get a personalized playlist.
        </p>

        {tracks == null && !loading && (
          <>
            <div className="mt-10">
              <MoodSelection onSelect={handleMoodClick} />
            </div>

            <div className="my-10 flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-sm font-medium text-muted-foreground">OR</span>
              <Separator className="flex-1" />
            </div>

            <CustomMoodInput
              value={customMood}
              onChange={setCustomMood}
              onGenerate={handleGenerate}
            />
          </>
        )}

        {loading && <LoadingPlaylist count={5} />}

        {tracks && (
          <PlaylistResult
            tracks={tracks}
            onBack={() => {
              setTracks(null);
              setLoading(false);
              setCustomMood("");
              setLastQuery(null);
              setMeta(undefined);
            }}
          />
        )}
        {tracks && meta?.personalized && (
          <div className="mt-3 text-sm text-muted-foreground">
            🎧 Personalized {meta?.username ? `for @${meta.username}` : "for you"} based on your recent listening.
          </div>
        )}
      </div>
    </main>
  );
}
