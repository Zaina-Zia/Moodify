"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Wand2 } from "lucide-react";

export function CustomMoodInput({
  value,
  onChange,
  onGenerate,
}: {
  value: string;
  onChange: (val: string) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Input
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder="e.g., 'A rainy day in a cozy cafe...'"
        className="h-11"
      />
      <Button onClick={onGenerate} className="h-11">
        <Wand2 className="mr-2 h-4 w-4" />
        Generate
      </Button>
    </div>
  );
}
