import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Phase =
	| "go-peer-build"
	| "prototype-services"
	| "prototype-registration"
	| "chromium"
	| "webrtc-connect"
	| "login-auth"
	| "browser-cleanup"
	| "prototype-cleanup";
type Outcome = "end" | "error" | "retry";

const PREFIX = "[ci-stage] ";
const MAX_FILE_BYTES = 32 * 1024;
const MAX_STDERR_RECORDS = 256;
let stderrRecords = 0;

function report(phase: Phase, event: "start" | Outcome, durationMs?: number, attempt?: number) {
	// Only fixed labels and numeric timing metadata: no error text, process arguments or payloads.
	const line = `${JSON.stringify({ timestamp: new Date().toISOString(), phase, event, pid: process.pid, durationMs, attempt })}\n`;
	const directory = process.env.NF_CI_STAGE_DIR;
	if (directory) {
		try {
			// Bun can buffer parallel worker output. Persist before returning to the phase so
			// an external timeout can still identify a worker that never reported completion.
			const file = join(directory, `ci-stage-${process.pid}.jsonl`);
			const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
			if (size + Buffer.byteLength(line) <= MAX_FILE_BYTES)
				appendFileSync(file, line, { mode: 0o600 });
		} catch {
			// A missing/unwritable diagnostics directory must not change the test result.
		}
	}
	if (stderrRecords < MAX_STDERR_RECORDS) {
		stderrRecords++;
		process.stderr.write(`${PREFIX}${line}`);
	}
}

export function startCiStage(phase: Phase, attempt?: number): (outcome: Outcome) => void {
	const started = performance.now();
	report(phase, "start", undefined, attempt);
	let finished = false;
	return (outcome) => {
		if (finished) return;
		finished = true;
		report(phase, outcome, Math.round(performance.now() - started), attempt);
	};
}

export async function withCiStage<T>(phase: Phase, run: () => Promise<T>): Promise<T> {
	const finish = startCiStage(phase);
	try {
		const result = await run();
		finish("end");
		return result;
	} catch (error) {
		finish("error");
		throw error;
	}
}
