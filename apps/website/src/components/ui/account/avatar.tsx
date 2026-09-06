"use client";
import { Avatar } from "@base-ui/react/avatar";
import { cn } from "@/lib/utils";

export function AccountAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar.Root
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-xs font-medium uppercase",
        className,
      )}
    >
      <Avatar.Fallback>{Array.from(name.trim())[0] ?? "D"}</Avatar.Fallback>
    </Avatar.Root>
  );
}
