import { parentPort, workerData } from "node:worker_threads";
import type { LegacyRetainedHistoryInput } from "./legacy-retained-history-contract";
import { inspectLegacyRetainedHistoryWithBindingsReadonly } from "./legacy-retained-history-validator";

if (!parentPort) throw new Error("retained history reader requires worker context");
parentPort.postMessage(
	await inspectLegacyRetainedHistoryWithBindingsReadonly(workerData as LegacyRetainedHistoryInput),
);
parentPort.close();
