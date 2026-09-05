import { cn } from "@/lib/utils";

interface IHeroProps {
  className?: string;
  title: string;
  titleTag?: "h1" | "p";
  description: string;
}

export default function Hero({
  className,
  title,
  titleTag: TitleTag = "h1",
  description,
}: IHeroProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <TitleTag className="max-w-4xl font-heading text-3xl leading-tight font-semibold tracking-tight text-balance md:text-5xl md:leading-tighter lg:text-6xl lg:leading-tighter">
        {title}
      </TitleTag>
      <p className="mt-2.5 max-w-lg text-lg leading-snug tracking-tight text-pretty text-muted-foreground lg:mt-4">
        {description}
      </p>
    </div>
  );
}
