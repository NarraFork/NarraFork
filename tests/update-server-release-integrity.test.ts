import { describe, expect, test } from "bun:test";
import {
	getPatchSourceMismatch,
	getReleaseIdentityMismatch,
} from "../update-server/lib/release-integrity";
import type { PlatformFileInfo, ZstdPatchMeta } from "../update-server/types";

const sourcePlatform: PlatformFileInfo = {
	filename: "narrafork-0.5.10-linux-x64",
	size: 100,
	sha512: "published-source-sha",
	hasZstdPatch: true,
};

function patchMeta(overrides: Partial<ZstdPatchMeta> = {}): ZstdPatchMeta {
	return {
		fromVersion: "0.5.10",
		toVersion: "0.5.11",
		oldFileSize: 100,
		oldFileSha512: "published-source-sha",
		stableEnd: 0,
		newTailSize: 120,
		patchSize: 20,
		newFileSize: 120,
		newFileSha512: "target-sha",
		...overrides,
	};
}

describe("update server release integrity", () => {
	test("accepts a patch generated from the published source binary", () => {
		expect(getPatchSourceMismatch(patchMeta(), sourcePlatform)).toBeNull();
	});

	test("rejects missing or mismatched source identities", () => {
		expect(
			getPatchSourceMismatch(
				patchMeta({ oldFileSize: undefined, oldFileSha512: undefined }),
				sourcePlatform,
			),
		).toContain("must include");
		expect(getPatchSourceMismatch(patchMeta({ oldFileSize: 101 }), sourcePlatform)).toContain(
			"does not match",
		);
		expect(getPatchSourceMismatch(patchMeta(), undefined)).toContain("source platform is missing");
	});

	test("keeps an existing release immutable by default", () => {
		const existing = { filename: "narrafork-0.5.11-linux-x64", size: 120, sha512: "a" };
		expect(getReleaseIdentityMismatch(existing, existing)).toBeNull();
		expect(getReleaseIdentityMismatch(existing, { ...existing, sha512: "b" })).toContain(
			"existing filename",
		);
	});
});
