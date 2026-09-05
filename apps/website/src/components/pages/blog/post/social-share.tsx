"use client";

import { AnimatePresence, domAnimation, LazyMotion } from "motion/react";
import * as m from "motion/react-m";

import { cn } from "@/lib/utils";
import useCopyToClipboard from "@/hooks/use-copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface ISocialShareProps {
  className?: string;
  title?: string;
  pathname: string;
}

const TRANS_CLICK_IN = { duration: 0.3, ease: [0.18, 0, 0, 1] };
const TRANS_CLICK_OUT = { duration: 0.15, ease: "easeOut" };

const textVariants = {
  initial: { opacity: 0, filter: "blur(2px)" },
  animate: { opacity: 1, filter: "blur(0px)", transition: TRANS_CLICK_OUT },
  exit: { opacity: 0, filter: "blur(2px)", transition: TRANS_CLICK_IN },
};

const variantsForCopiedState = {
  initial: { opacity: 0, x: "-4px" },
  animate: { opacity: 1, x: "0px", transition: TRANS_CLICK_OUT },
  exit: { opacity: 0, x: "-4px", transition: TRANS_CLICK_IN },
};

const variantsForCopyLinkState = {
  initial: { opacity: 0, x: "4px" },
  animate: { opacity: 1, x: "0px", transition: TRANS_CLICK_OUT },
  exit: { opacity: 0, x: "4px", transition: TRANS_CLICK_IN },
};

const checkIconPolylineAnimVariants = {
  initial: { pathLength: 0, opacity: 0 },
  animate: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { duration: 0.3, ease: "easeOut" },
      opacity: { duration: 0.3, ease: TRANS_CLICK_IN.ease },
    },
  },
  exit: {
    opacity: 0,
    transition: {
      opacity: {
        duration: TRANS_CLICK_OUT.duration,
        ease: TRANS_CLICK_OUT.ease,
      },
    },
  },
};

function SocialShare({ className, title = "Share", pathname }: ISocialShareProps) {
  const { isCopied, handleCopy } = useCopyToClipboard(3000);
  const url = `${process.env.NEXT_PUBLIC_DEFAULT_SITE_URL}${pathname}`;

  return (
    <div className={cn("social-share flex flex-col", className)}>
      <h3 className="font-heading text-sm leading-none font-medium tracking-tight text-muted-foreground">
        {title}
      </h3>
      <Separator className="mt-4 mb-6" orientation="horizontal" />
      <Button
        className="group pr-3.5 pl-3 [&_svg]:size-3"
        variant="outline"
        size="sm"
        onClick={() => handleCopy(url)}
      >
        <LazyMotion features={domAnimation}>
          <AnimatePresence mode="popLayout">
            {isCopied ? (
              <m.span
                className="flex items-center gap-x-1.5 will-change-transform"
                key="state-copied"
                variants={variantsForCopiedState}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <m.polyline
                    points="3 13 9 19 21 6"
                    variants={checkIconPolylineAnimVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  />
                </svg>
                <m.span
                  className="inline leading-none"
                  key="text-copied"
                  variants={textVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  Copied
                </m.span>
              </m.span>
            ) : (
              <m.span
                className="flex items-center gap-x-1.5 will-change-transform"
                key="state-copy"
                variants={variantsForCopyLinkState}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path
                    className="duration-150 ease-linear group-hover:translate-x-[0.5px] group-hover:-translate-y-[0.5px] group-hover:duration-350 group-hover:ease-[cubic-bezier(.37,.44,.22,1.38)]"
                    d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                  ></path>
                  <path
                    className="duration-150 ease-linear group-hover:-translate-x-[0.5px] group-hover:translate-y-[0.5px] group-hover:duration-350 group-hover:ease-[cubic-bezier(.37,.44,.22,1.38)]"
                    d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                  ></path>
                </svg>
                <m.span
                  className="inline leading-none"
                  key="text-link"
                  variants={textVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  Copy <span className="sr-only">article</span> link
                </m.span>
              </m.span>
            )}
          </AnimatePresence>
        </LazyMotion>
      </Button>
    </div>
  );
}

export default SocialShare;
