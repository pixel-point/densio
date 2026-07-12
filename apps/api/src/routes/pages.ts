import { Hono } from "hono";

export const pageRoutes = new Hono();

pageRoutes.get("/billing/success", (context) =>
  context.html(page("Checkout completed", "Return to the ffmpeg-api CLI and check capabilities.")),
);

pageRoutes.get("/billing/canceled", (context) =>
  context.html(page("Checkout canceled", "No billing change was made. You can return to the CLI.")),
);

pageRoutes.get("/billing", (context) =>
  context.html(page("Billing session complete", "You can return to the ffmpeg-api CLI.")),
);

const page = (heading: string, message: string) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${heading}</title></head>
  <body><main><h1>${heading}</h1><p>${message}</p></main></body>
</html>`;
