module.exports = {
  siteUrl: process.env.NEXT_PUBLIC_DEFAULT_SITE_URL || "http://localhost:3000",
  generateRobotsTxt: true,
  exclude: ["/app", "/app/*", "/auth/*", "/invites/*", "/checkout/*", "/billing"],
  robotsTxtOptions: {
    policies: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/app", "/auth/", "/invites/", "/checkout/", "/billing"],
      },
    ],
  },
};
