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
							INTEGRATION_AUTHORITY_CONFLICT:
								"The plugin authorization state conflicts with this installation.",
							PLUGINS_DISABLED: "The plugin system is disabled on this server.",
							PLUGIN_OPERATION_FAILED: "The plugin operation failed.",
							NOT_FOUND: "The requested plugin resource was not found.",
							VALIDATION_ERROR: "The request was rejected by server-side validation.",
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

	test("maps integration authority conflicts to a known plugin error", () => {
		const t = createT();
		const error = new ApiError("Revoked plugin authorities cannot be reactivated", 409, {
			error: "Revoked plugin authorities cannot be reactivated",
			code: "INTEGRATION_AUTHORITY_CONFLICT",
		});
		expect(localizePluginError(error, t)).toBe(
			"The plugin authorization state conflicts with this installation.",
		);
	});

	test("includes the server-provided reason for validation errors", () => {
		const t = createT();
		const error = new ApiError(
			"Invalid plugin manifest: contributes.themes.0.tokens: unrecognized key",
			400,
			{
				error: "Invalid plugin manifest: contributes.themes.0.tokens: unrecognized key",
				code: "VALIDATION_ERROR",
			},
		);
		expect(localizePluginError(error, t)).toBe(
			"The request was rejected by server-side validation. Invalid plugin manifest: contributes.themes.0.tokens: unrecognized key",
		);
	});

	test("does not duplicate a validation summary when no detail is available", () => {
		const t = createT();
		const summary = "The request was rejected by server-side validation.";
		expect(localizePluginError(new ApiError(summary, 400, { code: "VALIDATION_ERROR" }), t)).toBe(
			summary,
		);
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
