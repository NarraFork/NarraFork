import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextChanges } from "@shared/prefix-context";

// Install the real filesystem spy before the singleton captures its stat reader.
const realStat = fsPromises.stat;
const statSpy = spyOn(fsPromises, "stat");
const { InstructionFileCache } = await import("../instruction-file-cache");
const { readFileCapped } = await import("../read-file-capped");
const { buildEffectiveSystemPrompt } = await import("../../services/narrator-prompt");
afterAll(() => statSpy.mockRestore());

function fixture(options: { maxEntries?: number; maxBytes?: number; ttlMs?: number } = {}) {
	let clock = 0;
	let revision = 1;
	let exists = true;
	let reads = 0;
	let text = "first";
	const cache = new InstructionFileCache({
		...options,
		now: () => clock,
		statFile: async () => {
			if (!exists) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return {
				size: text.length,
				mtimeMs: revision,
				ctimeMs: revision,
				ino: 1,
				dev: 1,
				isFile: () => true,
			};
		},
		readFile: async (_path, maxBytes) => {
			reads++;
			return {
				content: text.slice(0, maxBytes),
				truncated: maxBytes !== undefined && text.length > maxBytes,
			};
		},
	});
	return {
		cache,
		reads: () => reads,
		change: (value: string) => {
			text = value;
			revision++;
		},
		exists: (value: boolean) => {
			exists = value;
		},
		advance: (milliseconds: number) => {
			clock += milliseconds;
		},
	};
}

describe("static instruction file cache", () => {
	test("unchanged passes stat but do not read/decode the same file again", async () => {
		const f = fixture();
		expect(await f.cache.read("CLAUDE.md")).toEqual({ content: "first", truncated: false });
		for (let pass = 0; pass < 20; pass++) await f.cache.read("CLAUDE.md");
		expect(f.reads()).toBe(1);
	});

	test("same-size edits invalidate immediately, and returned wrappers are detached", async () => {
		const f = fixture();
		const first = await f.cache.read("AGENTS.md");
		if (first) first.content = "caller mutation";
		expect((await f.cache.read("AGENTS.md"))?.content).toBe("first");
		f.change("other");
		expect((await f.cache.read("AGENTS.md"))?.content).toBe("other");
		expect(f.reads()).toBe(2);
	});

	test("does not cache missing files or resurrect a deleted file", async () => {
		const f = fixture();
		f.exists(false);
		expect(await f.cache.read("AGENTS.override.md")).toBeNull();
		f.exists(true);
		expect((await f.cache.read("AGENTS.override.md"))?.content).toBe("first");
		f.exists(false);
		expect(await f.cache.read("AGENTS.override.md")).toBeNull();
		expect(f.cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	for (const code of ["EIO", "ESTALE", "EACCES"]) {
		for (const phase of ["before", "after"] as const) {
			test(`propagates ${code} during ${phase}-read stat without serving cached bytes`, async () => {
				const cwd = await mkdtemp(join(tmpdir(), "narrafork-instruction-error-"));
				const path = join(cwd, "AGENTS.md");
				const cache = new InstructionFileCache({ ttlMs: 0 });
				const error = Object.assign(new Error(code), { code });
				try {
					await writeFile(path, "known instructions");
					expect((await cache.read(path))?.content).toBe("known instructions");
					if (phase === "after") statSpy.mockImplementationOnce(realStat);
					statSpy.mockRejectedValueOnce(error);
					await expect(cache.read(path)).rejects.toBe(error);
					expect((await cache.read(path))?.content).toBe("known instructions");
				} finally {
					statSpy.mockImplementation(realStat);
					await rm(cwd, { recursive: true, force: true });
				}
			});
		}
	}

	for (const code of ["EIO", "ESTALE", "EACCES", "ENOENT", "ENOTDIR"]) {
		test(`capped instruction reads classify stat ${code}`, async () => {
			const cwd = await mkdtemp(join(tmpdir(), "narrafork-instruction-capped-error-"));
			const path = join(cwd, "AGENTS.md");
			const error = Object.assign(new Error(code), { code });
			try {
				await writeFile(path, "known instructions");
				statSpy.mockRejectedValueOnce(error);
				const direct = readFileCapped(path, 5);
				if (code === "ENOENT" || code === "ENOTDIR") await expect(direct).resolves.toBeNull();
				else await expect(direct).rejects.toBe(error);
				const cache = new InstructionFileCache();
				statSpy.mockImplementationOnce(realStat).mockRejectedValueOnce(error);
				const cached = cache.read(path, 5);
				if (code === "ENOENT" || code === "ENOTDIR") await expect(cached).resolves.toBeNull();
				else await expect(cached).rejects.toBe(error);
				expect(await cache.read(path, 5)).toEqual({ content: "known", truncated: true });
			} finally {
				statSpy.mockImplementation(realStat);
				await rm(cwd, { recursive: true, force: true });
			}
		});
	}

	for (const code of ["ENOENT", "ENOTDIR"]) {
		test(`treats ${code} as missing and evicts cached bytes`, async () => {
			const cwd = await mkdtemp(join(tmpdir(), "narrafork-instruction-missing-"));
			const path = join(cwd, "AGENTS.md");
			const cache = new InstructionFileCache();
			try {
				await writeFile(path, "known instructions");
				await cache.read(path);
				expect(cache.stats().entries).toBe(1);
				statSpy.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
				expect(await cache.read(path)).toBeNull();
				expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
			} finally {
				statSpy.mockImplementation(realStat);
				await rm(cwd, { recursive: true, force: true });
			}
		});
	}

	test("keeps separate limits and truncation results", async () => {
		const f = fixture();
		expect(await f.cache.read("AGENTS.md", 2)).toEqual({ content: "fi", truncated: true });
		expect(await f.cache.read("AGENTS.md", 5)).toEqual({ content: "first", truncated: false });
		expect(f.reads()).toBe(2);
		expect(await f.cache.read("AGENTS.md", 200_001)).toEqual({
			content: "first",
			truncated: false,
		});
		expect(await f.cache.read("AGENTS.md")).toEqual({ content: "first", truncated: false });
		expect(f.reads()).toBe(4);
		for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(f.cache.read("AGENTS.md", invalid)).rejects.toBeInstanceOf(RangeError);
		}
	});

	test("expires unchanged content and respects entry/decoded-byte bounds", async () => {
		const f = fixture({ maxEntries: 2, maxBytes: 600, ttlMs: 10 });
		await f.cache.read("one");
		await f.cache.read("two");
		await f.cache.read("three");
		expect(f.cache.stats().entries).toBe(2);
		expect(f.cache.stats().bytes).toBeLessThanOrEqual(600);
		f.advance(11);
		await f.cache.read("three");
		expect(f.reads()).toBe(4);
		f.cache.clear();
		expect(f.cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	test("does not retain an entry larger than the memory budget", async () => {
		const f = fixture({ maxBytes: 10 });
		expect((await f.cache.read("one"))?.content).toBe("first");
		expect(f.cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	test("oversized reads do not evict unrelated cache entries", async () => {
		const f = fixture({ maxBytes: 600 });
		await f.cache.read("small");
		const before = f.cache.stats();
		f.change("x".repeat(1000));
		expect((await f.cache.read("large"))?.content).toBe("x".repeat(1000));
		expect(f.cache.stats()).toEqual(before);
	});

	test("reads complete multi-chunk UTF-8 files above the residency budget", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "narrafork-instruction-full-"));
		const path = join(cwd, "AGENTS.md");
		const content = "你好😀\n".repeat(40_000);
		const cache = new InstructionFileCache({ maxBytes: 1024 });
		try {
			await writeFile(path, content);
			expect(await cache.read(path)).toEqual({ content, truncated: false });
			expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
			expect(await cache.read(path, 3)).toEqual({ content: "你", truncated: true });
			expect(cache.stats().entries).toBe(1);
			// The cached explicit prefix must never stand in for a full default read.
			expect(await cache.read(path)).toEqual({ content, truncated: false });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("shares concurrent reads but a changed signature cannot cache old facts", async () => {
		let revision = 1;
		let reads = 0;
		let release: ((value: { content: string; truncated: boolean }) => void) | undefined;
		const cache = new InstructionFileCache({
			statFile: async () => ({
				size: 5,
				mtimeMs: revision,
				ctimeMs: revision,
				ino: 1,
				dev: 1,
				isFile: () => true,
			}),
			readFile: () => {
				reads++;
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		});
		const a = cache.read("AGENTS.md");
		const b = cache.read("AGENTS.md");
		await Promise.resolve();
		expect(reads).toBe(1);
		revision++;
		release?.({ content: "first", truncated: false });
		await Promise.all([a, b]);
		expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});
});

test("an instruction stat EIO aborts collection without publishing a deletion or fallback", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "narrafork-instruction-recovery-"));
	const path = join(cwd, "AGENTS.override.md");
	const options = { basePrompt: null, cwd, locale: "en" as const };
	const error = Object.assign(new Error("transient stat failure"), { code: "EIO" });
	try {
		await writeFile(join(cwd, "AGENTS.md"), "lower-priority instructions");
		await writeFile(path, "authoritative instructions");
		const first = await buildEffectiveSystemPrompt(options);
		const baseline = new Map(first.parts.map((part) => [part.key, part.text]));
		expect(baseline.get("instructions.project")).toContain("authoritative instructions");
		const calls = statSpy.mock.calls.length;
		statSpy.mockRejectedValueOnce(error);
		await expect(buildEffectiveSystemPrompt(options)).rejects.toBe(error);
		expect(statSpy.mock.calls[calls]?.[0]).toBe(path);
		const recovered = await buildEffectiveSystemPrompt(options);
		expect(contextChanges(baseline, recovered.parts)).toEqual([]);
		await rm(path);
		const missing = await buildEffectiveSystemPrompt(options);
		expect(contextChanges(baseline, missing.parts)).toEqual([
			{
				key: "instructions.project",
				value: "## Project Instructions\n\nlower-priority instructions",
			},
		]);
		await rm(join(cwd, "AGENTS.md"));
		const removed = await buildEffectiveSystemPrompt(options);
		expect(contextChanges(baseline, removed.parts)).toEqual([
			{ key: "instructions.project", value: null },
		]);
	} finally {
		statSpy.mockImplementation(realStat);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a higher-priority file appearing/deleting changes the next prompt, without caching runtime state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "narrafork-instruction-cache-"));
	const options = { basePrompt: "first base", cwd, locale: "en" as const };
	try {
		await writeFile(join(cwd, "CLAUDE.md"), "unique legacy instruction");
		const first = await buildEffectiveSystemPrompt(options);
		expect(first.prompt).toContain("unique legacy instruction");
		await writeFile(join(cwd, "AGENTS.md"), "unique standard instruction");
		const standard = await buildEffectiveSystemPrompt(options);
		expect(standard.prompt).toContain("unique standard instruction");
		expect(standard.prompt).not.toContain("unique legacy instruction");
		await writeFile(join(cwd, "AGENTS.override.md"), "unique override instruction");
		const override = await buildEffectiveSystemPrompt({ ...options, basePrompt: "new base" });
		expect(override.prompt).toContain("unique override instruction");
		expect(override.prompt).toContain("new base");
		expect(override.prompt).not.toContain("first base");
		await rm(join(cwd, "AGENTS.override.md"));
		const restored = await buildEffectiveSystemPrompt(options);
		expect(restored.prompt).toContain("unique standard instruction");
		expect(restored.prompt).not.toContain("unique override instruction");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
