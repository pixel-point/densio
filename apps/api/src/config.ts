import { Schema } from "effect";

const positiveInteger = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum, minimum }));

const ConfigInput = Schema.Struct({
  artifactCleanupIntervalSeconds: positiveInteger(1, 86_400),
  artifactTtlSeconds: positiveInteger(60, 604_800),
  audioSilenceThresholdDb: Schema.NumberFromString.check(
    Schema.isBetween({ maximum: 0, minimum: -120 }),
  ),
  authAccessTtlSeconds: positiveInteger(60, 86_400),
  authChallengeTtlSeconds: positiveInteger(60, 3_600),
  authIpHashSecret: Schema.NonEmptyString,
  authMaxChallengesPerEmail: positiveInteger(1, 100),
  authMaxChallengesPerIp: positiveInteger(1, 100),
  authOutboxEncryptionKey: Schema.NonEmptyString,
  authRateLimitWindowSeconds: positiveInteger(1, 86_400),
  authRefreshTtlSeconds: positiveInteger(300, 31_536_000),
  billingSessionTtlSeconds: positiveInteger(60, 86_400),
  databasePath: Schema.NonEmptyString,
  emailFrom: Schema.NonEmptyString,
  emailLeaseSeconds: positiveInteger(1, 3_600),
  emailMaxAttempts: positiveInteger(1, 20),
  emailPollIntervalMs: positiveInteger(100, 60_000),
  emailRetryBaseSeconds: positiveInteger(1, 3_600),
  ffmpegPath: Schema.NonEmptyString,
  ffprobePath: Schema.NonEmptyString,
  host: Schema.NonEmptyString,
  jobHeartbeatSeconds: positiveInteger(1, 3_600),
  jobLeaseSeconds: positiveInteger(2, 7_200),
  jobMaxAttempts: positiveInteger(1, 20),
  jobPollIntervalMs: positiveInteger(10, 60_000),
  jobWorkerConcurrency: positiveInteger(1, 32),
  maxComparisonSeconds: positiveInteger(1, 3),
  maxConcurrentMediaProcesses: positiveInteger(1, 32),
  maxExtractedImages: positiveInteger(1, 100_000),
  maxUploadBytes: positiveInteger(1, Number.MAX_SAFE_INTEGER),
  mediaRoot: Schema.NonEmptyString,
  port: positiveInteger(1, 65_535),
  publicBaseUrl: Schema.NonEmptyString,
  resendApiKey: Schema.String,
  stripeBasicPriceId: Schema.String,
  stripePremiumPriceId: Schema.String,
  stripeProPriceId: Schema.String,
  stripeSecretKey: Schema.String,
  stripeWebhookSecret: Schema.String,
  uploadTtlSeconds: positiveInteger(60, 86_400),
  workerId: Schema.NonEmptyString,
});

const decodeConfig = Schema.decodeUnknownSync(ConfigInput);

export const loadConfig = (environment: NodeJS.ProcessEnv) => {
  const publicBaseUrl = environment.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const config = decodeConfig({
    artifactCleanupIntervalSeconds: environment.ARTIFACT_CLEANUP_INTERVAL_SECONDS ?? "600",
    artifactTtlSeconds: environment.ARTIFACT_TTL_SECONDS ?? "86400",
    audioSilenceThresholdDb: environment.AUDIO_SILENCE_THRESHOLD_DB ?? "-50",
    authAccessTtlSeconds: environment.AUTH_ACCESS_TTL_SECONDS ?? "900",
    authChallengeTtlSeconds: environment.AUTH_CHALLENGE_TTL_SECONDS ?? "600",
    authIpHashSecret: environment.AUTH_IP_HASH_SECRET ?? "development-only-change-me",
    authMaxChallengesPerEmail: environment.AUTH_MAX_CHALLENGES_PER_EMAIL ?? "3",
    authMaxChallengesPerIp: environment.AUTH_MAX_CHALLENGES_PER_IP ?? "10",
    authOutboxEncryptionKey: environment.AUTH_OUTBOX_ENCRYPTION_KEY ?? "0".repeat(64),
    authRateLimitWindowSeconds: environment.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? "60",
    authRefreshTtlSeconds: environment.AUTH_REFRESH_TTL_SECONDS ?? "2592000",
    billingSessionTtlSeconds: environment.BILLING_SESSION_TTL_SECONDS ?? "1800",
    databasePath: environment.DATABASE_PATH ?? "./data/database.sqlite",
    emailFrom: environment.EMAIL_FROM ?? "FFmpeg API <login@example.com>",
    emailLeaseSeconds: environment.EMAIL_LEASE_SECONDS ?? "30",
    emailMaxAttempts: environment.EMAIL_MAX_ATTEMPTS ?? "5",
    emailPollIntervalMs: environment.EMAIL_POLL_INTERVAL_MS ?? "1000",
    emailRetryBaseSeconds: environment.EMAIL_RETRY_BASE_SECONDS ?? "5",
    ffmpegPath: environment.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: environment.FFPROBE_PATH ?? "ffprobe",
    host: environment.HOST ?? "0.0.0.0",
    jobHeartbeatSeconds: environment.JOB_HEARTBEAT_SECONDS ?? "10",
    jobLeaseSeconds: environment.JOB_LEASE_SECONDS ?? "60",
    jobMaxAttempts: environment.JOB_MAX_ATTEMPTS ?? "2",
    jobPollIntervalMs: environment.JOB_POLL_INTERVAL_MS ?? "500",
    jobWorkerConcurrency: environment.JOB_WORKER_CONCURRENCY ?? "3",
    maxComparisonSeconds: environment.MAX_COMPARISON_SECONDS ?? "3",
    maxConcurrentMediaProcesses: environment.MAX_CONCURRENT_MEDIA_PROCESSES ?? "3",
    maxExtractedImages: environment.MAX_EXTRACTED_IMAGES ?? "2000",
    maxUploadBytes: environment.MAX_UPLOAD_BYTES ?? "21474836480",
    mediaRoot: environment.MEDIA_ROOT ?? "./data/media",
    port: environment.PORT ?? "3000",
    publicBaseUrl,
    resendApiKey: environment.RESEND_API_KEY ?? "",
    stripeBasicPriceId: environment.STRIPE_BASIC_PRICE_ID ?? "",
    stripePremiumPriceId: environment.STRIPE_PREMIUM_PRICE_ID ?? "",
    stripeProPriceId: environment.STRIPE_PRO_PRICE_ID ?? "",
    stripeSecretKey: environment.STRIPE_SECRET_KEY ?? "",
    stripeWebhookSecret: environment.STRIPE_WEBHOOK_SECRET ?? "",
    uploadTtlSeconds: environment.UPLOAD_TTL_SECONDS ?? "3600",
    workerId: environment.WORKER_ID ?? "ffmpeg-api-worker",
  });
  if (config.jobHeartbeatSeconds >= config.jobLeaseSeconds) {
    throw new Error("JOB_HEARTBEAT_SECONDS must be less than JOB_LEASE_SECONDS");
  }

  return {
    ...config,
    artifactCleanupIntervalMs: config.artifactCleanupIntervalSeconds * 1_000,
    artifactTtlMs: config.artifactTtlSeconds * 1_000,
    auth: {
      accessTokenTtlMs: config.authAccessTtlSeconds * 1_000,
      challengeTtlMs: config.authChallengeTtlSeconds * 1_000,
      maxChallengesPerEmail: config.authMaxChallengesPerEmail,
      maxChallengesPerIp: config.authMaxChallengesPerIp,
      publicBaseUrl: config.publicBaseUrl,
      rateLimitWindowMs: config.authRateLimitWindowSeconds * 1_000,
      refreshTokenTtlMs: config.authRefreshTtlSeconds * 1_000,
    },
    billing: {
      checkoutCancelUrl:
        environment.STRIPE_CHECKOUT_CANCEL_URL ?? `${publicBaseUrl}/billing/canceled`,
      checkoutSuccessUrl:
        environment.STRIPE_CHECKOUT_SUCCESS_URL ?? `${publicBaseUrl}/billing/success`,
      portalReturnUrl: environment.STRIPE_PORTAL_RETURN_URL ?? `${publicBaseUrl}/billing`,
      priceIds: {
        basic: config.stripeBasicPriceId,
        premium: config.stripePremiumPriceId,
        pro: config.stripeProPriceId,
      },
      webhookSecret: config.stripeWebhookSecret,
    },
    billingSessionTtlMs: config.billingSessionTtlSeconds * 1_000,
    email: {
      from: config.emailFrom,
      leaseMs: config.emailLeaseSeconds * 1_000,
      maxAttempts: config.emailMaxAttempts,
      pollIntervalMs: config.emailPollIntervalMs,
      retryBaseMs: config.emailRetryBaseSeconds * 1_000,
    },
    jobWorker: {
      concurrency: config.jobWorkerConcurrency,
      heartbeatIntervalMs: config.jobHeartbeatSeconds * 1_000,
      leaseDurationMs: config.jobLeaseSeconds * 1_000,
      maxAttempts: config.jobMaxAttempts,
      pollIntervalMs: config.jobPollIntervalMs,
      workerId: config.workerId,
    },
    uploadTtlMs: config.uploadTtlSeconds * 1_000,
    trustProxy: environment.TRUST_PROXY === "true",
  };
};

export type AppConfig = ReturnType<typeof loadConfig>;
