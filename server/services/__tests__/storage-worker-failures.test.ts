import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageCategoryKey } from "@shared/storage-categories";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projects } from "../../db/schema";
import * as fsWorker from "../../lib/fs-scan-worker/client";
import * as measurementCore from "../../lib/fs-scan-worker/measure-tree";
import { generateId } from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import {
	REQUEST_RECORDING_DIR,
	REQUEST_RECORDING_SAVED_DIR,
} from "../../lib/request-recorder-protocol";
import { setUploadsDirForTests } from "../../lib/uploads";
import { cancelStorageScan, getStorageScanJob, startStorageScan } from "../storage-scan-job";
import {
	cleanupAllShares,
	invalidateStorageCache,
	removeUploadDirectoryWithoutMedia,
	StorageScanAbortedError,
	scanStorageCategory,
	scanUploads,
} from "../storage-service";

let root: string;
let projectId: string;
let measurement: ReturnType<typeof spyOn<typeof fsWorker, "measureDirectoriesOffThread">>;
let hostWalk: ReturnType<typeof spyOn<typeof measurementCore, "measureDirectoryTrees">>;
const ownedCategoryDirs: string[] = [];
const failure = new fsWorker.FsScanWorkerUnavailableError(new Error("injected worker unavailable"));

function categoryJob(key: StorageCategoryKey) {
	return getStorageScanJob().categoryJobs.find((job) => job.key === key);
}

async function settleCategory(key: StorageCategoryKey): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (categoryJob(key)?.status === "running" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	expect(categoryJob(key)?.status).not.toBe("running");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "narrafork-storage-worker-failure-"));
	setUploadsDirForTests(join(root, "uploads"));
	mkdirSync(join(root, "uploads", "owner"), { recursive: true });
	mkdirSync(join(root, "repo", ".worktrees", "branch"), { recursive: true });
	writeFileSync(join(root, "uploads", "owner", "image.png"), "keep this upload");
	writeFileSync(join(root, "repo", ".worktrees", "branch", "file"), "keep this worktree");
	projectId = generateId();
	const now = new Date().toISOString();
	db.insert(projects)
		.values({
			id: projectId,
			name: projectId,
			gitPath: join(root, "repo"),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	measurement = spyOn(fsWorker, "measureDirectoriesOffThread").mockRejectedValue(failure);
	hostWalk = spyOn(measurementCore, "measureDirectoryTrees").mockRejectedValue(
		new Error("directory scans cannot move to the server thread"),
	);
	invalidateStorageCache();
});

afterEach(async () => {
	await cancelStorageScan({ categories: ["uploads", "worktrees"] });
	expect(hostWalk).not.toHaveBeenCalled();
	mock.restore();
	db.delete(projects).where(eq(projects.id, projectId)).run();
	setUploadsDirForTests(null);
	invalidateStorageCache();
	rmSync(root, { recursive: true, force: true });
	for (const directory of ownedCategoryDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("storage categories preserve filesystem worker failures", () => {
	test("uploads rejects worker failures instead of reporting zero", async () => {
		await expect(scanUploads()).rejects.toBe(failure);
		expect(measurement).toHaveBeenCalledTimes(1);
	});

	test("uploads rejects a failure after a successful owner instead of publishing partial bytes", async () => {
		mkdirSync(join(root, "uploads", "second-owner"));
		measurement.mockResolvedValueOnce([{ sizeBytes: 40, entriesScanned: 1, truncated: false }]);
		await expect(scanUploads()).rejects.toBe(failure);
		expect(measurement).toHaveBeenCalledTimes(2);
	});

	for (const key of ["uploads", "worktrees"] as const) {
		test(`${key} publishes the existing job error state, including the worker reason`, async () => {
			expect(startStorageScan({ categories: [key] }).started).toBe(true);
			await settleCategory(key);
			expect(categoryJob(key)).toMatchObject({ status: "error", error: failure.message });
			expect(categoryJob(key)?.result).toBeNull();
			expect(existsSync(join(root, "repo", ".worktrees", "branch", "file"))).toBe(true);
		});

		test(`${key} translates worker cancellation to a cancelled job, not success or error`, async () => {
			measurement.mockRejectedValue(new fsWorker.DirectoryMeasureAbortedError());
			startStorageScan({ categories: [key] });
			await settleCategory(key);
			expect(categoryJob(key)).toMatchObject({ status: "cancelled", error: null });
		});

		test(`${key} still returns a legitimate zero for missing directories without invoking a worker`, async () => {
			rmSync(join(root, "uploads"), { recursive: true, force: true });
			rmSync(join(root, "repo", ".worktrees"), { recursive: true, force: true });
			const result = await scanStorageCategory(key);
			expect(result.sizeBytes).toBe(0);
			expect(result.unavailable).toBeUndefined();
			expect(measurement).not.toHaveBeenCalled();
		});
	}

	test("worktrees rejects a worker failure after measuring an earlier project", async () => {
		const secondId = generateId();
		const now = new Date().toISOString();
		db.insert(projects)
			.values({
				id: secondId,
				name: secondId,
				gitPath: join(root, "repo"),
				createdAt: now,
				updatedAt: now,
			})
			.run();
		try {
			measurement.mockResolvedValueOnce([{ sizeBytes: 40, entriesScanned: 1, truncated: false }]);
			await expect(scanStorageCategory("worktrees")).rejects.toBe(failure);
			expect(measurement).toHaveBeenCalledTimes(2);
		} finally {
			db.delete(projects).where(eq(projects.id, secondId)).run();
		}
	});

	for (const [key, directory] of [
		["chatAttachments", "chat-attachments"],
		["shares", "shares"],
		["treeSnapshots", "tree-snapshots"],
		["requestRecordings", REQUEST_RECORDING_DIR],
		["savedRequestRecordings", REQUEST_RECORDING_SAVED_DIR],
		["dormantIgnored", "dormant-ignored"],
	] as const) {
		test(`${key} also rejects worker unavailability`, async () => {
			const directoryPath = join(getNarraforkHome(), directory);
			if (!existsSync(directoryPath)) {
				mkdirSync(directoryPath, { recursive: true });
				ownedCategoryDirs.push(directoryPath);
			}
			await expect(scanStorageCategory(key)).rejects.toBe(failure);
		});
	}

	test("an absent measurement is not silently turned into zero bytes", async () => {
		measurement.mockResolvedValue([]);
		await expect(scanUploads()).rejects.toThrow("returned no directory measurement");
	});

	test("an already-cancelled category does not perform measurement", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			scanStorageCategory("uploads", { signal: controller.signal }),
		).rejects.toBeInstanceOf(StorageScanAbortedError);
		expect(measurement).not.toHaveBeenCalled();
	});

	test("cleanup measurement failure rejects and leaves the unmeasured directory intact", async () => {
		mkdirSync(join(root, "uploads", "owner", "nested"));
		writeFileSync(join(root, "uploads", "owner", "nested", "image.png"), "keep");
		await expect(removeUploadDirectoryWithoutMedia("owner")).rejects.toBe(failure);
		expect(existsSync(join(root, "uploads", "owner", "nested", "image.png"))).toBe(true);
	});

	test("share cleanup cannot claim freedBytes: 0 success after a worker failure", async () => {
		const shares = join(getNarraforkHome(), "shares");
		const share = join(shares, generateId());
		mkdirSync(share, { recursive: true });
		ownedCategoryDirs.push(share);
		writeFileSync(join(share, "content"), "keep");
		await expect(cleanupAllShares()).rejects.toBe(failure);
		expect(existsSync(join(share, "content"))).toBe(true);
	});
});
