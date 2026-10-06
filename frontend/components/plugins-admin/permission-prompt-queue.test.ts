import { describe, expect, test } from "bun:test";
import { PermissionPromptQueue } from "./permission-prompt-queue";

/**
 * Policy checks for the global admin prompt: which events raise it, and when a
 * dismissed request stays dismissed. A regression here either spams the admin
 * with a modal on every denied plugin call, or never shows the prompt at all —
 * both are silent failures from the component's point of view.
 */

const runtimeEvent = (pluginId: string, requestId: string) => ({
	type: "plugin:permission_request",
	pluginId,
	requestId,
	source: "runtime",
});

describe("PermissionPromptQueue", () => {
	test("a runtime permission request raises the prompt for its plugin", () => {
		const queue = new PermissionPromptQueue();
		expect(queue.handleEvent(runtimeEvent("demo", "req-1"))).toBe("demo");
		expect(queue.current).toBe("demo");
	});

	test("a missing source is treated as runtime (older servers omit the field)", () => {
		const queue = new PermissionPromptQueue();
		const detail = runtimeEvent("demo", "req-1");
		delete (detail as { source?: string }).source;
		expect(queue.handleEvent(detail)).toBe("demo");
	});

	test("upgrade requests never raise the global prompt", () => {
		const queue = new PermissionPromptQueue();
		expect(
			queue.handleEvent({
				type: "plugin:permission_request",
				pluginId: "demo",
				requestId: "req-1",
				source: "upgrade",
			}),
		).toBeUndefined();
		expect(queue.current).toBeUndefined();
	});

	test("unrelated event types and malformed details are ignored", () => {
		const queue = new PermissionPromptQueue();
		expect(queue.handleEvent(undefined)).toBeUndefined();
		expect(
			queue.handleEvent({ type: "plugin:permission_resolved", pluginId: "demo" }),
		).toBeUndefined();
		expect(queue.handleEvent({ type: "plugin:permission_request" })).toBeUndefined();
		expect(
			queue.handleEvent({ type: "plugin:permission_request", pluginId: "demo" }),
		).toBeUndefined();
		expect(queue.current).toBeUndefined();
	});

	test("closing with dismissed ids keeps the same request from re-raising the prompt", () => {
		const queue = new PermissionPromptQueue();
		queue.handleEvent(runtimeEvent("demo", "req-1"));
		expect(queue.close(["req-1"])).toBeUndefined();
		// A plugin retrying the denied capability rebroadcasts the same requestId.
		expect(queue.handleEvent(runtimeEvent("demo", "req-1"))).toBeUndefined();
		// ...but a genuinely new request must re-open the prompt.
		expect(queue.handleEvent(runtimeEvent("demo", "req-2"))).toBe("demo");
	});

	test("requests from multiple plugins queue in arrival order", () => {
		const queue = new PermissionPromptQueue();
		expect(queue.handleEvent(runtimeEvent("alpha", "req-1"))).toBe("alpha");
		expect(queue.handleEvent(runtimeEvent("beta", "req-2"))).toBe("alpha");
		expect(queue.close(["req-1"])).toBe("beta");
		expect(queue.close(["req-2"])).toBeUndefined();
	});

	test("a second request for the plugin currently showing does not duplicate the queue entry", () => {
		const queue = new PermissionPromptQueue();
		queue.handleEvent(runtimeEvent("demo", "req-1"));
		expect(queue.handleEvent(runtimeEvent("demo", "req-2"))).toBe("demo");
		expect(queue.close([])).toBeUndefined();
	});
});
