export const billingReturnUrl = (baseUrl: string, organizationId: string) => {
  const url = new URL(baseUrl);
  url.searchParams.set("organizationId", organizationId);
  return url.toString();
};
