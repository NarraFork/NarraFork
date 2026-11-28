import { describe, expect, test } from "bun:test";
import { resolveRemoteRequestRule } from "./request-policy";

const narratorId = "abcdefghijklmnopqrstu";

describe("bounded UI projection remote request rules", () => {
	test.each([
		["GET", "/api/settings/runtime", "settings-runtime", 8 * 1024],
		["GET", "/api/model-catalog/runtime?model=auto%3Aexample", "model-runtime", 4 * 1024],
		["GET", "/api/model-catalog/options?q=example&limit=40", "model-options", 64 * 1024],
		["GET", "/api/model-catalog/options?sourceModelId=example", "model-options", 64 * 1024],
		["GET", "/api/user-preferences/ui", "preferences-ui", 64 * 1024],
		["PATCH", "/api/user-preferences/ui", "preferences-ui", 64 * 1024],
		[
			"GET",
			`/api/user-preferences/spec-tab-layout?narratorId=${narratorId}`,
			"preferences-spec-layout",
			64 * 1024,
		],
		["PATCH", "/api/user-preferences/spec-tab-layout", "preferences-spec-layout", 64 * 1024],
		["GET", `/api/narrators/${narratorId}/ui-summary`, "narrator-ui-summary", 2 * 1024],
	])("%s %s uses only its exact, small ready-phase rule", (method, path, id, bytes) => {
		const rule = resolveRemoteRequestRule(String(method), String(path), "ready");
		expect(rule?.id).toBe(id);
		expect(rule?.responseBytes).toBe(bytes);
		expect(resolveRemoteRequestRule(String(method), String(path), "paired")).toBeNull();
	});

	test("UI writes have an explicit small request ceiling, not the legacy preference read rule", () => {
		for (const path of ["/api/user-preferences/ui", "/api/user-preferences/spec-tab-layout"]) {
			expect(resolveRemoteRequestRule("PATCH", path, "ready")?.requestBytes).toBe(64 * 1024);
		}
		expect(resolveRemoteRequestRule("PATCH", "/api/user-preferences", "ready")).toBeNull();
		expect(resolveRemoteRequestRule("PATCH", "/api/user-preferences?view=ui", "ready")).toBeNull();
		expect(
			resolveRemoteRequestRule("PATCH", "/api/user-preferences?view=ui&view=full", "ready"),
		).toBeNull();
		expect(resolveRemoteRequestRule("GET", "/api/user-preferences?view=ui", "ready")?.id).toBe(
			"preferences-read",
		);
	});

	test.each([
		["PATCH", "/api/settings/runtime"],
		["POST", "/api/model-catalog/runtime"],
		["DELETE", "/api/model-catalog/options"],
		["PATCH", `/api/narrators/${narratorId}/ui-summary`],
		["GET", "/api/settings/runtime/private"],
		["GET", "/api/model-catalog/options/private"],
		["GET", "/api/user-preferences/ui/private"],
		["GET", "/api/user-preferences/gateway"],
		["GET", "/api/narrators/named?view=suggestions"],
		["GET", "/api/narrators/short/ui-summary"],
		["GET", "/api/settings/../runtime"],
		["GET", "/api/settings/%72untime"],
		["GET", "//api/settings/runtime"],
		["get", "/api/settings/runtime"],
	])("%s %s cannot inherit broader access from the UI projection rules", (method, path) => {
		expect(resolveRemoteRequestRule(method, path, "ready")).toBeNull();
	});

	test("existing full editor reads keep their separate rules and are never confused with slim DTOs", () => {
		for (const [path, id] of [
			["/api/settings", "settings-read"],
			["/api/model-catalog/card?model=example", "model-catalog-read"],
			["/api/user-preferences", "preferences-read"],
		]) {
			const rule = resolveRemoteRequestRule("GET", path, "ready");
			expect(rule?.id).toBe(id);
			expect(rule?.responseBytes).toBeGreaterThan(64 * 1024);
		}
	});
});
