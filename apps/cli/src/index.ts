import { runCli } from "./cli.ts";

const abortController = new AbortController();
const interrupt = () => abortController.abort();
process.once("SIGINT", interrupt);

process.exitCode = await runCli(process.argv.slice(2), { signal: abortController.signal });
process.removeListener("SIGINT", interrupt);
