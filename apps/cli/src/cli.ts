import { runStorageCommand } from "./storage-commands.ts";
import { runVideosCommand } from "./video-commands.ts";
import { runAuthCommand } from "./auth-commands.ts";
import { runArtifactCommand } from "./artifact-command.ts";
import { parseGlobalArguments } from "./cli-arguments.ts";
import { CliProblemError, CliUsageError, unexpectedCliError } from "./cli-errors.ts";
import { CLI_HELP } from "./help.ts";
import { runExecutionPlansCommand } from "./execution-plan-commands.ts";
import { runJobsCommand } from "./job-commands.ts";
import { emitProblem } from "./render.ts";
import { makeCliRuntime, type CliDependencies } from "./runtime.ts";
import { runBillingCommand, runCapabilitiesCommand } from "./service-commands.ts";
import { runSkillCommand } from "./skill-command.ts";
import { runInspectCommand, runSourcesCommand } from "./source-commands.ts";
import { runOrganizationsCommand } from "./organization-commands.ts";
import { runInvitationsCommand } from "./organization-invitation-commands.ts";

type CommandHandler = (
  argumentsInput: ReadonlyArray<string>,
  runtime: ReturnType<typeof makeCliRuntime>,
) => Promise<void>;

const commandHandlers = new Map<string, CommandHandler>([
  ["storage", runStorageCommand],
  ["videos", runVideosCommand],
  ["orgs", runOrganizationsCommand],
  ["invitations", runInvitationsCommand],
  ["artifacts", runArtifactCommand],
  ["auth", runAuthCommand],
  ["billing", runBillingCommand],
  ["capabilities", runCapabilitiesCommand],
  ["inspect", runInspectCommand],
  ["jobs", runJobsCommand],
  ["plans", runExecutionPlansCommand],
  ["skill", runSkillCommand],
  ["sources", runSourcesCommand],
]);

export const runCli = async (argv: ReadonlyArray<string>, dependencies: CliDependencies = {}) => {
  return executeCli(argv, dependencies).catch((cause: unknown) => {
    const runtime = makeCliRuntime(
      { json: argv.includes("--json") },
      { ...dependencies, environment: {} },
    );
    const error = cause instanceof CliProblemError ? cause : unexpectedCliError();
    emitProblem(runtime, error);
    return error.exitCode;
  });
};

const executeCli = async (argv: ReadonlyArray<string>, dependencies: CliDependencies) => {
  const globals = parseGlobalArguments(argv);
  const runtime = makeCliRuntime(globals, dependencies);
  if (globals.help || globals.arguments.length === 0) {
    runtime.writeStdout(CLI_HELP);
    return 0;
  }

  const [command, ...argumentsRemaining] = globals.arguments;
  const handler = commandHandlers.get(command ?? "");
  if (handler === undefined) throw new CliUsageError(`Unknown command: ${command ?? ""}.`);
  await handler(argumentsRemaining, runtime);
  return 0;
};
