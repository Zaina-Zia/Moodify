"use client"

import { useEffect, useState } from "react"
import { MoodSelection } from "@/components/mood-selection"
import { CustomMoodInput } from "@/components/custom-mood-input"
import { Separator } from "@/components/ui/separator"
import { Headphones } from "lucide-react"
import { fetchPlaylistByMood, fetchPlaylistByPrompt, type Track, type PersonalizationMeta, type Language } from "@/lib/playlist"

import { PlaylistResult, LoadingPlaylist } from "@/components/playlist-result"

export default function Page() {
  const [customMood, setCustomMood] = useState("")
  const [loading, setLoading] = useState(false)
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [meta, setMeta] = useState<PersonalizationMeta | undefined>(undefined)
  const [lastQuery, setLastQuery] = useState<string | null>(null)
  const [me, setMe] = useState<{ display_name?: string; images?: { url: string }[] } | null>(null)
  const [language, setLanguage] = useState<Language>("any")

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" })
        const data = await res.json()
        if (data?.ok && data.me) setMe(data.me)
        else setMe(null)
      } catch {
        setMe(null)
      }
    })()
  }, [])

  const handleMoodClick = (mood: string) => {
    console.log("Selected mood:", mood)
    setLastQuery(mood)
    setLoading(true)
    setTracks(null)
    setTimeout(async () => {
      const { tracks: list, usedMock, meta } = await fetchPlaylistByMood(mood, language)
      if (usedMock) {
        // Minimal friendly notice
        console.warn("Couldn't fetch Spotify playlist, showing mock vibes instead ")
        if (typeof window !== "undefined") alert("Couldn't fetch playlist, showing mock vibes instead ")
      }
      setTracks(list)
      setMeta(meta)
      setLoading(false)
    }, 1000)
  }

  const handleGenerate = () => {
    if (!customMood.trim()) return
    console.log("Custom vibe:", customMood.trim())
    const prompt = customMood.trim()
    setLastQuery(prompt)
    setLoading(true)
    setTracks(null)
    setTimeout(async () => {
      const { tracks: list, usedMock, meta } = await fetchPlaylistByPrompt(prompt, language)
      if (usedMock) {
        console.warn("Couldn't fetch Spotify playlist, showing mock vibes instead ")
        if (typeof window !== "undefined") alert("Couldn't fetch playlist, showing mock vibes instead ")
      }
      setTracks(list)
      setMeta(meta)
      setLoading(false)
    }, 1000)
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-3 py-8 sm:px-4 sm:py-12 md:py-16">
      <div className="mx-auto w-full max-w-4xl text-center">
        <div className="mb-6 flex flex-col items-end gap-3 sm:mb-8 sm:flex-row sm:justify-between">
          {me ? (
            <div className="flex items-center gap-2 sm:gap-3">
              {me.images?.[0]?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={me.images[0].url || "/placeholder.svg"}
                  alt="avatar"
                  className="h-8 w-8 rounded-full ring-2 ring-[hsl(var(--primary))]"
                />
              ) : null}
              <span className="text-xs sm:text-sm text-[hsl(var(--muted-foreground))]">
                {me.display_name ?? "Spotify User"}
              </span>
              <a href="/api/auth/logout" className="text-xs text-[hsl(var(--primary))] hover:underline">
                Log out
              </a>
            </div>
          ) : (
            <a
              href="/api/auth/login"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[#1DB954] px-4 text-xs sm:text-sm font-medium text-white shadow hover:opacity-90"
            >
              Log in with Spotify
            </a>
          )}
        </div>
        <h1 className="text-4xl font-black tracking-tighter text-[hsl(var(--primary))] sm:text-5xl md:text-7xl">
          Moodify
        </h1>
        <p className="mt-1 text-base font-semibold text-[hsl(var(--secondary))] sm:mt-2 sm:text-lg md:text-xl">
          Feel the Music
        </p>
        <div className="mx-auto mt-4 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[hsl(var(--primary))] to-[hsl(var(--secondary))] text-white shadow-lg sm:mt-6 sm:h-12 sm:w-12">
          <Headphones className="h-5 w-5 sm:h-6 sm:w-6" />
        </div>
        {tracks == null && !loading && (
          <p className="mx-auto mt-4 max-w-2xl text-sm text-[hsl(var(--muted-foreground))] sm:mt-6 sm:text-base md:text-lg">
            Select your mood or describe your vibe to get a personalized playlist.
          </p>
        )}

        {tracks == null && !loading && (
          <>
            {/* Language selector placed above mood grid */}
            <div className="mt-8 sm:mt-10 md:mt-12 flex items-center justify-center gap-3">
              <label htmlFor="language" className="text-xs sm:text-sm text-[hsl(var(--muted-foreground))]">Language</label>
              <select
                id="language"
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
                className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--foreground))] px-2 text-xs sm:text-sm shadow-sm ring-1 ring-[hsl(var(--primary))]/30 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
              >
                <option value="any">Default / Any</option>
                <option value="english">English</option>
                <option value="urdu">Urdu</option>
              </select>
            </div>

            <div className="mt-4 sm:mt-6 md:mt-8">
              <MoodSelection onSelect={handleMoodClick} />
            </div>

            <div className="my-8 flex items-center gap-3 sm:my-10">
              <Separator className="flex-1" />
              <span className="text-xs font-medium text-[hsl(var(--muted-foreground))] sm:text-sm">OR</span>
              <Separator className="flex-1" />
            </div>

            <div className="px-0 sm:px-4">
              <CustomMoodInput value={customMood} onChange={setCustomMood} onGenerate={handleGenerate} />
            </div>
          </>
        )}

        {loading && (
          <>
            <div className="mt-4 text-xs sm:text-sm text-[hsl(var(--muted-foreground))]">
              Generating {lastQuery ?? 'your'} {language === 'any' ? '' : language} playlist…
            </div>
            <LoadingPlaylist count={5} />
          </>
        )}

        {tracks && (
          <PlaylistResult
            tracks={tracks}
            onBack={() => {
              setTracks(null)
              setLoading(false)
              setCustomMood("")
              setLastQuery(null)
              setMeta(undefined)
            }}
            comfort={(meta as any)?.comfort}
          />
        )}
        {tracks && meta?.personalized && (
          <div className="mt-3 text-xs text-[hsl(var(--muted-foreground))] sm:text-sm">
            🎧 Personalized {meta?.username ? `for @${meta.username}` : "for you"} based on your recent listening.
          </div>
        )}
      </div>
    </main>
  )
}
  