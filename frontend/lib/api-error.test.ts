import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "./api/client";
import { describeApiError, hasDistinctRawMessage } from "./api-error";

/**
 * A `t` that resolves against the real `errors.json` bundles.
 *
 * Stubbing translations would let the lookup order pass while the actual keys are absent, which
 * is the exact defect the parity test exists to catch — so this reads the shipped files.
 */
function makeTranslate(locale: "en" | "zh-CN") {
	const bundle = JSON.parse(
		readFileSync(join(import.meta.dir, "..", "locales", locale, "errors.json"), "utf8"),
	) as Record<string, unknown>;
	const common: Record<string, string> = { unexpectedError: "Something went wrong" };

	return (key: string, options?: Record<string, unknown>) => {
		const ns = options?.ns;
		const table = ns === "common" ? common : bundle;
		const value = key
			.split(".")
			.reduce<unknown>(
				(acc, part) =>
					acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined,
				table,
			);
		if (typeof value !== "string") {
			return (options?.defaultValue as string) ?? key;
		}
		// Interpolation values come from `options.replace`, matching i18next: that is the
		// dedicated channel, and it is what the production code uses so a placeholder named
		// after an i18next option (`ns`, `lng`, `defaultValue`) cannot be swallowed as
		// configuration. Reading them off the top level here instead would let this stub pass
		// a spread-based implementation that breaks on exactly those names.
		const replace = (options?.replace as Record<string, unknown> | undefined) ?? {};
		return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
			const param = replace[name];
			return param === undefined ? whole : String(param);
		});
	};
}

const tEn = makeTranslate("en");
const tZh = makeTranslate("zh-CN");

function apiError(
	status: number,
	data: Record<string, unknown>,
	message = String(data.error ?? "Request failed"),
): ApiError {
	return new ApiError(message, status, data);
}

describe("messageCode lookup", () => {
	test("renders the localized template with interpolated params", () => {
		const described = describeApiError(
			apiError(404, {
				error: "Chapter not found: abc123",
				code: "NOT_FOUND",
				messageCode: "RESOURCE_NOT_FOUND",
				messageParams: { entity: "Chapter", id: "abc123" },
			}),
			tZh,
		);
		expect(described.message).toBe("未找到章节：abc123");
		expect(described.localized).toBe(true);
		expect(described.messageCode).toBe("RESOURCE_NOT_FOUND");
	});

	test("keeps the server's English available untouched alongside the translation", () => {
		const described = describeApiError(
			apiError(404, {
				error: "Chapter not found: abc123",
				code: "NOT_FOUND",
				messageCode: "RESOURCE_NOT_FOUND",
				messageParams: { entity: "Chapter", id: "abc123" },
			}),
			tZh,
		);
		expect(described.raw).toBe("Chapter not found: abc123");
		expect(hasDistinctRawMessage(described)).toBe(true);
	});

	test("passes an unlisted entity through verbatim rather than breaking the sentence", () => {
		const described = describeApiError(
			apiError(404, {
				error: "Widget not found: w1",
				code: "NOT_FOUND",
				messageCode: "RESOURCE_NOT_FOUND",
				messageParams: { entity: "Widget", id: "w1" },
			}),
			tZh,
		);
		expect(described.message).toBe("未找到Widget：w1");
	});
});

describe("fallback order", () => {
	test("falls back to the behaviour code when messageCode is absent", () => {
		// Lets a whole class be covered (GIT_NOT_INSTALLED) before individual messages migrate.
		const described = describeApiError(
			apiError(503, { error: "Git is not installed. …", code: "GIT_NOT_INSTALLED" }),
			tZh,
		);
		expect(described.message).toBe("未安装 Git。请安装 git 后重试此操作。");
		expect(described.localized).toBe(true);
	});

	test("falls back to the server's prose for an un-migrated error", () => {
		const described = describeApiError(
			apiError(400, { error: "Branch name already taken", code: "VALIDATION_ERROR" }),
			tZh,
		);
		expect(described.message).toBe("Branch name already taken");
		expect(described.localized).toBe(false);
		// No disclosure: expanding it would repeat the same sentence.
		expect(hasDistinctRawMessage(described)).toBe(false);
	});

	test("discards a messageCode this build does not know", () => {
		const described = describeApiError(
			apiError(400, {
				error: "Something specific from a newer server",
				code: "VALIDATION_ERROR",
				messageCode: "INVENTED_LATER",
			}),
			tZh,
		);
		expect(described.message).toBe("Something specific from a newer server");
		expect(described.messageCode).toBeNull();
	});

	test("uses the supplied fallback for a bodyless failure", () => {
		const described = describeApiError(new ApiError("", 0, undefined), tEn, "Network unreachable");
		expect(described.message).toBe("Network unreachable");
	});

	test("uses common:unexpectedError when there is nothing else", () => {
		expect(describeApiError(undefined, tEn).message).toBe("Something went wrong");
		expect(describeApiError({}, tEn).message).toBe("Something went wrong");
	});
});

describe("non-ApiError inputs", () => {
	test("reads a plain Error's message", () => {
		const described = describeApiError(new Error("boom"), tEn);
		expect(described.message).toBe("boom");
		expect(described.status).toBeNull();
		expect(described.code).toBeNull();
	});

	test("reads a thrown string", () => {
		expect(describeApiError("raw failure", tEn).message).toBe("raw failure");
	});
});

describe("param hygiene", () => {
	test("clamps an oversized param arriving from the wire", () => {
		const described = describeApiError(
			apiError(404, {
				error: "x",
				code: "NOT_FOUND",
				messageCode: "RESOURCE_NOT_FOUND",
				messageParams: { entity: "Chapter", id: "z".repeat(500) },
			}),
			tEn,
		);
		expect(described.message.length).toBeLessThan(300);
	});

	test("leaves a placeholder visible when its param is missing", () => {
		const described = describeApiError(
			apiError(404, { error: "x", code: "NOT_FOUND", messageCode: "RESOURCE_NOT_FOUND" }),
			tEn,
		);
		expect(described.message).toBe("{{entity}} not found: {{id}}");
	});
});
