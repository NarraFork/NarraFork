import { afterEach, beforeEach, expect, test } from "bun:test";
import { ApiError } from "./client";
import { api } from "./index";

const originalFetch = globalThis.fetch;
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const requests: Array<{ url: string; input?: RequestInit }> = [];
beforeEach(() => {
	requests.length = 0;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
	globalThis.fetch = (async (url, input) => {
		requests.push({ url: String(url), input });
		return Response.json({ ok: true });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (storage) Object.defineProperty(globalThis, "localStorage", storage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
test("workspace context endpoints encode owner identity and pin switch to the observed revision", async () => {
	const input = {
		expectedRevision: 4,
		requestId: "switch-id",
		target: { deviceId: "local", cwd: "/new/path" },
		expectedWorktreeKey: "new-key",
	};
	await api.getWorkspaceContext("n /1");
	await api.switchWorkspaceContext("n /1", input);
	expect(requests[0]?.url).toEndWith("/narrators/n%20%2F1/workspace-context");
	expect(requests[1]?.url).toEndWith("/narrators/n%20%2F1/workspace-context/switch");
	expect(JSON.parse(String(requests[1]?.input?.body))).toEqual(input);
});
test("worktree prepare/list/create use frozen shared endpoints; no extra confirmation request", async () => {
	await api.prepareNarratorWorktree("n", {
		expectedRevision: 4,
		workspaceKey: "workspace / key",
		requirement: "fix auth",
	});
	await api.listNarratorWorktrees("n", "workspace / key");
	await api.createNarratorWorktree("n", {
		expectedRevision: 4,
		workspaceKey: "workspace / key",
		requestId: "create-id",
		destinationPath: "/new/path",
		branch: { kind: "new", name: "fix-auth" },
	});
	expect(requests.map((r) => r.url)).toEqual([
		"/api/narrators/n/git/worktrees/prepare",
		"/api/narrators/n/git/worktrees?workspaceKey=workspace%20%2F%20key",
		"/api/narrators/n/git/worktrees",
	]);
	expect(JSON.parse(String(requests[0]?.input?.body))).toMatchObject({
		requirement: "fix auth",
		expectedRevision: 4,
	});
});
test("projectId paginated compatibility filter retains standalone all and cursor", async () => {
	await api.listNarratorsPaginated({ projectId: "p /1", standalone: "all", cursor: "cursor" });
	const params = new URL(requests[0]?.url ?? "", "http://localhost").searchParams;
	expect(params.get("projectId")).toBe("p /1");
	expect(params.get("standalone")).toBe("all");
	expect(params.get("cursor")).toBe("cursor");
});
test("receipt reconciliation uses the original proposal at a distinct read-only endpoint", async () => {
	const original = {
		expectedRevision: 1,
		workspaceKey: "original-key",
		requestId: "original-id",
		destinationPath: "/repo/.worktrees/new",
		branch: { kind: "new" as const, name: "new" },
		baseRef: "HEAD",
	};
	await api.reconcileNarratorWorktree("n /id", original);
	expect(requests[0]?.url).toBe("/api/narrators/n%20%2Fid/git/worktrees/reconcile");
	expect(JSON.parse(String(requests[0]?.input?.body))).toEqual(original);
	expect(requests).toHaveLength(1);
});
test("busy 409 remains a failure, without automatic replay or success", async () => {
	globalThis.fetch = (async (url, input) => {
		requests.push({ url: String(url), input });
		return Response.json({ error: "Workspace is busy", code: "WORKSPACE_BUSY" }, { status: 409 });
	}) as typeof fetch;
	try {
		await api.switchWorkspaceContext("n", {
			expectedRevision: 1,
			requestId: "switch-id",
			target: { deviceId: "local", cwd: "/new" },
		});
		throw new Error("unexpected success");
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(409);
	}
	expect(requests).toHaveLength(1);
});
