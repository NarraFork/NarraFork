import { isMainThread, parentPort } from "node:worker_threads";
import { handleStructuralRequest } from "./tree-sitter-core";
import {
	isRecord,
	STRUCTURAL_ERROR_MESSAGES,
	STRUCTURAL_GRAMMAR_LIMIT,
	STRUCTURAL_INPUT_LIMIT,
	STRUCTURAL_METADATA_LIMIT,
	STRUCTURAL_RESULT_LIMIT,
	type StructuralErrorCode,
	type StructuralWorkerRequest,
} from "./worker-protocol";

if (isMainThread || !parentPort) throw new Error("Structural entry requires a worker thread");
const port = parentPort;
let busy = false;
const operations = new Set([
	"supports",
	"outline",
	"locate",
	"enclosing",
	"imports",
	"statistics",
	"elementTree",
	"explainLimitation",
]);

function inputError(message: Record<string, unknown>): StructuralErrorCode | null {
	const task = message.task;
	if (!isRecord(task)) return "STRUCTURAL_WORKER_PROTOCOL";
	if (task.operation === "verifyGrammar") {
		if (!(task.bytes instanceof Uint8Array)) return "STRUCTURAL_WORKER_PROTOCOL";
		return task.bytes.byteLength > STRUCTURAL_GRAMMAR_LIMIT ? "STRUCTURAL_INPUT_TOO_LARGE" : null;
	}
	if (
		!operations.has(task.operation as string) ||
		!isRecord(task.doc) ||
		typeof task.doc.filePath !== "string" ||
		typeof task.doc.text !== "string" ||
		!(task.doc.languageId === null || typeof task.doc.languageId === "string") ||
		Object.hasOwn(task.doc, "signal")
	)
		return "STRUCTURAL_WORKER_PROTOCOL";
	if (
		Buffer.byteLength(task.doc.text) > STRUCTURAL_INPUT_LIMIT ||
		Buffer.byteLength(
			JSON.stringify({
				filePath: task.doc.filePath,
				languageId: task.doc.languageId,
				args: task.args,
			}),
		) > STRUCTURAL_METADATA_LIMIT
	)
		return "STRUCTURAL_INPUT_TOO_LARGE";
	if (task.args !== undefined && !isRecord(task.args)) return "STRUCTURAL_WORKER_PROTOCOL";
	if (task.operation === "locate" && !isRecord((task.args as Record<string, unknown>)?.selector))
		return "STRUCTURAL_WORKER_PROTOCOL";
	if (task.operation === "enclosing") {
		const position = (task.args as Record<string, unknown>)?.position;
		if (
			!isRecord(position) ||
			!Number.isSafeInteger(position.line) ||
			(position.line as number) < 1 ||
			(position.column !== undefined &&
				(!Number.isSafeInteger(position.column) || (position.column as number) < 1))
		)
			return "STRUCTURAL_WORKER_PROTOCOL";
	}
	return null;
}

port.on("message", async (message: unknown) => {
	if (isRecord(message) && message.action === "ping" && Object.keys(message).length === 1) {
		port.postMessage({ ready: true });
		return;
	}
	if (
		!isRecord(message) ||
		typeof message.requestId !== "string" ||
		!Number.isSafeInteger(message.generation) ||
		(message.generation as number) < 0 ||
		busy
	)
		throw new Error("Invalid structural worker request");
	const { requestId, generation } = message;
	const fail = (code: StructuralErrorCode) =>
		port.postMessage({
			requestId,
			generation,
			error: { code, message: STRUCTURAL_ERROR_MESSAGES[code] },
		});
	busy = true;
	try {
		const invalid = inputError(message);
		if (invalid) {
			fail(invalid);
			return;
		}
		const result = await handleStructuralRequest(
			(message as unknown as StructuralWorkerRequest).task,
		);
		const json = JSON.stringify(result);
		if (json === undefined) {
			fail("STRUCTURAL_TASK_FAILED");
			return;
		}
		if (Buffer.byteLength(json) > STRUCTURAL_RESULT_LIMIT) {
			fail("STRUCTURAL_RESULT_TOO_LARGE");
			return;
		}
		port.postMessage({ requestId, generation, result });
	} catch {
		fail("STRUCTURAL_TASK_FAILED");
	} finally {
		busy = false;
	}
});
