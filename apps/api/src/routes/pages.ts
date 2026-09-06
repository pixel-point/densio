import { Hono } from "hono";

export const createPageRoutes = (websiteBaseUrl = "http://localhost:3001") => {
  const routes = new Hono();
  const destinations = [
    ["/billing/success", "/checkout/success"],
    ["/billing/canceled", "/checkout/canceled"],
    ["/billing", "/billing"],
  ] as const;
  destinations.forEach(([path, destination]) =>
    routes.get(path, (context) => {
      context.header("cache-control", "no-store");
      const url = new URL(destination, websiteBaseUrl);
      const organizationId = context.req.query("organizationId");
      if (organizationId) url.searchParams.set("organizationId", organizationId);
      return context.redirect(url.toString(), 303);
    }),
  );
  return routes;
};
