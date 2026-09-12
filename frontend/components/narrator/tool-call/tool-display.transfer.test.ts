import { describe, expect, it } from "bun:test";
import { getCategory, getCategoryColor, getSummary } from "./tool-display";

describe("Send delivery-state header summary", () => {
	it.each([
		{ await: true },
		{ await: false },
		{},
	])("shows sending rather than a mode before queueing for %j", (input) => {
		expect(getSummary("Send", { id: "parent", ...input })).toBe("to parent · Sending");
		expect(
			getSummary("Send", { id: "parent", ...input }, undefined, { communicationRunning: "发送中" }),
		).toBe("to parent · 发送中");
	});

	it("uses projected metadata but preserves an explicit false input", () => {
		const metadata = { await: true, targets: [{ id: "parent", status: "queued" }] };
		expect(getSummary("Send", { _truncated: true }, metadata)).toBe("to parent · Sent · Waiting");
		expect(getSummary("Send", { await: false }, metadata)).toBe("to parent · Sent");
	});
});

describe("TransferFile classification", () => {
	it("is its own category, not generic", () => {
		// Generic is what made a transfer render as its own raw argument JSON.
		expect(getCategory("TransferFile")).toBe("transfer");
		expect(getCategoryColor("transfer")).not.toBe("gray");
	});

	it("is visually distinct from ShareFile", () => {
		// Both hand a file somewhere; a reader scanning a long run has to tell them
		// apart at a glance.
		expect(getCategoryColor("transfer")).not.toBe(getCategoryColor("share"));
	});
});

describe("TransferFile header summary", () => {
	const input = {
		direction: "upload",
		device: "r1ql577g9n-ckSTS7gm7K",
		remotePath: "/home/tiny/narrafork-box-final.apk",
		localPath: "/dist/narrafork-box-0.1.0-arm64.apk",
	};

	it("names the file and the device with a direction arrow", () => {
		expect(getSummary("TransferFile", input, { deviceName: "pad7s" })).toBe(
			"narrafork-box-final.apk → pad7s",
		);
	});

	it("flips the arrow for a download", () => {
		expect(
			getSummary("TransferFile", { ...input, direction: "download" }, { deviceName: "pad7s" }),
		).toBe("narrafork-box-final.apk ← pad7s");
	});

	it("omits the device rather than showing its raw id", () => {
		// The input only carries the nanoid, which tells the reader nothing; the
		// resolved name lives in metadata and the detail card shows it regardless.
		const text = getSummary("TransferFile", input);
		expect(text).toBe("narrafork-box-final.apk");
		expect(text).not.toContain("r1ql577g9n");
	});

	it("falls back to the local basename when only that side is known", () => {
		expect(
			getSummary("TransferFile", { direction: "upload", localPath: "/dist/app.apk" }, {}),
		).toBe("app.apk");
	});

	it("still says something when no path resolved", () => {
		expect(getSummary("TransferFile", { direction: "upload" }, { deviceName: "pad7s" })).toBe(
			"→ pad7s",
		);
		expect(getSummary("TransferFile", {}, {})).toBe("Transfer");
	});
});
