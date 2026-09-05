import { CopyPromptButton } from "./copy-prompt-button";

export function Hero() {
  return (
    <section
      aria-labelledby="home-hero-title"
      className="flex min-h-[calc(100svh-var(--sticky-header-height))] flex-col items-center justify-center gap-8 px-5 py-20 md:px-8"
    >
      <h1
        id="home-hero-title"
        aria-label="Agent first video optimization"
        className="text-center font-sans text-[3rem] leading-[0.9] font-normal tracking-tighter text-primary sm:text-[6rem] md:text-[7.5rem]"
      >
        <span aria-hidden="true" className="block">
          <span className="block font-medium whitespace-nowrap">
            <span className="font-display font-bold">A</span>g
            <span className="font-heading font-normal">e</span>nt
          </span>
          <span className="block font-medium whitespace-nowrap">
            <span className="font-heading font-normal">f</span>irst{" "}
            <span className="font-display tracking-normal">
              {/* Geist Pixel ships one weight; allow synthesized bold for these accents. */}
              <span className="font-heading font-bold" style={{ fontSynthesis: "weight" }}>
                v
              </span>
              id
              <span className="font-heading font-bold" style={{ fontSynthesis: "weight" }}>
                e
              </span>
              o
            </span>
          </span>
          <span className="block whitespace-nowrap">
            <span className="font-heading">o</span>pti<span className="font-heading">m</span>iza
            <span className="font-display font-medium tracking-normal">tion</span>
          </span>
        </span>
      </h1>
      <p className="max-w-xl text-center font-sans text-lg leading-relaxed font-normal text-muted-foreground md:text-xl">
        Make your videos lighter and your website faster.
      </p>
      <CopyPromptButton />
    </section>
  );
}
