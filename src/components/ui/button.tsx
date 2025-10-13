import * as React from "react";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "default", ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";
    const sizes = "h-10 px-4 py-2";
    const variants =
      variant === "outline"
        ? "border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm hover:bg-[hsl(var(--accent))]/10 hover:border-[hsl(var(--primary))]"
        : "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow hover:opacity-90";

    return (
      <button ref={ref} className={[base, sizes, variants, className].join(" ")} {...props} />
    );
  }
);
Button.displayName = "Button";
