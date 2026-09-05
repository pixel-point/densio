import { Context } from "effect";

// Filesystem-owning operations provide this hook so child processes remain
// visible to crash recovery even if their parent exits first.
export class ProcessWriteActivity extends Context.Service<
  ProcessWriteActivity,
  {
    track: (processId: number) => () => void;
  }
>()("densio/ProcessWriteActivity") {}
