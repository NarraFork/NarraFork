/**
 * Normalizing what people typed before it is committed. Typed text is untrusted like agent
 * input (`normalizeBlock` costs tens of milliseconds per 16 KiB and far more on pathological
 * input), so it runs through the same runner as `OutlineEdit` text: inline when small, on the
 * outline text worker otherwise, with its time limit and queue bound.
 */

import type { EditTextNormalized } from "../edit-text";
import { processEditText } from "../edit-text-runner";

export type LiveNormalized = EditTextNormalized;

/** Texts in the runner's per-job byte budget go together; larger sets are cut into jobs. */
const JOB_BYTES = 192 * 1024;
const utf8 = new TextEncoder();

export async function normalizeLiveTexts(texts: readonly string[]): Promise<LiveNormalized[]> {
	const out: LiveNormalized[] = [];
	let batch: string[] = [];
	let bytes = 0;
	const run = async () => {
		if (batch.length === 0) return;
		out.push(...(await processEditText({ kind: "normalize", contents: batch })));
		batch = [];
		bytes = 0;
	};
	for (const text of texts) {
		const size = utf8.encode(text).length;
		if (bytes + size > JOB_BYTES) await run();
		batch.push(text);
		bytes += size;
	}
	await run();
	return out;
}
