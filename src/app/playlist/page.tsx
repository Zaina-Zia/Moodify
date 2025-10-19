"use client";
import React, { useMemo, useState } from "react";

type Track = {
  title: string;
  artist: string;
  cover: string;
  previewUrl?: string | null;
  spotifyUrl?: string;
  matchReason?: string;
};

type ApiResp = {
  ok: boolean;
  mood?: string;
  tracks?: Track[];
  error?: string;
};

const MOODS = ["Happy", "Chill", "Sad", "Energetic", "Focus", "Romantic", "Angry"] as const;

export default function PlaylistPage() {
  const [mood, setMood] = useState<(typeof MOODS)[number]>("Happy");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);

  const canPlayAudio = typeof Audio !== "undefined";
  const [playingSrc, setPlayingSrc] = useState<string | null>(null);
  const audioEl = useMemo(() => (canPlayAudio ? new Audio() : null), [canPlayAudio]);

  const onGenerate = async () => {
    setLoading(true);
    setError(null);
    setTracks([]);
    try {
      const res = await fetch("/api/generatePlaylist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mood }),
      });
      const json: ApiResp = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Request failed: ${res.status}`);
      setTracks(json.tracks || []);
    } catch (e: any) {
      setError(e?.message || "Failed to generate playlist");
    } finally {
      setLoading(false);
    }
  };

  const togglePreview = (url?: string | null) => {
    if (!audioEl || !url) return;
    if (playingSrc === url) {
      audioEl.pause();
      setPlayingSrc(null);
      return;
    }
    audioEl.pause();
    audioEl.src = url;
    audioEl.play().catch(() => {});
    setPlayingSrc(url);
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Moodify Playlist Generator</h1>

      <div className="flex gap-3 items-end mb-6 flex-wrap">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Mood</label>
          <select
            className="border rounded px-3 py-2"
            value={mood}
            onChange={(e) => setMood(e.target.value as any)}
          >
            {MOODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={onGenerate}
          disabled={loading}
          className="bg-black text-white px-4 py-2 rounded disabled:opacity-60"
        >
          {loading ? "Generating..." : "Generate Playlist"}
        </button>
      </div>

      {error ? (
        <div className="text-red-600 mb-4">{error}</div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
        {tracks.map((t, i) => (
          <div key={`${t.title}-${t.artist}-${i}`} className="border rounded overflow-hidden">
            <div className="aspect-square bg-gray-100 overflow-hidden">
              {t.cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.cover} alt={`${t.title}`} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">No cover</div>
              )}
            </div>
            <div className="p-3 space-y-2">
              <div className="font-medium leading-snug">{t.title}</div>
              <div className="text-sm text-gray-600">{t.artist}</div>
              {t.matchReason ? (
                <div className="text-xs text-gray-500">{t.matchReason}</div>
              ) : null}
              <div className="flex gap-2 pt-1">
                {t.previewUrl ? (
                  <button
                    className="text-sm px-3 py-1 border rounded"
                    onClick={() => togglePreview(t.previewUrl)}
                  >
                    {playingSrc === t.previewUrl ? "Pause" : "Preview"}
                  </button>
                ) : null}
                {t.spotifyUrl ? (
                  <a
                    className="text-sm px-3 py-1 border rounded"
                    href={t.spotifyUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      {!loading && tracks.length === 0 ? (
        <div className="text-gray-500">Select a mood and click "Generate Playlist" to begin.</div>
      ) : null}
    </div>
  );
}
