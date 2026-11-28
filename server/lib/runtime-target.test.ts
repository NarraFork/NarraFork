import { expect, test } from "bun:test";
import { isCompiledModuleUrl, isCompiledRuntime } from "./runtime-target";

test("compiled module detection accepts Bun virtual roots and encoded Windows boundaries", () => {
	for (const url of [
		"file:///$bunfs/root/narrafork",
		"/$bunfs/root/narrafork",
		"file:///%24bunfs/root/narrafork",
		"file:///C:/%7EBUN/root/narrafork.exe",
		"file:///C:/%7eBUN%2froot/narrafork.exe",
		"file:///C:%5C%7EBUN%5Croot%5Cnarrafork.exe",
		"file:///C:/~BUN/root/narrafork.exe",
		"file:\\\\C:\\~BUN\\root\\narrafork.exe",
		"C:/~BUN/root/narrafork.exe",
		"C:\\~BUN\\root\\narrafork.exe",
		"C:%5C%7EBUN%5Croot%5Cnarrafork.exe",
		"/~BUN/root/narrafork.exe",
		"~BUN/root/narrafork.exe",
		"~BUN\\root\\narrafork.exe",
	]) {
		expect(isCompiledModuleUrl(url)).toBe(true);
	}
});

test("source paths, lookalike segments, remote URLs and queries are not compiled modules", () => {
	for (const url of [
		import.meta.url,
		"file:///project/server/lib/runtime-target.ts",
		"file:///C:/workspace%20name/server/main.ts",
		"file:///project/$bunfs/root/source.ts",
		"file:///C:/project/~BUN/root/source.ts",
		"file:///C:/project/%7EBUN/root/source.ts",
		"C:\\project\\~BUN\\root\\source.ts",
		"file:///$bunfs-backup/root/source.ts",
		"file:///C:/~BUNNER/root/source.ts",
		"file:///C:/%7EBUN-tools/root/source.ts",
		"file:///C:/%257EBUN/root/source.ts",
		"file:///project/source.ts?path=/$bunfs/root/narrafork",
		"file:///project/source.ts#/%7EBUN/root/narrafork",
		"C:\\project\\source.ts?path=\\~BUN\\root\\narrafork",
		"https://example.com/$bunfs/root/narrafork",
		"file://remote-host/~BUN/root/narrafork",
		"file:///C:/%7EBUN%2G/root/narrafork.exe",
		"~BUN-not-a-root/root/narrafork",
		"",
	]) {
		expect(isCompiledModuleUrl(url)).toBe(false);
	}
	expect(isCompiledRuntime()).toBe(false);
});
