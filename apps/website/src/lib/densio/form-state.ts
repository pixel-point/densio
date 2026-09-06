export type FormState = { error?: string; success?: string };
export type AuthFormState = FormState & {
  waiting?: { email: string; expiresAt: string; pollAfterSeconds: number };
};
export type PollState =
  | { status: "pending"; pollAfterSeconds: number; expiresAt?: string }
  | { status: "confirmed"; returnTo: string }
  | { status: "error"; error: string };
