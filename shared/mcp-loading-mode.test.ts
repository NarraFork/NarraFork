import { describe, expect, it } from "bun:test";
import {
	applyMcpLoadingPatch,
	hasMcpLoadingConflict,
	normalizeMcpLoadingConfig,
	resolveMcpLoadingMode,
} from "./mcp-loading-mode";

describe("MCP loading policy", () => {
	it("migrates legacy switches and defaults new configurations to auto", () => {
		expect(resolveMcpLoadingMode({ enabled: true })).toBe("resident");
		expect(resolveMcpLoadingMode({ enabled: false })).toBe("disabled");
		expect(normalizeMcpLoadingConfig({})).toEqual({ mode: "auto", enabled: true });
	});
	it("treats mode as authoritative when repairing stored data", () => {
		expect(normalizeMcpLoadingConfig({ mode: "auto", enabled: false })).toEqual({
			mode: "auto",
			enabled: true,
		});
		expect(normalizeMcpLoadingConfig({ mode: "disabled", enabled: true })).toEqual({
			mode: "disabled",
			enabled: false,
		});
	});
	it("rejects contradictory explicit API writes", () => {
		for (const patch of [
			{ mode: "disabled", enabled: true },
			{ mode: "auto", enabled: false },
			{ mode: "resident", enabled: false },
		]) {
			expect(hasMcpLoadingConflict(patch)).toBe(true);
			expect(() => applyMcpLoadingPatch({}, patch)).toThrow("conflicts");
		}
	});
	it("preserves enabled policy for legacy PATCH and restores disabled to resident", () => {
		for (const mode of ["auto", "resident"] as const) {
			expect(applyMcpLoadingPatch({ mode }, { enabled: true })).toEqual({ mode, enabled: true });
			expect(applyMcpLoadingPatch({ mode }, {})).toEqual({ mode, enabled: true });
		}
		expect(applyMcpLoadingPatch({ mode: "disabled" }, { enabled: true })).toEqual({
			mode: "resident",
			enabled: true,
		});
		expect(applyMcpLoadingPatch({ mode: "auto" }, { enabled: false })).toEqual({
			mode: "disabled",
			enabled: false,
		});
	});
});
