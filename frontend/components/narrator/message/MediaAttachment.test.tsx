import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	AUDIO_ATTACHMENT_HEIGHT,
	VIDEO_ATTACHMENT_HEIGHT,
} from "@shared/pretext-layout/media-attachment-layout";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import { MediaAttachment, PendingMediaAttachment } from "./MediaAttachment";

const instance = i18next.createInstance();
await instance.init({
	lng: "en",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
});
const globals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLDivElement;
let requests: Array<{ url: URL; options?: RequestInit }>;
let response: () => Response | Promise<Response>;
let created: ReturnType<typeof spyOn<typeof URL, "createObjectURL">>;
let revoked: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;

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
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		matchMedia,
		localStorage: { getItem: () => "test-token" },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	requests = [];
	response = () => new Response("media", { headers: { "content-type": "video/mp4" } });
	globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
		requests.push({ url: new URL(String(input), "http://test"), options });
		return response();
	}) as typeof fetch;
	let id = 0;
	created = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++id}`);
	revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	created.mockRestore();
	revoked.mockRestore();
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

function media(type: "audio" | "video" = "video", overrides = {}) {
	return {
		type,
		mediaId: `${type}/id`,
		filename: `${type}.mp4`,
		mediaType: `${type}/mp4`,
		uploadNarratorId: "original/owner",
		...overrides,
	};
}

async function render(children: ReactNode) {
	await act(async () => {
		root.render(
			<StrictMode>
				<I18nextProvider i18n={instance}>
					<MantineProvider env="test">{children}</MantineProvider>
				</I18nextProvider>
			</StrictMode>,
		);
	});
}

async function clickPreview() {
	const button = container.querySelector("button");
	expect(button).not.toBeNull();
	await act(async () => button?.click());
}

const cases = [
	["audio", AUDIO_ATTACHMENT_HEIGHT],
	["video", VIDEO_ATTACHMENT_HEIGHT],
] as const;

describe("explicit authenticated media preview", () => {
	test.each(
		cases,
	)("mounting and remounting %s stays idle at a stable height", async (type, height) => {
		const attachment = <MediaAttachment narratorId="panel" block={media(type)} />;
		await render(attachment);
		expect(container.querySelector("button")?.textContent).toBe(en.mediaPreviewLoad);
		expect(container.querySelector("button")?.parentElement?.parentElement?.style.height).toBe(
			`${height}px`,
		);
		expect(container.querySelector("audio, video, [role=status]")).toBeNull();
		await render(null);
		await render(attachment);
		expect(requests).toHaveLength(0);
		expect(created).not.toHaveBeenCalled();
	});

	test.each(
		cases,
	)("click loads %s once with auth and cross-owner context", async (type, height) => {
		const pending = Promise.withResolvers<Response>();
		response = () => pending.promise;
		await render(<MediaAttachment narratorId="panel/id" block={media(type)} />);
		await clickPreview();
		expect(requests).toHaveLength(1);
		expect(requests[0].url.pathname).toBe(`/api/uploads/original%2Fowner/media/${type}%2Fid`);
		expect(requests[0].url.searchParams.get("referencingNarratorId")).toBe("panel/id");
		expect(new Headers(requests[0].options?.headers).get("authorization")).toBe(
			"Bearer test-token",
		);
		expect(container.querySelector("[role=status]")?.textContent).toBe(en.mediaPreviewLoading);
		expect(container.querySelector("button")).toBeNull();
		await act(async () => pending.resolve(new Response("media")));
		const player = container.querySelector(type);
		expect(player?.getAttribute("src")).toBe("blob:test-1");
		expect(player?.hasAttribute("controls")).toBe(true);
		expect(player?.parentElement?.style.height).toBe(`${height}px`);
		await render(null);
		expect(requests[0].options?.signal?.aborted).toBe(true);
		expect(revoked).toHaveBeenCalledTimes(1);
		expect(revoked).toHaveBeenCalledWith("blob:test-1");
		await render(<MediaAttachment narratorId="panel/id" block={media(type)} />);
		expect(requests).toHaveLength(1);
		expect(container.querySelector("button")?.textContent).toBe(en.mediaPreviewLoad);
	});

	test("owner-local requests omit referencing context and source replacement stays idle", async () => {
		await render(
			<MediaAttachment
				narratorId="owner"
				block={media("audio", { uploadNarratorId: undefined })}
			/>,
		);
		await clickPreview();
		expect(requests[0].url.pathname).toBe("/api/uploads/owner/media/audio%2Fid");
		expect(requests[0].url.search).toBe("");
		await render(
			<MediaAttachment narratorId="owner" block={media("audio", { mediaId: "other" })} />,
		);
		expect(revoked).toHaveBeenCalledTimes(1);
		expect(revoked).toHaveBeenCalledWith("blob:test-1");
		expect(container.querySelector("audio")).toBeNull();
		expect(container.querySelector("button")?.textContent).toBe(en.mediaPreviewLoad);
		expect(requests).toHaveLength(1);
	});

	test("unmount aborts the request and ignores a late response without reading its body", async () => {
		const pending = Promise.withResolvers<Response>();
		response = () => pending.promise;
		await render(<MediaAttachment narratorId="panel" block={media()} />);
		await clickPreview();
		expect(requests[0].options?.signal?.aborted).toBe(false);
		await render(null);
		expect(requests[0].options?.signal?.aborted).toBe(true);
		const late = new Response("late");
		const blob = spyOn(late, "blob");
		await act(async () => pending.resolve(late));
		expect(blob).not.toHaveBeenCalled();
		expect(created).not.toHaveBeenCalled();
	});

	test("a source change during blob reading aborts and discards the old body", async () => {
		const body = Promise.withResolvers<Blob>();
		const first = new Response("first");
		spyOn(first, "blob").mockReturnValue(body.promise);
		response = () => first;
		await render(<MediaAttachment narratorId="panel" block={media()} />);
		await clickPreview();
		await render(<MediaAttachment narratorId="other-panel" block={media()} />);
		expect(requests[0].options?.signal?.aborted).toBe(true);
		await act(async () => body.resolve(new Blob(["old body"])));
		expect(created).not.toHaveBeenCalled();
		expect(requests).toHaveLength(1);
		expect(container.querySelector("button")?.textContent).toBe(en.mediaPreviewLoad);
	});

	test("download failure offers an explicit retry, not an automatic request", async () => {
		response = () => new Response("denied", { status: 403 });
		await render(<MediaAttachment narratorId="panel" block={media()} />);
		await clickPreview();
		expect(container.querySelector("[role=alert]")?.textContent).toBe(en.mediaPreviewFailed);
		expect(container.querySelector("button")?.textContent).toBe(en.mediaPreviewRetry);
		expect(requests).toHaveLength(1);
		expect(created).not.toHaveBeenCalled();
		response = () => new Response("retried");
		await clickPreview();
		expect(requests).toHaveLength(2);
		expect(requests[0].options?.signal?.aborted).toBe(true);
		expect(container.querySelector("video")?.getAttribute("src")).toBe("blob:test-1");
	});

	test("playback failures can reload and release the failed download URL", async () => {
		await render(<MediaAttachment narratorId="panel" block={media()} />);
		await clickPreview();
		await act(async () =>
			container.querySelector("video")?.dispatchEvent(new window.Event("error")),
		);
		expect(container.querySelector("[role=alert]")?.textContent).toBe(en.mediaPreviewFailed);
		await clickPreview();
		expect(revoked).toHaveBeenCalledTimes(1);
		expect(revoked).toHaveBeenCalledWith("blob:test-1");
		expect(requests).toHaveLength(2);
		expect(container.querySelector("video")?.getAttribute("src")).toBe("blob:test-2");
	});

	test("existing local blob previews are immediately usable without downloading or revoking borrowed URLs", async () => {
		await render(
			<MediaAttachment narratorId="panel" block={media("audio", { previewUrl: "blob:local" })} />,
		);
		expect(container.querySelector("audio")?.getAttribute("src")).toBe("blob:local");
		expect(container.querySelector("button")).toBeNull();
		await render(null);
		expect(requests).toHaveLength(0);
		expect(created).not.toHaveBeenCalled();
		expect(revoked).not.toHaveBeenCalled();
	});

	test("pending local Files preview immediately and release their own URLs on replacement and unmount", async () => {
		const file = new File(["audio"], "recording.mp3", { type: "audio/mpeg" });
		await render(<PendingMediaAttachment file={file} />);
		const localUrl = container.querySelector("audio")?.getAttribute("src");
		expect(localUrl).toStartWith("blob:test-");
		expect(created).toHaveBeenLastCalledWith(file);
		const createdCount = created.mock.calls.length;
		await render(<PendingMediaAttachment file={file} />);
		expect(created).toHaveBeenCalledTimes(createdCount);
		expect(container.querySelector("audio")?.getAttribute("src")).toBe(localUrl);
		const replacement = new File(["video"], "clip.mp4", { type: "video/mp4" });
		await render(<PendingMediaAttachment file={replacement} />);
		expect(revoked).toHaveBeenCalledWith(localUrl);
		expect(created).toHaveBeenLastCalledWith(replacement);
		const replacementUrl = container.querySelector("video")?.getAttribute("src");
		await render(null);
		expect(revoked).toHaveBeenCalledWith(replacementUrl);
		expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length);
		expect(requests).toHaveLength(0);
	});
});
