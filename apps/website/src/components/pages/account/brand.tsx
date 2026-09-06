import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function AccountBrand({ size = "default" }: { size?: "default" | "auth" }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded",
        size === "auth" && "h-[72px]",
      )}
      aria-label="Densio home"
    >
      <Image
        src="/logo-dark.svg"
        alt="densio"
        width={size === "auth" ? 120 : 60}
        height={size === "auth" ? 44 : 22}
        priority
        className={cn("w-auto", size === "auth" ? "h-11" : "h-[22px]")}
      />
    </Link>
  );
}
