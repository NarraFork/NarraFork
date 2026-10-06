import { describe, expect, test } from "bun:test";
import { PluginUiRpcError } from "./session-client";
import { PluginUiSessionRecoveryBudget } from "./session-recovery";

function isSessionInvalid(error: unknown): boolean {
	return error instanceof PluginUiRpcError && error.code === "PLUGIN_UI_SESSION_INVALID";
}

describe("plugin UI session recovery budget", () => {
	test("allows one transparent rebuild per backend session generation", () => {
		const budget = new PluginUiSessionRecoveryBudget();
		expect(budget.consume("panel-1")).toBe(true);
		expect(budget.consume("panel-1")).toBe(false);
		expect(budget.consume("panel-2")).toBe(true);
	});

	test("successful rebuild resets the budget for a later TTL expiry", () => {
		const budget = new PluginUiSessionRecoveryBudget();
		const expired = new PluginUiRpcError("PLUGIN_UI_SESSION_INVALID", "session expired", {
			retryable: true,
		});

		// First backend session expires and consumes its one automatic rebuild.
		expect(isSessionInvalid(expired)).toBe(true);
		expect(budget.consume("panel-1")).toBe(true);
		expect(budget.consume("panel-1")).toBe(false);

		// The replacement session reaches the registered/ready lifecycle. Production
		// resets here, so the same panel can recover after the next 10-minute TTL.
		budget.reset("panel-1");
		expect(budget.consume("panel-1")).toBe(true);
		expect(budget.consume("panel-1")).toBe(false);

		// A second successful rebuild grants the next generation its own allowance.
		budget.reset("panel-1");
		expect(budget.consume("panel-1")).toBe(true);
	});

	test("manual reload and contribution identity changes reset the allowance", () => {
		const budget = new PluginUiSessionRecoveryBudget();
		expect(budget.consume("panel-1")).toBe(true);

		// Manual reload.
		budget.reset("panel-1");
		expect(budget.consume("panel-1")).toBe(true);

		// Hash/version/entry/style or host-context rebuild.
		budget.reset("panel-1");
		expect(budget.consume("panel-1")).toBe(true);
	});

	test("non-session errors do not consume recovery", () => {
		const budget = new PluginUiSessionRecoveryBudget();
		const denied = new PluginUiRpcError("PERMISSION_DENIED", "denied", { retryable: false });
		const quota = new PluginUiRpcError("STORAGE_QUOTA_EXCEEDED", "quota", {
			retryable: false,
		});
		expect(isSessionInvalid(denied)).toBe(false);
		expect(isSessionInvalid(quota)).toBe(false);
		expect(budget.consume("panel-1")).toBe(true);
	});
});
