import { describe, expect, it } from "bun:test";
import {
	buildTransferProgressPayload,
	formatTransferBytes,
	formatTransferDuration,
	formatTransferProgress,
	formatTransferSummary,
	transferProgressFigures,
} from "../transfer-progress";

const MB = 1024 * 1024;

describe("formatTransferBytes", () => {
	it("scales through the units", () => {
		expect(formatTransferBytes(512)).toBe("512 B");
		expect(formatTransferBytes(2048)).toBe("2.0 KB");
		expect(formatTransferBytes(5 * MB)).toBe("5.0 MB");
		expect(formatTransferBytes(3 * 1024 * MB)).toBe("3.00 GB");
	});

	it("never renders a negative or non-finite size", () => {
		expect(formatTransferBytes(-1)).toBe("0 B");
		expect(formatTransferBytes(Number.NaN)).toBe("0 B");
	});
});

describe("formatTransferDuration", () => {
	it("formats sub-second, seconds, minutes and hours", () => {
		expect(formatTransferDuration(0.4)).toBe("<1s");
		expect(formatTransferDuration(42)).toBe("42s");
		expect(formatTransferDuration(120)).toBe("2m");
		expect(formatTransferDuration(150)).toBe("2m30s");
		expect(formatTransferDuration(3 * 3600 + 600)).toBe("3h10m");
	});
});

const base = {
	direction: "upload" as const,
	deviceName: "pad7s",
	bytesTransferred: 4 * MB,
	totalBytes: 10 * MB,
	filesDone: 0,
	totalFiles: 1,
	elapsedMs: 2000,
	remotePath: "/home/tiny/app.apk",
	localPath: "/dist/app.apk",
};

describe("buildTransferProgressPayload", () => {
	it("reports bytes as completed/total so the client can draw a determinate bar", () => {
		const p = buildTransferProgressPayload(base);
		expect(p.completed).toBe(4 * MB);
		expect(p.total).toBe(10 * MB);
		expect(p.phase).toBe("upload");
		expect(p.elapsedMs).toBe(2000);
	});

	it("OMITS the total when unknown rather than sending zero", () => {
		// An upload's sender knows only what it has sent. A `total: 0` would let a
		// client compute 0% and paint a bar frozen at zero, which reads as a stalled
		// transfer; an absent total tells it to animate instead.
		const p = buildTransferProgressPayload({ ...base, totalBytes: 0 });
		expect(p.total).toBeUndefined();
		expect(p.completed).toBe(4 * MB);
	});

	it("carries item counts only for a multi-file transfer", () => {
		expect(buildTransferProgressPayload(base).itemsTotal).toBeUndefined();
		const dir = buildTransferProgressPayload({
			...base,
			filesDone: 3,
			totalFiles: 9,
			currentFile: "lib/native.so",
		});
		expect(dir.itemsDone).toBe(3);
		expect(dir.itemsTotal).toBe(9);
		expect(dir.currentItem).toBe("lib/native.so");
	});
});

describe("transferProgressFigures", () => {
	it("states absolute bytes, rate and ETA", () => {
		expect(transferProgressFigures(base)).toEqual([
			"4.0 MB / 10.0 MB",
			"2.0 MB/s",
			// 6 MB left at 2 MB/s.
			"ETA 3s",
		]);
	});

	it("omits rate and ETA before either is observable", () => {
		// Zeroing them would present "0 B/s · ETA 0s" as a measurement of a stalled
		// transfer, when in fact nothing has been measured yet.
		expect(transferProgressFigures({ ...base, bytesTransferred: 0, elapsedMs: 0 })).toEqual([
			"0 B / 10.0 MB",
		]);
	});

	it("omits ETA but keeps rate when the total is unknown", () => {
		expect(transferProgressFigures({ ...base, totalBytes: 0 })).toEqual(["4.0 MB", "2.0 MB/s"]);
	});

	it("adds a file counter only for a multi-file transfer", () => {
		expect(transferProgressFigures(base).some((f) => f.startsWith("file "))).toBe(false);
		const dir = transferProgressFigures({
			...base,
			filesDone: 3,
			totalFiles: 9,
			currentFile: "lib/native.so",
		});
		expect(dir).toContain("file 4/9 lib/native.so");
	});

	it("never reports a file index past the total", () => {
		const dir = transferProgressFigures({ ...base, filesDone: 9, totalFiles: 9 });
		expect(dir).toContain("file 9/9");
	});
});

describe("formatTransferProgress", () => {
	it("states the percentage in words, with NO ascii bar", () => {
		// The bar is a real UI element drawn from the structured payload. An ASCII one
		// here would be a second, worse rendering of the same fact — it cannot
		// animate, and a client wanting the number back would have to parse it.
		const text = formatTransferProgress(base);
		expect(text).toContain("upload → pad7s — 40%");
		expect(text).not.toMatch(/[█░[\]]/);
	});

	it("carries the same figures as the bar", () => {
		expect(formatTransferProgress(base)).toContain("4.0 MB / 10.0 MB · 2.0 MB/s · ETA 3s");
	});

	it("orders the path line in transfer direction", () => {
		expect(formatTransferProgress(base)).toContain("/dist/app.apk → /home/tiny/app.apk");
		expect(formatTransferProgress({ ...base, direction: "download" })).toContain(
			"/home/tiny/app.apk ← /dist/app.apk",
		);
	});

	it("says 'in progress' rather than a fabricated percent when the total is unknown", () => {
		const text = formatTransferProgress({ ...base, totalBytes: 0 });
		expect(text).toContain("in progress");
		expect(text).not.toContain("%");
	});
});

describe("formatTransferSummary", () => {
	it("states direction, size, route, duration and rate", () => {
		const text = formatTransferSummary({
			direction: "upload",
			deviceName: "pad7s",
			bytesTransferred: 10 * MB,
			filesTransferred: 1,
			elapsedMs: 5000,
			remotePath: "/home/tiny/app.apk",
			localPath: "/dist/app.apk",
		});
		expect(text).toBe(
			"Uploaded 10.0 MB — /dist/app.apk → pad7s:/home/tiny/app.apk in 5s, 2.0 MB/s.",
		);
	});

	it("counts files for a directory transfer", () => {
		const text = formatTransferSummary({
			direction: "download",
			deviceName: "pad7s",
			bytesTransferred: 2 * MB,
			filesTransferred: 7,
			elapsedMs: 1000,
			remotePath: "/data",
			localPath: "/tmp/data",
		});
		expect(text).toContain("Downloaded 7 files (2.0 MB)");
		expect(text).toContain("pad7s:/data → /tmp/data");
	});

	it("omits the rate for an instantaneous transfer rather than dividing by zero", () => {
		const text = formatTransferSummary({
			direction: "upload",
			deviceName: "pad7s",
			bytesTransferred: 0,
			filesTransferred: 1,
			elapsedMs: 0,
			remotePath: "/r/empty",
			localPath: "/l/empty",
		});
		expect(text).not.toContain("/s");
		expect(text).toContain("0 B");
	});
});
