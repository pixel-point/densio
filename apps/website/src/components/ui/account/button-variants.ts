import { cva } from "class-variance-authority";

export const accountButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap text-sm leading-5 font-medium tracking-normal transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-input bg-background text-foreground hover:bg-accent",
        ghost: "border border-transparent text-foreground hover:bg-accent",
        destructive: "border border-input bg-background text-destructive hover:bg-destructive/5",
      },
      size: {
        default: "h-9 rounded-md px-4",
        sm: "h-8 rounded-sm px-4",
        lg: "h-10 rounded-md px-4",
        "icon-xs": "size-6 rounded-sm p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
