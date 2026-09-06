"use client";

import { Input } from "@base-ui/react/input";
import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const accountInputClasses =
  "flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base leading-6 tracking-tight placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 md:text-sm md:leading-5";
export function AccountInput({
  className,
  ...props
}: Omit<Input.Props, "className"> & { className?: string }) {
  return <Input data-slot="input" className={cn(accountInputClasses, className)} {...props} />;
}
export function AccountField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Field.Root className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Field.Label className="text-sm leading-5 font-medium tracking-tight">{label}</Field.Label>
      {children}
    </Field.Root>
  );
}
