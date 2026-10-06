import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ActiveNarrator } from "../narrator-session-state";
import {
	capturePlannedUpdateRecoverySnapshot,
	resetUpdateCoordinationForTests,
} from "../update-coordinator";

const { runAgentLoop } = await import("../narrator-session");

beforeEach(() => {
	resetUpdateCoordinationForTests();
});

afterEach(() => {
	resetUpdateCoordinationForTests();
});

describe("narrator loop setup cleanup", () => {
	test("unregisters the update loop when narrator initialization fails", async () => {
		const active = {
			narratorId: "missing-loop-narrator",
			conversationId: "conversation",
			cwd: "/tmp",
			model: "test:model",
			provider: "test",
			systemPrompt: null,
			events: new EventEmitter(),
			alive: true,
			locale: "en",
			abortController: new AbortController(),
			_enabledOptionalTools: new Set<string>(),
			_disabledTools: new Set<string>(),
			_blockedSkills: { all: false, names: new Set<string>() },
			_substatus: new Set<string>(),
		} as unknown as ActiveNarrator;

		await expect(runAgentLoop(active, "start", [])).rejects.toThrow(
			"Narrator not found: missing-loop-narrator",
		);
		expect(active._loopRunning).toBe(false);
		expect(active.alive).toBe(false);
		expect(capturePlannedUpdateRecoverySnapshot().narrators).toEqual([]);
	});
});
