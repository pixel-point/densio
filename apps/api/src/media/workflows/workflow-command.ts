import { DateTime, Effect, Schema } from "effect";

import type { CommandPlan } from "../command-plan.ts";
import { MediaProcessRunner } from "../process/media-process-runner.ts";
import type { WorkflowCommandDiagnostic } from "./workflow-types.ts";

export const WorkflowCommandDiagnosticSchema = Schema.Struct({
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
  displayCommand: Schema.String,
  startedAt: Schema.String,
  completedAt: Schema.String,
  exitCode: Schema.Number,
  stderrTail: Schema.optionalKey(Schema.String),
});

const FailedCommandSchema = Schema.Struct({
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
  displayCommand: Schema.String,
  startedAt: Schema.String,
});

export class MediaWorkflowProcessError extends Schema.TaggedErrorClass<MediaWorkflowProcessError>()(
  "MediaWorkflowProcessError",
  {
    completedCommands: Schema.Array(WorkflowCommandDiagnosticSchema),
    exitCode: Schema.NullOr(Schema.Number),
    failedCommand: FailedCommandSchema,
    message: Schema.String,
    stderrTail: Schema.String,
  },
) {}

export const runWorkflowCommand = Effect.fn("MediaWorkflow.runCommand")(function* (
  plan: CommandPlan,
) {
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const runner = yield* MediaProcessRunner;
  const result = yield* runner.run({ executable: plan.executable, arguments: plan.argv }).pipe(
    Effect.mapError(
      (error) =>
        new MediaWorkflowProcessError({
          completedCommands: [],
          exitCode: error.exitCode,
          failedCommand: {
            arguments: [...plan.argv],
            displayCommand: plan.displayCommand,
            executable: plan.executable,
            startedAt,
          },
          message: error.message,
          stderrTail: error.stderrTail,
        }),
    ),
  );
  const completedAt = DateTime.formatIso(yield* DateTime.now);

  return {
    arguments: plan.argv,
    completedAt,
    displayCommand: plan.displayCommand,
    executable: plan.executable,
    exitCode: result.exitCode,
    startedAt,
    ...(result.stderrTail.length === 0 ? {} : { stderrTail: result.stderrTail }),
  } satisfies WorkflowCommandDiagnostic;
});

export const runWorkflowCommands = Effect.fn("MediaWorkflow.runCommands")(function* (
  plans: ReadonlyArray<CommandPlan>,
) {
  const completedCommands = new Map<number, WorkflowCommandDiagnostic>();

  return yield* Effect.forEach(
    plans,
    (plan, index) =>
      runWorkflowCommand(plan).pipe(
        Effect.tap((command) =>
          Effect.sync(() => {
            completedCommands.set(index, command);
          }),
        ),
        Effect.mapError((error) =>
          withCompletedCommands(
            error,
            [...completedCommands.entries()]
              .toSorted(([left], [right]) => left - right)
              .map(([, command]) => command),
          ),
        ),
      ),
    { concurrency: "unbounded" },
  );
});

export const withCompletedCommands = (
  error: MediaWorkflowProcessError,
  commands: ReadonlyArray<WorkflowCommandDiagnostic>,
) =>
  new MediaWorkflowProcessError({
    completedCommands: [...commands, ...error.completedCommands],
    exitCode: error.exitCode,
    failedCommand: error.failedCommand,
    message: error.message,
    stderrTail: error.stderrTail,
  });
