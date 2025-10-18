"use client"

import type React from "react"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Wand2 } from "lucide-react"

export function CustomMoodInput({
  value,
  onChange,
  onGenerate,
}: {
  value: string
  onChange: (val: string) => void
  onGenerate: () => void
}) {
  return (
    <div className="flex flex-col gap-2 sm:gap-3">
      <Input
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder="e.g., 'A rainy day in a cozy cafe...'"
        className="h-10 sm:h-11 text-xs sm:text-sm"
      />
      <Button
        onClick={onGenerate}
        className="h-10 sm:h-11 gap-2 rounded-lg bg-gradient-to-r from-primary to-secondary px-4 sm:px-6 text-xs sm:text-sm font-semibold hover:opacity-90"
      >
        <Wand2 className="h-4 w-4" />
        Generate
      </Button>
    </div>
  )
}
