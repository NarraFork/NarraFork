import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { UpdateIndexRelease, UpdateIndexV1 } from "../../../shared/update-index-types";
import { type GithubFetch, GithubReleaseUpdater } from "../github-release-update";

const repository = "Fork/Project";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sha512 = (value: string) => createHash("sha512").update(value).digest("base64");
const commit = "a".repeat(40);
const input = {
	repository,
	channel: "stable" as const,
	platform: "linux-x64",
	currentVersion: "1.0.0",
};
const sourceIdentity = {
	source: "github" as const,
	repository: repository.toLowerCase(),
	channel: "stable" as const,
	platform: "linux-x64",
};
const raw = `https://raw.githubusercontent.com/${repository}/narrafork-updates/`;
function fixture(version = "2.0.0", notes = "Notes outside the catalog") {
	const name = `narrafork-${version}-linux-x64`;
	const payload = `binary ${version}`;
	const metadata = JSON.stringify({
		name,
		version,
		platform: "linux-x64",
		size: payload.length,
		sha256: sha256(payload),
		sha512: sha512(payload),
		commit,
	});
	const document = JSON.stringify({ schemaVersion: 1, repository, version, notes });
	const record: UpdateIndexRelease = {
		version,
		tag: `v${version}`,
		commit,
		prerelease: false,
		publishedAt: "2026-10-06T00:00:00Z",
		notes: {
			path: `notes/${version}-${sha256(document)}.json`,
			size: Buffer.byteLength(document),
			sha256: sha256(document),
		},
		files: [
			{
				name,
				platform: "linux-x64",
				size: payload.length,
				sha256: sha256(payload),
				sha512: sha512(payload),
				metadata: {
					name: `${name}.metadata.json`,
					size: Buffer.byteLength(metadata),
					sha256: sha256(metadata),
				},
				patches: [],
			},
		],
	};
	return { record, metadata, document, payload };
}
function catalog(items: ReturnType<typeof fixture>[]): UpdateIndexV1 {
	return {
		schemaVersion: 1,
		repository,
		generation: 1,
		generatedAt: "2026-10-06T00:00:00Z",
		channels: { stable: "2.0.0", beta: "2.0.0" },
		releases: items.map((item) => item.record),
	};
}
function harness(
	items = [fixture()],
	intercept?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
	const index = catalog(items);
	const calls: string[] = [];
	const fetcher: GithubFetch = async (url, init) => {
		calls.push(url);
		const intercepted = intercept?.(url, init);
		if (intercepted) return intercepted;
		if (url.toLowerCase() === `${raw}update-index-v1.json`.toLowerCase())
			return Response.json(index, { headers: { etag: '"catalog-1"' } });
		const item = items.find((item) => url.endsWith(binaryOf(item).metadata.name));
		if (item) return new Response(item.metadata);
		const note = items.find((item) => item.record.notes && url.endsWith(item.record.notes.path));
		if (note) return new Response(note.document);
		throw new Error(`Unexpected request ${url}`);
	};
	return { index, calls, fetcher, updater: new GithubReleaseUpdater(fetcher) };
}
function binaryOf(item: ReturnType<typeof fixture>) {
	const binary = item.record.files[0];
	if (!binary) throw new Error("Missing fixture binary");
	return binary;
}
function request(item = fixture()) {
	return { version: item.record.version, sha512: binaryOf(item).sha512, sourceIdentity };
}

describe("bounded anonymous GitHub catalog", () => {
	test("fork catalog uses no releases list and never fetches wide notes during check", async () => {
		const item = fixture("2.0.0", "x".repeat(900_000));
		const { updater, calls } = harness([item]);
		const result = await updater.check(input);
		expect(result.errorCode).toBeUndefined();
		expect(result.latestVersion).toBe("2.0.0");
		expect(result.releaseInfo?.notesDeferred).toBe(true);
		expect(result.notesAvailable).toBe(true);
		expect(result.releaseInfo?.releaseNotes).toBeUndefined();
		expect(calls).toHaveLength(2);
		expect(
			calls.every(
				(url) =>
					!url.includes("api.github.com") &&
					!url.includes("NarraFork/NarraFork") &&
					!url.includes("/notes/"),
			),
		).toBe(true);
	});
	test.each([
		"repository",
		"schema",
		"size",
		"json",
	])("invalid %s does not fall back", async (kind) => {
		const { updater, calls } = harness(undefined, (url) => {
			if (!url.endsWith("update-index-v1.json")) return;
			if (kind === "size") return new Response(" ".repeat(256 * 1024 + 1));
			if (kind === "json") return new Response("{");
			return Response.json({
				...catalog([fixture()]),
				...(kind === "schema" ? { schemaVersion: 2 } : { repository: "other/repo" }),
			});
		});
		expect((await updater.check(input)).errorCode).toBe("INVALID_METADATA");
		expect(calls).toHaveLength(1);
	});
	test("304 reuses validated repository catalog and recomputes platform selection", async () => {
		let requests = 0;
		const { updater } = harness(undefined, (url, init) => {
			if (url.endsWith("update-index-v1.json") && ++requests > 1) {
				expect(new Headers(init?.headers).get("if-none-match")).toBe('"catalog-1"');
				return new Response(null, { status: 304, headers: { etag: '"catalog-1"' } });
			}
		});
		expect((await updater.check(input)).updateAvailable).toBe(true);
		expect((await updater.check(input, { force: true })).updateAvailable).toBe(true);
		expect((await updater.check({ ...input, platform: "linux-arm64" })).errorCode).toBe(
			"PLATFORM_UNAVAILABLE",
		);
	});
	test("catalog cache evicts after four repositories and never forwards authentication", async () => {
		const inputs: RequestInit[] = [];
		const updater = new GithubReleaseUpdater(async (url, init) => {
			if (!url.endsWith("update-index-v1.json")) return new Response(fixture().metadata);
			inputs.push(init ?? {});
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			expect(init?.redirect).toBe("error");
			const repo = new URL(url).pathname.split("/").slice(1, 3).join("/");
			return Response.json(
				{ ...catalog([fixture()]), repository: repo },
				{ headers: { etag: `"${repo}"` } },
			);
		});
		for (let i = 0; i < 5; i++)
			expect((await updater.check({ ...input, repository: `fork/repo${i}` })).updateAvailable).toBe(
				true,
			);
		await updater.check({ ...input, repository: "fork/repo0" }, { force: true });
		expect(new Headers(inputs.at(-1)?.headers).has("if-none-match")).toBe(false);
	});
	test("channel changes select their own index target even with a shared ETag", async () => {
		const stable = fixture();
		const beta = fixture("2.0.1");
		beta.record.prerelease = true;
		const { updater, index } = harness([stable, beta]);
		index.channels.beta = "2.0.1";
		expect((await updater.check(input)).latestVersion).toBe("2.0.0");
		expect((await updater.check({ ...input, channel: "beta" })).latestVersion).toBe("2.0.1");
	});
	test("index header and streamed body deadlines fail without REST fallback", async () => {
		for (const body of [false, true]) {
			let calls = 0;
			const updater = new GithubReleaseUpdater(
				async () => {
					calls++;
					return body
						? new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(Buffer.from("{"));
									},
								}),
							)
						: new Promise<Response>(() => {});
				},
				Date.now,
				{ requestTimeoutMs: 20, checkTimeoutMs: 100 },
			);
			expect((await updater.check(input)).errorCode).toBe("TIMEOUT");
			expect(calls).toBe(1);
		}
	});
	test("304 cannot borrow another repository cache or a different ETag", async () => {
		for (const otherRepo of [false, true]) {
			let requests = 0;
			const { updater } = harness(undefined, (url) => {
				if (url.endsWith("update-index-v1.json") && ++requests > 1)
					return new Response(null, { status: 304, headers: { etag: '"wrong"' } });
			});
			await updater.check(input);
			expect(
				(
					await updater.check(
						{ ...input, repository: otherRepo ? "other/repo" : repository },
						{ force: true },
					)
				).errorCode,
			).toBe("INVALID_METADATA");
		}
	});
	test.each([
		"raw-bytes",
		"sha256",
		"sha512",
		"commit",
		"size",
	])("cross-checks sidecar %s", async (kind) => {
		const item = fixture();
		if (kind === "raw-bytes") item.metadata += " ";
		else {
			const meta = JSON.parse(item.metadata);
			meta[kind] =
				kind === "size"
					? meta.size + 1
					: kind === "sha512"
						? sha512("other")
						: "b".repeat(kind === "commit" ? 40 : 64);
			item.metadata = JSON.stringify(meta);
			binaryOf(item).metadata.size = Buffer.byteLength(item.metadata);
			binaryOf(item).metadata.sha256 = sha256(item.metadata);
		}
		expect((await harness([item]).updater.check(input)).errorCode).toBe("INVALID_METADATA");
	});
	test("raw redirects and anonymous authorization failures do not use REST", async () => {
		for (const status of [301, 401, 403, 500]) {
			const { updater, calls } = harness(
				undefined,
				() =>
					new Response(null, {
						status,
						headers: { location: "https://raw.githubusercontent.com/evil/repo/notes.json" },
					}),
			);
			expect((await updater.check(input)).updateAvailable).toBe(false);
			expect(calls).toHaveLength(1);
		}
	});
	test("only 404 enters the existing REST compatibility route", async () => {
		const { updater, calls } = harness(undefined, (url) => {
			if (url.endsWith("update-index-v1.json")) return new Response(null, { status: 404 });
			if (url.startsWith("https://api.github.com/")) return Response.json([]);
		});
		expect((await updater.check(input)).errorCode).toBe("NO_RELEASE");
		expect(calls).toHaveLength(2);
	});
	test("caller cancellation does not produce a full recommendation", async () => {
		const controller = new AbortController();
		const { updater } = harness(undefined, (url) => {
			if (url.endsWith(".metadata.json")) {
				controller.abort();
				return new Response(fixture().metadata);
			}
		});
		const result = await updater.check(input, { signal: controller.signal });
		expect(result.updateAvailable).toBe(false);
		expect(result.errorCode).toBe("CANCELLED");
	});
});

describe("indexed delta safety", () => {
	function addPatch(item: ReturnType<typeof fixture>, from: ReturnType<typeof fixture>) {
		const binary = binaryOf(item);
		const base = binaryOf(from);
		const name = `${binary.name}.from-${from.record.version}.zstd-patch`;
		const metadata = JSON.stringify({
			fromVersion: from.record.version,
			toVersion: item.record.version,
			oldFileSize: base.size,
			oldFileSha512: base.sha512,
			newFileSize: binary.size,
			newFileSha512: binary.sha512,
			stableEnd: 0,
			newTailSize: binary.size,
			patchSize: 1,
			mode: "patch-from",
		});
		binary.patches.push({
			fromVersion: from.record.version,
			name,
			size: 1,
			sha256: sha256("p"),
			metadata: {
				name: `${name}.meta.json`,
				size: Buffer.byteLength(metadata),
				sha256: sha256(metadata),
			},
		});
		return metadata;
	}
	test("validated two-step indexed chain retains hashes and never scans REST", async () => {
		const middle = fixture("1.5.0");
		const target = fixture();
		const first = addPatch(middle, fixture("1.0.0"));
		const second = addPatch(target, middle);
		const { updater, calls } = harness([target, middle], (url) =>
			url.endsWith(".meta.json")
				? new Response(url.includes("v1.5.0/") ? first : second)
				: undefined,
		);
		const result = await updater.check(input);
		expect(result.strategy).toBe("zstd");
		expect(result.downloadSize).toBe(2);
		expect(result.releaseInfo?._github?.patchChain).toHaveLength(2);
		expect(
			result.releaseInfo?._github?.patchChain?.every((step) => step.sha256 === sha256("p")),
		).toBe(true);
		expect(calls.some((url) => url.includes("api.github.com"))).toBe(false);
	});
	test.each([
		"hash",
		"size",
		"intermediate-hash",
	])("a bad %s sidecar keeps the exact full target", async (kind) => {
		const middle = fixture("1.5.0");
		const target = fixture();
		let first = addPatch(middle, fixture("1.0.0"));
		const second = addPatch(target, middle);
		if (kind === "intermediate-hash") {
			const meta = JSON.parse(first);
			meta.newFileSha512 = sha512("other");
			first = JSON.stringify(meta);
			const patch = binaryOf(middle).patches[0];
			if (!patch) throw new Error("Missing fixture patch");
			patch.metadata.sha256 = sha256(first);
		}
		if (kind === "hash") first = first.replace('"stableEnd":0', '"stableEnd":1');
		if (kind === "size") first += " ";
		const { updater } = harness([target, middle], (url) =>
			url.endsWith(".meta.json")
				? new Response(url.includes("v1.5.0/") ? first : second)
				: undefined,
		);
		const result = await updater.check(input);
		expect(result.strategy).toBe("full");
		expect(result.releaseInfo?.sha512).toBe(binaryOf(target).sha512);
		expect(result.repository).toBe(repository);
	});
	test("cancellation while probing optional patches must not become full fallback", async () => {
		const target = fixture();
		const meta = addPatch(target, fixture("1.0.0"));
		const controller = new AbortController();
		const { updater } = harness([target], (url) => {
			if (url.endsWith(".meta.json")) {
				controller.abort();
				return new Response(meta);
			}
		});
		const result = await updater.check(input, { signal: controller.signal });
		expect(result.errorCode).toBe("CANCELLED");
		expect(result.updateAvailable).toBe(false);
		expect(result.releaseInfo).toBeUndefined();
	});
});

describe("content-addressed notes", () => {
	test("loads only on demand and checks exact artifact", async () => {
		const { updater, calls } = harness();
		await updater.check(input);
		expect(calls.some((url) => url.includes("/notes/"))).toBe(false);
		expect(await updater.getNotes(request())).toEqual({ notes: "Notes outside the catalog" });
		expect(calls.filter((url) => url.includes("/notes/"))).toHaveLength(1);
		await expect(updater.getNotes({ ...request(), sha512: sha512("wrong") })).rejects.toThrow(
			"artifact",
		);
		expect(calls.filter((url) => url.includes("/notes/"))).toHaveLength(1);
	});
	test.each([
		"hash",
		"version",
		"repository",
		"oversized",
	])("rejects %s notes without invalidating binary checks", async (kind) => {
		const item = fixture();
		if (kind !== "hash" && kind !== "oversized") {
			const document = JSON.parse(item.document);
			document[kind] = kind === "version" ? "1.0.0" : "other/repo";
			item.document = JSON.stringify(document);
			item.record.notes = {
				path: `notes/2.0.0-${sha256(item.document)}.json`,
				sha256: sha256(item.document),
				size: Buffer.byteLength(item.document),
			};
		}
		const { updater } = harness([item], (url) =>
			url.includes("/notes/") && (kind === "hash" || kind === "oversized")
				? new Response(kind === "hash" ? "changed" : "x".repeat(1024 * 1024 + 1))
				: undefined,
		);
		expect((await updater.check(input)).updateAvailable).toBe(true);
		await expect(updater.getNotes(request(item))).rejects.toThrow();
		expect((await updater.check(input)).updateAvailable).toBe(true);
	});
	test("notes cancel promptly and do not leak authorization", async () => {
		const controller = new AbortController();
		const { updater } = harness(undefined, (url, init) => {
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			if (url.includes("/notes/")) {
				controller.abort();
				return new Promise<Response>(() => {});
			}
		});
		await expect(updater.getNotes(request(), controller.signal)).rejects.toThrow();
	});
});
