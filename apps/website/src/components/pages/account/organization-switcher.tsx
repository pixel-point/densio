"use client";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import type { OrganizationMembership } from "@densio/shared";
import { selectOrganization } from "@/app/(account)/app/actions";
import { AccountAvatar } from "@/components/ui/account/avatar";
import { ScrollFade } from "@/components/ui/account/scroll-fade";
import { CreateOrganization } from "./create-organization";

export function OrganizationSwitcher({
  organizations,
  organizationId,
}: {
  organizations: readonly OrganizationMembership[];
  organizationId: string;
}) {
  const current = organizations.find((item) => item.organization.organizationId === organizationId);
  const others = organizations.filter(
    (item) => item.organization.organizationId !== organizationId,
  );
  const pathname = usePathname();
  const trigger = useRef<HTMLButtonElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [creation, setCreation] = useState({ open: false, key: "" });
  const select = (id: string) =>
    startTransition(async () => {
      const result = await selectOrganization(id, pathname);
      setError(result.error);
    });
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          ref={trigger}
          disabled={pending}
          aria-label="Switch organization"
          className="group flex min-w-0 items-center gap-2 rounded-md text-sm leading-[17.5px] font-medium tracking-tight outline-offset-4"
        >
          <AccountAvatar name={current?.organization.name ?? "Organization"} />
          <span className="max-w-[min(240px,35vw)] truncate">
            {current?.organization.name ?? "Select organization"}
          </span>
          <span className="-ml-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground group-hover:bg-accent">
            <ChevronsUpDown className="size-3.5" />
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="account-theme z-60"
            align="start"
            alignOffset={-11}
            sideOffset={8}
            collisionPadding={8}
          >
            <OrganizationOptions
              current={current}
              others={others}
              select={select}
              onCreate={() => setCreation({ open: true, key: crypto.randomUUID() })}
            />
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {error && (
        <p
          role="alert"
          className="absolute top-12 right-5 left-5 rounded-lg border border-border bg-background p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <CreateOrganization
        finalFocus={trigger}
        key={creation.key}
        open={creation.open}
        idempotencyKey={creation.key}
        onOpenChange={(open) => setCreation((value) => ({ ...value, open }))}
      />
    </>
  );
}
function OrganizationItem({
  item,
  current,
  onSelect,
}: {
  item: OrganizationMembership;
  current?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      onClick={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm leading-5 font-medium tracking-tight outline-none data-highlighted:bg-accent"
    >
      <AccountAvatar name={item.organization.name} />
      <span className="flex-1 truncate">{item.organization.name}</span>
      {current && <Check className="size-4 shrink-0" />}
    </Menu.Item>
  );
}

function OrganizationOptions({
  current,
  others,
  select,
  onCreate,
}: {
  current: OrganizationMembership | undefined;
  others: readonly OrganizationMembership[];
  select: (organizationId: string) => void;
  onCreate: () => void;
}) {
  return (
    <Menu.Popup className="w-[330px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg outline-none">
      {current && (
        <div className="p-1">
          <OrganizationItem
            item={current}
            current
            onSelect={() => select(current.organization.organizationId)}
          />
        </div>
      )}
      {others.length > 0 && (
        <Menu.Group className="border-t border-border">
          <Menu.GroupLabel className="block px-3 pt-3 pb-1 text-xs leading-4 font-medium text-muted-foreground">
            Organizations
          </Menu.GroupLabel>
          <ScrollFade>
            {others.map((item) => (
              <OrganizationItem
                key={item.organization.organizationId}
                item={item}
                onSelect={() => select(item.organization.organizationId)}
              />
            ))}
          </ScrollFade>
        </Menu.Group>
      )}
      <div className="border-t border-border p-1">
        <Menu.Item
          onClick={onCreate}
          className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm leading-5 font-medium outline-none data-highlighted:bg-accent"
        >
          <Plus className="size-4" />
          Create organization
        </Menu.Item>
      </div>
    </Menu.Popup>
  );
}
