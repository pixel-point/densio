import { runAuthCommand } from "./auth-commands.ts";
import { runArtifactCommand } from "./artifact-command.ts";
import { parseGlobalArguments } from "./cli-arguments.ts";
import { CliProblemError, CliUsageError, unexpectedCliError } from "./cli-errors.ts";
import { CLI_HELP } from "./help.ts";
import { runJobsCommand } from "./job-commands.ts";
import { runMediaCommand } from "./media-commands.ts";
import { emitProblem } from "./render.ts";
import { makeCliRuntime, type CliDependencies } from "./runtime.ts";
import { runBillingCommand, runCapabilitiesCommand } from "./service-commands.ts";
import { runSkillCommand } from "./skill-command.ts";

type CommandHandler = (
  argumentsInput: ReadonlyArray<string>,
  runtime: ReturnType<typeof makeCliRuntime>,
) => Promise<void>;

const commandHandlers = new Map<string, CommandHandler>([
  ["artifacts", runArtifactCommand],
  ["auth", runAuthCommand],
  ["billing", runBillingCommand],
  ["capabilities", runCapabilitiesCommand],
  [
    "compare-quality",
    (argumentsInput, runtime) => runMediaCommand("compare-quality", argumentsInput, runtime),
  ],
  ["compress", (argumentsInput, runtime) => runMediaCommand("compress", argumentsInput, runtime)],
  [
    "extract-images",
    (argumentsInput, runtime) => runMediaCommand("extract-images", argumentsInput, runtime),
  ],
  ["jobs", runJobsCommand],
  ["skill", runSkillCommand],
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
