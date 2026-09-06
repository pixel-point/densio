"use client";

import { Button } from "@base-ui/react/button";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { accountButtonVariants } from "./button-variants";

type Props = Omit<Button.Props, "className"> &
  VariantProps<typeof accountButtonVariants> & { className?: string };
export function AccountButton({ className, variant, size, ...props }: Props) {
  return (
    <Button
      data-slot="button"
      className={cn(accountButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
