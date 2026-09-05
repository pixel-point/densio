import type { OrganizationAuditActor, OrganizationAuditEventKind } from "@densio/shared";
import type { DatabaseTransaction } from "./database.ts";
import { organizationAuditEvents } from "./schema.ts";

export const appendOrganizationAudit = (
  transaction: DatabaseTransaction,
  input: {
    organizationId: string;
    kind: OrganizationAuditEventKind;
    actor: OrganizationAuditActor;
    targetId: string;
    now: number;
    correlationId: string;
  },
) =>
  transaction
    .insert(organizationAuditEvents)
    .values({
      organizationId: input.organizationId,
      kind: input.kind,
      actorJson: JSON.stringify(input.actor),
      targetId: input.targetId,
      occurredAt: input.now,
      correlationId: input.correlationId,
    })
    .run();
