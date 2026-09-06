"use client";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { AccountButton } from "./button";

export function AccountDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-black/30" />
        <Dialog.Popup
          finalFocus={finalFocus}
          className="account-theme fixed top-1/2 left-1/2 z-70 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-6 shadow-xl"
        >
          <Dialog.Title className="pr-6 text-base leading-[22px] font-semibold">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-[21px] text-muted-foreground">
            {description}
          </Dialog.Description>
          <div className="mt-6">{children}</div>
          <Dialog.Close
            render={<AccountButton variant="ghost" size="icon-xs" />}
            className="absolute top-5 right-5"
            aria-label="Close dialog"
          >
            <X />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
