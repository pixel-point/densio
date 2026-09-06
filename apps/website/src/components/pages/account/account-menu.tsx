"use client";

import { Menu } from "@base-ui/react/menu";
import { LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { logout } from "@/app/(account)/auth/actions";
import { AccountAvatar } from "@/components/ui/account/avatar";
import { accountPath } from "@/lib/densio/navigation";
import { FormFeedback } from "./form-feedback";

const itemClasses =
  "flex w-full cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm leading-5 font-medium outline-none data-highlighted:bg-accent data-disabled:opacity-50";

export function AccountMenu({ email, organizationId }: { email: string; organizationId: string }) {
  const [state, signOut, pending] = useActionState(logout, {});
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Account menu"
        className="flex size-11 items-center justify-center rounded-full outline-offset-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <AccountAvatar name={email} className="size-7 rounded-full" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="account-theme z-60"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          <Menu.Popup className="w-72 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-popover p-1 shadow-lg outline-none">
            <Menu.Group>
              <Menu.GroupLabel className="block truncate border-b border-border px-2 pt-2 pb-3 text-sm font-medium">
                {email}
              </Menu.GroupLabel>
              <Menu.LinkItem
                render={<Link href={accountPath(organizationId, "profile")} />}
                closeOnClick
                className={itemClasses}
              >
                <UserRound className="size-4" aria-hidden="true" />
                Profile
              </Menu.LinkItem>
              <form action={signOut}>
                <Menu.Item
                  render={<button type="submit" />}
                  nativeButton
                  closeOnClick={false}
                  disabled={pending}
                  className={itemClasses}
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  {pending ? "Signing out…" : "Sign out"}
                </Menu.Item>
                <FormFeedback state={state} />
              </form>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
