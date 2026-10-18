import { expect } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import type {} from "../../scripts/smoke-editor-cache-fixture";

export async function editorDraftBrowserAcceptance(
	page: Page,
	fixture: {
		path: string;
		origin: string;
		original: string;
		downloadDirectory: string;
		writeDisk(text: string): Promise<void>;
		readDisk(): Promise<string>;
		removeDisk(): Promise<void>;
		revoke(revoked: boolean): void;
		changeContext(changed: boolean): void;
		commits(): number;
		loseNextReceipt(): void;
		restartService(): Promise<void>;
	},
) {
	const wait = (predicate: Parameters<Page["waitForFunction"]>[0]) =>
		page.waitForFunction(predicate, { timeout: 12_000, polling: 50 });
	const ready = () =>
		wait(
			() =>
				window.__editorCache?.snapshot().views === 2 &&
				window.__editorCache.snapshot().registry.loads === 0,
		);
	const state = () => page.evaluate(() => window.__editorCache.snapshot());
	const edit = (text: string) =>
		page.evaluate((value) => window.__editorCache.edit("file-0", value), text);
	const rows = () =>
		page.evaluate(async () => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const r = indexedDB.open("narrafork-editor-drafts", 1);
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error);
			});
			const result = await new Promise<
				{
					writerId: string;
					revision: number;
					generation: string;
					scope: { resourceKey: string };
					operation?: unknown;
					anchor?: { anchorId: string; checkpointGeneration: string };
				}[]
			>((resolve, reject) => {
				const r = db.transaction("metadata").objectStore("metadata").getAll(undefined, 33);
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error);
			});
			db.close();
			return result;
		});
	const save = async (target: Page = page) => {
		await target.evaluate(() => window.__editorCache.focus("file-0"));
		await target.keyboard.down("Control");
		await target.keyboard.press("s");
		await target.keyboard.up("Control");
	};
	page.on("dialog", (dialog) => {
		void dialog.accept();
	});
	await ready();
	const initial = await state();
	expect(initial.registry.tabs).toBe(1000);
	expect(initial.monacoModels).toBe(1);
	expect(initial.drafts.bodyReads).toBe(0);
	expect(initial.drafts.metadataReads).toBe(2);
	const writerBeforeRefresh = initial.drafts.writerId;
	await edit("/* LOCAL_REFRESH */");
	await wait(() => window.__editorCache.snapshot().drafts.published === 1);
	expect(await rows()).toHaveLength(1);
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await page.waitForSelector("[data-editor-draft-restore]");
	expect((await state()).drafts.writerId).not.toBe(writerBeforeRefresh);
	expect((await state()).drafts.bodyReads).toBe(0);
	await page.click("[data-editor-draft-restore]");
	await wait(() => !!window.__editorCache.snapshot().registry.pinReasons.dirty);
	expect(
		(await state()).panes.every((pane) => pane.firstLine?.startsWith("/* LOCAL_REFRESH */")),
	).toBe(true);
	expect(await page.$("[data-editor-draft-restored]")).not.toBeNull();
	expect((await state()).drafts.bodyReads).toBeGreaterThan(0);
	// After a real external write, restoration must keep the pre-crash base and conflict.
	await fixture.writeDisk(`/* DISK_CHANGED */${fixture.original}`);
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await page.waitForSelector("[data-editor-draft-restore]");
	await page.click("[data-editor-draft-restore]");
	await wait(
		() =>
			!!document
				.querySelector("[data-editor-draft-restored]")
				?.textContent?.includes("Both the draft and disk changed"),
	);
	await save();
	await wait(() => !!window.__editorCache.snapshot().registry.pinReasons.conflict);
	expect(await fixture.readDisk()).toBe(`/* DISK_CHANGED */${fixture.original}`);
	expect((await state()).registry.pinReasons.dirty).toBe(1);
	await wait(
		() =>
			window.__editorCache.snapshot().drafts.running === 0 &&
			window.__editorCache.snapshot().drafts.queued === 0,
	);
	// Crash the fixture renderer, NOT the host/agent server. No unload checkpoint is assumed.
	const session = await page.createCDPSession();
	const crashed = new Promise<void>((resolve) => {
		page.once("error", () => resolve());
	});
	void session.send("Page.crash").catch(() => {});
	await Promise.race([
		crashed,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Renderer did not crash")), 5000),
		),
	]);
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await page.waitForSelector("[data-editor-draft-restore]");
	expect((await state()).drafts.bodyReads).toBe(0);
	const beforeSecond = await rows();
	await page.evaluate(() => sessionStorage.setItem("fixture-cloned-writer", "same-session-value"));
	const opened = page.browser().waitForTarget((target) => target.opener() === page.target());
	await page.evaluate(() => {
		window.open(location.href, "draft-second-window");
	});
	const second = await (await opened).page();
	if (!second) throw new Error("window.open did not create a page");
	second.on("dialog", (dialog) => {
		void dialog.accept();
	});
	try {
		await second.waitForFunction(
			() =>
				window.__editorCache?.snapshot().views === 2 &&
				window.__editorCache.snapshot().registry.loads === 0,
			{ timeout: 12_000 },
		);
		const secondWriter = await second.evaluate(
			() => window.__editorCache.snapshot().drafts.writerId,
		);
		expect(secondWriter).not.toBe((await state()).drafts.writerId);
		expect(await second.evaluate(() => sessionStorage.getItem("fixture-cloned-writer"))).toBe(
			"same-session-value",
		);
		await second.evaluate(() => window.__editorCache.edit("file-0", "/* SECOND_WINDOW */"));
		await second.waitForFunction(() => window.__editorCache.snapshot().drafts.published === 1, {
			timeout: 12_000,
		});
		const both = await rows();
		expect(both.some((row) => row.writerId === secondWriter)).toBe(true);
		for (const row of beforeSecond)
			expect(both.some((candidate) => candidate.generation === row.generation)).toBe(true);
		await save(second);
		await second.waitForFunction(
			() =>
				!window.__editorCache.snapshot().registry.pinReasons.dirty &&
				!window.__editorCache.snapshot().drafts.running,
			{ timeout: 12_000 },
		);
		const remaining = await rows();
		expect(remaining.some((row) => row.writerId === secondWriter)).toBe(false);
		for (const row of beforeSecond)
			expect(remaining.some((candidate) => candidate.generation === row.generation)).toBe(true);
	} finally {
		await second.close();
		await page.bringToFront();
	}
	// Revoking ACL while the model stays resident must also hide disk-backed discovery.
	fixture.revoke(true);
	await page.evaluate(() => window.__editorCache.workspaceVisible(false));
	await wait(() => window.__editorCache.snapshot().views === 0);
	const deniedResident = page.waitForResponse(
		(response) =>
			response.url().includes("/editor-documents/recovery-scope?") &&
			[403, 404].includes(response.status()),
	);
	await page.evaluate(() => window.__editorCache.workspaceVisible(true));
	await deniedResident;
	expect(await page.$("[data-editor-local-draft]")).toBeNull();
	expect((await state()).drafts.bodyReads).toBe(0);
	fixture.revoke(false);
	fixture.changeContext(true);
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await page.waitForSelector("[data-editor-draft-export]");
	expect(await page.$("[data-editor-draft-restore]")).toBeNull();
	expect((await state()).drafts.bodyReads).toBe(0);
	fixture.changeContext(false);
	await fixture.removeDisk();
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector("[data-editor-draft-export]");
	expect(await page.$("[data-editor-draft-restore]")).toBeNull();
	expect((await state()).monacoModels).toBe(0);
	expect((await state()).drafts.bodyReads).toBe(0);
	// Export the actual complete IDB body through Chrome while the real gate is blocked.
	await mkdir(fixture.downloadDirectory);
	const downloadSession = await page.browser().target().createCDPSession();
	await downloadSession.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: fixture.downloadDirectory,
		eventsEnabled: true,
	});
	let complete!: () => void,
		fail!: (error: Error) => void,
		guid = "";
	const downloaded = new Promise<void>((resolve, reject) => {
		complete = resolve;
		fail = reject;
	});
	downloadSession.on("Browser.downloadWillBegin", (event) => {
		if (event.suggestedFilename === "editor-recovered-draft.utf8.txt") guid = event.guid;
	});
	downloadSession.on("Browser.downloadProgress", (event) => {
		if (event.guid === guid) {
			if (event.state === "completed") complete();
			else if (event.state === "canceled") fail(new Error("Draft download cancelled"));
		}
	});
	const downloadTimeout = setTimeout(() => fail(new Error("Draft export timed out")), 10_000);
	try {
		await page.click("[data-editor-draft-export]");
		await downloaded;
		expect(
			await readFile(join(fixture.downloadDirectory, "editor-recovered-draft.utf8.txt"), "utf8"),
		).toBe(`/* LOCAL_REFRESH */${fixture.original}`);
		expect((await state()).drafts.bodyReads).toBeGreaterThan(0);
		expect((await state()).registry.pinReasons["recovery-candidate"]).toBe(1);
		expect((await state()).registry.pinnedBytes).toBeGreaterThan(0);
	} finally {
		clearTimeout(downloadTimeout);
		await downloadSession.detach();
	}
	await wait(() => !window.__editorCache.snapshot().registry.pinReasons["recovery-candidate"]);
	expect((await state()).registry.pinnedBytes).toBe(0);
	fixture.revoke(true);
	const denied = page.waitForResponse(
		(response) =>
			response.url().includes("/editor-documents/recovery-scope?") &&
			[403, 404].includes(response.status()),
	);
	await page.reload({ waitUntil: "domcontentloaded" });
	await denied;
	await wait(() => !!window.__editorCache && !!document.querySelector("[data-cache-pane]"));
	expect(await page.$("[data-editor-local-draft]")).toBeNull();
	expect((await state()).drafts.bodyReads).toBe(0);
	expect((await state()).drafts.metadataReads).toBe(0);
	fixture.revoke(false);
	await fixture.writeDisk(fixture.original);
	// IndexedDB unavailable must not disable ordinary v1 editing or saving.
	const disabled = await page.evaluateOnNewDocument(() =>
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			get() {
				throw new DOMException("disabled", "SecurityError");
			},
		}),
	);
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await edit("/* IDB_DISABLED */");
	await page.waitForSelector("[data-editor-backup-incomplete]");
	await save();
	await wait(() => !window.__editorCache.snapshot().registry.pinReasons.dirty);
	expect(await fixture.readDisk()).toBe(`/* IDB_DISABLED */${fixture.original}`);
	expect(
		await page.evaluate(() =>
			window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
		),
	).toBe(true);
	await page.removeScriptToEvaluateOnNewDocument(disabled.identifier);
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await page.evaluate(() => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			if (this.name === "chunks") throw new DOMException("fixture quota", "QuotaExceededError");
			return original.apply(this, args);
		};
	});
	await edit("/* QUOTA_FAILURE */");
	await page.waitForSelector("[data-editor-backup-incomplete]");
	expect((await state()).registry.pinReasons.dirty).toBe(1);
	expect(
		await page.evaluate(
			() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
		),
	).toBe(true);
	await save();
	await wait(() => !window.__editorCache.snapshot().registry.pinReasons.dirty);
	expect(await fixture.readDisk()).toBe(`/* QUOTA_FAILURE *//* IDB_DISABLED */${fixture.original}`);
	// Existing ordinary checkpoint + marker/delete failure + lost commit reply. The
	// backend anchor, not an IDB hint or the current disk hash, must preserve query-first.
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	await edit("/* PROVENANCE_RACE */");
	await wait(() => window.__editorCache.snapshot().drafts.published === 1);
	const raceWriter = (await state()).drafts.writerId;
	const ordinary = (await rows()).find((row) => row.writerId === raceWriter);
	expect(ordinary?.operation).toBeUndefined();
	expect(ordinary?.anchor).toBeDefined();
	await page.evaluate(() => {
		const counters = { puts: 0, deletes: 0 };
		Reflect.set(window, "__editorDraftIdbFaults", counters);
		const put = IDBObjectStore.prototype.put,
			remove = IDBObjectStore.prototype.delete;
		IDBObjectStore.prototype.put = function (...args) {
			if (this.name === "metadata") {
				counters.puts++;
				throw new DOMException("fixture marker failure", "QuotaExceededError");
			}
			return put.apply(this, args);
		};
		IDBObjectStore.prototype.delete = function (...args) {
			if (this.name === "metadata") {
				counters.deletes++;
				throw new DOMException("fixture cleanup failure", "QuotaExceededError");
			}
			return remove.apply(this, args);
		};
	});
	expect(await page.evaluate(() => window.__editorCache.tryCheckpointCleanup())).toEqual({
		attempted: true,
		failed: true,
	});
	const commitsBeforeLoss = fixture.commits();
	fixture.loseNextReceipt();
	await save();
	await wait(() => !!window.__editorCache.snapshot().registry.pinReasons.unknown);
	expect(await page.$("[data-editor-backup-incomplete]")).not.toBeNull();
	expect((await rows()).find((row) => row.writerId === raceWriter)?.operation).toBeUndefined();
	const faults = await page.evaluate(
		() => Reflect.get(window, "__editorDraftIdbFaults") as { puts: number; deletes: number },
	);
	expect(faults.puts).toBeGreaterThan(0);
	expect(faults.deletes).toBeGreaterThan(0);
	expect(await fixture.readDisk()).toBe(
		`/* PROVENANCE_RACE *//* QUOTA_FAILURE *//* IDB_DISABLED */${fixture.original}`,
	);
	expect(fixture.commits()).toBe(commitsBeforeLoss + 1);
	await fixture.restartService();
	await page.reload({ waitUntil: "domcontentloaded" });
	await ready();
	const raceSelector = `[data-editor-draft-anchor="${ordinary?.anchor?.anchorId}"]`;
	await page.waitForSelector(`${raceSelector} [data-editor-draft-query]`);
	expect(await page.$(`${raceSelector} [data-editor-draft-restore]`)).toBeNull();
	expect((await state()).drafts.bodyReads).toBe(0);
	await page.click(`${raceSelector} [data-editor-draft-query]`);
	await page.waitForSelector(`${raceSelector} [data-editor-draft-receipt="saved"]`);
	expect(fixture.commits()).toBe(commitsBeforeLoss + 1);
	console.info(
		"EDITOR_DRAFT_PROVENANCE_CHROMIUM",
		JSON.stringify({
			idbMarkerFailures: faults.puts,
			idbDeleteFailures: faults.deletes,
			lostCommitReplies: 1,
			serviceColdRestarts: 1,
			recoveredOriginalSavedReceipt: 1,
			reapply: 0,
		}),
	);
	console.info(
		"EDITOR_DRAFT_CHROMIUM",
		JSON.stringify({
			tabs: 1000,
			initialModels: 1,
			hiddenBodyReads: 0,
			rendererCrashes: 1,
			windows: 2,
			clonedSessionStorageWriterIsolation: true,
			blockedGateExports: 1,
			changedBindingReadOnly: 1,
			unavailableSave: 1,
			quotaFailureSave: 1,
			revokedMetadataReads: 0,
			revokedBodyReads: 0,
			retainedWriters: beforeSecond.length,
		}),
	);
	await page.evaluate(() => window.__editorCache.dispose());
}
