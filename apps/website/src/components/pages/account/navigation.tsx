"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { accountPath } from "@/lib/densio/navigation";
import { cn } from "@/lib/utils";

const sections = [
  { name: "General", path: "" },
  { name: "Profile", path: "profile" },
  { name: "Members", path: "members" },
  { name: "Billing", path: "billing" },
];
export function SettingsNavigation({ organizationId }: { organizationId: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Organization settings"
      className="-mb-px flex gap-8 overflow-x-auto border-b border-border"
    >
      {sections.map((section) => {
        const href = accountPath(organizationId, section.path);
        const active = pathname === href;
        return (
          <Link
            key={section.name}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 py-3.5 text-sm leading-5 font-semibold tracking-tight transition-colors",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {section.name}
          </Link>
        );
      })}
    </nav>
  );
}
