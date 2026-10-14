import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LegacyMigrationPreview, LegacyMigrationResult } from "../lib/api/legacy-migration";

const previewData: LegacyMigrationPreview = {
	projectId: "p",
	projectName: "legacy",
	syncDisabled: false,
	phase: "none",
	canMigrate: true,
	narratorCount: 1,
	chapterCount: 1,
	blockers: [],
	revision: "r",
};
const preview = mock(async () => previewData);
const disableSync = mock(async () => ({ syncDisabled: true as const, drained: true }));
const migrate = mock(
	async (_id: string, _revision: string): Promise<LegacyMigrationResult> => ({
		phase: "completed",
		narratorIds: ["n"],
		syncDisabled: true as const,
	}),
);
mock.module("../lib/api/legacy-migration", () => ({
	legacyMigrationApi: { preview, disableSync, migrate },
}));
const { useLegacyMigration, legacyMigrationPollInterval } = await import("./useLegacyMigration");
let latest: ReturnType<typeof useLegacyMigration>;
let root: Root;
let container: HTMLDivElement;
let qc: QueryClient;
const saved = new Map<string, PropertyDescriptor | undefined>();
function Probe({
	opened,
	allowed,
	receipt = false,
}: {
	opened: boolean;
	allowed: boolean;
	receipt?: boolean;
}) {
	latest = useLegacyMigration("p", opened, allowed, receipt);
	return null;
}
beforeEach(() => {
	preview.mockClear();
	disableSync.mockClear();
	migrate.mockClear();
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});
async function render(opened = true, allowed = true, receipt = false) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<Probe opened={opened} allowed={allowed} receipt={receipt} />
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
test("full preview is never queried with a closed drawer or without management permission", async () => {
	await render(false);
	expect(preview).not.toHaveBeenCalled();
	await render(true, false);
	expect(preview).not.toHaveBeenCalled();
	await render();
	expect(preview).toHaveBeenCalledTimes(1);
	expect(disableSync).not.toHaveBeenCalled();
	expect(migrate).not.toHaveBeenCalled();
});
test("completed response remains locally available and closing/reopening never queries deleted project", async () => {
	await render();
	await act(async () => {
		await latest.migration.mutateAsync("r");
	});
	await render(false);
	await render();
	expect(migrate).toHaveBeenCalledWith("p", "r");
	expect(latest.migration.data?.narratorIds).toEqual(["n"]);
	expect(preview).toHaveBeenCalledTimes(1);
});
test("completed migration unmounts and recovers an independently authorized receipt after project 404", async () => {
	await render();
	await act(async () => {
		await latest.migration.mutateAsync("r");
	});
	await act(async () => root.render(null));
	preview.mockResolvedValueOnce({
		...previewData,
		phase: "completed",
		narratorIds: ["n"],
		syncDisabled: true,
	});
	await render(true, false, true);
	expect(preview).toHaveBeenCalledTimes(2);
	expect(latest.preview.data?.phase).toBe("completed");
	expect(latest.preview.data?.narratorIds).toEqual(["n"]);
	expect(latest.migration.data).toBeUndefined();
	await render(false, false, true);
	await render(true, false, true);
	expect(preview).toHaveBeenCalledTimes(2);
	expect(migrate).toHaveBeenCalledTimes(1);
});
test("read-only 404 receipt probe rejected with 403 stops without mutation", async () => {
	preview.mockRejectedValueOnce(new Error("403 receipt denied"));
	await render(true, false, true);
	expect(latest.preview.isError).toBe(true);
	expect(latest.preview.error?.message).toBe("403 receipt denied");
	expect(preview).toHaveBeenCalledTimes(1);
	expect(migrate).not.toHaveBeenCalled();
	expect(disableSync).not.toHaveBeenCalled();
});
test("migration refreshes narrator list and retained detail but not messages or deleted project", async () => {
	const keys = [
		["narrators", { standalone: "all" }],
		["narrators", "n"],
		["narrators", "n", "messages"],
		["projects", "p"],
		["chapters", "c"],
	];
	for (const key of keys) qc.setQueryData(key, {});
	await render();
	await act(async () => {
		await latest.migration.mutateAsync("r");
	});
	expect(qc.getQueryState(keys[0])?.isInvalidated).toBe(true);
	expect(qc.getQueryState(keys[1])?.isInvalidated).toBe(true);
	for (const key of keys.slice(2)) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
});
test("standalone sync action retains disabled state without migrating", async () => {
	await render();
	await act(async () => {
		await latest.disable.mutateAsync();
	});
	await render();
	expect(latest.syncDisabled).toBe(true);
	expect(latest.draining).toBe(false);
	expect(migrate).not.toHaveBeenCalled();
});
test("preview syncDrained resumes a known drain and stops it only on explicit completion", async () => {
	await render();
	await act(async () => {
		qc.setQueryData(["legacy-migration", "p"], {
			...previewData,
			syncDisabled: true,
			syncDrained: false,
		});
	});
	await render();
	expect(latest.draining).toBe(true);
	await act(async () => {
		qc.setQueryData(["legacy-migration", "p"], {
			...previewData,
			syncDisabled: true,
			syncDrained: true,
		});
	});
	await render();
	expect(latest.draining).toBe(false);
	expect(latest.drainTimedOut).toBe(false);
	expect(migrate).not.toHaveBeenCalled();
});
test("failed conversion refreshes preview because sync may already be disabled", async () => {
	await render();
	preview.mockResolvedValueOnce({
		...previewData,
		syncDisabled: true,
		syncDrained: true,
		phase: "blocked",
		canMigrate: false,
		blockers: [{ code: "running", message: "Wait for idle" }],
	});
	migrate.mockRejectedValueOnce(new Error("409 blocked"));
	await act(async () => {
		await latest.migration.mutateAsync("r").catch(() => {});
	});
	await render();
	expect(preview).toHaveBeenCalledTimes(2);
	expect(latest.syncDisabled).toBe(true);
	expect(latest.preview.data?.blockers[0]?.message).toBe("Wait for idle");
});
test("cleanup pending retains server blockers and refreshes revision for explicit retry", async () => {
	await render();
	preview.mockResolvedValueOnce({
		...previewData,
		phase: "cleanup_pending",
		syncDisabled: true,
		revision: "cleanup-r",
	});
	migrate.mockResolvedValueOnce({
		phase: "cleanup_pending",
		narratorIds: ["n"],
		syncDisabled: true,
		blockers: [{ code: "db_cleanup", message: "File locked" }],
	});
	await act(async () => {
		await latest.migration.mutateAsync("r");
	});
	await render();
	expect(latest.migration.data?.blockers?.[0]?.message).toBe("File locked");
	expect(latest.preview.data?.revision).toBe("cleanup-r");
	expect(preview).toHaveBeenCalledTimes(2);
});
test("polling only runs for an open active drain and stops on errors", () => {
	expect(legacyMigrationPollInterval(true, true, false)).toBe(2000);
	expect(legacyMigrationPollInterval(false, true, false)).toBe(false);
	expect(legacyMigrationPollInterval(true, false, false)).toBe(false);
	expect(legacyMigrationPollInterval(true, true, true)).toBe(false);
});
