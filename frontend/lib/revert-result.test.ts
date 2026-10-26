import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FileChangeRevertApplyResponse } from "@shared/file-change-protocol";
import { QueryClient } from "@tanstack/react-query";
import { createInstance } from "i18next";
import en from "../locales/en/narrator.json";
import zh from "../locales/zh-CN/narrator.json";
import { ApiError, api } from "./api";
import {
	extractRevertResult,
	formatRevertFailure,
	formatRevertSuccessWarning,
	invalidateRevertQueries,
	isRevertHistoryCommitted,
} from "./revert-result";

const partial: FileChangeRevertApplyResponse = {
	planId: "restore-plan",
	status: "partial",
	journalStatus: "partial",
	settling: false,
	reason: "history retained after file failure",
	historyStatus: "complete",
	historyCommitted: false,
	files: [
		{ deviceId: "local", filePath: "/repo/a.ts", status: "applied" },
		{ deviceId: "local", filePath: "/repo/b.ts", status: "failed", reason: "EACCES" },
		{ deviceId: "remote", filePath: "/repo/c.ts", status: "unknown", reason: "connection lost" },
		{ deviceId: "local", filePath: "/repo/d.ts", status: "unchanged" },
		{ deviceId: "local", filePath: "/repo/e.ts", status: "conflict" },
		{ deviceId: "local", filePath: "/repo/f.ts", status: "not_attempted" },
	],
};
const committed: FileChangeRevertApplyResponse = {
	...partial,
	status: "committed",
	journalStatus: "committed",
	historyCommitted: true,
	reason: null,
	files: partial.files.slice(0, 1),
};

async function translator(language: "en" | "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng: language,
		fallbackLng: "en",
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
		defaultNS: "narrator",
		interpolation: { escapeValue: false },
	});
	return (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));
}

for (const language of ["en", "zh-CN"] as const) {
	describe(`revert result feedback (${language})`, () => {
		test("actual Error payloads preserve applied, failed, unknown and retained history", async () => {
			const t = await translator(language);
			for (const data of [partial, { result: partial }, { revertResult: partial }]) {
				const error = new ApiError("File operation could not be completed safely", 409, {
					...data,
				});
				expect(error).toBeInstanceOf(Error);
				expect(extractRevertResult(error)).toEqual(partial);
				const message = formatRevertFailure(t, error, { fallbackKey: "batchDeleteFailed" });
				expect(message).toContain(t("revertPlanPartial"));
				expect(message).toContain(t("revertHistoryUnchanged"));
				expect(message).not.toContain("revertHistoryUnchanged");
				for (const file of partial.files) {
					if (file.status === "applied" || file.status === "unchanged") {
						expect(message).toContain(
							t("revertResultSuccessCount", {
								count: 1,
								status: t(`revertFileStatus.${file.status}`),
							}),
						);
						continue;
					}
					expect(message).toContain(`${file.filePath}: ${t(`revertFileStatus.${file.status}`)}`);
					if (file.reason) expect(message).toContain(file.reason);
				}
				expect(message).toContain("[remote]");
				expect(message).toContain(error.message);
				expect(isRevertHistoryCommitted(error)).toBe(false);
			}
		});

		test("settling and cancelled results keep distinct explanations", async () => {
			const t = await translator(language);
			for (const [result, key] of [
				[{ ...partial, status: "executing", settling: true }, "revertPlanSettling"],
				[{ ...partial, status: "cancelled" }, "revertPlanCancelled"],
			] as const) {
				const message = formatRevertFailure(t, { revertResult: result });
				expect(message).toContain(t(key));
				expect(message).toContain("/repo/b.ts");
				expect(message).toContain(t("revertHistoryUnchanged"));
			}
		});

		test("bounded file details disclose omitted results", async () => {
			const t = await translator(language);
			const message = formatRevertFailure(t, {
				...partial,
				files: Array.from({ length: 14 }, (_, index) => ({
					...partial.files[1],
					filePath: `/file-${index}.ts`,
				})),
			});
			expect(message).toContain("/file-11.ts");
			expect(message).not.toContain("/file-12.ts");
			expect(message).toContain(t("revertResultMoreFiles", { count: 2 }));
			expect(message).not.toContain("revertResultMoreFiles");
		});

		test.each([
			"failed",
			"unknown",
		] as const)("a trailing %s remains visible after twelve successes", async (status) => {
			const t = await translator(language);
			const message = formatRevertFailure(t, {
				...partial,
				files: [
					...Array.from({ length: 12 }, (_, i) => ({
						deviceId: "local",
						filePath: `/ok-${i}`,
						status: "applied",
					})),
					{ deviceId: "remote", filePath: "/last-failure", status, reason: "IO_ERROR" },
				],
			});
			expect(message).toContain(`/last-failure: ${t(`revertFileStatus.${status}`)}`);
			expect(message).toContain("IO_ERROR");
			expect(message).toContain(
				t("revertResultSuccessCount", { count: 12, status: t("revertFileStatus.applied") }),
			);
			expect(message).not.toContain("/ok-");
		});

		test("a committed recording gap is an advisory, not a failed history update", async () => {
			const t = await translator(language);
			expect(formatRevertSuccessWarning(t, committed)).toBeNull();
			expect(formatRevertSuccessWarning(t, partial)).toBeNull();
			const message = formatRevertSuccessWarning(t, {
				revertResult: { ...committed, historyStatus: "unavailable" },
			});
			expect(message).toContain(t("revertPlanHistoryUnavailable"));
			expect(message).toContain(
				t("revertResultSuccessCount", { count: 1, status: t("revertFileStatus.applied") }),
			);
			expect(message).not.toContain(t("revertHistoryUnchanged"));
		});
	});
}

test("history success requires an explicit complete acknowledgement", () => {
	expect(isRevertHistoryCommitted({ ok: true, revertResult: committed })).toBe(true);
	for (const value of [
		{ ok: true },
		{ ...committed, historyCommitted: false },
		{ ...committed, historyCommitted: undefined },
		{ ...committed, settling: true },
		{ ...committed, status: "partial" },
		{ ...committed, journalStatus: "applying" },
		{ ...committed, files: partial.files },
	])
		expect(isRevertHistoryCommitted(value)).toBe(false);
	expect(extractRevertResult(new Error("lost response"))).toBeNull();
	expect(extractRevertResult({ ...partial, files: [null] })).toBeNull();
});

test("network failures remain errors without fabricated file or history outcomes", async () => {
	const t = await translator("en");
	const message = formatRevertFailure(t, new Error("connection lost"), {
		fallbackKey: "editFailed",
	});
	expect(message).toContain(t("editFailed"));
	expect(message).toContain("connection lost");
	expect(message).not.toContain(t("revertHistoryUnchanged"));
	expect(message).not.toContain(t("revertFileStatus.applied"));
	const reload = formatRevertFailure(
		t,
		new ApiError("reload", 409, { code: "REVERT_RUNTIME_RELOAD_REQUIRED" }),
	);
	expect(reload).toContain(t("revertScopeRuntimeReloadRequired"));
});

test("refresh invalidates history and existing file previews, scoped to the narrator", () => {
	const qc = new QueryClient();
	const resources = ["messages", "file-tree-status", "tool-calls"];
	for (const narrator of ["a", "b"]) {
		for (const resource of resources)
			qc.setQueryData(["narrators", narrator, resource, "detail"], {});
	}
	invalidateRevertQueries(qc, "a");
	for (const resource of resources) {
		expect(qc.getQueryState(["narrators", "a", resource, "detail"])?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["narrators", "b", resource, "detail"])?.isInvalidated).toBe(false);
	}
	qc.clear();
});

describe("HTTP error and success envelope mapping", () => {
	const originalFetch = globalThis.fetch;
	let storage: PropertyDescriptor | undefined;
	beforeEach(() => {
		storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => null },
		});
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (storage) Object.defineProperty(globalThis, "localStorage", storage);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	for (const action of ["delete", "edit"] as const) {
		const run = () =>
			action === "delete"
				? api.deleteMessageBlocks("n", [{ messageId: "m", blockIndex: 0, blockId: "b0" }])
				: api.editAndRegenerate("n", "m", "edited", { skipRevert: false });

		test(`${action} maps a real HTTP conflict to an Error retaining every file result`, async () => {
			let calls = 0;
			globalThis.fetch = Object.assign(
				async () => {
					calls++;
					return Response.json(
						{
							error: "File operation could not be completed safely",
							code: "SNAPSHOT_REVERT_FAILED",
							...partial,
						},
						{ status: 409 },
					);
				},
				{ preconnect: originalFetch.preconnect },
			);
			let failure: unknown;
			try {
				await run();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ApiError);
			expect(extractRevertResult(failure)).toMatchObject(partial);
			const t = await translator("en");
			const message = formatRevertFailure(t, failure);
			expect(message).toContain("1 file(s): Restored");
			expect(message).toContain("/repo/b.ts: Failed (EACCES)");
			expect(message).toContain("/repo/c.ts: Outcome unknown");
			expect(calls).toBe(1);
		});

		test(`${action} preserves a partial response even if HTTP and ok claim success`, async () => {
			globalThis.fetch = Object.assign(
				async () => Response.json({ ok: true, deleted: 0, failed: 0, revertResult: partial }),
				{ preconnect: originalFetch.preconnect },
			);
			const result = await run();
			expect(result.ok).toBe(true);
			expect(extractRevertResult(result)).toEqual(partial);
			expect(isRevertHistoryCommitted(result)).toBe(false);
		});
	}
});
