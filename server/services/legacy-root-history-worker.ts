import { parentPort, workerData } from "node:worker_threads";
import type { LegacyRootHistoryInput } from "./legacy-root-history-contract";
import { inspectLegacyRootHistoryReadonly } from "./legacy-root-history-validator";

if (!parentPort) throw new Error("history reader requires worker context");
parentPort.postMessage(inspectLegacyRootHistoryReadonly(workerData as LegacyRootHistoryInput));
parentPort.close();
