import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthStatusSchema,
  OrganizationSchema,
  OrganizationCreateRequestSchema,
  OrganizationMemberRoleRequestSchema,
  OrganizationListQuerySchema,
  OrganizationInvitationCreateRequestSchema,
  OrganizationAuditQuerySchema,
  OrganizationDeletionReceiptSchema,
} from "../src/index.ts";

describe("organization contracts", () => {
  it("separates authenticated identity from the default organization's entitlement", () => {
    const status = {
      authenticated: true,
      user: { id: "user-1", email: "owner@example.test" },
      defaultOrganizationId: "org-1",
      sessionExpiresAt: "2026-09-05T00:00:00.000Z",
    };
    expect(Schema.is(AuthStatusSchema)(status)).toBe(true);
    expect(Schema.is(AuthStatusSchema)({ ...status, defaultOrganizationId: undefined })).toBe(
      false,
    );
    expect(() =>
      Schema.decodeUnknownSync(AuthStatusSchema, { onExcessProperty: "error" })({
        ...status,
        user: { ...status.user, plan: "pro" },
      }),
    ).toThrow();
  });

  it("requires stable organization identity and bounded display names", () => {
    expect(OrganizationSchema).toBeDefined();
    const organization = {
      organizationId: "org-1",
      name: "My organization",
      billingEmail: "owner@example.test",
      state: "active",
      createdByUserId: "user-1",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(OrganizationSchema)(organization)).toEqual(organization);
    const valid = Schema.is(OrganizationCreateRequestSchema);
    expect(valid({ name: "Team" })).toBe(true);
    expect(valid({ name: " " })).toBe(false);
    expect(valid({ name: "x".repeat(101) })).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(OrganizationCreateRequestSchema, { onExcessProperty: "error" })({
        name: "Team",
        organizationId: "stolen-org",
      }),
    ).toThrow();
  });

  it("never grants ownership through generic member or invitation input", () => {
    expect(OrganizationMemberRoleRequestSchema).toBeDefined();
    expect(Schema.is(OrganizationMemberRoleRequestSchema)({ role: "admin" })).toBe(true);
    expect(Schema.is(OrganizationMemberRoleRequestSchema)({ role: "owner" })).toBe(false);
    expect(
      Schema.is(OrganizationInvitationCreateRequestSchema)({
        email: "User@Example.test",
        role: "member",
      }),
    ).toBe(true);
    expect(
      Schema.is(OrganizationInvitationCreateRequestSchema)({
        email: "user@example.test",
        role: "owner",
      }),
    ).toBe(false);
  });

  it("bounds directory and audit cursors", () => {
    expect(OrganizationListQuerySchema).toBeDefined();
    expect(Schema.is(OrganizationListQuerySchema)({ state: "deleted", limit: 100 })).toBe(true);
    expect(Schema.is(OrganizationListQuerySchema)({ limit: 101 })).toBe(false);
    expect(Schema.is(OrganizationAuditQuerySchema)({ after: 0, limit: 100 })).toBe(true);
    expect(Schema.is(OrganizationAuditQuerySchema)({ after: -1 })).toBe(false);
  });

  it("models durable closure without claiming physical deletion early", () => {
    expect(OrganizationDeletionReceiptSchema).toBeDefined();
    const receipt = {
      organizationId: "org-1",
      state: "deleting",
      requestedAt: "2026-09-04T00:00:00.000Z",
      statusUrl: "https://api.densio.sh/v1/organizations/org-1",
    };
    expect(Schema.is(OrganizationDeletionReceiptSchema)(receipt)).toBe(true);
    expect(Schema.is(OrganizationDeletionReceiptSchema)({ ...receipt, state: "deleted" })).toBe(
      false,
    );
  });
});
