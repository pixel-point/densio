"use client";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { accountInputClasses } from "./input";

type Option = { value: string; label: string };
export function AccountSelect({
  name,
  label,
  defaultValue,
  options,
  disabled,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: Option[];
  disabled?: boolean;
}) {
  return (
    <Select.Root name={name} defaultValue={defaultValue} items={options} disabled={disabled}>
      <Select.Trigger
        aria-label={label}
        className={cn(accountInputClasses, "items-center justify-between gap-2")}
      >
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="account-theme z-70"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="min-w-(--anchor-width) overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm leading-5 outline-none data-highlighted:bg-accent"
                >
                  <Select.ItemText className="flex-1">{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check className="size-4" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
