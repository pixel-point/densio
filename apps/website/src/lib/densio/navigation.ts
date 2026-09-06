const organizationSegment = "[A-Za-z0-9_-]+";
const accountRoute = new RegExp(
  `^/app(?:/${organizationSegment}(?:/settings(?:/(?:profile|members|billing))?)?)?$`,
);
const settingsRoute = new RegExp(
  `^/app/${organizationSegment}/settings(?:/(profile|members|billing))?$`,
);

export const accountPath = (organizationId: string, section = "") =>
  `/app/${encodeURIComponent(organizationId)}/settings${section ? `/${section}` : ""}`;

export const safeReturnTo = (value: unknown) =>
  typeof value === "string" && accountRoute.test(value) ? value : "/app";

export const switchOrganizationPath = (pathname: string, organizationId: string) =>
  accountPath(organizationId, settingsRoute.exec(pathname)?.[1] ?? "");
