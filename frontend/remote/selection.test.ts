import { expect, mock, test } from "bun:test";
import {
	REMOTE_FRONTEND_CAPABILITY,
	type RemoteBackendIdentity,
} from "@shared/remote-access/application";
import { computeRemoteFrontendBuildId } from "@shared/remote-access/frontend-manifest";
import { integrity, sameOriginStaticUrl, selectRemoteBuild, sha256 } from "./selection";

const origin = "https://instance.test";
const identity: RemoteBackendIdentity = {
	nfVersion: "0.1.0",
	sourceCommit: "a".repeat(40),
	repository: "owner/nf",
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: ["projects"],
};
function manifest(version: string, buildId: string) {
	return {
		schemaVersion: 1,
		repository: identity.repository,
		nfVersion: version,
		sourceCommit: identity.sourceCommit,
		buildId,
		capability: REMOTE_FRONTEND_CAPABILITY,
		entry: "mount.js",
		bootstrap: "bootstrap.js",
		css: [],
		files: [
			{ path: "mount.js", size: 10, sha256: "c".repeat(64) },
			{ path: "bootstrap.js", size: 10, sha256: "d".repeat(64) },
		],
		archive: {
			name: `narrafork-${version}-remote-frontend.tar.gz`,
			size: 20,
			sha256: "e".repeat(64),
		},
	};
}
async function fixture() {
	const builds = [manifest("0.1.0", "a".repeat(64)), manifest("0.2.0", "b".repeat(64))];
	for (const build of builds) build.buildId = await computeRemoteFrontendBuildId(build);
	const entries = await Promise.all(
		builds.map(async (build) => ({
			buildId: build.buildId,
			repository: build.repository,
			nfVersion: build.nfVersion,
			bootstrapAbi: 1,
			apiEpoch: 1,
			wireVersion: 2,
			manifestPath: `/remote/frontends/${build.buildId}/manifest.json`,
			manifestSha256: await sha256(new TextEncoder().encode(JSON.stringify(build))),
			disabled: false,
		})),
	);
	const catalog = { schemaVersion: 1, bootstrapAbi: 1, entries };
	const fetcher = mock(async (input: RequestInfo | URL) => {
		const path = new URL(String(input), origin).pathname;
		if (path === "/remote/catalog.json") return Response.json(catalog);
		const entry = entries.find((item) => item.manifestPath === path);
		const build = builds.find((item) => item.buildId === entry?.buildId);
		return build ? Response.json(build) : new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { builds, entries, catalog, fetcher };
}
test("two installed versions select their exact immutable entry, not the newest", async () => {
	const { fetcher, builds } = await fixture();
	const old = await selectRemoteBuild(identity, origin, fetcher);
	const newer = await selectRemoteBuild({ ...identity, nfVersion: "0.2.0" }, origin, fetcher);
	expect(old.entryUrl).toBe(`${origin}/remote/frontends/${builds[0].buildId}/mount.js`);
	expect(newer.entryUrl).toBe(`${origin}/remote/frontends/${builds[1].buildId}/mount.js`);
});
test("unknown, disabled and ambiguous versions fail closed", async () => {
	const f = await fixture();
	await expect(
		selectRemoteBuild({ ...identity, nfVersion: "0.3.0" }, origin, f.fetcher),
	).rejects.toThrow();
	f.entries[0].disabled = true;
	await expect(selectRemoteBuild(identity, origin, f.fetcher)).rejects.toThrow();
	f.entries[0].disabled = false;
	f.entries.push({ ...f.entries[0], buildId: "f".repeat(64) });
	await expect(selectRemoteBuild(identity, origin, f.fetcher)).rejects.toThrow();
});
test("bad manifest digest prevents executable loading", async () => {
	const f = await fixture();
	f.entries[0].manifestSha256 = "0".repeat(64);
	await expect(selectRemoteBuild(identity, origin, f.fetcher)).rejects.toThrow(
		"REMOTE_MANIFEST_HASH_MISMATCH",
	);
});
test("cross-origin, traversal and query-shaped static paths are rejected", () => {
	for (const path of [
		"https://evil.test/mount.js",
		"//evil.test/mount.js",
		"/remote/../api/health",
		"/remote/%2e%2e/api",
		"/remote/mount.js?next=/api",
		"/remote/mount.js#x",
	])
		expect(() => sameOriginStaticUrl(path, origin)).toThrow();
	expect(sameOriginStaticUrl("/remote/catalog.json", origin).href).toBe(
		`${origin}/remote/catalog.json`,
	);
});
test("SRI strings are SHA-256 rather than unchecked executable URLs", () => {
	expect(integrity("00".repeat(32))).toBe(`sha256-${btoa("\0".repeat(32))}`);
	expect(() => integrity("wrong")).toThrow();
});
