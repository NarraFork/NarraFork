import { describe, expect, test } from "bun:test";
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	FileReferenceContextTracker,
	getAgentFileReferenceContext,
} from "./file-reference-context";

const backend = (deviceId: string, defaultCwd?: string | null) =>
	({
		deviceId,
		kind: deviceId === "local" ? "local" : "remote",
		defaultCwd,
	}) as ExecutionBackend;

describe("file reference generation contexts", () => {
	test("uses the active device's memory backend cwd, never a remote host fallback", () => {
		expect(getAgentFileReferenceContext({ cwd: "/host/repo" }, () => backend("local"))).toEqual({
			deviceId: "local",
			cwd: "/host/repo",
		});
		expect(
			getAgentFileReferenceContext({ cwd: "/host/repo", defaultDeviceId: "Remote" }, () =>
				backend("Remote", "C:\\project"),
			),
		).toEqual({ deviceId: "Remote", cwd: "C:\\project" });
		expect(
			getAgentFileReferenceContext({ cwd: "/host/repo", defaultDeviceId: "Remote" }, () =>
				backend("Remote"),
			),
		).toBeNull();
		expect(
			getAgentFileReferenceContext({ cwd: "/host/repo", defaultDeviceId: "Offline" }, () => {
				throw new Error("offline");
			}),
		).toBeNull();
	});

	test("captures each lane only once and retains copies across device/cwd changes", () => {
		const tracker = new FileReferenceContextTracker();
		const current = { deviceId: "A", cwd: "/repo" };
		let reads = 0;
		const getter = () => {
			reads++;
			return current;
		};
		expect(tracker.capture(0, getter)).toEqual({ deviceId: "A", cwd: "/repo" });
		const firstId = tracker.blockId(0);
		current.deviceId = "B";
		current.cwd = "/other";
		expect(tracker.capture(0, getter)).toEqual({ deviceId: "A", cwd: "/repo" });
		expect(reads).toBe(1);
		expect(tracker.blockId(0)).toBe(firstId);
		expect(tracker.capture(1, getter)).toEqual(current);
		expect(tracker.complete(1)).toEqual(current);
		expect(tracker.complete(0)).toEqual({ deviceId: "A", cwd: "/repo" });
		expect(tracker.capture(0, getter)).toEqual(current);
		expect(tracker.blockId(0)).not.toBe(firstId);
	});

	test("null is captured, not replaced by a later device; reset discards it", () => {
		const tracker = new FileReferenceContextTracker();
		tracker.capture(undefined, () => null);
		const known = { deviceId: "local", cwd: "/repo" };
		expect(tracker.capture(undefined, () => known)).toBeNull();
		expect(tracker.complete(undefined)).toBeNull();
		tracker.capture(0, () => known);
		tracker.clear();
		expect(tracker.complete(0)).toBeNull();
		expect(tracker.fallback()).toBeNull();
	});

	test("unknown, relative and over-budget contexts do not become inferred links", () => {
		for (const value of [
			undefined,
			null,
			{},
			{ deviceId: "local", cwd: "src" },
			{ deviceId: "", cwd: "/repo" },
			{ deviceId: "bad\nname", cwd: "/repo" },
			{ deviceId: "local", cwd: `/${"x".repeat(4096)}` },
		]) {
			expect(normalizeFileReferenceContext(value)).toBeNull();
		}
	});
});
