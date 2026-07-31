import { describe, expect, test } from "bun:test";
import { createDefaultOAuthAppPolicy, OAUTH_APP_AVAILABLE_SCOPES } from "./oauth-apps";

describe("OAuth app canonical scopes", () => {
	test("offers only direct canonical capability IDs", () => {
		expect(OAUTH_APP_AVAILABLE_SCOPES).toEqual([
			"project.read",
			"device.read",
			"device.provision",
			"device.rotate",
			"narrator.read",
			"event.subscribe",
			"narrator.provision",
			"narrator.send_message",
			"narrator.interrupt",
		]);
		expect(new Set(OAUTH_APP_AVAILABLE_SCOPES).size).toBe(OAUTH_APP_AVAILABLE_SCOPES.length);
		expect(OAUTH_APP_AVAILABLE_SCOPES.every((scope) => scope.includes("."))).toBe(true);
		expect(OAUTH_APP_AVAILABLE_SCOPES.some((scope) => scope.includes(":"))).toBe(false);
	});
});

describe("OAuth app policy defaults", () => {
	// Device access defaults: host denied, global/selfRegistered open.
	test("defaults device access with host denied and remote groups open", () => {
		expect(createDefaultOAuthAppPolicy()).toEqual({
			defaultPermissionMode: "readOnly",
			allowedPermissionModes: ["readOnly"],
			systemPromptMode: "managed",
			maxSystemPromptChars: 0,
			allowGlobalDevice: false,
			allowKnowledgeWrite: false,
			deviceAccess: { host: "denied", global: "readWrite", selfRegistered: "readWrite" },
		});
	});

	test("returns independent policy state for create and edit forms", () => {
		const createPolicy = createDefaultOAuthAppPolicy();
		const editPolicy = createDefaultOAuthAppPolicy();
		createPolicy.allowedPermissionModes.push("dontAsk");
		createPolicy.deviceAccess.global = "denied";

		expect(editPolicy.allowedPermissionModes).toEqual(["readOnly"]);
		expect(editPolicy.deviceAccess.global).toBe("readWrite");
	});
});
