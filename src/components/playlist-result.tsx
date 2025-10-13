"use client";

import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import type { Track } from "@/lib/playlist";
import * as React from "react";

export function PlaylistResult({
  tracks,
  onBack,
}: {
  tracks: Track[];
  onBack: () => void;
}) {
  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Your personalized playlist</h2>
        <Button variant="outline" onClick={onBack}>Try another mood</Button>
      </div>
      <AnimatePresence mode="wait">
        <motion.ul
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3"
        >
          {tracks.map((t, i) => (
            <motion.li
              key={`${t.title}-${i}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.08 }}
              className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 shadow-sm"
            >
              <div className="flex items-center gap-3">
                <div className="relative h-16 w-16 overflow-hidden rounded-md">
                  <Image
                    src={t.cover}
                    alt={t.title}
                    fill
                    className="object-cover"
                    unoptimized
                    sizes="64px"
                  />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">{t.artist}</p>
                </div>
              </div>
              <PreviewControl url={t.previewUrl ?? undefined} />
            </motion.li>
          ))}
        </motion.ul>
      </AnimatePresence>
    </div>
  );
}

// Preview button + hidden audio element to play 30s sample when available
function PreviewControl({ url }: { url?: string }) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);

  React.useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  if (!url) {
    return (
      <div className="mt-2">
        <Button variant="outline" disabled className="h-8 px-3 text-xs">
          No preview available
        </Button>
      </div>
    );
  }

  const onToggle = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      try {
        await el.play();
        setPlaying(true);
      } catch {
        // ignore autoplay restrictions errors
      }
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <Button onClick={onToggle} className="h-8 px-3 text-xs">
        {playing ? "⏸ Pause" : "▶️ Play Preview"}
      </Button>
      <audio ref={audioRef} src={url} preload="none" onEnded={() => setPlaying(false)} />
    </div>
  );
}

export function LoadingPlaylist({ count = 4 }: { count?: number }) {
  return (
    <div className="mt-8">
      <p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">Tuning your vibe…</p>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {Array.from({ length: count }).map((_, i) => (
          <li
            key={i}
            className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div className="h-14 w-14 animate-pulse rounded-md bg-[hsl(var(--muted))]" />
              <div className="flex-1">
                <div className="mb-2 h-3 w-32 animate-pulse rounded bg-[hsl(var(--muted))]" />
                <div className="h-3 w-24 animate-pulse rounded bg-[hsl(var(--muted))]" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
