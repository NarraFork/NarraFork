import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
	type GithubPatchStep,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	MAX_RELEASE_PATCH_STEPS,
} from "../../../shared/release-patch";
import { generateZstdPatchToFile } from "../../lib/zstd-patch";
import {
	createGithubUpdateDeadline,
	downloadGithubUpdateToFile,
	type GithubUpdateDependencies,
} from "../github-release-patch-apply";
import type { ReleaseInfo, UpdateProgress } from "../update-service";

const hash = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");
const repository = "Fixtures/Updates";
const binaryName = (version: string) => `narrafork-${version}-linux-x64`;
const assetUrl = (version: string, name: string) =>
	`https://github.com/${repository}/releases/download/v${version}/${name}`;
const binaries = [
	Buffer.from("fixture initial binary".repeat(256)),
	Buffer.from("fixture middle binary!".repeat(256)),
	Buffer.from("fixture final binary!!".repeat(256)),
];

function step(fromIndex: number): GithubPatchStep {
	const fromVersion = `1.0.${fromIndex}`;
	const toVersion = `1.0.${fromIndex + 1}`;
	const url = assetUrl(toVersion, `${binaryName(toVersion)}.zstd-patch`);
	return {
		fromVersion,
		toVersion,
		patchSize: 1,
		url,
		metaUrl: `${url}.meta.json`,
		meta: {
			fromVersion,
			toVersion,
			oldFileSize: binaries[fromIndex].length,
			oldFileSha512: hash(binaries[fromIndex]),
			stableEnd: 0,
			newTailSize: binaries[fromIndex + 1].length,
			patchSize: 1,
			newFileSize: binaries[fromIndex + 1].length,
			newFileSha512: hash(binaries[fromIndex + 1]),
			mode: "patch-from",
		},
	};
}

function release(chain: GithubPatchStep[]): ReleaseInfo {
	const version = chain.at(-1)?.toVersion ?? "1.0.2";
	const bytes = binaries[Number(version.split(".").at(-1))];
	const path = binaryName(version);
	return {
		source: "github",
		version,
		path,
		repository,
		releaseDate: "2026-10-06",
		sha512: hash(bytes),
		files: [{ url: path, size: bytes.length, sha512: hash(bytes) }],
		_github: { repository, downloadUrl: assetUrl(version, path), patchChain: chain },
	};
}

let directory: string;
let basePath: string;
let outputPath: string;
let fullCalls: number;
let patchCalls: number;
let fallbackCalls: number;
let progress: UpdateProgress[];
let dependencies: GithubUpdateDependencies;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "nf-github-patch-tests-"));
	basePath = join(directory, "current.binary");
	outputPath = join(directory, "download.tmp");
	await writeFile(basePath, binaries[0]);
	fullCalls = 0;
	patchCalls = 0;
	fallbackCalls = 0;
	progress = [];
	dependencies = {
		downloadPatch: async (patchStep, path, options) => {
			patchCalls++;
			options.signal.throwIfAborted();
			const bytes = Buffer.from([Number(patchStep.toVersion.split(".").at(-1))]);
			await writeFile(path, bytes, { flag: "wx" });
			options.onProgress?.(bytes.length);
		},
		downloadFull: async (info, path, options) => {
			fullCalls++;
			options.signal.throwIfAborted();
			const bytes = binaries[Number(info.version.split(".").at(-1))];
			await writeFile(path, bytes, { flag: "wx" });
			options.onProgress?.(bytes.length);
		},
		resolveZstd: async () => "/fixture/local/zstd",
		applyPatch: async (options) => {
			const marker = await readFile(options.patchFilePath);
			const bytes = binaries[marker[0]];
			await writeFile(options.outputFilePath, bytes);
			return { sizeBytes: bytes.length, sha512: hash(bytes) };
		},
		onFallback: () => {
			fallbackCalls++;
		},
	};
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function run(
	chain = [step(0), step(1)],
	signal = new AbortController().signal,
	base: string | null = basePath,
) {
	return downloadGithubUpdateToFile(
		{
			release: release(chain),
			currentVersion: "1.0.0",
			basePath: base,
			outputPath,
			signal,
			onProgress: (value) => {
				progress.push(value);
			},
		},
		dependencies,
	);
}
async function expectClean(hasOutput = true) {
	expect((await readdir(directory)).sort()).toEqual(
		hasOutput ? ["current.binary", "download.tmp"] : ["current.binary"],
	);
	expect(await readFile(basePath)).toEqual(binaries[0]);
}

describe("GitHub file-based patch execution", () => {
	test("direct patch succeeds with cumulative payload progress and cleanup", async () => {
		expect(await run([step(0)])).toBe("zstd");
		expect(await readFile(outputPath)).toEqual(binaries[1]);
		expect(fullCalls).toBe(0);
		expect(patchCalls).toBe(1);
		expect(progress.at(-1)?.bytesDownloaded).toBe(step(0).patchSize);
		await expectClean();
	});
	test("chain verifies every intermediate and reaches the full binary identity", async () => {
		expect(await run()).toBe("zstd");
		expect(await readFile(outputPath)).toEqual(binaries[2]);
		expect(fullCalls).toBe(0);
		expect(patchCalls).toBe(2);
		expect(progress.at(-1)?.bytesDownloaded).toBe(step(0).patchSize + step(1).patchSize);
		expect(progress.at(-1)?.percent).toBe(100);
		await expectClean();
	});
	test("bad base SHA512 falls back before payload or CLI lookup", async () => {
		const chain = [step(0), step(1)];
		chain[0].meta.oldFileSha512 = hash(Buffer.from("not this base"));
		dependencies.resolveZstd = async () => {
			throw new Error("must not resolve");
		};
		expect(await run(chain)).toBe("full");
		expect(patchCalls).toBe(0);
		expect(fullCalls).toBe(1);
		await expectClean();
	});
	test("missing executable / wrong initial version / disconnected identities fall back", async () => {
		for (const reason of ["noexec", "version", "link", "final", "base-size"]) {
			const chain = [step(0), step(1)];
			if (reason === "version") chain[0].fromVersion = "0.9.0";
			if (reason === "link") chain[1].meta.oldFileSha512 = hash(Buffer.from("wrong link"));
			if (reason === "final") chain[1].meta.newFileSha512 = hash(Buffer.from("wrong target"));
			if (reason === "base-size") chain[0].meta.oldFileSize++;
			expect(await run(chain, undefined, reason === "noexec" ? null : basePath)).toBe("full");
			await rm(outputPath);
		}
		expect(patchCalls).toBe(0);
		expect(fullCalls).toBe(5);
		await expectClean(false);
	});
	test("wrong decoded hash falls back immediately without downloading later steps", async () => {
		dependencies.applyPatch = async (options) => {
			const wrong = Buffer.alloc(options.meta.newFileSize, 42);
			await writeFile(options.outputFilePath, wrong);
			return { sizeBytes: wrong.length, sha512: options.meta.newFileSha512 };
		};
		expect(await run()).toBe("full");
		expect(patchCalls).toBe(1);
		expect(fullCalls).toBe(1);
		expect(await readFile(outputPath)).toEqual(binaries[2]);
		const reset = progress.findIndex(
			(value, index) =>
				index > 0 &&
				value.phase === "downloading" &&
				value.bytesDownloaded === 0 &&
				value.totalBytes === binaries[2].length,
		);
		expect(reset).toBeGreaterThan(0);
		await expectClean();
	});
	test("missing local zstd never downloads a helper; full is still available", async () => {
		dependencies.resolveZstd = async () => null;
		expect(await run()).toBe("full");
		expect(patchCalls).toBe(0);
		expect(fullCalls).toBe(1);
		await expectClean();
	});
	for (const failure of ["download", "decode", "patch-size", "output-size"]) {
		test(`${failure} failure removes private steps before Github full fallback`, async () => {
			if (failure === "download")
				dependencies.downloadPatch = async (_step, path) => {
					await writeFile(path, "partial");
					throw new Error("download failed");
				};
			if (failure === "patch-size")
				dependencies.downloadPatch = async (_step, path) => {
					await writeFile(path, "too short");
				};
			if (failure === "decode" || failure === "output-size")
				dependencies.applyPatch = async (options) => {
					await writeFile(options.outputFilePath, "partial decode");
					if (failure === "decode") throw new Error("decode failed");
					return { sizeBytes: options.meta.newFileSize, sha512: options.meta.newFileSha512 };
				};
			const full = dependencies.downloadFull;
			dependencies.downloadFull = async (...args) => {
				await expectClean(false);
				await full(...args);
			};
			expect(await run()).toBe("full");
			expect(fallbackCalls).toBe(1);
			await expectClean();
		});
	}
	test("unbounded steps, oversized metadata and foreign repo/tag fall back before patch requests", async () => {
		for (const failure of ["steps", "size", "repo", "tag", "meta-url"]) {
			const chain = [step(0), step(1)];
			if (failure === "steps")
				chain.push(...Array.from({ length: MAX_RELEASE_PATCH_STEPS }, () => step(1)));
			if (failure === "size") chain[0].patchSize = 512 * 1024 * 1024 + 1;
			if (failure === "repo") chain[0].url = chain[0].url.replace(repository, "Evil/Other");
			if (failure === "tag") chain[0].url = chain[0].url.replace("/v1.0.1/", "/v1.0.9/");
			if (failure === "meta-url") chain[0].metaUrl += "?target=other";
			expect(await run(chain)).toBe("full");
			await rm(outputPath);
		}
		expect(patchCalls).toBe(0);
		expect(fullCalls).toBe(5);
		await expectClean(false);
	});
	test("cancel during download cleans partial steps and never falls back", async () => {
		const controller = new AbortController();
		dependencies.downloadPatch = async (_step, path, options) => {
			await writeFile(path, "partial download");
			controller.abort(new Error("cancelled by user"));
			options.signal.throwIfAborted();
		};
		await expect(run(undefined, controller.signal)).rejects.toThrow("cancelled by user");
		expect(fullCalls).toBe(0);
		expect(fallbackCalls).toBe(0);
		await expectClean(false);
	});
	test("cancel during reconstruction removes output and never starts full", async () => {
		const controller = new AbortController();
		dependencies.applyPatch = async (options) => {
			await writeFile(options.outputFilePath, "partial output");
			controller.abort(new Error("cancel during decode"));
			throw controller.signal.reason;
		};
		await expect(run(undefined, controller.signal)).rejects.toThrow("cancel during decode");
		expect(fullCalls).toBe(0);
		await expectClean(false);
	});
	test("overall deadline cancels download and prevents full fallback", async () => {
		const deadline = createGithubUpdateDeadline(undefined, 30);
		dependencies.downloadPatch = async (_step, path, options) => {
			await writeFile(path, "partial");
			await new Promise<void>((_resolve, reject) => {
				if (options.signal.aborted) reject(options.signal.reason);
				else
					options.signal.addEventListener("abort", () => reject(options.signal.reason), {
						once: true,
					});
			});
		};
		try {
			await expect(run(undefined, deadline.signal)).rejects.toThrow("overall deadline");
			expect(fullCalls).toBe(0);
			await expectClean(false);
		} finally {
			deadline.dispose();
		}
	});
	test("deadline is preserved when a patch error falls back to full", async () => {
		const deadline = createGithubUpdateDeadline(undefined, 30);
		dependencies.resolveZstd = async () => null;
		dependencies.downloadFull = async (_info, _path, options) => {
			fullCalls++;
			expect(options.signal).toBe(deadline.signal);
			await new Promise<void>((_resolve, reject) => {
				if (options.signal.aborted) reject(options.signal.reason);
				else
					options.signal.addEventListener("abort", () => reject(options.signal.reason), {
						once: true,
					});
			});
		};
		try {
			await expect(run(undefined, deadline.signal)).rejects.toThrow("overall deadline");
			expect(fullCalls).toBe(1);
			await expectClean(false);
		} finally {
			deadline.dispose();
		}
	});
	test("full verification failure removes only its successfully-created destination", async () => {
		dependencies.resolveZstd = async () => null;
		dependencies.downloadFull = async (_release, path) => {
			fullCalls++;
			await writeFile(path, Buffer.alloc(binaries[2].length, 42), { flag: "wx" });
		};
		await expect(run()).rejects.toThrow("SHA512 mismatch");
		expect(fullCalls).toBe(1);
		await expectClean(false);
	});
	test("wrong final reconstruction hash still falls back before returning to the main downloader", async () => {
		const apply = dependencies.applyPatch;
		if (!apply) throw new Error("Missing fixture application");
		dependencies.applyPatch = async (options) => {
			if (options.meta.toVersion === "1.0.1") return apply(options);
			await writeFile(options.outputFilePath, Buffer.alloc(binaries[2].length, 42));
			return { sizeBytes: binaries[2].length, sha512: hash(binaries[2]) };
		};
		expect(await run()).toBe("full");
		expect(patchCalls).toBe(2);
		expect(fullCalls).toBe(1);
		expect(await readFile(outputPath)).toEqual(binaries[2]);
		await expectClean();
	});
	test("internal repository mismatch never redirects either patch or full download", async () => {
		const info = release([step(0), step(1)]);
		info.repository = "Different/Configured";
		await expect(
			downloadGithubUpdateToFile(
				{
					release: info,
					currentVersion: "1.0.0",
					basePath,
					outputPath,
					signal: new AbortController().signal,
				},
				dependencies,
			),
		).rejects.toThrow("repository does not match");
		expect(fullCalls).toBe(0);
		expect(patchCalls).toBe(0);
		await expectClean(false);
	});
	test("pre-existing destination is never overwritten or removed", async () => {
		await writeFile(outputPath, "user-owned file");
		await expect(run()).rejects.toThrow("EEXIST");
		expect(await readFile(outputPath, "utf8")).toBe("user-owned file");
		await expectClean();
	});
	test("parent cancellation propagates through deadline, including pre-aborted signals", () => {
		const parent = new AbortController();
		const deadline = createGithubUpdateDeadline(parent.signal);
		parent.abort(new Error("parent cancel"));
		expect(deadline.signal.aborted).toBe(true);
		expect(deadline.signal.reason.message).toBe("parent cancel");
		deadline.dispose();
		const alreadyAborted = createGithubUpdateDeadline(parent.signal);
		expect(alreadyAborted.signal.aborted).toBe(true);
		alreadyAborted.dispose();
	});
	for (const mode of ["dictionary", undefined] as const) {
		test(`small real legacy patch (${mode ?? "implicit"}) succeeds without resolving zstd`, async () => {
			const patchStep = step(0);
			const stableEnd = "fixture".length;
			const patch = zstdCompressSync(binaries[1].subarray(stableEnd));
			patchStep.patchSize = patch.length;
			patchStep.meta = {
				...patchStep.meta,
				mode,
				stableEnd,
				newTailSize: binaries[1].length - stableEnd,
				patchSize: patch.length,
			};
			dependencies.resolveZstd = async () => {
				throw new Error("Legacy must not probe or download CLI");
			};
			dependencies.applyPatch = undefined;
			dependencies.downloadPatch = async (_step, path, options) => {
				patchCalls++;
				await writeFile(path, patch, { flag: "wx" });
				options.onProgress?.(patch.length);
			};
			expect(await run([patchStep])).toBe("zstd");
			expect(await readFile(outputPath)).toEqual(binaries[1]);
			expect(fullCalls).toBe(0);
			expect(progress.every((value) => value.strategy === "zstd" && value.fallback === false)).toBe(
				true,
			);
			await expectClean();
		});
	}
	for (const field of ["oldFileSize", "newFileSize", "patchSize"] as const) {
		test(`oversized legacy ${field} falls back before decoding or CLI lookup`, async () => {
			const patchStep = step(0);
			patchStep.meta.mode = "dictionary";
			const info = release([patchStep]);
			patchStep.meta[field] = MAX_RELEASE_LEGACY_BYTES + 1;
			if (field !== "oldFileSize") {
				const targetSize =
					field === "patchSize" ? MAX_RELEASE_LEGACY_BYTES + 1024 : patchStep.meta.newFileSize;
				patchStep.meta.newFileSize = targetSize;
				patchStep.meta.newTailSize = targetSize;
				info.files[0].size = targetSize;
			}
			if (field === "patchSize") patchStep.patchSize = patchStep.meta.patchSize;
			let fallbackReason = "";
			dependencies.onFallback = (error) => {
				fallbackReason = String(error);
			};
			dependencies.resolveZstd = async () => {
				throw new Error("must not resolve large legacy CLI");
			};
			dependencies.applyPatch = async () => {
				throw new Error("must not decode large legacy");
			};
			dependencies.downloadFull = async () => {
				fullCalls++;
				throw new Error("fixture full fallback reached");
			};
			await expect(
				downloadGithubUpdateToFile(
					{
						release: info,
						currentVersion: "1.0.0",
						basePath,
						outputPath,
						signal: new AbortController().signal,
					},
					dependencies,
				),
			).rejects.toThrow("fixture full fallback reached");
			expect(fallbackReason).toContain("memory budget");
			expect(fullCalls).toBe(1);
			expect(patchCalls).toBe(0);
			await expectClean(false);
		});
	}
	test("legacy verifies actual base again after download, before reading it into decoder buffers", async () => {
		const patchStep = step(0);
		patchStep.meta.mode = "dictionary";
		const download = dependencies.downloadPatch;
		const apply = dependencies.applyPatch;
		if (!apply) throw new Error("Missing fixture decoder");
		let decodeCalls = 0;
		dependencies.applyPatch = async (options) => {
			decodeCalls++;
			return apply(options);
		};
		dependencies.downloadPatch = async (...args) => {
			await download(...args);
			await writeFile(basePath, "base changed during download");
		};
		expect(await run([patchStep])).toBe("full");
		expect(decodeCalls).toBe(0);
		expect(fullCalls).toBe(1);
		await writeFile(basePath, binaries[0]);
		await expectClean();
	});
	test("mixed small legacy / patch-from chain resolves the local CLI only once", async () => {
		const chain = [step(0), step(1)];
		chain[0].meta.mode = "dictionary";
		let resolverCalls = 0;
		dependencies.resolveZstd = async () => {
			resolverCalls++;
			return "/fixture/local/zstd";
		};
		expect(await run(chain)).toBe("zstd");
		expect(resolverCalls).toBe(1);
		expect(fullCalls).toBe(0);
		await expectClean();
	});
	for (const extra of [0, 1]) {
		test(`patch chain ${extra ? "larger than" : "equal to"} full falls back before any patch request`, async () => {
			const chain = [step(0), step(1)];
			chain[1].patchSize = binaries[2].length - chain[0].patchSize + extra;
			chain[1].meta.patchSize = chain[1].patchSize;
			expect(await run(chain)).toBe("full");
			expect(patchCalls).toBe(0);
			expect(fullCalls).toBe(1);
			expect(progress.at(-1)?.strategy).toBe("full");
			expect(progress.at(-1)?.fallback).toBe(true);
			await expectClean();
		});
	}
	test("combined patches over 512MiB are rejected even when individually valid and smaller than full", async () => {
		const chain = [step(0), step(1)];
		const info = release(chain);
		info.files[0].size = 768 * 1024 * 1024;
		chain[1].meta.newFileSize = info.files[0].size;
		chain[1].meta.newTailSize = info.files[0].size;
		for (const item of chain) {
			item.patchSize = Math.floor(MAX_RELEASE_PATCH_BYTES / 2) + 1;
			item.meta.patchSize = item.patchSize;
		}
		let fallbackReason = "";
		dependencies.onFallback = (error) => {
			fallbackReason = String(error);
		};
		dependencies.downloadFull = async () => {
			fullCalls++;
			throw new Error("fixture full fallback reached");
		};
		await expect(
			downloadGithubUpdateToFile(
				{
					release: info,
					currentVersion: "1.0.0",
					basePath,
					outputPath,
					signal: new AbortController().signal,
				},
				dependencies,
			),
		).rejects.toThrow("fixture full fallback reached");
		expect(fallbackReason).toContain("total-byte budget");
		expect(patchCalls).toBe(0);
		expect(fullCalls).toBe(1);
		await expectClean(false);
	});
	test("full-only is marked full without a fallback warning", async () => {
		expect(await run([])).toBe("full");
		expect(progress.every((value) => value.strategy === "full" && value.fallback === false)).toBe(
			true,
		);
		await expectClean();
	});
	const zstd = Bun.which("zstd");
	test.skipIf(!zstd)("small generated patch uses the actual async zstd application", async () => {
		const newPath = join(directory, "target.fixture");
		const patchPath = join(directory, "source.patch");
		await writeFile(newPath, binaries[1]);
		const meta = await generateZstdPatchToFile({
			oldFilePath: basePath,
			newFilePath: newPath,
			patchOutputPath: patchPath,
			fromVersion: "1.0.0",
			toVersion: "1.0.1",
			zstdPath: zstd ?? undefined,
		});
		const patchStep = step(0);
		patchStep.meta = meta;
		patchStep.patchSize = meta.patchSize;
		dependencies.resolveZstd = async () => zstd;
		dependencies.applyPatch = undefined;
		dependencies.downloadPatch = async (_step, path) => {
			await writeFile(path, await readFile(patchPath), { flag: "wx" });
		};
		expect(await run([patchStep])).toBe("zstd");
		expect(await readFile(outputPath)).toEqual(binaries[1]);
		expect(fullCalls).toBe(0);
		await rm(newPath);
		await rm(patchPath);
		await expectClean();
	});
});
