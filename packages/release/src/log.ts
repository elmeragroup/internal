import { Context } from "effect";

export class ReleaseLog extends Context.Service<ReleaseLog, { log: (message: string) => void }>()(
  "elmera/release/Log"
) {}
