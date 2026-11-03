import { describe, expect, mock, test } from "bun:test";
import type { BrowserContext, Target } from "puppeteer-core";
import { closeTab, isOpenedFrom, rememberTargetLineage } from "../tab-scope";

interface FakeTarget {
	target: Target;
	close: ReturnType<typeof mock>;
}

function fakeTarget(opener?: FakeTarget, type = "page"): FakeTarget {
	const close = mock(async () => {});
	const target = {
		type: () => type,
		opener: () => opener?.target,
		page: async () => ({ close }),
	} as unknown as Target;
	return { target, close };
}

function fakeContext(targets: FakeTarget[], shared: boolean) {
	const close = mock(async () => {});
	const context = {
		targets: () => targets.map((t) => t.target),
		close,
	} as unknown as BrowserContext;
	const browser = { defaultBrowserContext: () => (shared ? context : {}) };
	Object.assign(context, { browser: () => browser });
	return { context, close };
}

describe("tab scope", () => {
	test("isOpenedFrom follows the opener chain only", () => {
		const root = fakeTarget();
		const popup = fakeTarget(root);
		const nested = fakeTarget(popup);
		const unrelated = fakeTarget();
		expect(isOpenedFrom(root.target, root.target)).toBe(true);
		expect(isOpenedFrom(nested.target, root.target)).toBe(true);
		expect(isOpenedFrom(unrelated.target, root.target)).toBe(false);
		expect(isOpenedFrom(root.target, popup.target)).toBe(false);
	});

	test("a shared context closes only the session's tab tree", async () => {
		const root = fakeTarget();
		const popup = fakeTarget(root);
		const worker = fakeTarget(root, "service_worker");
		const usersTab = fakeTarget();
		const { context, close } = fakeContext([root, popup, worker, usersTab], true);
		await closeTab(context, root.target);
		expect(root.close).toHaveBeenCalledTimes(1);
		expect(popup.close).toHaveBeenCalledTimes(1);
		expect(worker.close).not.toHaveBeenCalled();
		expect(usersTab.close).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	test("retains descendants after an intermediate opener disappears", async () => {
		const root = fakeTarget();
		const popup = fakeTarget(root);
		const nested = fakeTarget(popup);
		const usersTab = fakeTarget();
		rememberTargetLineage(nested.target);
		Object.assign(nested.target, { opener: () => undefined });
		Object.assign(popup.target, { opener: () => undefined });
		expect(isOpenedFrom(nested.target, root.target)).toBe(true);
		const { context, close } = fakeContext([root, nested, usersTab], true);
		await closeTab(context, root.target);
		expect(root.close).toHaveBeenCalledTimes(1);
		expect(nested.close).toHaveBeenCalledTimes(1);
		expect(usersTab.close).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	test("an isolated context is closed as a whole", async () => {
		const root = fakeTarget();
		const { context, close } = fakeContext([root], false);
		await closeTab(context, root.target);
		expect(close).toHaveBeenCalledTimes(1);
		expect(root.close).not.toHaveBeenCalled();
	});
});
