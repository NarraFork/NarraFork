import { describe, expect, test } from "bun:test";
import { AUTO_SWITCH_WAIT_THRESHOLD_MS, autoForcedSwitchTarget } from "./auto-forced-switch";

const now = 1_000_000;
const elsewhere = () => "other:gpt-5.5";

describe("auto forced switch", () => {
	test("only auto: values switch; a named service stays", () => {
		expect(
			autoForcedSwitchTarget({ modelRef: "codex:gpt-5.5", provider: "codex", resolve: elsewhere }),
		).toBeNull();
		expect(
			autoForcedSwitchTarget({ modelRef: "__default__", provider: "codex", resolve: elsewhere }),
		).toBeNull();
		expect(
			autoForcedSwitchTarget({ modelRef: "auto:gpt-5.5", provider: "codex", resolve: elsewhere }),
		).toBe("other:gpt-5.5");
	});

	test("a short wait is kept; a long or unknown one moves", () => {
		const input = { modelRef: "auto:gpt-5.5", provider: "codex", now, resolve: elsewhere };
		expect(autoForcedSwitchTarget({ ...input, resumeAt: now + 5 * 60_000 })).toBeNull();
		expect(
			autoForcedSwitchTarget({ ...input, resumeAt: now + AUTO_SWITCH_WAIT_THRESHOLD_MS + 1 }),
		).toBe("other:gpt-5.5");
		expect(autoForcedSwitchTarget(input)).toBe("other:gpt-5.5");
	});

	test("nowhere better to go: same provider back, or no source at all", () => {
		const base = { modelRef: "auto:gpt-5.5", provider: "codex" };
		expect(autoForcedSwitchTarget({ ...base, resolve: () => "codex:gpt-5.5" })).toBeNull();
		expect(
			autoForcedSwitchTarget({
				...base,
				resolve: () => {
					throw new Error("no source");
				},
			}),
		).toBeNull();
	});
});
