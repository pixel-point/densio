import type { ReactNode } from "react";
import { Button } from "react-email";
import { emailTheme } from "../theme.ts";

export const ActionButton = ({
  href,
  children,
  variant = "outline",
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: "outline" | "solid";
}) => (
  <Button
    className={`email-button-${variant}`}
    href={href}
    style={{
      backgroundColor: variant === "solid" ? "#000000" : emailTheme.colors.background,
      border: `1px solid ${variant === "solid" ? "#000000" : emailTheme.colors.foreground}`,
      borderRadius: "6px",
      color: variant === "solid" ? "#FFFFFF" : emailTheme.colors.text,
      display: "inline-block",
      fontFamily: emailTheme.fontFamily,
      fontSize: "16px",
      fontWeight: 500,
      lineHeight: 1,
      letterSpacing: "normal",
      padding: "10px 40px",
      textAlign: "center",
      textDecoration: "none",
    }}
  >
    {children}
  </Button>
);
