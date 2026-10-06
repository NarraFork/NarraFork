/**
 * What the "show original" disclosure offers, and when it offers nothing.
 *
 * The catalog rollout gives an error two texts: the server's English template and the
 * client's translation of the same `messageCode`. For most entries those differ, and the
 * disclosure is how a user reaches the original for a bug report. For several entries they
 * are byte-identical in English — `FORBIDDEN_ACTION`, `RESOURCE_NOT_FOUND`,
 * `VALIDATION_FAILED` and the `MERGE_DIRTY_*` family all translate to the same sentence the
 * server sends — and there the block repeated the message under a link promising something
 * else.
 *
 * Tested through `errorDetailDisclosure` rather than by rendering: the decision is pure, and
 * a DOM assertion here would mostly exercise Mantine's Collapse.
 *
 * Run: bun test frontend/components/common/ErrorDetail.test.tsx
 */

import { describe, expect, test } from "bun:test";
import type { DescribedApiError } from "../../lib/api-error";
import { errorDetailDisclosure } from "./ErrorDetail";

function described(overrides: Partial<DescribedApiError> = {}): DescribedApiError {
	return {
		message: "You are not allowed to perform this action",
		raw: "You are not allowed to perform this action",
		code: "FORBIDDEN",
		messageCode: "FORBIDDEN_ACTION",
		status: 403,
		localized: true,
		...overrides,
	};
}

describe("errorDetailDisclosure", () => {
	test("hides the raw block when it would repeat the shown sentence", () => {
		// The regression: a translation identical to the server's template.
		const result = errorDetailDisclosure(described());
		expect(result.showRaw).toBe(false);
		// Still disclosed, because the codes are not visible anywhere else.
		expect(result.showDisclosure).toBe(true);
	});

	test("a custom forbidden reason is shown as-is with nothing hidden behind a link", () => {
		// `ForbiddenError` with caller prose carries no messageCode, so its message is already
		// the server's own words — there is no second version to offer.
		const result = errorDetailDisclosure(
			described({
				message: "You can only delete your own messages",
				raw: "You can only delete your own messages",
				messageCode: null,
			}),
		);
		expect(result.showRaw).toBe(false);
		expect(result.showDisclosure).toBe(false);
	});

	test("shows the raw block when the localized wording really differs", () => {
		const result = errorDetailDisclosure(
			described({
				message: "你没有权限执行此操作",
				raw: "You are not allowed to perform this action",
			}),
		);
		expect(result.showRaw).toBe(true);
		expect(result.showDisclosure).toBe(true);
	});

	test("offers no disclosure at all when there is nothing to add", () => {
		// A transport failure: one sentence, no codes, no server text. A link here would
		// open an empty panel.
		const result = errorDetailDisclosure(
			described({
				message: "Something went wrong",
				raw: null,
				code: null,
				messageCode: null,
				status: null,
				localized: false,
			}),
		);
		expect(result.showRaw).toBe(false);
		expect(result.showDisclosure).toBe(false);
	});

	test("a coarse code alone does not earn a disclosure", () => {
		// The un-migrated majority: the sentence shown IS the server's own text, so there is
		// no "original" to reveal. Almost every error has a `code`, so treating it as reason
		// enough would put an empty-feeling panel on all of them.
		const result = errorDetailDisclosure(
			described({
				message: "refusing to merge unrelated histories",
				raw: "refusing to merge unrelated histories",
				messageCode: null,
				code: "GIT_ERROR",
				status: 422,
			}),
		);
		expect(result.showRaw).toBe(false);
		expect(result.showDisclosure).toBe(false);
	});
});
