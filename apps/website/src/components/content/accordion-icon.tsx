import Image from "next/image";

import { cn } from "@/lib/utils";

interface AccordionIconProps {
  src: string;
  alt?: string;
  className?: string;
}

export function AccordionIcon({ src, alt = "", className }: AccordionIconProps) {
  return (
    <Image
      className={cn("size-6 shrink-0", className)}
      src={src}
      alt={alt}
      width={24}
      height={24}
    />
  );
}
