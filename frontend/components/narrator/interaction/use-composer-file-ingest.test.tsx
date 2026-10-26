import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act, createElement, type DragEvent, type SetStateAction, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getComposerFileOrder } from "../composer/composer-file-order";
import * as panelTypes from "../narrator-panel-types";
import {
	type AttachmentInsertionBookmark,
	type AttachmentInsertionOrigin,
	COMPOSER_DRAG_IDLE_MS,
	COMPOSER_FILE_INGEST_TIMEOUT_MS,
	type UseComposerFileIngestOptions,
	useComposerFileIngest,
} from "./use-composer-file-ingest";

let root: Root;
let host: HTMLElement;
let hook: ReturnType<typeof useComposerFileIngest>;
let images: File[];
let textFiles: File[];
let narratorId: string;
let captureInsertion: UseComposerFileIngestOptions["captureInsertion"];
let onAcceptedFiles: UseComposerFileIngestOptions["onAcceptedFiles"];
const sendingRef = { current: false };
const dragCounterRef = { current: 0 };
let dragging: boolean;
let imageCommits: number;
let textCommits: number;
let renders: { images: number; texts: number }[];
let resize: ReturnType<typeof spyOn<typeof panelTypes, "resizeImageIfNeeded">>;
let notify: ReturnType<typeof spyOn<typeof notifications, "show">>;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const png = (name = "image.png") => new File(["png"], name, { type: "image/png" });
const text = (name = "note.txt") => new File(["text"], name, { type: "text/plain" });
function Harness() {
	const [attachedImages, setImages] = useState<File[]>([]);
	const [attachedTextFiles, setTextFiles] = useState<File[]>([]);
	const updateImages = useRef((next: SetStateAction<File[]>) => {
		imageCommits++;
		setImages(next);
	}).current;
	const updateTextFiles = useRef((next: SetStateAction<File[]>) => {
		textCommits++;
		setTextFiles(next);
	}).current;
	images = attachedImages;
	textFiles = attachedTextFiles;
	renders.push({ images: images.length, texts: textFiles.length });
	hook = useComposerFileIngest({
		narratorId,
		sendingRef,
		captureInsertion,
		onAcceptedFiles,
		dragCounterRef,
		updateAttachedImages: updateImages,
		updateAttachedTextFiles: updateTextFiles,
		setIsDragging: (value) => {
			dragging = value;
		},
		t: (key) => key,
	});
	return null;
}
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function render() {
	await act(async () => root.render(createElement(Harness)));
}
beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	narratorId = "narrator-a";
	captureInsertion = undefined;
	onAcceptedFiles = undefined;
	sendingRef.current = false;
	dragCounterRef.current = 0;
	dragging = false;
	imageCommits = 0;
	textCommits = 0;
	renders = [];
	resize = spyOn(panelTypes, "resizeImageIfNeeded").mockImplementation(async (file) => file);
	notify = spyOn(notifications, "show").mockImplementation(() => "notification");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await render();
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	mock.restore();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

test("mixed paste waits for resizing, commits both arrays together and retains original selection order", async () => {
	const pending = deferred<File>();
	const original = png();
	const resized = png("resized.png");
	const first = text("first.txt");
	const last = text("last.md");
	resize.mockImplementation(() => pending.promise);
	let ingestion: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		ingestion = hook.handleComposerPasteImages([first, original, last]);
	});
	expect(images).toEqual([]);
	expect(textFiles).toEqual([]);
	expect(hook.isIngesting).toBe(true);
	expect(hook.ingestingRef.current).toBe(true);
	await act(async () => {
		pending.resolve(resized);
		await ingestion;
	});
	expect(await ingestion).toEqual([first, resized, last]);
	expect(images).toEqual([resized]);
	expect(textFiles).toEqual([first, last]);
	expect(imageCommits).toBe(1);
	expect(textCommits).toBe(1);
	expect(
		renders.every(
			(rendered) =>
				(rendered.images === 0 && rendered.texts === 0) ||
				(rendered.images === 1 && rendered.texts === 2),
		),
	).toBe(true);
	expect(
		[resized, first, last].sort((a, b) => getComposerFileOrder(a) - getComposerFileOrder(b)),
	).toEqual([first, resized, last]);
	expect(getComposerFileOrder(resized)).toBe(getComposerFileOrder(original));
	expect(hook.isIngesting).toBe(false);
});

test("batches commit FIFO and use at most two concurrent image preprocessors", async () => {
	const first = deferred<File>();
	const second = deferred<File>();
	const imageA = png("a.png");
	const imageB = png("b.png");
	const imageC = png("c.png");
	resize.mockImplementation((file) =>
		file === imageA ? first.promise : file === imageB ? second.promise : Promise.resolve(file),
	);
	let a: Promise<File[]> = Promise.resolve([]);
	let b: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		a = hook.ingestFiles([imageA, imageB, imageC]);
		b = hook.ingestFiles([text("next.txt")]);
	});
	expect(resize).toHaveBeenCalledTimes(2);
	expect(textFiles).toEqual([]);
	await act(async () => {
		first.resolve(imageA);
	});
	expect(resize).toHaveBeenCalledTimes(3);
	expect(images).toEqual([]);
	await act(async () => {
		second.resolve(imageB);
		await Promise.all([a, b]);
	});
	expect(images).toEqual([imageA, imageB, imageC]);
	expect(textFiles.map((file) => file.name)).toEqual(["next.txt"]);
	expect(getComposerFileOrder(textFiles[0])).toBeGreaterThan(getComposerFileOrder(imageC));
});

test("legacy addImages/addTextFiles keep category filtering, GIF bypass and synchronous text append", async () => {
	const gif = new File(["gif"], "animation.gif", { type: "image/gif" });
	await act(async () => {
		hook.addTextFiles([text(), png()]);
	});
	expect(textFiles.map((file) => file.name)).toEqual(["note.txt", "image.png"]);
	expect(images).toEqual([]);
	await act(async () => {
		await hook.addImages([gif, text("ignored.txt")]);
	});
	expect(images).toEqual([gif]);
	expect(resize).not.toHaveBeenCalled();
	expect(notify).not.toHaveBeenCalled();
});

test("oversized files are rejected before resizing while non-image types follow existing upload policy", async () => {
	const largeImage = png("large.png");
	Object.defineProperty(largeImage, "size", { value: panelTypes.MAX_IMAGE_SIZE + 1 });
	const largeText = text("large.log");
	Object.defineProperty(largeText, "size", { value: panelTypes.MAX_TEXT_FILE_SIZE + 1 });
	const binary = new File(["binary"], "archive.zip", { type: "application/zip" });
	await act(async () => {
		await hook.ingestFiles([largeImage, largeText, binary]);
	});
	expect(images).toEqual([]);
	expect(textFiles).toEqual([binary]);
	expect(resize).not.toHaveBeenCalled();
	expect(notify).toHaveBeenCalledTimes(2);
	expect(hook.isIngesting).toBe(false);
});

test("send lock rejects new ingress and invalidates already running resize, even after unlocking", async () => {
	const pending = deferred<File>();
	resize.mockImplementation(() => pending.promise);
	let result: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		result = hook.ingestFiles([png()]);
	});
	sendingRef.current = true;
	await render();
	await act(async () => {
		expect(await hook.ingestFiles([text()])).toEqual([]);
	});
	sendingRef.current = false;
	await render();
	await act(async () => {
		pending.resolve(png("late.png"));
		await result;
	});
	expect(await result).toEqual([]);
	expect(images).toEqual([]);
	expect(textFiles).toEqual([]);
});

test("narrator A→B→A still rejects stale batch and does not block new scope", async () => {
	const pending = deferred<File>();
	resize.mockImplementation(() => pending.promise);
	let result: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		result = hook.ingestFiles([png()]);
	});
	narratorId = "narrator-b";
	await render();
	narratorId = "narrator-a";
	await render();
	await act(async () => {
		await hook.ingestFiles([text("current.txt")]);
		pending.resolve(png("late.png"));
		await result;
	});
	expect(await result).toEqual([]);
	expect(images).toEqual([]);
	expect(textFiles.map((file) => file.name)).toEqual(["current.txt"]);
});

test("five-second batch timeout falls back once to original files, ignores late resized outputs", async () => {
	const pending = deferred<File>();
	const image = png();
	resize.mockImplementation(() => pending.promise);
	const originalTimeout = globalThis.setTimeout;
	let expire: (() => void) | undefined;
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: TimerHandler,
		delay?: number,
		...args: unknown[]
	) => {
		if (delay === COMPOSER_FILE_INGEST_TIMEOUT_MS) expire = callback as () => void;
		return originalTimeout(callback, delay, ...args);
	}) as typeof setTimeout);
	let result: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		result = hook.ingestFiles([image, text()]);
	});
	expect(expire).toBeDefined();
	await act(async () => {
		expire?.();
		await result;
	});
	expect(await result).toEqual([image, textFiles[0]]);
	expect(images).toEqual([image]);
	expect(imageCommits).toBe(1);
	await act(async () => {
		pending.resolve(png("late.png"));
	});
	expect(images).toEqual([image]);
	expect(imageCommits).toBe(1);
	expect(hook.isIngesting).toBe(false);
});

test("resize rejection keeps original, callback identity stays stable and paste resets panel drag state", async () => {
	resize.mockRejectedValue(new Error("decoder failed"));
	const image = png();
	const callback = hook.handleComposerPasteImages;
	dragCounterRef.current = 4;
	dragging = true;
	await act(async () => {
		await callback([text(), image]);
	});
	expect(images).toEqual([image]);
	expect(dragCounterRef.current).toBe(0);
	expect(dragging).toBe(false);
	await render();
	expect(hook.handleComposerPasteImages).toBe(callback);
});

test("drop already consumed by an editor is not imported a second time", async () => {
	const event = {
		defaultPrevented: true,
		preventDefault: mock(() => {}),
		stopPropagation: mock(() => {}),
		dataTransfer: { types: ["Files"], files: [text()] },
	} as unknown as DragEvent;
	dragCounterRef.current = 3;
	dragging = true;
	await act(async () => {
		hook.dropZoneProps.onDrop(event);
	});
	expect(textFiles).toEqual([]);
	expect(dragCounterRef.current).toBe(0);
	expect(dragging).toBe(false);
	expect(event.stopPropagation).toHaveBeenCalledTimes(1);
});

function dragEvent(currentTarget: Element, relatedTarget: Element | null = null) {
	return {
		currentTarget,
		relatedTarget,
		defaultPrevented: false,
		preventDefault: () => {},
		stopPropagation: () => {},
		dataTransfer: { types: ["Files"], files: [], dropEffect: "none" },
	} as unknown as DragEvent;
}
function dragZone() {
	const zone = document.createElement("div");
	const child = document.createElement("span");
	const outside = document.createElement("p");
	zone.append(child);
	document.body.append(zone, outside);
	return { zone, child, outside };
}

for (const [name, fire] of [
	["window drop", () => window.dispatchEvent(new window.Event("drop"))],
	["window dragend", () => window.dispatchEvent(new window.Event("dragend"))],
	["window blur", () => window.dispatchEvent(new window.Event("blur"))],
	[
		"document hidden",
		() => {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "hidden",
			});
			document.dispatchEvent(new window.Event("visibilitychange"));
		},
	],
] as const) {
	test(`${name} clears the overlay when the matching dragleave never arrives`, async () => {
		const { zone, child } = dragZone();
		await act(async () => {
			hook.dropZoneProps.onDragEnter(dragEvent(zone));
			hook.dropZoneProps.onDragEnter(dragEvent(child));
		});
		expect(dragging).toBe(true);
		await act(async () => fire());
		expect(dragging).toBe(false);
		expect(dragCounterRef.current).toBe(0);
	});
}

test("moving between descendants keeps the overlay; leaving to an outside node always clears it", async () => {
	const { zone, child, outside } = dragZone();
	await act(async () => {
		hook.dropZoneProps.onDragEnter(dragEvent(zone, outside));
		hook.dropZoneProps.onDragEnter(dragEvent(zone, zone));
		hook.dropZoneProps.onDragLeave(dragEvent(zone, child));
	});
	expect(dragging).toBe(true);
	// A stale count (enters whose leaves were lost) must not survive a real exit.
	dragCounterRef.current = 5;
	await act(async () => hook.dropZoneProps.onDragLeave(dragEvent(zone, outside)));
	expect(dragging).toBe(false);
	expect(dragCounterRef.current).toBe(0);
});

test("null relatedTarget falls back to balanced enter/leave counting", async () => {
	const { zone } = dragZone();
	await act(async () => {
		hook.dropZoneProps.onDragEnter(dragEvent(zone));
		hook.dropZoneProps.onDragEnter(dragEvent(zone));
		hook.dropZoneProps.onDragLeave(dragEvent(zone));
	});
	expect(dragging).toBe(true);
	await act(async () => hook.dropZoneProps.onDragLeave(dragEvent(zone)));
	expect(dragging).toBe(false);
});

test("drag that stops sending dragover is cleared by the idle watchdog", async () => {
	const originalTimeout = globalThis.setTimeout;
	const idle: (() => void)[] = [];
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: TimerHandler,
		delay?: number,
		...args: unknown[]
	) => {
		if (delay === COMPOSER_DRAG_IDLE_MS) idle.push(callback as () => void);
		return originalTimeout(callback, delay, ...args);
	}) as typeof setTimeout);
	const { zone } = dragZone();
	await act(async () => {
		hook.dropZoneProps.onDragEnter(dragEvent(zone));
		hook.dropZoneProps.onDragOver(dragEvent(zone));
	});
	expect(idle).toHaveLength(2);
	expect(dragging).toBe(true);
	await act(async () => idle.at(-1)?.());
	expect(dragging).toBe(false);
	expect(dragCounterRef.current).toBe(0);
	// dragover after a reset (e.g. pointer still over the zone) restores the overlay.
	await act(async () => hook.dropZoneProps.onDragOver(dragEvent(zone)));
	expect(dragging).toBe(true);
});

test("each queued batch restores its own enqueue selection, never a later selection", async () => {
	const pending = deferred<File>();
	const original = png();
	resize.mockImplementation(() => pending.promise);
	let selection = "first insertion";
	const restored: string[] = [];
	const origins: AttachmentInsertionOrigin[] = [];
	const books: AttachmentInsertionBookmark[] = [];
	captureInsertion = (origin) => {
		origins.push(origin);
		const captured = selection;
		const bookmark = {
			restore: mock(() => {
				restored.push(captured);
				return true;
			}),
			cancel: mock(() => {}),
		};
		books.push(bookmark);
		return bookmark;
	};
	const committed: File[][] = [];
	onAcceptedFiles = (files, bookmark) => {
		if (!bookmark?.restore()) return false;
		committed.push(files);
		return true;
	};
	await render();
	let first: Promise<File[]> = Promise.resolve([]);
	let second: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		first = hook.handleComposerPasteImages([original]);
		selection = "second insertion";
		second = hook.ingestFiles([text("second.txt")], "drop");
		selection = "user selected body to keep";
	});
	expect(books).toHaveLength(2);
	expect(committed).toEqual([]);
	await act(async () => {
		pending.resolve(original);
		await Promise.all([first, second]);
	});
	expect(origins).toEqual(["paste", "drop"]);
	expect(restored).toEqual(["first insertion", "second insertion"]);
	expect(committed.map((files) => files[0].name)).toEqual(["image.png", "second.txt"]);
	expect(images).toEqual([]);
	expect(textFiles).toEqual([]);
	for (const book of books) expect(book.cancel).toHaveBeenCalled();
});

test("rejected or externally cancelled bookmarks never fall back to legacy arrays", async () => {
	const pending = deferred<File>();
	resize.mockImplementation(() => pending.promise);
	let cancelled = false;
	const bookmark = {
		restore: mock(() => !cancelled),
		cancel: mock(() => {
			cancelled = true;
		}),
	};
	captureInsertion = () => bookmark;
	onAcceptedFiles = mock((_files, book) => !!book?.restore());
	await render();
	let result: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		result = hook.ingestFiles([png()]);
	});
	bookmark.cancel();
	await act(async () => {
		pending.resolve(png());
		await result;
	});
	expect(await result).toEqual([]);
	expect(onAcceptedFiles).toHaveBeenCalledTimes(1);
	expect(imageCommits).toBe(0);
	expect(textCommits).toBe(0);
});

test("empty picker, invalid files and send-locked ingress consume and cancel their bookmark", async () => {
	const books: { restore: ReturnType<typeof mock>; cancel: ReturnType<typeof mock> }[] = [];
	const origins: AttachmentInsertionOrigin[] = [];
	captureInsertion = (origin) => {
		origins.push(origin);
		const book = { restore: mock(() => true), cancel: mock(() => {}) };
		books.push(book);
		return book;
	};
	onAcceptedFiles = mock(() => true);
	await render();
	await act(async () => {
		hook.handleFileInputChange({ target: { files: [], value: "" } } as unknown as Parameters<
			typeof hook.handleFileInputChange
		>[0]);
		await hook.addImages([text()]);
		sendingRef.current = true;
		await hook.ingestFiles([text()]);
	});
	expect(origins).toEqual(["picker", "direct", "direct"]);
	for (const book of books) {
		expect(book.cancel).toHaveBeenCalled();
		expect(book.restore).not.toHaveBeenCalled();
	}
	expect(onAcceptedFiles).not.toHaveBeenCalled();
});

for (const invalidate of ["scope", "send", "unmount"] as const) {
	test(`${invalidate} invalidation cancels active and queued bookmarks without insertion`, async () => {
		const pending = deferred<File>();
		resize.mockImplementation(() => pending.promise);
		const books: { restore: ReturnType<typeof mock>; cancel: ReturnType<typeof mock> }[] = [];
		captureInsertion = () => {
			const book = { restore: mock(() => true), cancel: mock(() => {}) };
			books.push(book);
			return book;
		};
		onAcceptedFiles = mock(() => true);
		await render();
		let first: Promise<File[]> = Promise.resolve([]);
		let second: Promise<File[]> = Promise.resolve([]);
		await act(async () => {
			first = hook.ingestFiles([png()]);
			second = hook.ingestFiles([text()]);
		});
		if (invalidate === "scope") narratorId = "other";
		if (invalidate === "send") sendingRef.current = true;
		if (invalidate === "unmount") await act(async () => root.unmount());
		else await render();
		await act(async () => {
			await Promise.all([first, second]);
			pending.resolve(png());
		});
		expect(await first).toEqual([]);
		expect(await second).toEqual([]);
		expect(onAcceptedFiles).not.toHaveBeenCalled();
		for (const book of books) {
			expect(book.cancel).toHaveBeenCalled();
			expect(book.restore).not.toHaveBeenCalled();
		}
	});
}

test("unmount cancels waiting work without late state writes", async () => {
	const pending = deferred<File>();
	resize.mockImplementation(() => pending.promise);
	let result: Promise<File[]> = Promise.resolve([]);
	await act(async () => {
		result = hook.ingestFiles([png()]);
	});
	await act(async () => root.unmount());
	await result;
	pending.resolve(png("late.png"));
	await Promise.resolve();
	expect(await result).toEqual([]);
	expect(imageCommits).toBe(0);
});
