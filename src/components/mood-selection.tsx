"use client"

import { Button } from "@/components/ui/button"
import { Smile, Frown, Coffee, Heart, Zap, BrainCircuit } from "lucide-react"

const moods = [
  { label: "Happy", Icon: Smile },
  { label: "Sad", Icon: Frown },
  { label: "Chill", Icon: Coffee },
  { label: "Romantic", Icon: Heart },
  { label: "Energetic", Icon: Zap },
  { label: "Focus", Icon: BrainCircuit },
] as const

export function MoodSelection({ onSelect }: { onSelect: (mood: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 md:gap-4 lg:grid-cols-3">
      {moods.map(({ label, Icon }) => (
        <Button
          key={label}
          variant="outline"
          onClick={() => onSelect(label)}
          className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-md transition-all duration-200 hover:scale-105 hover:border-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/10 hover:shadow-lg sm:h-28 md:h-32 lg:h-36"
        >
          <Icon className="h-6 w-6 text-[hsl(var(--primary))] sm:h-7 sm:w-7 md:h-8 md:w-8" />
          <span className="text-xs font-semibold sm:text-sm">{label}</span>
        </Button>
      ))}
    </div>
  )
}
