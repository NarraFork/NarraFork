import { describe, expect, test } from "bun:test";
import { OAUTH_APP_AVAILABLE_SCOPES } from "./oauth-apps";

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
	});
});
