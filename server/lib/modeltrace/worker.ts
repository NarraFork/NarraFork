import { dirname } from "node:path";
import { parentPort } from "node:worker_threads";
import { loadDetector } from "lmfpd-sdk";
import {
	MODELTRACE_RESULT_LIMIT,
	type ModelTraceOutput,
	validOutputs,
	type WorkerReply,
} from "./protocol";
import detectorAsset from "./shared_detector.bin" with { type: "file" };
import bankAsset from "./unified_bank.json" with { type: "file" };

function uncalibratedWeights(results: { score: number }[]): number[] {
	// The SDK returns results in descending score order.
	const best = results[0].score;
	const weights = results.map(({ score }) => Math.exp(score - best));
	const sum = weights.reduce((total, weight) => total + weight, 0);
	return weights.map((weight) => weight / sum);
}

async function rank(outputs: ModelTraceOutput[]): Promise<WorkerReply> {
	if (!validOutputs(outputs)) return { type: "unavailable" };
	// The build preserves asset names and directories, so the SDK can open both by
	// their fixed basenames from source or Bun's embedded filesystem. No cache or network.
	const bankPath = String(bankAsset);
	const directory = dirname(bankPath);
	if (directory !== dirname(detectorAsset)) return { type: "unavailable" };
	const detector = await loadDetector({ source: directory });
	const { decision, results } = detector.analyze(outputs);
	// Single-sample SDK scores are not calibrated probabilities. Convert the full
	// ranking to relative weights (temperature 1) before limiting the UI to five rows.
	const relativeWeights = decision === "partial" ? uncalibratedWeights(results) : undefined;
	return {
		type: "ranked",
		ranking: {
			decision,
			results: results
				.slice(0, MODELTRACE_RESULT_LIMIT)
				.map(({ model, display_name, probability }, index) => ({
					model,
					displayName: display_name,
					probability: relativeWeights?.[index] ?? probability,
				})),
		},
	};
}

const port = parentPort;
if (!port) throw new Error("Model fingerprint analysis requires a worker");
port.postMessage({ ready: true });
port.once("message", async (outputs: ModelTraceOutput[]) => {
	try {
		port.postMessage(await rank(outputs));
	} catch {
		// Do not forward raw samples, local paths, or error stacks.
		port.postMessage({ type: "unavailable" } satisfies WorkerReply);
	}
});
