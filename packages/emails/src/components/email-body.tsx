import type { ReactNode } from "react";
import { emailTheme } from "../theme.ts";

const bodyStyle = {
  backgroundColor: emailTheme.colors.canvas,
  fontFamily: emailTheme.fontFamily,
  margin: 0,
  padding: 0,
};

export const EmailBody = ({ children }: { readonly children: ReactNode }) => (
  <body dir="ltr" style={bodyStyle}>
    {/* Keep the canvas opaque when email clients replace the document body. */}
    <table
      role="presentation"
      width="100%"
      border={0}
      cellPadding="0"
      cellSpacing="0"
      bgcolor={emailTheme.colors.canvas}
      style={{ backgroundColor: emailTheme.colors.canvas }}
    >
      <tbody>
        <tr>
          <td style={bodyStyle}>{children}</td>
        </tr>
      </tbody>
    </table>
  </body>
);
