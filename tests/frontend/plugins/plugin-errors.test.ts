import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import {
	isPluginsDisabledError,
	localizePluginError,
} from "../../../frontend/components/plugins-admin/errors";
import { ApiError } from "../../../frontend/lib/api/client";

function createT() {
	const instance = i18next.createInstance();
	void instance.init({
		lng: "en",
		resources: {
			en: {
				plugins: {
					admin: {
						errors: {
							PLUGINS_DISABLED: "The plugin system is disabled on this server.",
							PLUGIN_OPERATION_FAILED: "The plugin operation failed.",
							NOT_FOUND: "The requested plugin resource was not found.",
							UNKNOWN: "An unexpected plugin error occurred.",
						},
					},
				},
			},
		},
		ns: ["plugins"],
		defaultNS: "plugins",
	});
	return instance.getFixedT("en", "plugins") as never as Parameters<typeof localizePluginError>[1];
}

describe("plugin error localization", () => {
	test("maps known backend codes to localized messages", () => {
		const t = createT();
		const error = new ApiError("Plugin system is disabled", 503, {
			error: "Plugin system is disabled",
			code: "PLUGINS_DISABLED",
		});
		expect(localizePluginError(error, t)).toBe("The plugin system is disabled on this server.");
	});

	test("never leaks raw Error.message for unknown codes", () => {
		const t = createT();
		const error = new ApiError("Bearer abc123 leaked", 500, {
			error: "Bearer abc123 leaked",
			code: "SOME_INTERNAL_CODE",
		});
		expect(localizePluginError(error, t)).toBe("An unexpected plugin error occurred.");
	});

	test("detects the PLUGINS_DISABLED steady state by code or status", () => {
		expect(
			isPluginsDisabledError(new ApiError("disabled", 503, { code: "PLUGINS_DISABLED" })),
		).toBe(true);
		expect(isPluginsDisabledError(new ApiError("disabled", 503, {}))).toBe(true);
		expect(isPluginsDisabledError(new ApiError("other", 500, { code: "OTHER" }))).toBe(false);
		expect(isPluginsDisabledError(new Error("nope"))).toBe(false);
	});

	test("falls back by HTTP status when no code is present", () => {
		const t = createT();
		expect(localizePluginError(new ApiError("missing", 404, {}), t)).toBe(
			"The requested plugin resource was not found.",
		);
		expect(localizePluginError(new ApiError("disabled", 503, {}), t)).toBe(
			"The plugin system is disabled on this server.",
		);
		expect(localizePluginError(new Error("raw"), t)).toBe("An unexpected plugin error occurred.");
	});
});
