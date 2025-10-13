"use client";

import { Button } from "@/components/ui/button";
import { Smile, Frown, Coffee, Heart, Zap, BrainCircuit } from "lucide-react";

const moods = [
  { label: "Happy", Icon: Smile },
  { label: "Sad", Icon: Frown },
  { label: "Chill", Icon: Coffee },
  { label: "Romantic", Icon: Heart },
  { label: "Energetic", Icon: Zap },
  { label: "Focus", Icon: BrainCircuit },
] as const;

export function MoodSelection({ onSelect }: { onSelect: (mood: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {moods.map(({ label, Icon }) => (
        <Button
          key={label}
          variant="outline"
          onClick={() => onSelect(label)}
          className="h-32 flex flex-col items-center justify-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm transition-transform hover:scale-[1.02] hover:border-[hsl(var(--primary))]"
        >
          <Icon className="h-6 w-6 text-[hsl(var(--primary))]" />
          <span className="text-sm font-medium">{label}</span>
        </Button>
      ))}
    </div>
  );
}
