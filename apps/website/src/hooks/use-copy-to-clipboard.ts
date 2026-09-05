import { useCallback, useEffect, useState } from "react";
import copyToClipboard from "copy-to-clipboard";

type UseCopyToClipboardResult = {
  isCopied: boolean;
  handleCopy: (text: string | number) => boolean;
};

export default function useCopyToClipboard(
  resetInterval: number | null = null,
): UseCopyToClipboardResult {
  const [isCopied, setCopied] = useState(false);

  const handleCopy = useCallback((text: string | number) => {
    const copied = copyToClipboard(text.toString());
    setCopied(copied);
    return copied;
  }, []);

  useEffect(() => {
    let timeout: NodeJS.Timeout;
    if (isCopied && resetInterval) {
      timeout = setTimeout(() => setCopied(false), resetInterval);
    }

    return () => clearTimeout(timeout);
  }, [isCopied, resetInterval]);

  return { isCopied, handleCopy };
}
