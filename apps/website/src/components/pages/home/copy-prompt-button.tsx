"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import useCopyToClipboard from "@/hooks/use-copy-to-clipboard";
import { Button } from "@/components/ui/button";

const prompt =
  "Use Densio to optimize a video for my website. If the Densio skill isn't installed, install it with `npx skills add pixel-point/densio --skill densio`. Then ask me which video to optimize and save the compressed files in my project.";

export function CopyPromptButton() {
  const { isCopied, handleCopy } = useCopyToClipboard(2500);
  const [copyFailed, setCopyFailed] = useState(false);

  return (
    <div className="flex flex-col items-center gap-2 font-sans">
      <Button
        type="button"
        className="h-12 min-w-40 px-6 lg:h-12"
        onClick={() => setCopyFailed(!handleCopy(prompt))}
      >
        {isCopied ? (
          <Check aria-hidden="true" className="mr-2" />
        ) : (
          <Copy aria-hidden="true" className="mr-2" />
        )}
        <span aria-live="polite">{isCopied ? "Copied!" : "Copy prompt"}</span>
      </Button>
      {copyFailed && (
        <p role="alert" className="text-center text-sm text-destructive">
          Couldn't copy the prompt. Please try again.
        </p>
      )}
    </div>
  );
}
