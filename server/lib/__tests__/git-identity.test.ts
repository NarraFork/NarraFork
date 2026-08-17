import { describe, expect, test } from "bun:test";
import {
	buildGitIdentityEnv,
	invalidateGitIdentityCache,
	resolveActingGitUserId,
} from "../git-identity";

describe("buildGitIdentityEnv", () => {
	test("a complete identity pins author AND committer", () => {
		// Setting only GIT_AUTHOR_* leaves the committer resolving from the host
		// config, which is the shared identity this module exists to eliminate.
		expect(buildGitIdentityEnv({ name: "Alice", email: "alice@example.com" })).toEqual({
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		});
	});

	test("never emits a date, so commit time stays the real time", () => {
		const env = buildGitIdentityEnv({ name: "Alice", email: "alice@example.com" });
		expect(Object.keys(env ?? {}).sort()).toEqual([
			"GIT_AUTHOR_EMAIL",
			"GIT_AUTHOR_NAME",
			"GIT_COMMITTER_EMAIL",
			"GIT_COMMITTER_NAME",
		]);
	});

	test("a half-filled identity yields null rather than a partial env", () => {
		// This is the load-bearing case: git rejects GIT_AUTHOR_NAME="" with
		// "fatal: empty ident name not allowed", so a partial env does not degrade
		// to the host identity — it makes every commit fail outright.
		expect(buildGitIdentityEnv({ name: "Alice" })).toBeNull();
		expect(buildGitIdentityEnv({ email: "alice@example.com" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "Alice", email: "" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "", email: "alice@example.com" })).toBeNull();
	});

	test("whitespace-only values count as missing, not as a usable ident", () => {
		expect(buildGitIdentityEnv({ name: "   ", email: "alice@example.com" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "Alice", email: "\t\n " })).toBeNull();
	});

	test("surrounding whitespace is trimmed off a usable identity", () => {
		expect(buildGitIdentityEnv({ name: "  Alice  ", email: " alice@example.com " })).toEqual({
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		});
	});

	test("ident-breaking characters are refused instead of written into the commit", () => {
		// `<`/`>` delimit the email in the ident line and a newline ends the line, so
		// either produces a corrupt commit object rather than a mis-attributed one.
		expect(buildGitIdentityEnv({ name: "Al<ice", email: "alice@example.com" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "Alice>", email: "alice@example.com" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "Alice", email: "<alice@example.com>" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "Ali\nce", email: "alice@example.com" })).toBeNull();
		expect(buildGitIdentityEnv({ name: "Alice", email: "a@e.com\rX" })).toBeNull();
	});

	test("absent input yields null so callers inherit the host identity", () => {
		expect(buildGitIdentityEnv(null)).toBeNull();
		expect(buildGitIdentityEnv(undefined)).toBeNull();
		expect(buildGitIdentityEnv({})).toBeNull();
	});

	test("non-string values are treated as missing rather than coerced", () => {
		expect(buildGitIdentityEnv({ name: 42 as unknown as string, email: "a@e.com" })).toBeNull();
	});
});

describe("resolveActingGitUserId", () => {
	test("the triggering user wins: authorship follows whoever made the agent work", () => {
		expect(resolveActingGitUserId("turn-user", "owner-user")).toBe("turn-user");
	});

	test("falls back to the owner when nobody triggered the turn", () => {
		// Background continuations and scheduled runs have no triggering user, and
		// the session's owner is a better author than the host machine.
		expect(resolveActingGitUserId(null, "owner-user")).toBe("owner-user");
		expect(resolveActingGitUserId(undefined, "owner-user")).toBe("owner-user");
	});

	test("returns null when neither is known, which means inherit the host identity", () => {
		expect(resolveActingGitUserId(null, null)).toBeNull();
		expect(resolveActingGitUserId(undefined, undefined)).toBeNull();
	});
});

describe("invalidateGitIdentityCache", () => {
	test("is callable for one user and for the whole cache without a database", () => {
		// Importing this module must not open a connection; these calls are the
		// eviction hooks used by the profile route.
		expect(() => invalidateGitIdentityCache("user-1")).not.toThrow();
		expect(() => invalidateGitIdentityCache(null)).not.toThrow();
		expect(() => invalidateGitIdentityCache()).not.toThrow();
	});
});
