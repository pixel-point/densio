import Image from "next/image";

import { cn } from "@/lib/utils";

interface CardIconProps {
  src: string;
  alt?: string;
  className?: string;
}

export function CardIcon({ src, alt = "", className }: CardIconProps) {
  return (
    <Image
      className={cn("size-9 shrink-0", className)}
      src={src}
      alt={alt}
      width={36}
      height={36}
    />
  );
}
