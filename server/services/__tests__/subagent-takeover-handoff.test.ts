import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import * as executor from "../subagent-executor";
import { clearManualOverrideRuntimes, isManualOverride } from "../subagent-manual-override";
import { startContinuedSubagent } from "../subagent-runner";
import {
	clearTakenOver,
	isTakenOver,
	markPendingBackgroundFinalize,
	markTakenOver,
} from "../subagent-takeover";

const ids: string[] = [];
afterEach(async () => {
	clearManualOverrideRuntimes();
	for (const id of ids) clearTakenOver(id);
	if (ids.length) await db.delete(narrators).where(inArray(narrators.id, ids));
	ids.length = 0;
});

async function fixture() {
	const parentId = generateId();
	const childId = generateId();
	ids.push(childId, parentId);
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: parentId, variant: "primary", status: "working", createdAt: now, updatedAt: now },
		{
			id: childId,
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: parentId,
			status: "idle",
			model: "claude-sonnet-4-6",
			createdAt: now,
			updatedAt: now,
		},
	]);
	return { parentId, childId };
}

// Drive the real continued runner and terminal chain. Only the model execution
// boundary is replaced: no upstream request or live-session mutation is involved.
describe("continued subagent completion ownership", () => {
	for (const release of [false, true]) {
		test(
			release
				? "consumes a background release after switching to a foreground driver"
				: "announces completion even without a retained background task row",
			async () => {
				const { parentId, childId } = await fixture();
				if (release) {
					markTakenOver(childId, { background: true });
					markPendingBackgroundFinalize(childId);
				}
				const execute = spyOn(executor, "executeSubagent").mockResolvedValue({
					finalText: "verified final result",
					hasError: false,
					allowInboxWake: true,
				});
				let timer: ReturnType<typeof setTimeout> | undefined;
				let run: Awaited<ReturnType<typeof startContinuedSubagent>> | undefined;
				try {
					run = await startContinuedSubagent({
						subagentId: childId,
						parentNarratorId: parentId,
						toolUseId: "origin-tool",
						prompt: "finish",
						locale: "en",
						signal: new AbortController().signal,
						persistPrompt: false,
						initialHistory: [],
						initialTrailingToolResults: [],
					});
					const output = await Promise.race([
						run.terminalCompletion,
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error("terminal handoff stayed suspended")),
								1000,
							);
						}),
					]);
					expect(output).toContain("verified final result");
					expect(isManualOverride(childId)).toBe(false);
					expect(isTakenOver(childId)).toBe(false);
					expect(run.takeResumedBackgroundAnnouncement?.()).toMatchObject({
						subagentId: childId,
						parentNarratorId: parentId,
						status: "completed",
						wakeParent: true,
					});
					expect(run.takeResumedBackgroundAnnouncement?.()).toBeUndefined();
					expect(
						(
							await db
								.select({ status: narrators.status })
								.from(narrators)
								.where(eq(narrators.id, childId))
						)[0]?.status,
					).toBe("idle");
				} finally {
					clearTimeout(timer);
					clearManualOverrideRuntimes();
					await run?.terminalCompletion;
					execute.mockRestore();
				}
			},
		);
	}
});
