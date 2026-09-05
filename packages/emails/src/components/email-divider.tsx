import { Hr } from "react-email";
import { emailTheme } from "../theme.ts";

export const EmailDivider = () => (
  <Hr
    style={{
      border: "none",
      borderTop: `1px dashed ${emailTheme.colors.border}`,
      margin: "32px 0",
    }}
  />
);
