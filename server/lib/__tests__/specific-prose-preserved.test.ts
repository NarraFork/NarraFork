/**
 * Errors whose callers usually pass a MORE SPECIFIC message than the catalog has must not
 * have that message replaced by the generic one.
 *
 * The catalog rollout attaches a `messageCode` so the frame can be localized, and the
 * client deliberately prefers `messageCode` over the English prose on the wire. Those two
 * decisions combine badly when the code is attached unconditionally: `FORBIDDEN_ACTION`
 * says "you are not allowed to perform this action", so "You can only delete your own
 * messages" rendered as the version that tells the user nothing, and git's `fatal:` line —
 * the only text that says WHY a push was refused — was demoted the same way.
 *
 * That regression is invisible in English-only testing, because the raw message is still
 * on the wire and still shown when no translation is found. It only appears once a
 * translation exists. Hence these assertions are about the PAYLOAD, not about rendering.
 */

import { describe, expect, test } from "bun:test";
import { ERROR_CATALOG } from "@shared/error-catalog";
import { toErrorPayload } from "../app-error-response";
import { ForbiddenError, GitAuthError } from "../errors";

describe("errors that carry caller-specific prose", () => {
	test("a custom forbidden reason keeps its own wording", () => {
		const payload = toErrorPayload(new ForbiddenError("You can only delete your own messages"));
		expect(payload.error).toBe("You can only delete your own messages");
		// No messageCode at all, rather than a code whose wording contradicts `error`.
		expect(payload.messageCode).toBeUndefined();
		expect(payload.code).toBe("FORBIDDEN");
	});

	test("the default forbidden message is still localizable", () => {
		const payload = toErrorPayload(new ForbiddenError());
		expect(payload.messageCode).toBe("FORBIDDEN_ACTION");
		expect(payload.error).toBe(ERROR_CATALOG.FORBIDDEN_ACTION.en);
	});

	test("git's own failure line survives instead of being generalized", () => {
		const detail = "fatal: Authentication failed for 'https://example.com/repo.git/'";
		const payload = toErrorPayload(new GitAuthError(detail));
		expect(payload.error).toBe(detail);
		expect(payload.messageCode).toBeUndefined();
		expect(payload.code).toBe("GIT_AUTH_REQUIRED");
	});

	test("the default git auth message is still localizable", () => {
		const payload = toErrorPayload(new GitAuthError());
		expect(payload.messageCode).toBe("GIT_AUTH_REQUIRED");
		expect(payload.error).toBe(ERROR_CATALOG.GIT_AUTH_REQUIRED.en);
	});

	test("the sentinel defaults are the catalog's own text", () => {
		// The "did the caller customize this?" test is a string comparison, so a divergent
		// copy of either sentence would silently stop localizing the default case.
		expect(new ForbiddenError().message).toBe(ERROR_CATALOG.FORBIDDEN_ACTION.en);
		expect(new GitAuthError().message).toBe(ERROR_CATALOG.GIT_AUTH_REQUIRED.en);
	});
});
