import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";

const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = globalKeys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const listeners = new Set<(event: Record<string, unknown>) => void>();
mock.module("@frontend/lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: (_options: unknown, callback: (event: Record<string, unknown>) => void) => {
			listeners.add(callback);
			return callback;
		},
		removeListener: (callback: (event: Record<string, unknown>) => void) => {
			listeners.delete(callback);
		},
	},
}));
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { PermissionRulePolicySync } = await import("./PermissionRuleResultNotice");
let root: Root;
let container: HTMLElement;
let client: InstanceType<typeof QueryClient>;

beforeEach(async () => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<PermissionRulePolicySync narratorId="owner" pendingPermissions={[]} />
			</QueryClientProvider>,
		);
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
function emit(event: Record<string, unknown>) {
	for (const listener of listeners) listener(event);
}
const receipt = {
	status: "applied",
	scope: "narrator",
	deviceId: "local",
	requestId: "request",
	ruleId: "rule",
};
const keys = (owner: string) =>
	["whitelist-dirs", "blacklist-dirs", "cmd-whitelist", "cmd-blacklist"].map((key) => [key, owner]);

test.each([
	"applied",
	"alreadyExists",
])("%s refreshes existing lists without a banner", (status) => {
	const invalidate = spyOn(client, "invalidateQueries");
	emit({ type: "tool_started", toolName: "RequestPermissionRule", toolUseId: "tool" });
	emit({
		type: "tool_completed",
		toolUseId: "tool",
		status: "success",
		output: { ...receipt, status },
	});
	expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual(keys("owner"));
	expect(container.innerHTML).toBe("");
});
test("approval, failed receipts and unrelated tools cannot activate a rule", () => {
	const invalidate = spyOn(client, "invalidateQueries");
	emit({ type: "tool_completed", toolUseId: "unrelated", status: "success", output: receipt });
	emit({
		type: "permission_request",
		request: { toolName: "RequestPermissionRule", toolUseId: "pending" },
	});
	expect(invalidate).not.toHaveBeenCalled();
	emit({
		type: "tool_completed",
		toolUseId: "pending",
		status: "success",
		output: { ...receipt, status: "approved" },
	});
	emit({ type: "tool_started", toolName: "RequestPermissionRule", toolUseId: "failed" });
	emit({ type: "tool_completed", toolUseId: "failed", status: "error", output: receipt });
	expect(invalidate).not.toHaveBeenCalled();
	expect(container.innerHTML).toBe("");
});
test("policy and access changes refresh their existing lists", () => {
	const invalidate = spyOn(client, "invalidateQueries");
	emit({ type: "permission:policy_changed", narratorId: "child" });
	emit({ type: "narrator_access_changed" });
	expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
		...keys("child"),
		...keys("owner"),
	]);
});
test("successful child tool execution refreshes the child's list and unsubscribes on unmount", async () => {
	const invalidate = spyOn(client, "invalidateQueries");
	emit({ type: "tool_started", toolName: "RequestPermissionRule", toolUseId: "child-tool" });
	emit({
		type: "tool_completed",
		toolUseId: "child-tool",
		subagentNarratorId: "child",
		status: "success",
		output: receipt,
	});
	expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual(keys("child"));
	expect(container.innerHTML).toBe("");
	await act(async () => root.unmount());
	expect(listeners.size).toBe(0);
});
