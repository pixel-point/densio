import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function AccountCard({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border border-border bg-card py-5 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div data-slot="card-header" className="flex flex-col gap-1 px-6">
      <h2 className="text-base leading-[22px] font-semibold tracking-normal">{title}</h2>
      {description && (
        <p className="text-sm leading-[21px] tracking-normal text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}
export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center justify-end gap-3 border-t border-border px-6 pt-4",
        className,
      )}
      {...props}
    />
  );
}
