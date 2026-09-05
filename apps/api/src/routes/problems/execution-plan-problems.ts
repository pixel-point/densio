import { TrimRangeInvalid, TrimTimelineUnsupported } from "../../media/inspection/trim-errors.ts";
import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import {
  ExecutionPlanClientReferenceConflict,
  ExecutionPlanCreditGuardExceeded,
  ExecutionPlanCreditsUnavailable,
  ExecutionPlanDecisionRequired,
  MediaDecisionRequired,
  HlsSourceUnsupported,
  ExecutionPlanEntitlementRejected,
  ExecutionPlanExpired,
  ExecutionPlanIdempotencyConflict,
  ExecutionPlanInvalidOptions,
  ExecutionPlanNotFound,
  ExecutionPlanOutputLimitExceeded,
  ExecutionPlanSourceUnavailable,
  ExecutionPlanStateConflict,
} from "../../execution-plans/execution-plan-errors.ts";

export const executionPlanNotFoundDescriptor = defineProblem({
  code: "EXECUTION_PLAN_NOT_FOUND",
  description: "The execution plan does not exist for this account.",
  status: 404,
  title: "Execution plan not found",
});

export const executionPlanSourceDescriptor = defineProblem({
  code: "PREPARED_SOURCE_UNAVAILABLE",
  description: "The prepared source is not ready or has expired.",
  status: 409,
  title: "Prepared source unavailable",
});

export const executionPlanStateDescriptor = defineProblem({
  code: "EXECUTION_PLAN_STATE_CONFLICT",
  description: "The execution plan is not in a state that permits this operation.",
  status: 409,
  title: "Execution plan state conflict",
});

export const executionPlanExpiredDescriptor = defineProblem({
  code: "EXECUTION_PLAN_EXPIRED",
  description: "The execution plan has expired.",
  status: 410,
  title: "Execution plan expired",
});

export const executionPlanDecisionRequiredDescriptor = defineProblem({
  code: "EXECUTION_PLAN_DECISION_REQUIRED",
  description: "The execution plan requires an explicit decision before execution.",
  status: 409,
  title: "Execution plan decision required",
});

export const executionPlanIdempotencyDescriptor = defineProblem({
  code: "IDEMPOTENCY_CONFLICT",
  description: "The idempotency key conflicts with another plan intent.",
  status: 409,
  title: "Idempotency conflict",
});

export const executionPlanGuardDescriptor = defineProblem({
  code: "MAX_CREDITS_EXCEEDED",
  description: "The exact quote exceeds the caller's maximum-credit guard.",
  status: 412,
  title: "Credit guard exceeded",
});

export const executionPlanCreditsDescriptor = defineProblem({
  code: "CREDITS_EXHAUSTED",
  description: "The account does not have enough unreserved credits for this plan.",
  status: 402,
  title: "Credits exhausted",
});

export const executionPlanEntitlementDescriptor = defineProblem({
  code: "PLAN_ENTITLEMENT_REQUIRED",
  description: "The source or requested codec exceeds the current plan entitlement.",
  status: 403,
  title: "Plan entitlement required",
});

export const executionPlanOutputDescriptor = defineProblem({
  code: "OUTPUT_LIMIT_EXCEEDED",
  description: "The requested plan would produce too many outputs.",
  status: 400,
  title: "Output limit exceeded",
});

export const executionPlanInvalidDescriptor = defineProblem({
  code: "INVALID_REQUEST",
  description: "The requested transform or comparison sample is not valid for the source.",
  status: 400,
  title: "Invalid execution plan",
});

export const executionPlanClientReferenceDescriptor = defineProblem({
  code: "CLIENT_REFERENCE_CONFLICT",
  description: "The client reference is already assigned to another job.",
  status: 409,
  title: "Client reference conflict",
});

export const mediaDecisionRequiredDescriptor = defineProblem({
  code: "MEDIA_DECISION_REQUIRED",
  status: 409,
  title: "Media decision required",
  description: "An explicit frame-rate choice is required before submitting this source.",
});

export const hlsSourceUnsupportedDescriptor = defineProblem({
  code: "HLS_SOURCE_UNSUPPORTED",
  status: 422,
  title: "Unsupported HLS source",
  description: "The source requires an unsupported HLS transform or exceeds package limits.",
});

export const trimTimelineDescriptor = defineProblem({
  code: "TRIM_TIMELINE_UNSUPPORTED",
  description: "Exact trim boundaries cannot be established from the source timeline.",
  status: 422,
  title: "Unsupported trim timeline",
});

export const executionPlanProblem = (error: unknown) => {
  if (error instanceof TrimRangeInvalid)
    return makeDescriptorProblem(executionPlanInvalidDescriptor, {
      detail: error.message,
      retryable: false,
      suggestedAction: "Select a nonempty frame range within the source video.",
      details: { reason: "invalid-trim-range" },
    });
  if (error instanceof TrimTimelineUnsupported)
    return makeDescriptorProblem(trimTimelineDescriptor, {
      detail: error.message,
      retryable: false,
      suggestedAction: "Use a source with valid frame timestamps and durations.",
    });
  if (error instanceof HlsSourceUnsupported)
    return makeDescriptorProblem(hlsSourceUnsupportedDescriptor, {
      detail: error.reason,
      retryable: false,
      suggestedAction: "Use a progressive SDR source inspected by the current API.",
    });
  if (error instanceof MediaDecisionRequired)
    return makeDescriptorProblem(mediaDecisionRequiredDescriptor, {
      detail: "Choose a frame-rate policy before starting this source.",
      retryable: false,
      suggestedAction: "Resubmit with options.frameRate set to preserve or cap at 30 fps.",
      details: {
        sourceId: error.sourceId,
        decision: {
          ...error.decision,
          choices: [{ mode: "preserve" }, { mode: "cap", maximum: 30 }],
        },
      },
    });
  if (error instanceof ExecutionPlanNotFound) return notFound();
  if (error instanceof ExecutionPlanExpired) return expired();
  if (error instanceof ExecutionPlanDecisionRequired) return decisionRequired();
  if (error instanceof ExecutionPlanSourceUnavailable) return sourceUnavailable();
  if (error instanceof ExecutionPlanStateConflict) return stateConflict(error.state);
  if (error instanceof ExecutionPlanIdempotencyConflict) return idempotencyConflict();
  if (error instanceof ExecutionPlanCreditGuardExceeded) return creditGuard(error);
  if (error instanceof ExecutionPlanCreditsUnavailable) return creditsUnavailable(error);
  if (error instanceof ExecutionPlanEntitlementRejected) return entitlementRejected(error);
  if (error instanceof ExecutionPlanOutputLimitExceeded) return outputLimit(error);
  if (error instanceof ExecutionPlanInvalidOptions) return invalidOptions(error);
  if (error instanceof ExecutionPlanClientReferenceConflict) return clientReferenceConflict();
  return undefined;
};

const notFound = () =>
  makeDescriptorProblem(executionPlanNotFoundDescriptor, {
    detail: "The requested execution plan does not exist.",
    retryable: false,
    suggestedAction: "Check the plan ID belongs to the authenticated account.",
  });

const expired = () =>
  makeDescriptorProblem(executionPlanExpiredDescriptor, {
    detail: "The immutable plan has passed its execution deadline.",
    retryable: false,
    suggestedAction: "Create a new plan from a retained prepared source.",
  });

const decisionRequired = () =>
  makeDescriptorProblem(executionPlanDecisionRequiredDescriptor, {
    detail: "The plan requires a frame-rate decision before it can execute.",
    retryable: false,
    suggestedAction: "Resolve the advertised decision, then execute the superseding plan.",
  });

const sourceUnavailable = () =>
  makeDescriptorProblem(executionPlanSourceDescriptor, {
    detail: "The prepared source is not ready or its retention window has ended.",
    retryable: false,
    suggestedAction: "Inspect the source status or create and upload a new prepared source.",
  });

const stateConflict = (state: string) =>
  makeDescriptorProblem(executionPlanStateDescriptor, {
    detail: `The plan cannot perform this operation while it is ${state}.`,
    retryable: false,
    suggestedAction: "Read the plan status and follow its advertised action.",
  });

const idempotencyConflict = () =>
  makeDescriptorProblem(executionPlanIdempotencyDescriptor, {
    detail: "The idempotency key was already used for a different intent.",
    retryable: false,
    suggestedAction: "Replay the original request or choose a new idempotency key.",
  });

const creditGuard = (error: ExecutionPlanCreditGuardExceeded) =>
  makeDescriptorProblem(executionPlanGuardDescriptor, {
    detail: `The exact ${error.requiredCredits}-credit quote exceeds the ${error.maxCredits}-credit guard.`,
    retryable: false,
    suggestedAction: "Increase the explicit maximum or change the media plan.",
  });

const creditsUnavailable = (error: ExecutionPlanCreditsUnavailable) =>
  makeDescriptorProblem(executionPlanCreditsDescriptor, {
    detail: `${error.requiredCredits} credits are required, but ${error.availableCredits} are available.`,
    retryable: false,
    suggestedAction: "Wait for the monthly reset or upgrade the account plan.",
  });

const entitlementRejected = (error: ExecutionPlanEntitlementRejected) =>
  makeDescriptorProblem(executionPlanEntitlementDescriptor, {
    detail:
      error.reason === "codec"
        ? `${error.codec ?? "The codec"} is not available on the ${error.plan} plan.`
        : `The source duration exceeds the ${error.limitSeconds ?? 0}-second ${error.plan} limit.`,
    retryable: false,
    suggestedAction: "Change the requested codec/source or upgrade the account plan.",
  });

const outputLimit = (error: ExecutionPlanOutputLimitExceeded) =>
  makeDescriptorProblem(executionPlanOutputDescriptor, {
    detail: `The plan would create ${error.estimatedCount} outputs; the limit is ${error.limit}.`,
    retryable: false,
    suggestedAction: "Increase the extraction interval or reduce the requested matrix.",
  });

const invalidOptions = (error: ExecutionPlanInvalidOptions) =>
  makeDescriptorProblem(executionPlanInvalidDescriptor, {
    detail: error.message,
    retryable: false,
    suggestedAction: "Adjust the transform or comparison sample positions and create a new plan.",
  });

const clientReferenceConflict = () =>
  makeDescriptorProblem(executionPlanClientReferenceDescriptor, {
    detail: "The client reference already belongs to another job.",
    retryable: false,
    suggestedAction: "Recover that job by reference or choose a new reference.",
  });
