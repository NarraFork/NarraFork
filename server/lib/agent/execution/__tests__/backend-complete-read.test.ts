import { describe, expect, test } from "bun:test";
import { readCompleteFileBytes } from "../backend";

describe("readCompleteFileBytes", () => {
	test("returns complete backend reads unchanged", async () => {
		const bytes = new TextEncoder().encode("complete content");
		const result = await readCompleteFileBytes(
			{
				deviceId: "remote-a",
				readFileBytes: async () => ({ bytes, truncated: false, totalSize: bytes.byteLength }),
			},
			"/workspace/file.txt",
		);

		expect(result.bytes).toEqual(bytes);
		expect(result.truncated).toBeFalse();
	});

	test("fails closed when a remote backend returns only a prefix", async () => {
		const bytes = new TextEncoder().encode("prefix");
		await expect(
			readCompleteFileBytes(
				{
					deviceId: "remote-a",
					readFileBytes: async () => ({ bytes, truncated: true, totalSize: 20_000_000 }),
				},
				"/workspace/large.txt",
			),
		).rejects.toThrow("device remote-a truncated /workspace/large.txt at 6 of 20000000 bytes");
	});
});
