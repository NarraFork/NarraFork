import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import {
	ComposerTextAttachmentPreview,
	MAX_COMPOSER_TEXT_PREVIEW_BYTES,
	readComposerTextAttachment,
} from "./ComposerTextAttachmentPreview";

const instance = i18next.createInstance();
await instance.init({
	lng: "en",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
});
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let onClose = mock(() => {});

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	});
	Object.assign(window, { matchMedia });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		matchMedia,
		requestAnimationFrame: (): number => 1,
		cancelAnimationFrame() {},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	onClose = mock(() => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

async function render(
	file: File | undefined,
	name = file?.name ?? "missing.txt",
	mounted = true,
	mediaKind?: "audio" | "video",
) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={instance}>
				<MantineProvider env="test">
					{mounted && (
						<ComposerTextAttachmentPreview
							file={file}
							name={name}
							mediaKind={mediaKind}
							onClose={onClose}
						/>
					)}
				</MantineProvider>
			</I18nextProvider>,
		),
	);
}

function delayedFile(name: string) {
	const pending = Promise.withResolvers<ArrayBuffer>();
	const file = new File(["placeholder"], name);
	spyOn(file, "slice").mockReturnValue({ arrayBuffer: () => pending.promise } as Blob);
	return { file, ...pending };
}

function buffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

describe("bounded attachment text reading", () => {
	test("reads only the byte-limited prefix and leaves the original file unchanged", async () => {
		const content = `${"a".repeat(MAX_COMPOSER_TEXT_PREVIEW_BYTES)}hidden suffix`;
		const file = new File([content], "large.txt");
		const slice = spyOn(file, "slice");
		const result = await readComposerTextAttachment(file);
		expect(slice).toHaveBeenCalledWith(0, MAX_COMPOSER_TEXT_PREVIEW_BYTES);
		expect(result).toEqual({
			text: "a".repeat(MAX_COMPOSER_TEXT_PREVIEW_BYTES),
			truncated: true,
		});
		expect(await file.text()).toBe(content);
	});

	test("preserves complete UTF-8 characters without showing a cut trailing sequence", async () => {
		const content = `${"a".repeat(MAX_COMPOSER_TEXT_PREVIEW_BYTES - 1)}中`;
		expect(await readComposerTextAttachment(new File([content], "utf8.txt"))).toEqual({
			text: "a".repeat(MAX_COMPOSER_TEXT_PREVIEW_BYTES - 1),
			truncated: true,
		});
		expect(await readComposerTextAttachment(new File(["中文\n🙂"], "utf8.txt"))).toEqual({
			text: "中文\n🙂",
			truncated: false,
		});
	});

	test("also bounds displayed UTF-8 bytes after malformed input expands", async () => {
		const file = new File([new Uint8Array(MAX_COMPOSER_TEXT_PREVIEW_BYTES).fill(255)], "bad.txt");
		const result = await readComposerTextAttachment(file);
		expect(result.truncated).toBe(true);
		expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(
			MAX_COMPOSER_TEXT_PREVIEW_BYTES,
		);
	});

	test("does not truncate an exact-limit or empty file", async () => {
		const exact = new File(["a".repeat(MAX_COMPOSER_TEXT_PREVIEW_BYTES)], "exact.txt");
		expect((await readComposerTextAttachment(exact)).truncated).toBe(false);
		expect(await readComposerTextAttachment(new File([], "empty.txt"))).toEqual({
			text: "",
			truncated: false,
		});
	});
});

describe("read-only attachment preview", () => {
	test("renders HTML-like content and names as literal text, never executable markup", async () => {
		const content = '<script>window.previewExecuted = true</script><img src=x onerror="alert(1)">';
		await render(new File([content], "<b>notes.html</b>", { type: "text/html" }));
		expect(document.querySelector("pre")?.textContent).toBe(content);
		expect(document.querySelector("script, img, textarea, [contenteditable=true]")).toBeNull();
		expect(document.body.textContent).toContain("<b>notes.html</b>");
		expect(document.querySelector("pre")?.getAttribute("aria-label")).toBe(
			en.attachments.previewContent,
		);
		await act(async () => document.querySelector<HTMLButtonElement>("button")?.click());
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("shows empty and truncation notices", async () => {
		await render(new File([], "empty.txt"));
		expect(document.body.textContent).toContain(en.attachments.previewEmpty);
		await render(new File(["x".repeat(MAX_COMPOSER_TEXT_PREVIEW_BYTES + 1)], "large.txt"));
		expect(document.body.textContent).toContain("Preview truncated to 256 KiB");
		expect(document.querySelector("pre")?.textContent?.length).toBe(
			MAX_COMPOSER_TEXT_PREVIEW_BYTES,
		);
	});

	test("reports missing and unreadable files without retaining previous content", async () => {
		await render(new File(["previous secret"], "first.txt"));
		await render(undefined);
		expect(document.querySelector("pre")).toBeNull();
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			en.attachments.previewFailed,
		);
		const next = delayedFile("failed.txt");
		await render(next.file);
		expect(document.body.textContent).toContain(en.attachments.previewLoading);
		await act(async () => next.reject(new Error("permission denied")));
		expect(document.body.textContent).toContain(en.attachments.previewFailed);
		expect(document.body.textContent).not.toContain("permission denied");
	});

	test("ignores late completion from a replaced resource, even with the same filename", async () => {
		const first = delayedFile("same.txt");
		const second = delayedFile("same.txt");
		await render(first.file);
		await render(second.file);
		await act(async () => second.resolve(buffer("new content")));
		await act(async () => first.resolve(buffer("stale secret")));
		expect(document.querySelector("pre")?.textContent).toBe("new content");
	});

	test("ignores rejected reads after closing and starts a fresh read on reopening", async () => {
		const first = delayedFile("first.txt");
		await render(first.file);
		await render(first.file, first.file.name, false);
		await act(async () => first.reject(new Error("late failure")));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await render(new File(["fresh content"], "fresh.txt"));
		expect(document.querySelector("pre")?.textContent).toBe("fresh content");
	});

	test("times out a stuck read and ignores its late success", async () => {
		const pending = delayedFile("slow.txt");
		const schedule = globalThis.setTimeout;
		let expire: (() => void) | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign(
				(callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
					if (delay === 10_000) {
						expire = callback as () => void;
						return schedule(() => {}, 0);
					}
					return schedule(callback, delay, ...args);
				},
				schedule,
			),
		);
		try {
			await render(pending.file);
			expect(expire).toBeDefined();
			await act(async () => expire?.());
			expect(document.body.textContent).toContain(en.attachments.previewFailed);
			await act(async () => pending.resolve(buffer("too late")));
			expect(document.querySelector("pre")).toBeNull();
		} finally {
			timer.mockRestore();
		}
	});
});

describe("native composer media playback", () => {
	for (const kind of ["audio", "video"] as const) {
		test(`${kind} previews use native controls without decoding binary as text and revoke on close`, async () => {
			const file = new File([new Uint8Array([255, 0, 128])], `${kind}.mp4`, {
				type: `${kind}/mp4`,
			});
			const slice = spyOn(file, "slice");
			const create = spyOn(URL, "createObjectURL").mockReturnValue(`blob:${kind}-preview`);
			const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
			try {
				await render(file, file.name, true, kind);
				const player = document.querySelector(kind);
				expect(player?.hasAttribute("controls")).toBe(true);
				expect(player?.getAttribute("preload")).toBe("metadata");
				expect(player?.getAttribute("src")).toBe(`blob:${kind}-preview`);
				expect(player?.getAttribute("aria-label")).toBe(file.name);
				expect(document.querySelector("pre")).toBeNull();
				expect(slice).not.toHaveBeenCalled();
				expect(create).toHaveBeenCalledWith(file);
				await render(file, file.name, false, kind);
				expect(revoke).toHaveBeenCalledWith(`blob:${kind}-preview`);
				expect(revoke).toHaveBeenCalledTimes(1);
			} finally {
				slice.mockRestore();
				create.mockRestore();
				revoke.mockRestore();
			}
		});
	}
	test("switching native resources releases the previous URL and text previews recover independently", async () => {
		const audio = new File(["audio"], "same.mp4", { type: "audio/mp4" });
		const video = new File(["video"], "same.mp4", { type: "video/mp4" });
		let sequence = 0;
		const create = spyOn(URL, "createObjectURL").mockImplementation(
			() => `blob:preview-${++sequence}`,
		);
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		try {
			await render(audio, audio.name, true, "audio");
			await render(video, video.name, true, "video");
			expect(document.querySelector("audio")).toBeNull();
			expect(document.querySelector("video")?.getAttribute("src")).toBe("blob:preview-2");
			expect(revoke).toHaveBeenCalledWith("blob:preview-1");
			await render(new File(["readable text"], "notes.txt"));
			expect(document.querySelector("audio, video")).toBeNull();
			expect(document.querySelector("pre")?.textContent).toBe("readable text");
			expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:preview-1", "blob:preview-2"]);
			await render(undefined, "closed", false);
		} finally {
			create.mockRestore();
			revoke.mockRestore();
		}
	});
});
