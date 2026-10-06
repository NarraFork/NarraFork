import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryProfileView } from "../../../browser/memory-profile-types";
import type { BrowserSession } from "../../../browser/session";
import type { ToolContext } from "../../types";

const home = await mkdtemp(join(tmpdir(), "nf-profile-tool-"));
const previous = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { browserTool } = await import("../browser");
const { handleBrowserMemoryProfile } = await import("../browser-memory-profile");
const { PROFILE_LIMITS } = await import("../../../browser/memory-profile-constants");
afterAll(async () => {
	if (previous === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previous;
	await rm(home, { recursive: true, force: true });
});
const session = { id: "profile-tool" } as BrowserSession;
function fixture() {
	const calls: Array<{ action: string; profileId?: string; mode?: string; durationMs?: number }> =
		[];
	let view: MemoryProfileView = {
		profileId: "test-profile",
		state: "recording",
		config: { mode: "both", durationMs: 30000, samplingIntervalBytes: 32768 },
	};
	const deps = {
		startMemoryProfile: async (
			_session: BrowserSession,
			opts: { mode?: string; durationMs?: number } = {},
		) => {
			calls.push({ action: "start", ...opts });
			return view;
		},
		stopMemoryProfile: async (_session: BrowserSession, profileId: string) => {
			calls.push({ action: "stop", profileId });
			return view;
		},
		statusMemoryProfile: (_session: BrowserSession, profileId?: string) => {
			calls.push({ action: "status", profileId });
			return view;
		},
		cancelMemoryProfile: async (_session: BrowserSession, profileId: string) => {
			calls.push({ action: "cancel", profileId });
			return view;
		},
	};
	return {
		deps,
		calls,
		setView: (next: MemoryProfileView) => {
			view = next;
		},
	};
}
describe("Browser memory recording tool contract", () => {
	test("four actions and profile parameters are consistent between raw schema and Zod", () => {
		const raw = browserTool.rawJsonSchema as {
			properties: Record<string, { enum?: string[]; type?: string }>;
		};
		for (const action of [
			"memory_profile_start",
			"memory_profile_stop",
			"memory_profile_status",
			"memory_profile_cancel",
		]) {
			expect(raw.properties.action?.enum).toContain(action);
			expect(
				browserTool.parameters.safeParse({ action, session_id: "id", profile_id: "p" }).success,
			).toBe(true);
		}
		for (const mode of ["allocation", "gc", "both"]) {
			expect(raw.properties.mode?.enum).toContain(mode);
			expect(
				browserTool.parameters.safeParse({
					action: "memory_profile_start",
					mode,
					duration_ms: "1000",
					sampling_interval_bytes: "32768",
				}).success,
			).toBe(true);
		}
		expect(
			browserTool.parameters.safeParse({ action: "memory_profile_start", mode: "full" }).success,
		).toBe(false);
		expect(browserTool.description).toContain("samples have no timestamps");
		expect(browserTool.description).toContain("Raw browser-wide traces are never shared");
	});
	test("all recording actions require an owned session", async () => {
		const ctx = { narratorId: "not-owner" } as ToolContext;
		for (const action of [
			"memory_profile_start",
			"memory_profile_stop",
			"memory_profile_status",
			"memory_profile_cancel",
		]) {
			const missing = await browserTool.execute({ action }, ctx);
			expect(missing.isError).toBe(true);
			expect(missing.output).toContain("session_id is required");
			const foreign = await browserTool.execute({ action, session_id: "foreign" }, ctx);
			expect(foreign.isError).toBe(true);
			expect(foreign.output).toContain("Session not found");
		}
	});
	test("stop/cancel missing profile ID do not call backend", async () => {
		const f = fixture();
		for (const action of ["memory_profile_stop", "memory_profile_cancel"] as const) {
			const result = await handleBrowserMemoryProfile(session, action, {}, f.deps);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("profile_id is required");
		}
		expect(f.calls).toHaveLength(0);
	});
	test("dispatch forwards ID and recording config; status permits latest ID omission", async () => {
		const f = fixture();
		await handleBrowserMemoryProfile(
			session,
			"memory_profile_start",
			{ mode: "gc", durationMs: 1000 },
			f.deps,
		);
		await handleBrowserMemoryProfile(
			session,
			"memory_profile_stop",
			{ profileId: "test-profile" },
			f.deps,
		);
		await handleBrowserMemoryProfile(session, "memory_profile_status", {}, f.deps);
		await handleBrowserMemoryProfile(
			session,
			"memory_profile_cancel",
			{ profileId: "test-profile" },
			f.deps,
		);
		expect(f.calls).toEqual([
			{ action: "start", mode: "gc", durationMs: 1000 },
			{ action: "stop", profileId: "test-profile" },
			{ action: "status", profileId: undefined },
			{ action: "cancel", profileId: "test-profile" },
		]);
	});
	test("results report semantic limits, failure state, and UTF8 bounded output", async () => {
		const f = fixture();
		f.setView({
			profileId: "test-profile",
			state: "failed",
			stage: "target_lost",
			warnings: ["中🙂".repeat(10000)],
		});
		const result = await handleBrowserMemoryProfile(session, "memory_profile_status", {}, f.deps);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Output clipped");
		expect(result.output).toContain("estimates");
		expect(result.output.isWellFormed()).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(PROFILE_LIMITS.summaryBytes);
		expect(result.metadata?.sessionId).toBe("profile-tool");
	});
});
