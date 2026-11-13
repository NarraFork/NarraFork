import { describe, expect, test } from "bun:test";
import componentVersions from "./component-versions.json";
import {
	createHelperDistributionDependencies,
	parseComponentVersions,
} from "./helper-distribution";
import {
	REMOTE_PEER_LICENSE_FILES,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
	resolveRemotePeerPlatform,
} from "./remote-peer";
import { createRemotePeerDistribution, REMOTE_PEER_DISTRIBUTION } from "./remote-peer-distribution";
import {
	parseRemotePeerDistribution,
	parseRemotePeerManifest,
	parseRemotePeerReleaseManifest,
	parseRemotePeerReleaseTag,
} from "./remote-peer-manifest";

const version = "0.1.0-alpha.1";
const expected = {
	repository: "fixture/peer",
	tag: `remote-peer-v${version}`,
	version,
	protocolVersion: 1,
};
function envelope() {
	return {
		schemaVersion: 1,
		repository: expected.repository,
		tag: expected.tag,
		commit: "a".repeat(40),
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "2026-10-27T00:00:00Z",
			platforms: Object.fromEntries(
				REMOTE_PEER_PLATFORMS.map((platform) => [
					platform,
					{
						filename: remotePeerPublishedFilename(version, platform),
						size: 256,
						sha256: "b".repeat(64),
					},
				]),
			),
		},
		licenses: REMOTE_PEER_LICENSE_FILES.map((name) => ({
			name,
			size: 256,
			sha256: "c".repeat(64),
		})),
	};
}
describe("optional remote peer component", () => {
	test("release tags preserve valid prerelease case and the complete bounded version", () => {
		for (const v of ["0.1.0-alpha.RC1", `0.1.0-${"A".repeat(58)}`]) {
			expect(parseRemotePeerReleaseTag(`remote-peer-v${v}`)).toBe(v);
			expect(
				parseRemotePeerDistribution({ version: v, tag: `remote-peer-v${v}`, protocolVersion: 1 })
					.version,
			).toBe(v);
		}
		for (const tag of [
			"remote-peer-latest",
			"executor-v0.1.0",
			"remote-peer-v0.1.0+meta",
			"remote-peer-v0.1.0-../bad",
			`remote-peer-v0.1.0-${"A".repeat(59)}`,
		])
			expect(() => parseRemotePeerReleaseTag(tag)).toThrow();
	});
	test("keeps historical executor-only pins and mandatory main dependencies unchanged", () => {
		const old = { executor: { version: "0.9.4", protocolVersion: 1 } };
		expect(parseComponentVersions(old)).toEqual(old);
		expect(createRemotePeerDistribution(parseComponentVersions(old).remotePeer)).toBeUndefined();
		expect(createHelperDistributionDependencies()).not.toHaveProperty("remotePeer");
		const declared = parseComponentVersions(componentVersions).remotePeer;
		expect(REMOTE_PEER_DISTRIBUTION).toEqual(
			declared
				? {
						version: declared.version,
						tag: `remote-peer-v${declared.version}`,
						protocolVersion: declared.protocolVersion,
					}
				: undefined,
		);
		expect(Object.isFrozen(REMOTE_PEER_DISTRIBUTION)).toBe(true);
	});
	test("rejects explicit malformed optional pins rather than app-version fallback", () => {
		for (const remotePeer of [
			null,
			{},
			{ version: "latest", protocolVersion: 1 },
			{ version, protocolVersion: 0 },
			{ version, protocolVersion: 1, url: "https://untrusted.test" },
			{ version: "0.1.0+build", protocolVersion: 1 },
		])
			expect(() =>
				parseComponentVersions({ executor: { version: "0.9.4", protocolVersion: 1 }, remotePeer }),
			).toThrow();
		expect(() =>
			parseRemotePeerDistribution({ version, protocolVersion: 1, tag: "executor-v0.1.0" }),
		).toThrow();
	});
	test("maps only supported host OS/architectures without baseline special binaries", () => {
		expect(resolveRemotePeerPlatform("win32", "x64")).toBe("windows-amd64");
		expect(resolveRemotePeerPlatform("darwin", "arm64")).toBe("darwin-arm64");
		expect(resolveRemotePeerPlatform("linux", "ia32")).toBeNull();
		expect(resolveRemotePeerPlatform("android", "arm64")).toBeNull();
	});
	test("requires complete canonical published platforms and licenses, but permits builder subsets", () => {
		const value = envelope();
		expect(parseRemotePeerReleaseManifest(value, expected).manifest.version).toBe(version);
		delete value.manifest.platforms["windows-arm64"];
		expect(parseRemotePeerManifest(value.manifest).platforms).not.toHaveProperty("windows-arm64");
		expect(() => parseRemotePeerReleaseManifest(value, expected)).toThrow(/all platforms/);
	});
	for (const [name, mutate] of [
		[
			"repository",
			(x: ReturnType<typeof envelope>) => {
				x.repository = "foreign/peer";
			},
		],
		[
			"tag",
			(x: ReturnType<typeof envelope>) => {
				x.tag = "remote-peer-latest";
			},
		],
		[
			"commit",
			(x: ReturnType<typeof envelope>) => {
				x.commit = "short";
			},
		],
		[
			"protocol",
			(x: ReturnType<typeof envelope>) => {
				x.manifest.protocolVersion = 2;
			},
		],
		[
			"filename",
			(x: ReturnType<typeof envelope>) => {
				x.manifest.platforms["linux-amd64"].filename = "../remote-peer";
			},
		],
		[
			"hash",
			(x: ReturnType<typeof envelope>) => {
				x.manifest.platforms["linux-amd64"].sha256 = "B".repeat(64);
			},
		],
		[
			"binary size",
			(x: ReturnType<typeof envelope>) => {
				x.manifest.platforms["linux-amd64"].size = 32 * 1024 * 1024 + 1;
			},
		],
		[
			"license size",
			(x: ReturnType<typeof envelope>) => {
				x.licenses[0].size = 65537;
			},
		],
		[
			"license absence",
			(x: ReturnType<typeof envelope>) => {
				x.licenses = [];
			},
		],
		[
			"license duplication",
			(x: ReturnType<typeof envelope>) => {
				x.licenses.push(x.licenses[0]);
			},
		],
	] as const)
		test(`rejects ${name} mismatch`, () => {
			const value = envelope();
			mutate(value);
			expect(() => parseRemotePeerReleaseManifest(value, expected)).toThrow();
		});
	test("rejects unknown and oversized envelopes", () => {
		expect(() =>
			parseRemotePeerReleaseManifest({ ...envelope(), unknown: true }, expected),
		).toThrow();
		expect(() =>
			parseRemotePeerReleaseManifest({ ...envelope(), unknown: "x".repeat(65537) }, expected),
		).toThrow();
		const value = envelope();
		expect(() =>
			parseRemotePeerManifest({
				...value.manifest,
				platforms: { ...value.manifest.platforms, "linux-ia32": {} },
			}),
		).toThrow();
		expect(() =>
			parseRemotePeerReleaseManifest(value, { ...expected, commit: "d".repeat(40) }),
		).toThrow();
	});
});
