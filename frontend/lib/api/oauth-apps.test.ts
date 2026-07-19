import { describe, expect, test } from "bun:test";
import {
	OAUTH_APP_AVAILABLE_SCOPES,
	OAUTH_APP_LEGACY_SCOPES,
	OAUTH_APP_RECOMMENDED_SCOPES,
} from "./oauth-apps";

describe("OAuth app scope compatibility", () => {
	test("defaults new integrations to fine-grained External API v1 scopes", () => {
		expect(OAUTH_APP_RECOMMENDED_SCOPES).toEqual([
			"project:read",
			"device:read",
			"device:provision",
			"device:rotate",
			"narrator:read",
			"narrator:subscribe",
			"narrator:provision",
			"narrator:message",
			"narrator:interrupt",
		]);
		for (const legacyScope of OAUTH_APP_LEGACY_SCOPES) {
			expect(OAUTH_APP_RECOMMENDED_SCOPES).not.toContain(legacyScope);
		}
	});

	test("retains deprecated scopes only as explicit compatibility options", () => {
		expect(OAUTH_APP_LEGACY_SCOPES).toEqual(["device:manage", "narrator:use"]);
		expect(OAUTH_APP_AVAILABLE_SCOPES).toEqual([
			...OAUTH_APP_RECOMMENDED_SCOPES,
			...OAUTH_APP_LEGACY_SCOPES,
		]);
		expect(new Set(OAUTH_APP_AVAILABLE_SCOPES).size).toBe(OAUTH_APP_AVAILABLE_SCOPES.length);
	});
});
