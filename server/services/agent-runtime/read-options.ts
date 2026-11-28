import type { ReadQueryOptions } from "../../db/worker-read";

export type RuntimeReadOptions = Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs">;
