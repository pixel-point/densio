import { eq } from "drizzle-orm";
import { Effect, Result } from "effect";

import { parseEmailAddress } from "../auth/email-address.ts";
import {
  grantAdminPro,
  listAdminProGrants,
  revokeAdminPro,
} from "../billing/billing-repository.ts";
import type { Database } from "../database/database.ts";
import { users } from "../database/schema.ts";

interface AdminCommandDependencies {
  readonly grantedBy: string;
  readonly now: () => number;
}

export const runAdminCommand = async (
  database: Database,
  arguments_: ReadonlyArray<string>,
  dependencies: AdminCommandDependencies,
) => {
  if (arguments_[0] !== "pro") return invalidUsage();
  if (arguments_[1] === "list" && arguments_.length === 2) {
    return { exitCode: 0 as const, output: { grants: listAdminProGrants(database) } };
  }
  if ((arguments_[1] !== "grant" && arguments_[1] !== "revoke") || arguments_.length !== 3) {
    return invalidUsage();
  }

  const parsed = await Effect.runPromise(Effect.result(parseEmailAddress(arguments_[2])));
  if (Result.isFailure(parsed)) {
    return {
      error: { code: "INVALID_EMAIL", message: "Enter a valid email." },
      exitCode: 2 as const,
    };
  }
  const user = database.db.select().from(users).where(eq(users.email, parsed.success)).get();
  if (user === undefined) {
    return {
      error: {
        code: "USER_NOT_FOUND",
        message: "The account must complete login before it can receive an admin grant.",
      },
      exitCode: 4 as const,
    };
  }

  if (arguments_[1] === "grant") {
    const outcome = grantAdminPro(database, {
      grantedBy: dependencies.grantedBy,
      now: dependencies.now(),
      userId: user.id,
    });
    if (outcome.kind === "user-missing") return userDisappeared();
    return {
      exitCode: 0 as const,
      output: { created: outcome.created, email: parsed.success, userId: user.id },
    };
  }

  const revoked = revokeAdminPro(database, {
    now: dependencies.now(),
    userId: user.id,
  });
  return { exitCode: 0 as const, output: { email: parsed.success, revoked, userId: user.id } };
};

const invalidUsage = () => ({
  error: {
    code: "INVALID_USAGE",
    message: "Usage: api-admin pro grant <email> | revoke <email> | list",
  },
  exitCode: 2 as const,
});

const userDisappeared = () => ({
  error: { code: "USER_NOT_FOUND", message: "The account no longer exists." },
  exitCode: 4 as const,
});
