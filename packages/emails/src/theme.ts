import type { CSSProperties } from "react";

// Adapted from React Email's 02-Matte theme; see THIRD_PARTY_NOTICES.md.
export const emailTheme = {
  colors: {
    canvas: "#FFFFFF",
    background: "#FFFFFF",
    foreground: "#2C2B31",
    text: "#2C2B31",
    muted: "#2C2B31",
    border: "#E5E5E5",
  },
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
} as const;

export const emailStyles = {
  paragraph: {
    color: emailTheme.colors.text,
    fontFamily: emailTheme.fontFamily,
    fontWeight: 400,
    fontSize: "16px",
    lineHeight: "24px",
    letterSpacing: "-0.025em",
    margin: "24px 0",
  },
  small: {
    color: emailTheme.colors.text,
    fontFamily: emailTheme.fontFamily,
    fontWeight: 400,
    fontSize: "14px",
    lineHeight: "24px",
    letterSpacing: "-0.025em",
    margin: 0,
  },
  link: {
    color: emailTheme.colors.text,
    fontFamily: emailTheme.fontFamily,
    fontSize: "16px",
    fontWeight: 400,
    lineHeight: "normal",
    letterSpacing: "normal",
  },
} satisfies Record<string, CSSProperties>;
