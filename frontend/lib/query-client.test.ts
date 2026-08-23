/**
 * Which mutation failures reach the global toast.
 *
 * Every rule here fails silently when it regresses, which is why they are pinned:
 *
 *  - A suppressed toast that should have fired looks like a dead button — the user clicks,
 *    the request fails, and nothing on screen changes.
 *  - A toast that should have been suppressed covers the surface that already explained the
 *    failure, so the same sentence appears twice.
 *
 * The 401 split is the subtle one. `isSessionInvalidResponse` treats a code-less 401 as
 * session loss (legacy routes and proxy rejections carry no code), but keeps the session for
 * the codes that are NOT session failures. A wrong TOTP code is the case that matters: it
 * navigates nowhere, so silencing it leaves the user staring at an unchanged form.
 *
 * Run: bun test frontend/lib/query-client.test.ts
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "./api/client";
import { shouldShowMutationErrorToast } from "./query-client";

describe("global mutation error toast", () => {
	test("an ordinary failure is shown", () => {
		expect(shouldShowMutationErrorToast(new ApiError("Merge failed", 500, {}))).toBe(true);
	});

	test("a non-ApiError failure is shown", () => {
		// A thrown TypeError from a bad response shape still deserves to be surfaced.
		expect(shouldShowMutationErrorToast(new TypeError("x is not a function"))).toBe(true);
	});

	test("a call site that renders its own error suppresses it", () => {
		expect(
			shouldShowMutationErrorToast(new ApiError("Merge failed", 500, {}), {
				suppressErrorToast: true,
			}),
		).toBe(false);
	});

	test("meta present but not opting out still shows it", () => {
		expect(shouldShowMutationErrorToast(new ApiError("Merge failed", 500, {}), {})).toBe(true);
	});

	test("a cancelled upload is silent", () => {
		expect(
			shouldShowMutationErrorToast(new ApiError("Upload cancelled", 0, { code: "UPLOAD_ABORTED" })),
		).toBe(false);
	});

	test("a native fetch abort is silent", () => {
		expect(
			shouldShowMutationErrorToast(new DOMException("The operation was aborted", "AbortError")),
		).toBe(false);
	});

	test("a dead session is silent — the app navigates to login instead", () => {
		expect(
			shouldShowMutationErrorToast(new ApiError("Token expired", 401, { code: "TOKEN_EXPIRED" })),
		).toBe(false);
	});

	test("a 401 with no code is silent, matching the client's session handling", () => {
		expect(shouldShowMutationErrorToast(new ApiError("Unauthorized", 401, {}))).toBe(false);
	});

	test("a 401 that is NOT session loss is shown", () => {
		// The regression this pins: a wrong TOTP code navigates nowhere, so silencing it
		// made the form look unresponsive.
		expect(
			shouldShowMutationErrorToast(new ApiError("Invalid code", 401, { code: "MFA_CODE_INVALID" })),
		).toBe(true);
		expect(
			shouldShowMutationErrorToast(
				new ApiError("Passkey rejected", 401, { code: "PASSKEY_AUTH_FAILED" }),
			),
		).toBe(true);
	});

	test("a 403 is shown — only 401 participates in the session check", () => {
		expect(
			shouldShowMutationErrorToast(new ApiError("Forbidden", 403, { code: "FORBIDDEN" })),
		).toBe(true);
	});
});
