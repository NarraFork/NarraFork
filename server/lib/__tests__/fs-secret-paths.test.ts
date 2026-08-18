/**
 * Which files `/api/fs/*` refuses to serve.
 *
 * The endpoints take an absolute path from the client, and that is deliberate — the
 * viewer opens request dumps, truncated tool output and subagent conclusions that live
 * outside any project, and the directory browser has always listed the whole
 * filesystem. What must not follow is an escalation from "logged-in reader" to
 * "platform operator", which is exactly what serving three specific files does:
 *
 *   - `settings.json` holds `auth.jwtSecret`, so its bytes forge any user's session;
 *   - `narrafork.db` (and its WAL) holds every password hash and OAuth grant;
 *   - `~/.ssh` holds keys that are not even NarraFork's to leak.
 *
 * The positive cases matter as much as the negative ones: over-blocking would silently
 * break the file viewer for the platform files it exists to show, and nothing in the
 * UI would explain why one dump opens and another does not.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isSecretPlatformPath, isSecretUserPath } from "../fs-secret-paths";

const HOME = "/home/tester/.narrafork";
const USER_HOME = "/home/tester";

describe("platform credential files", () => {
	test.each([
		["settings.json", "the JWT signing secret"],
		["codex-credentials.json", "provider credentials"],
		["update-server.json", "the release upload token"],
		["update-server-test.json", "the test upload token"],
	])("refuses %s (%s)", (name) => {
		expect(isSecretPlatformPath(join(HOME, name), HOME)).toBe(true);
	});

	test.each([
		"narrafork.db",
		// The WAL holds recently written rows verbatim, so it discloses the same hashes
		// the main file does — a suffix-blind check would have missed it.
		"narrafork.db-wal",
		"narrafork.db-shm",
		"narrafork.db.bak",
	])("refuses %s", (name) => {
		expect(isSecretPlatformPath(join(HOME, name), HOME)).toBe(true);
	});

		// Matched as a directory because the layout is the provider's business and may
		// gain files this list has never heard of.
	});
});

describe("platform files the viewer must keep opening", () => {
	test.each([
		["malformed-request-dumps/dump.json", "a request dump the viewer links to"],
		["conclusions/abc.md", "a subagent conclusion"],
		["model-cache.json", "a non-secret cache"],
		["openai-models.json", "a non-secret model list"],
	])("allows %s (%s)", (rel) => {
		expect(isSecretPlatformPath(join(HOME, rel), HOME)).toBe(false);
	});

	test("allows a project file that merely shares a secret's name", () => {
		// The match is home-relative, not by basename: a repo's own settings.json is
		// ordinary content.
		expect(isSecretPlatformPath("/home/tester/code/app/settings.json", HOME)).toBe(false);
	});

	test("allows a path outside the NarraFork home entirely", () => {
		expect(isSecretPlatformPath("/tmp/whatever.json", HOME)).toBe(false);
	});

	test("does not treat the home directory itself as a secret", () => {
		expect(isSecretPlatformPath(HOME, HOME)).toBe(false);
	});
});

describe("escaping the home with traversal", () => {
	test("a traversal that lands on a secret is still refused", () => {
		// The check resolves first, so `dumps/../settings.json` cannot smuggle it past.
		expect(
			isSecretPlatformPath(join(HOME, "malformed-request-dumps", "..", "settings.json"), HOME),
		).toBe(true);
	});

	test("a traversal that leaves the home is not this module's concern", () => {
		expect(isSecretPlatformPath(join(HOME, "..", "notes.txt"), HOME)).toBe(false);
	});
});

describe("third-party credential stores in the user's home", () => {
	test.each([
		".ssh/id_rsa",
		".aws/credentials",
		".gnupg/secring.gpg",
		".kube/config",
	])("refuses %s", (rel) => {
		expect(isSecretUserPath(join(USER_HOME, rel), USER_HOME)).toBe(true);
	});

	test("allows ordinary files in the home", () => {
		expect(isSecretUserPath(join(USER_HOME, "notes.txt"), USER_HOME)).toBe(false);
		expect(isSecretUserPath(join(USER_HOME, "code", "app", "main.ts"), USER_HOME)).toBe(false);
	});

	test("does not mistake a FILE named like a store for the store", () => {
		// `.ssh` as a leaf is a file, and refusing it would be a rule about the name
		// rather than about the credential directory.
		expect(isSecretUserPath(join(USER_HOME, ".ssh"), USER_HOME)).toBe(false);
	});

	test("allows paths outside the home", () => {
		expect(isSecretUserPath("/etc/hosts", USER_HOME)).toBe(false);
	});
});
