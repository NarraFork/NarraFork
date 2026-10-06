import { describe, expect, test } from "bun:test";
import {
	ABSOLUTE_SESSION_MAX_SECONDS,
	isSessionInvalidResponse,
	isSessionTokenVersionCurrent,
	isWithinAbsoluteSessionLimit,
	resolveSessionStart,
	SESSION_RENEWAL_THRESHOLD_SECONDS,
	SESSION_TOKEN_TTL_SECONDS,
	shouldRenewSessionToken,
} from "../session-auth";

describe("isSessionInvalidResponse", () => {
	test("treats session-credential failures as session loss", () => {
		expect(isSessionInvalidResponse({ code: "TOKEN_EXPIRED" })).toBe(true);
		expect(isSessionInvalidResponse({ code: "UNAUTHORIZED" })).toBe(true);
		expect(isSessionInvalidResponse({ code: "SESSION_REQUIRED" })).toBe(true);
	});

	test("keeps the session for 401s unrelated to the session credential", () => {
		// Wrong TOTP / backup code while managing two-factor settings.
		expect(isSessionInvalidResponse({ code: "MFA_CODE_INVALID" })).toBe(false);
		expect(isSessionInvalidResponse({ code: "MFA_TOKEN_INVALID" })).toBe(false);
		expect(isSessionInvalidResponse({ code: "TOTP_DISABLE_UNVERIFIED" })).toBe(false);
		// Failed passkey ceremony.
		expect(isSessionInvalidResponse({ code: "PASSKEY_AUTH_FAILED" })).toBe(false);
		// An OAuth-only endpoint rejecting a first-party session JWT.
		expect(isSessionInvalidResponse({ code: "OAUTH_REQUIRED" })).toBe(false);
		// Plugin UI sessions are a separate credential from the user session.
		expect(isSessionInvalidResponse({ code: "PLUGIN_UI_SESSION_REQUIRED" })).toBe(false);
		expect(isSessionInvalidResponse({ code: "PLUGIN_UI_SESSION_INVALID" })).toBe(false);
		// OAuth client authentication failure on the token endpoint.
		expect(isSessionInvalidResponse({ error: "invalid_client", code: "invalid_client" })).toBe(
			false,
		);
	});

	test("falls back to session loss when no code is present", () => {
		// Legacy routes and proxy-generated 401s carry no code; 401 without any
		// further signal still has to be read as "not authenticated".
		expect(isSessionInvalidResponse({})).toBe(true);
		expect(isSessionInvalidResponse(null)).toBe(true);
		expect(isSessionInvalidResponse(undefined)).toBe(true);
		expect(isSessionInvalidResponse({ error: "Unauthorized" })).toBe(true);
		expect(isSessionInvalidResponse({ code: "   " })).toBe(true);
		expect(isSessionInvalidResponse({ code: 401 })).toBe(true);
	});
});

describe("shouldRenewSessionToken", () => {
	const now = 1_700_000_000;

	test("renews once the remaining lifetime falls under the threshold", () => {
		const exp = now + SESSION_RENEWAL_THRESHOLD_SECONDS - 60;
		expect(shouldRenewSessionToken(exp, now)).toBe(true);
	});

	test("leaves a freshly issued token alone", () => {
		const exp = now + SESSION_TOKEN_TTL_SECONDS;
		expect(shouldRenewSessionToken(exp, now)).toBe(false);
	});

	test("does not renew exactly at the threshold boundary", () => {
		const exp = now + SESSION_RENEWAL_THRESHOLD_SECONDS;
		expect(shouldRenewSessionToken(exp, now)).toBe(false);
	});

	test("does not renew an already-expired or malformed exp", () => {
		expect(shouldRenewSessionToken(now, now)).toBe(false);
		expect(shouldRenewSessionToken(now - 1, now)).toBe(false);
		expect(shouldRenewSessionToken(0, now)).toBe(false);
		expect(shouldRenewSessionToken(Number.NaN, now)).toBe(false);
	});

	test("an active user stays signed in until the absolute ceiling, then stops", () => {
		// Simulate a user who touches the app every other day for three months.
		// Renewal keeps the session alive while the chain is inside the ceiling and
		// stops the moment it is not — no "indefinitely" any more.
		const sessionStart = now;
		let exp = now + SESSION_TOKEN_TTL_SECONDS;
		let lastRenewalAt = now;
		const day = 24 * 60 * 60;
		for (let d = 0; d < 90; d += 2) {
			const at = now + d * day;
			if (!shouldRenewSessionToken(exp, at)) continue;
			if (!isWithinAbsoluteSessionLimit(sessionStart, at)) continue;
			exp = at + SESSION_TOKEN_TTL_SECONDS;
			lastRenewalAt = at;
		}
		// The last renewal happened inside the ceiling, so the session dies at most
		// one TTL after it — far short of the 90-day activity window.
		expect(lastRenewalAt - sessionStart).toBeLessThan(ABSOLUTE_SESSION_MAX_SECONDS);
		expect(exp).toBeLessThan(
			sessionStart + ABSOLUTE_SESSION_MAX_SECONDS + SESSION_TOKEN_TTL_SECONDS,
		);
		expect(exp).toBeLessThan(now + 90 * day);
	});
});

describe("absolute session ceiling", () => {
	const now = 1_700_000_000;

	test("permits renewal inside the ceiling and refuses it past the ceiling", () => {
		expect(isWithinAbsoluteSessionLimit(now, now)).toBe(true);
		expect(isWithinAbsoluteSessionLimit(now - (ABSOLUTE_SESSION_MAX_SECONDS - 1), now)).toBe(true);
		expect(isWithinAbsoluteSessionLimit(now - ABSOLUTE_SESSION_MAX_SECONDS, now)).toBe(false);
		expect(isWithinAbsoluteSessionLimit(now - 2 * ABSOLUTE_SESSION_MAX_SECONDS, now)).toBe(false);
	});

	test("keeps a real anchor and anchors legacy tokens at the present", () => {
		const anchor = now - 5 * 24 * 60 * 60;
		expect(resolveSessionStart(anchor, now)).toBe(anchor);
		// Tokens issued before the claim existed carry no anchor: they are treated
		// as starting now, so they get one more full window instead of a logout.
		expect(resolveSessionStart(undefined, now)).toBe(now);
		expect(resolveSessionStart(null, now)).toBe(now);
		expect(resolveSessionStart("not-a-number", now)).toBe(now);
		expect(resolveSessionStart(Number.NaN, now)).toBe(now);
		expect(resolveSessionStart(0, now)).toBe(now);
		expect(resolveSessionStart(-1, now)).toBe(now);
		// A future anchor would extend the ceiling, so it is not trusted either.
		expect(resolveSessionStart(now + 3600, now)).toBe(now);
	});

	test("a legacy token cannot be renewed forever either", () => {
		// First request re-anchors at the present, and every later renewal inherits
		// that anchor — so the chain still terminates.
		const anchored = resolveSessionStart(undefined, now);
		expect(isWithinAbsoluteSessionLimit(anchored, now)).toBe(true);
		expect(isWithinAbsoluteSessionLimit(anchored, now + ABSOLUTE_SESSION_MAX_SECONDS)).toBe(false);
	});
});

describe("isSessionTokenVersionCurrent", () => {
	test("accepts a token whose generation matches", () => {
		expect(isSessionTokenVersionCurrent(0, 0)).toBe(true);
		expect(isSessionTokenVersionCurrent(3, 3)).toBe(true);
	});

	test("rejects a token left behind by a bump", () => {
		expect(isSessionTokenVersionCurrent(0, 1)).toBe(false);
		expect(isSessionTokenVersionCurrent(2, 5)).toBe(false);
	});

	test("treats a missing claim as generation 0", () => {
		// Every token in circulation predates the claim; rejecting them outright would
		// sign the whole user base out on deploy.
		expect(isSessionTokenVersionCurrent(undefined, 0)).toBe(true);
		// ...but they must still be revocable, which is the entire point.
		expect(isSessionTokenVersionCurrent(undefined, 1)).toBe(false);
	});

	test("fails closed on a claim that is not a finite number", () => {
		for (const claim of ["0", null, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
			expect(isSessionTokenVersionCurrent(claim, 0)).toBe(false);
		}
	});

	test("accepts a claim ahead of the stored value", () => {
		// The cached generation can lag a bump by up to the cache TTL, so a token minted
		// against the newer value must not be rejected while that entry is still warm.
		expect(isSessionTokenVersionCurrent(2, 1)).toBe(true);
	});
});
