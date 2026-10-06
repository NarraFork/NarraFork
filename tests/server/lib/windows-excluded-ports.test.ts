import { describe, expect, it } from "bun:test";
import {
	findExcludingRange,
	formatPortRanges,
	isPortExcluded,
	MAX_TCP_PORT,
	nextAllowedPort,
	parseExcludedPortRanges,
	readWindowsExcludedPortRanges,
	readWindowsExcludedPortRangesAsync,
} from "../../../server/lib/windows-excluded-ports";

// Verbatim output from the field report (Chinese Windows, PowerShell 7.6.4). The
// default port 7778 sits inside 7681-7780 and every consecutive fallback port up
// to 7788 sits inside 7781-7880 — the exact case that made NarraFork unstartable.
const CHINESE_NETSH_OUTPUT = `
协议 tcp 端口排除范围

开始端口    结束端口
----------    --------
      5357        5357
      5985        5985
      7681        7780
      7781        7880
      8054        8153
      8554        8653
     14488       14587
     14588       14687
     14812       14911
     15001       15100
     29636       29735
     29744       29843
     29917       30016
     47001       47001
     50000       50059     *

* - 管理的端口排除。
`;

const ENGLISH_NETSH_OUTPUT = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      1024        1123
      7681        7780

* - Administered port exclusions.
`;

describe("parseExcludedPortRanges", () => {
	it("parses localised Chinese netsh output and merges adjacent blocks", () => {
		const ranges = parseExcludedPortRanges(CHINESE_NETSH_OUTPUT);

		// 7681-7780 and 7781-7880 are adjacent, so they collapse into one region.
		expect(ranges).toContainEqual({ start: 7681, end: 7880 });
		// 14488-14587 + 14588-14687 merge; 14812-14911 stays separate.
		expect(ranges).toContainEqual({ start: 14488, end: 14687 });
		expect(ranges).toContainEqual({ start: 14812, end: 14911 });
		// Single-port ranges survive.
		expect(ranges).toContainEqual({ start: 5357, end: 5357 });
		expect(ranges).toContainEqual({ start: 47001, end: 47001 });
		// The administered exclusion marked with `*` is still a real exclusion.
		expect(ranges).toContainEqual({ start: 50000, end: 50059 });
	});

	it("parses English netsh output", () => {
		expect(parseExcludedPortRanges(ENGLISH_NETSH_OUTPUT)).toEqual([
			{ start: 1024, end: 1123 },
			{ start: 7681, end: 7780 },
		]);
	});

	it("returns ranges sorted ascending", () => {
		const ranges = parseExcludedPortRanges("  9000 9100\n  1000 1100\n  5000 5100\n");
		expect(ranges).toEqual([
			{ start: 1000, end: 1100 },
			{ start: 5000, end: 5100 },
			{ start: 9000, end: 9100 },
		]);
	});

	it("merges overlapping ranges", () => {
		expect(parseExcludedPortRanges("  1000 1100\n  1050 1200\n")).toEqual([
			{ start: 1000, end: 1200 },
		]);
	});

	it("ignores headers, separators, legends and blank lines", () => {
		expect(parseExcludedPortRanges(ENGLISH_NETSH_OUTPUT)).toHaveLength(2);
		expect(parseExcludedPortRanges("协议 tcp 端口排除范围\n\n----------    --------\n")).toEqual(
			[],
		);
	});

	it("rejects malformed and out-of-domain rows", () => {
		// Reversed bounds, port 0, above 65535, single column, and non-numeric noise.
		const output = `
      7780        7681
         0          10
      70000       70100
      1234
      abc         def
      2000        2100
`;
		expect(parseExcludedPortRanges(output)).toEqual([{ start: 2000, end: 2100 }]);
	});

	it("returns an empty list for empty input", () => {
		expect(parseExcludedPortRanges("")).toEqual([]);
	});
});

describe("findExcludingRange / isPortExcluded", () => {
	const ranges = parseExcludedPortRanges(CHINESE_NETSH_OUTPUT);

	it("detects the reported default port as reserved", () => {
		expect(findExcludingRange(7778, ranges)).toEqual({ start: 7681, end: 7880 });
		expect(isPortExcluded(7778, ranges)).toBe(true);
	});

	it("treats range bounds as inclusive", () => {
		expect(isPortExcluded(7681, ranges)).toBe(true);
		expect(isPortExcluded(7880, ranges)).toBe(true);
		expect(isPortExcluded(7680, ranges)).toBe(false);
		expect(isPortExcluded(7881, ranges)).toBe(false);
	});

	it("reports ports outside every range as usable", () => {
		expect(isPortExcluded(7779, ranges)).toBe(true);
		expect(isPortExcluded(41221, ranges)).toBe(false);
		expect(findExcludingRange(41221, ranges)).toBeUndefined();
	});

	it("excludes nothing when no ranges are known", () => {
		expect(isPortExcluded(7778, [])).toBe(false);
	});
});

describe("nextAllowedPort", () => {
	const ranges = parseExcludedPortRanges(CHINESE_NETSH_OUTPUT);

	it("jumps past the whole merged reserved region in one step", () => {
		// The old behaviour probed 7778..7788 and failed on every one; the fix must
		// land past the end of BOTH adjacent blocks.
		expect(nextAllowedPort(7778, ranges)).toBe(7881);
	});

	it("returns the port unchanged when it is not reserved", () => {
		expect(nextAllowedPort(7000, ranges)).toBe(7000);
		expect(nextAllowedPort(7778, [])).toBe(7778);
	});

	it("skips consecutive regions that are separated by a single free port", () => {
		const gapRanges = parseExcludedPortRanges("  100 200\n  202 300\n");
		expect(nextAllowedPort(150, gapRanges)).toBe(201);
		expect(nextAllowedPort(202, gapRanges)).toBe(301);
	});

	it("skips a chain of overlapping regions", () => {
		const chained = parseExcludedPortRanges("  100 200\n  150 400\n  380 500\n");
		expect(nextAllowedPort(120, chained)).toBe(501);
	});

	it("returns null when the jump runs past the TCP port space", () => {
		const tailRanges = parseExcludedPortRanges(`  65000 ${MAX_TCP_PORT}\n`);
		expect(nextAllowedPort(65100, tailRanges)).toBeNull();
	});

	it("returns null for a starting port beyond the TCP port space", () => {
		expect(nextAllowedPort(MAX_TCP_PORT + 1, ranges)).toBeNull();
	});

	it("can still return the last usable port", () => {
		const tailRanges = parseExcludedPortRanges(`  65000 ${MAX_TCP_PORT - 1}\n`);
		expect(nextAllowedPort(65100, tailRanges)).toBe(MAX_TCP_PORT);
	});
});

describe("formatPortRanges", () => {
	it("formats ranges for log and console output", () => {
		expect(formatPortRanges(parseExcludedPortRanges(ENGLISH_NETSH_OUTPUT))).toBe(
			"1024-1123, 7681-7780",
		);
	});

	it("formats an empty list as an empty string", () => {
		expect(formatPortRanges([])).toBe("");
	});
});

describe("readWindowsExcludedPortRangesAsync", () => {
	it("fails open on unavailable, malformed, or throwing readers", async () => {
		expect(await readWindowsExcludedPortRangesAsync(async () => null)).toEqual([]);
		expect(await readWindowsExcludedPortRangesAsync(async () => "Access denied")).toEqual([]);
		expect(
			await readWindowsExcludedPortRangesAsync(async () => {
				throw new Error("netsh timed out");
			}),
		).toEqual([]);
	});

	it("reads current ranges on Windows and never invokes the reader elsewhere", async () => {
		let calls = 0;
		const ranges = await readWindowsExcludedPortRangesAsync(async () => {
			calls++;
			return "1356 1455\n1456 1555\n";
		});
		if (process.platform === "win32") {
			expect(calls).toBe(1);
			expect(ranges).toEqual([{ start: 1356, end: 1555 }]);
		} else {
			expect(calls).toBe(0);
			expect(ranges).toEqual([]);
		}
	});
});

describe("readWindowsExcludedPortRanges", () => {
	it("fails open when the netsh command is unavailable", () => {
		// Non-Windows hosts short-circuit to []; Windows hosts hit the null reader.
		expect(readWindowsExcludedPortRanges(() => null)).toEqual([]);
	});

	it("fails open when netsh output cannot be parsed", () => {
		expect(
			readWindowsExcludedPortRanges(() => "The requested operation requires elevation."),
		).toEqual([]);
	});

	it("never spawns a process on non-Windows hosts", () => {
		let called = false;
		const ranges = readWindowsExcludedPortRanges(() => {
			called = true;
			return CHINESE_NETSH_OUTPUT;
		});
		if (process.platform === "win32") {
			expect(called).toBe(true);
			expect(ranges).toContainEqual({ start: 7681, end: 7880 });
		} else {
			expect(called).toBe(false);
			expect(ranges).toEqual([]);
		}
	});
});
