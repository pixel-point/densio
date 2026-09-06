"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { pollLogin } from "@/app/(account)/auth/actions";

export function useLoginPolling({
  returnTo,
  expiresAt,
  pollAfterSeconds = 1,
  enabled = true,
}: {
  returnTo: string;
  expiresAt?: string;
  pollAfterSeconds?: number;
  enabled?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 30_000;
    const poll = async () => {
      if (Date.now() >= deadline) {
        setError("This sign-in request has expired. Request a new link to continue.");
        return;
      }
      const result = await pollLogin(returnTo).catch(() => ({
        status: "error" as const,
        error: "Unable to complete sign-in. Check your connection and try again.",
      }));
      if (!active) return;
      if (result.status === "confirmed") {
        router.replace(result.returnTo);
        return;
      }
      if (result.status === "error") {
        setError(result.error);
        return;
      }
      timer = setTimeout(poll, Math.max(1000, result.pollAfterSeconds * 1000));
    };
    timer = setTimeout(poll, Math.max(1000, pollAfterSeconds * 1000));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, expiresAt, pollAfterSeconds, returnTo, router, attempt]);
  return {
    error,
    retry: () => {
      setError(undefined);
      setAttempt((value) => value + 1);
    },
  };
}
