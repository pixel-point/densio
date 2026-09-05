import { Buffer } from "node:buffer";
import {
  OrganizationAuditActorSchema,
  NonNegativeIntegerSchema,
  type OrganizationAuditQuery,
  type OrganizationDirectoryQuery,
  type OrganizationListQuery,
} from "@densio/shared";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Option, Schema } from "effect";
import type { Database } from "./database.ts";
import {
  organizations,
  organizationMemberships,
  organizationAuditEvents,
  users,
} from "./schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import {
  memberProjection,
  organizationProjection,
} from "../organizations/organization-projections.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";

const DirectoryCursorSchema = Schema.Struct({
  at: NonNegativeIntegerSchema,
  id: Schema.NonEmptyString,
});
export const readDirectoryCursor = (cursor: string | undefined) => {
  if (cursor === undefined) return undefined;
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(DirectoryCursorSchema))(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (Option.isNone(result))
    throw organizationFailure("INVALID_REQUEST", "The directory cursor is invalid.");
  return result.value;
};
export const directoryNextCursor = (more: boolean, last: { at: number; id: string } | undefined) =>
  more && last !== undefined
    ? { nextCursor: Buffer.from(JSON.stringify(last)).toString("base64url") }
    : {};

export const getOrganization = (
  { db }: Database,
  input: { userId: string; organizationId: string },
) => {
  const context = authorizeOrganization(db, input, "organization-read", true);
  const user = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (user === undefined) throw new Error("Organization membership references a missing identity.");
  return {
    organization: organizationProjection(context.organization),
    membership: memberProjection(context.membership, user.email),
  };
};

export const listOrganizations = (
  { db }: Database,
  input: OrganizationListQuery & { userId: string },
) => {
  const cursor = readDirectoryCursor(input.cursor);
  const limit = input.limit ?? 25;
  const rows = db
    .select({
      organization: organizations,
      membership: organizationMemberships,
      email: users.email,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationMemberships.userId, input.userId),
        eq(organizations.state, input.state ?? "active"),
        cursor === undefined
          ? undefined
          : sql`(${organizationMemberships.joinedAt}, ${organizationMemberships.id}) > (${cursor.at}, ${cursor.id})`,
      ),
    )
    .orderBy(asc(organizationMemberships.joinedAt), asc(organizationMemberships.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1)?.membership;
  return {
    organizations: page.map((row) => ({
      organization: organizationProjection(row.organization),
      membership: memberProjection(row.membership, row.email),
    })),
    ...directoryNextCursor(
      rows.length > limit,
      last === undefined ? undefined : { at: last.joinedAt, id: last.id },
    ),
  };
};

export const listOrganizationMembers = (
  { db }: Database,
  input: OrganizationDirectoryQuery & { actor: OrganizationActor },
) => {
  authorizeOrganization(db, input.actor, "members-read");
  const cursor = readDirectoryCursor(input.cursor);
  const limit = input.limit ?? 25;
  const rows = db
    .select({ membership: organizationMemberships, email: users.email })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationMemberships.organizationId, input.actor.organizationId),
        cursor === undefined
          ? undefined
          : sql`(${organizationMemberships.joinedAt}, ${organizationMemberships.id}) > (${cursor.at}, ${cursor.id})`,
      ),
    )
    .orderBy(asc(organizationMemberships.joinedAt), asc(organizationMemberships.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1)?.membership;
  return {
    organizationId: input.actor.organizationId,
    members: page.map((row) => memberProjection(row.membership, row.email)),
    ...directoryNextCursor(
      rows.length > limit,
      last === undefined ? undefined : { at: last.joinedAt, id: last.id },
    ),
  };
};

export const listOrganizationAudit = (
  { db }: Database,
  input: OrganizationAuditQuery & { actor: OrganizationActor },
) => {
  authorizeOrganization(db, input.actor, "audit-read");
  const events = db
    .select()
    .from(organizationAuditEvents)
    .where(
      and(
        eq(organizationAuditEvents.organizationId, input.actor.organizationId),
        gt(organizationAuditEvents.sequence, input.after ?? 0),
      ),
    )
    .orderBy(asc(organizationAuditEvents.sequence))
    .limit(input.limit ?? 100)
    .all()
    .map((row) => ({
      sequence: row.sequence,
      organizationId: row.organizationId,
      kind: row.kind,
      actor: Schema.decodeUnknownSync(Schema.fromJsonString(OrganizationAuditActorSchema))(
        row.actorJson,
      ),
      targetId: row.targetId,
      occurredAt: new Date(row.occurredAt).toISOString(),
      correlationId: row.correlationId,
    }));
  return {
    organizationId: input.actor.organizationId,
    events,
    nextAfter: events.at(-1)?.sequence ?? input.after ?? 0,
  };
};
