import { setTimeout as sleep } from "node:timers/promises";

interface GmailMessage {
  readonly id?: string;
  readonly internalDate?: string;
  readonly payload?: GmailPart;
}

interface GmailPart {
  readonly body?: { readonly data?: string };
  readonly mimeType?: string;
  readonly parts?: ReadonlyArray<GmailPart>;
}

const confirmationUrlPattern = /https?:\/\/[^\s"'<>]+\/v1\/auth\/confirm\?[^\s"'<>]+/u;

export interface GmailCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export const taggedGmailAddress = (email: string, tag: string) => {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || !/^[a-z0-9-]+$/iu.test(tag)) {
    throw new Error("A valid Gmail address and alphanumeric tag are required.");
  }
  const localPart = email.slice(0, separator).split("+")[0];
  return `${localPart}+${tag}${email.slice(separator)}`;
};

export const gmailSearchQuery = (recipient: string) =>
  `to:${recipient} subject:"Confirm your sign-in to Densio" newer_than:1d`;

export const verificationUrlFromMessage = (message: GmailMessage) =>
  message.payload === undefined
    ? undefined
    : messageBodies(message.payload)
        .map((body) => body.match(confirmationUrlPattern)?.[0])
        .find((url) => url !== undefined)
        ?.replaceAll("&amp;", "&");

export const waitForMagicLink = async (
  credentials: GmailCredentials,
  recipient: string,
  startedAt: number,
  signal?: AbortSignal,
) => {
  const accessToken = await refreshAccessToken(credentials, signal);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const link = await findMagicLink(accessToken, recipient, startedAt, signal);
    if (link !== undefined) return link;
    await sleep(2_000, undefined, signal === undefined ? undefined : { signal });
  }
  throw new Error(`No Densio login email arrived for ${recipient} within 90 seconds.`);
};

const messageBodies = (part: GmailPart): ReadonlyArray<string> => [
  ...(part.body?.data === undefined ? [] : [Buffer.from(part.body.data, "base64url").toString()]),
  ...(part.parts?.flatMap(messageBodies) ?? []),
];

const refreshAccessToken = async (credentials: GmailCredentials, signal?: AbortSignal) => {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Gmail OAuth refresh failed with HTTP ${response.status}.`);
  const accessToken = readString(body, "access_token");
  if (accessToken === undefined) throw new Error("Gmail OAuth response contained no access token.");
  return accessToken;
};

const findMagicLink = async (
  accessToken: string,
  recipient: string,
  startedAt: number,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({
    maxResults: "10",
    q: gmailSearchQuery(recipient),
  });
  const response = await gmailRequest(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`,
    accessToken,
    signal,
  );
  const messages = readMessages(response);
  const completeMessages = await Promise.all(
    messages.map(({ id }) =>
      gmailRequest(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
        accessToken,
        signal,
      ),
    ),
  );
  return completeMessages
    .filter((message) => Number(message.internalDate) >= startedAt)
    .map(verificationUrlFromMessage)
    .find((link) => link !== undefined);
};

const gmailRequest = async (url: string, accessToken: string, signal?: AbortSignal) => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`Gmail API request failed with HTTP ${response.status}.`);
  return (await response.json()) as GmailMessage & {
    readonly messages?: ReadonlyArray<{ readonly id?: string }>;
  };
};

const readMessages = (response: { readonly messages?: ReadonlyArray<{ readonly id?: string }> }) =>
  response.messages?.flatMap(({ id }) => (id === undefined ? [] : [{ id }])) ?? [];

const readString = (value: unknown, key: string) => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
};
