import { describe, expect, test } from "bun:test";
import {
	type FileReferenceSnapshot,
	fileReferenceContentForDisplay,
	fileReferenceMessageForDisplay,
	fileTargetKey,
} from "./file-reference";

const snapshot: FileReferenceSnapshot = {
	type: "file_reference",
	reference: { id: "r1", deviceId: "DeviceABC", path: "/work/a.ts", label: "a.ts" },
	snapshotText: "private frozen source",
	snapshotHash: "hash",
	capturedAt: "2026-01-01T00:00:00Z",
};

describe("file-reference display boundaries", () => {
	test("HTTP and WS display copies omit snapshot bodies without changing stored/model data", () => {
		const message = { id: "m1", contentJson: [{ type: "text", text: "inspect this" }, snapshot] };
		const rendered = fileReferenceMessageForDisplay(message);
		expect(rendered).toEqual({
			id: "m1",
			contentJson: [
				message.contentJson[0],
				{ type: "file_reference", reference: snapshot.reference },
			],
		});
		expect(JSON.stringify(rendered)).not.toContain("snapshotText");
		expect(JSON.stringify(message)).toContain("private frozen source");
		expect(snapshot.snapshotHash).toBe("hash");
	});

	test("other blocks and non-array data are unchanged", () => {
		const text = {
			type: "text",
			text: "hello",
			fileReferenceContext: { deviceId: "local", cwd: "/work" },
		};
		expect(fileReferenceContentForDisplay([text])).toEqual([text]);
		expect(fileReferenceContentForDisplay(null)).toBeNull();
	});

	test("device identity is case-sensitive and distinct from the pathname", () => {
		expect(fileTargetKey(snapshot.reference)).not.toBe(
			fileTargetKey({ deviceId: "deviceabc", path: snapshot.reference.path }),
		);
		expect(fileTargetKey(snapshot.reference)).not.toBe(
			fileTargetKey({ deviceId: "local", path: snapshot.reference.path }),
		);
	});
});
