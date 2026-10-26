/**
 * Which files `/api/fs/*` refuses to serve.
 *
 * The endpoints take an absolute path from the client, and that is deliberate — the
 * viewer opens request dumps, truncated tool output and subagent conclusions that live
 * outside any project, and the directory browser has always listed the whole
 * filesystem. What must not follow is an escalation from "logged-in reader" to
 * "platform operator", which is exactly what serving three specific files does:
 *
 *   - `settings.json` holds `auth.jwtSecret`, whose bytes forge MFA challenges and
 *     internal signatures;
 *   - `narrafork.db` (and its WAL) holds every password hash and OAuth grant;
 *   - `~/.ssh` holds keys that are not even NarraFork's to leak.
 *
 * The positive cases matter as much as the negative ones: over-blocking would silently
 * break the file viewer for the platform files it exists to show, and nothing in the
 * UI would explain why one dump opens and another does not.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isPrivateRequestRecordingPath,
	isSecretPlatformPath,
	isSecretUserPath,
} from "../fs-secret-paths";

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

	test("refuses everything under a credential directory", () => {
		// Matched as a directory because the layout is the provider's business and may
		// gain files this list has never heard of.
		expect(isSecretPlatformPath(join(HOME, "codex-credentials.json"), HOME)).toBe(true);
	});
});

describe("private request recording directories", () => {
	test.each([
		"request-recordings",
		"saved-request-recordings",
		"token-repair-jobs",
	])("refuses %s root and every descendant", (name) => {
		for (const suffix of [
			"",
			"request/record.json",
			"narrator/save/chunks/stream.jsonl",
			".exports/capture.zip",
		]) {
			expect(isSecretPlatformPath(join(HOME, name, suffix), HOME)).toBe(true);
		}
		expect(isSecretPlatformPath(join(HOME, `${name}-other`, "notes.json"), HOME)).toBe(false);
		expect(isSecretPlatformPath(join("/tmp/project", name, "notes.json"), HOME)).toBe(false);
	});
	test("sharing ancestor directories is refused without blocking ordinary sibling files", () => {
		expect(isPrivateRequestRecordingPath(HOME, HOME, true)).toBe(true);
		expect(isPrivateRequestRecordingPath(USER_HOME, HOME, true)).toBe(true);
		expect(
			isPrivateRequestRecordingPath(join(HOME, "malformed-request-dumps", "dump.json"), HOME, true),
		).toBe(false);
	});
	test.each([
		"saved-request-recordings",
		"token-repair-jobs",
	])("symlinks cannot reveal private %s", (name) => {
		const temporary = mkdtempSync(join(tmpdir(), "nf-private-recording-path-"));
		const home = join(temporary, "platform");
		const root = join(home, name);
		mkdirSync(root, { recursive: true });
		const file = join(root, "manifest.json");
		writeFileSync(file, "private recording");
		const fileLink = join(temporary, "ordinary.json");
		const directoryLink = join(temporary, "ordinary-dir");
		const homeLink = join(temporary, "home-alias");
		try {
			symlinkSync(file, fileLink, "file");
			symlinkSync(root, directoryLink, "dir");
			symlinkSync(home, homeLink, "dir");
			expect(isSecretPlatformPath(fileLink, home)).toBe(true);
			expect(isSecretPlatformPath(join(directoryLink, "manifest.json"), home)).toBe(true);
			expect(isSecretPlatformPath(file, homeLink)).toBe(true);
			expect(isPrivateRequestRecordingPath(homeLink, home, true)).toBe(true);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});

describe("private editor protocol state", () => {
	test.each([
		"editor-transfers",
		"editor-native",
		"editor-native-operations",
	])("protects %s contents, roots, ancestors and physical aliases", (name) => {
		const temporary = mkdtempSync(join(tmpdir(), "nf-private-editor-path-"));
		const home = join(temporary, "platform"),
			root = join(home, name);
		mkdirSync(root, { recursive: true });
		const file = join(root, "operation.json");
		writeFileSync(file, "private");
		const fileLink = join(temporary, "file-alias"),
			dirLink = join(temporary, "dir-alias"),
			homeLink = join(temporary, "home-alias");
		try {
			symlinkSync(file, fileLink, "file");
			symlinkSync(root, dirLink, "dir");
			symlinkSync(home, homeLink, "dir");
			for (const path of [
				root,
				file,
				fileLink,
				dirLink,
				join(dirLink, "operation.json"),
				join(homeLink, name, "missing.json"),
			])
				expect(isSecretPlatformPath(path, home)).toBe(true);
			expect(isSecretPlatformPath(file, homeLink)).toBe(true);
			expect(isPrivateRequestRecordingPath(root, home, true)).toBe(true);
			expect(isPrivateRequestRecordingPath(homeLink, home, true)).toBe(true);
			expect(isSecretPlatformPath(join(temporary, name, "ordinary.json"), home)).toBe(false);
			expect(isSecretPlatformPath(join(home, `${name}-ordinary`, "file.json"), home)).toBe(false);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});

describe("platform files the viewer must keep opening", () => {
	test.each([
		["malformed-request-dumps/dump.json", "a request dump the viewer links to"],
		["request-dumps/spill.json", "a legacy usage-history dump"],
		["provider-dumps/capture.json", "a provider capture"],
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

describe("Windows / edge-case spellings of a secret filename", () => {
	test.each([
		["SETTINGS.JSON", "an all-uppercase spelling"],
		["Settings.Json", "a mixed-case spelling"],
		["settings.json.", "a trailing dot the Win32 layer discards"],
		["settings.json ", "a trailing space the Win32 layer discards"],
		["settings.json::$DATA", "the default NTFS data stream"],
		["settings.json:hidden", "a named alternate data stream"],
	])("refuses %s (%s)", (name) => {
		expect(isSecretPlatformPath(join(HOME, name), HOME)).toBe(true);
	});

	test.each([
		["NARRAFORK.DB", "an uppercase database spelling"],
		["narrafork.db-wal::$DATA", "a WAL alternate data stream"],
		["Narrafork.Db.bak", "a mixed-case backup"],
	])("refuses %s (%s)", (name) => {
		expect(isSecretPlatformPath(join(HOME, name), HOME)).toBe(true);
	});

	test("still allows an ordinary file whose name merely starts like a secret", () => {
		// `settings.jsonc` is not `settings.json`; stripping must not fold it onto the secret.
		expect(isSecretPlatformPath(join(HOME, "settings.jsonc"), HOME)).toBe(false);
		expect(isSecretPlatformPath(join(HOME, "settings.json.backup-notes.md"), HOME)).toBe(false);
	});
});

describe("symlinks whose real target is a credential file", () => {
	test("a link that resolves into ~/.narrafork is caught by its real path", () => {
		const temporary = mkdtempSync(join(tmpdir(), "nf-secret-symlink-"));
		const home = join(temporary, "platform");
		mkdirSync(home, { recursive: true });
		const secret = join(home, "settings.json");
		writeFileSync(secret, '{"auth":{"jwtSecret":"x"}}');
		const innocentLink = join(temporary, "harmless-config.json");
		try {
			symlinkSync(secret, innocentLink, "file");
			// Lexically the link is outside the home and innocuously named; the physical
			// (realpath-resolved) check is what refuses it.
			expect(isSecretPlatformPath(innocentLink, home)).toBe(true);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
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
