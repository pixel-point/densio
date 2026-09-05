import Image from "next/image";

import { cn } from "@/lib/utils";

interface IAuthorsVariantsProps {
  avatars: string[];
  avatarKeys?: string[];
  names?: string[];
  className?: string;
  priority?: boolean;
  size?: keyof typeof sizes;
}

const sizes = {
  xs: { className: "size-7", width: 28, height: 28 },
  sm: { className: "size-8", width: 32, height: 32 },
  md: { className: "size-8 md:size-9", width: 36, height: 36 },
  lg: { className: "size-8 md:size-10", width: 40, height: 40 },
} as const;

function StackedAvatars({
  className,
  avatars,
  avatarKeys,
  names,
  priority = false,
  size = "md",
}: IAuthorsVariantsProps) {
  if (avatars.length === 0) {
    return null;
  }

  const { className: imageClassName, width, height } = sizes[size] || sizes.md;

  if (avatars.length === 1) {
    return (
      <Image
        className={cn("shrink-0 rounded-full bg-muted", imageClassName, className)}
        src={avatars[0]}
        alt={names?.[0] ?? ""}
        width={width}
        height={height}
        loading={priority ? "eager" : undefined}
        quality={100}
      />
    );
  }

  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      {avatars.map((avatar, index) => {
        const isMasked = index < avatars.length - 1;
        const maskStyle = isMasked
          ? {
              WebkitMaskImage:
                "radial-gradient(circle at calc(100% + var(--avatar-mask-center-offset, 4px)) 50%, transparent calc(50% - 1px), black calc(50% - 1px))",
              maskImage:
                "radial-gradient(circle at calc(100% + var(--avatar-mask-center-offset, 4px)) 50%, transparent calc(50% - 1px), black calc(50% - 1px))",
            }
          : undefined;

        return (
          <Image
            className={cn(
              "relative shrink-0 rounded-full bg-muted",
              {
                "-ml-2.5": index > 0 && size === "xs",
                "-ml-3": index > 0 && size === "sm",
                "-ml-3 md:-ml-3.5": index > 0 && ["md", "lg"].includes(size),
                "[--avatar-mask-center-offset:4px]": isMasked,
                "md:[--avatar-mask-center-offset:6px]": isMasked && size === "lg",
              },
              imageClassName,
            )}
            key={avatarKeys?.[index] ?? `${avatar}-${index}`}
            src={avatar}
            alt={names?.[index] ?? ""}
            width={width}
            height={height}
            loading={priority ? "eager" : undefined}
            quality={100}
            style={maskStyle}
          />
        );
      })}
    </div>
  );
}

export default StackedAvatars;
