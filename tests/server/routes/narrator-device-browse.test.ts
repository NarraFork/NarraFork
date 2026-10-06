/**
 * `/api/narrators/:id/device-browse` must not hand a non-admin session more reach
 * than the admin-only `/api/devices` surface it bypasses.
 *
 * Remote executors run with `allowRoots` empty (unrestricted) by default, so an
 * unbounded `fs.list` walks a device's whole filesystem. Device visibility to a
 * narrator cannot authorize the *caller*: any logged-in user can name any
 * narratorId, and visibility is per-project rather than per-caller. These tests pin
 * the boundary: admins keep full reach, everyone else is confined to paths already
 * reachable through the narrator's own device rules and declared workspace root.
 */

import { describe, expect, test } from "bun:test";
import {
	DEVICE_BROWSE_FORBIDDEN_MESSAGE,
	isDeviceBrowsePathWithinNarratorScope,
} from "@server/routes/narrators";

const WORKSPACE = "/remote/work";

function rule(
	path: string,
	overrides: { enabled?: boolean; pathFlavor?: "posix" | "windows" } = {},
) {
	return {
		path,
		pathFlavor: overrides.pathFlavor ?? ("posix" as const),
		enabled: overrides.enabled ?? true,
	};
}

describe("non-admin device browse scope", () => {
	test("refuses a path outside the workspace root and every device rule", () => {
		// The pre-fix behaviour: any logged-in user could list an arbitrary absolute
		// path on a visible device, enumerating the whole filesystem.
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/etc",
				pathFlavor: "posix",
				defaultCwd: WORKSPACE,
				rules: [rule("/srv/app")],
			}),
		).toBe(false);
	});

	test("refuses the filesystem root even when a rule exists deeper in the tree", () => {
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/",
				pathFlavor: "posix",
				defaultCwd: WORKSPACE,
				rules: [rule("/srv/app")],
			}),
		).toBe(false);
	});

	test("refuses a sibling that merely shares a textual prefix with an allowed root", () => {
		// "/remote/work-secrets" starts with "/remote/work" as a string but is not
		// inside it, so prefix matching must be path-segment aware.
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/remote/work-secrets",
				pathFlavor: "posix",
				defaultCwd: WORKSPACE,
				rules: [],
			}),
		).toBe(false);
	});

	test("allows the device-declared workspace root and its descendants", () => {
		// The picker opens here and the narrator's tools already use it as their cwd,
		// so listing inside it reveals nothing new.
		for (const path of [WORKSPACE, "/remote/work/src", "/remote/work/src/deep/nested"]) {
			expect(
				isDeviceBrowsePathWithinNarratorScope({
					requestedPath: path,
					pathFlavor: "posix",
					defaultCwd: WORKSPACE,
					rules: [],
				}),
			).toBe(true);
		}
	});

	test("allows directories covered by an enabled device-scoped rule", () => {
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/srv/app/logs",
				pathFlavor: "posix",
				defaultCwd: WORKSPACE,
				rules: [rule("/srv/app")],
			}),
		).toBe(true);
	});

	test("ignores disabled rules, which grant no execution reach either", () => {
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/srv/app/logs",
				pathFlavor: "posix",
				defaultCwd: null,
				rules: [rule("/srv/app", { enabled: false })],
			}),
		).toBe(false);
	});

	test("ignores rules written for a different path grammar", () => {
		// A Windows rule can never authorize a POSIX target, matching how
		// compileExecutionPolicy filters directory rules by target flavor.
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/srv/app",
				pathFlavor: "posix",
				defaultCwd: null,
				rules: [rule("C:\\srv\\app", { pathFlavor: "windows" })],
			}),
		).toBe(false);
	});

	test("refuses everything when the device declared no workspace root and has no rules", () => {
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/remote/work",
				pathFlavor: "posix",
				defaultCwd: null,
				rules: [],
			}),
		).toBe(false);
	});

	test("matches Windows paths case-insensitively and across separator styles", () => {
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "C:\\Work\\SRC",
				pathFlavor: "windows",
				defaultCwd: "C:\\work",
				rules: [],
			}),
		).toBe(true);
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "C:\\Windows\\System32",
				pathFlavor: "windows",
				defaultCwd: "C:\\work",
				rules: [],
			}),
		).toBe(false);
	});

	test("survives a malformed stored rule without widening the scope", () => {
		// normalizePathKey rejects an empty path; a bad row must fail closed rather
		// than throwing a 500 or being treated as a match.
		expect(
			isDeviceBrowsePathWithinNarratorScope({
				requestedPath: "/srv/app",
				pathFlavor: "posix",
				defaultCwd: null,
				rules: [rule("   ")],
			}),
		).toBe(false);
	});

	test("uses one normalized refusal message, so responses cannot probe for paths", () => {
		// The success path returns the remote absolute path and device id in errors;
		// the refusal must not vary with the requested path.
		expect(DEVICE_BROWSE_FORBIDDEN_MESSAGE).not.toContain("/");
		expect(DEVICE_BROWSE_FORBIDDEN_MESSAGE).toContain("administrators");
	});
});
