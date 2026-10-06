import { afterAll, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";
import { hotSafe } from "../../lib/hot-safe";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));

let shouldFail = true;
const migrateLegacyTaskNotice = async () => {
	if (shouldFail) throw new Error("transient publication failure");
	return "migrated" as const;
};
mock.module("../agent-runtime/publication", () => ({
	flushRuntimePublications: () => {},
	getRuntimePublicationService: () => ({}),
	isRuntimePublicationUnavailableError: () => false,
	migrateLegacyTaskNotice,
	runtimePublication: { setLegacyCompletionAdmissionReader: () => {}, stop: () => {} },
	setLegacyCompletionAdmissionReader: () => {},
	setRuntimePublicationWake: () => {},
}));

const legacy = hotSafe("narrafork:parent-injection-queue", () => new Map<string, unknown[]>());
const entry = {
	kind: "bg_bash" as const,
	task: {
		id: "legacy-task",
		type: "bash" as const,
		title: "old shell",
		alias: null,
		status: "completed" as const,
		outputPreview: "old output",
	},
};
legacy.set("recipient", [entry]);

const { migrateLegacyParentInjections } = await import("../parent-injection-queue");

afterAll(() => sqlite.close());

test("keeps a legacy notice queued when publication migration fails", async () => {
	await expect(migrateLegacyParentInjections("recipient")).rejects.toThrow(
		"transient publication failure",
	);
	expect(legacy.get("recipient")).toEqual([entry]);

	shouldFail = false;
	await migrateLegacyParentInjections("recipient");
	expect(legacy.get("recipient")).toBeUndefined();
});
