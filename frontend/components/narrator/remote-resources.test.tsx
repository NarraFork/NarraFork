import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const requests: Array<{ path: string; init?: RequestInit }> = [];
let respond: () => Response | Promise<Response>;
mock.module("@frontend/lib/business-transport", () => ({
	businessTransport: {
		request: async (path: string, init?: RequestInit) => {
			requests.push({ path, init });
			return respond();
		},
	},
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { ImageViewerContext } = await import("../common/image-viewer-context");
const { useResolvedImageSrc } = await import("./vlist/render/vlist-image");
const { MarkdownImage } = await import("./markdown/MarkdownImage");
const { ShareFilePreview } = await import("./vlist/render/ShareFilePreview");
const { MediaAttachment } = await import("./message/MediaAttachment");
const { QueuedImageThumb, EditExistingImageThumb } = await import("./composer/EditAttachmentChips");
const { fetchImageBlob } = await import("./composer/image-clipboard");
const globals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLElement;
let created: ReturnType<typeof spyOn<typeof URL, "createObjectURL">>;
let revoked: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;
let nativeRequests = 0;
let token: string | null = "test-token";

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	Object.assign(window, { matchMedia });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		innerHeight: 800,
		innerWidth: 1200,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		},
		cancelAnimationFrame: () => {},
		localStorage: {
			getItem: () => token,
			removeItem: (key: string) => {
				if (key === "narrafork_token") token = null;
			},
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	requests.length = 0;
	nativeRequests = 0;
	token = "test-token";
	globalThis.fetch = Object.assign(
		async () => {
			nativeRequests++;
			throw new Error("native business bypass");
		},
		{ preconnect: originalFetch.preconnect },
	);
	respond = () => new Response("image", { headers: { "content-type": "image/png" } });
	let id = 0;
	created = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:remote-${++id}`);
	revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	expect(nativeRequests).toBe(0);
	created.mockRestore();
	revoked.mockRestore();
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
async function render(node: ReactNode) {
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<ImageViewerContext.Provider value={{ open() {} }}>{node}</ImageViewerContext.Provider>
			</MantineProvider>,
		);
	});
}
function ImageProbe({
	previewUrl,
	imageId,
	filePath,
}: {
	previewUrl?: string;
	imageId?: string;
	filePath?: string;
}) {
	const result = useResolvedImageSrc({ previewUrl, imageId, filePath }, "session", true);
	return result.src ? <img src={result.src} alt="preview" /> : <span>unavailable</span>;
}

test("upload preview URLs use the authorized transport and revoke the owned blob", async () => {
	await render(<ImageProbe previewUrl="/api/uploads/session/image" />);
	expect(requests).toHaveLength(1);
	expect(requests[0].path).toBe("/api/uploads/session/image");
	expect(new Headers(requests[0].init?.headers).get("Authorization")).toBe("Bearer test-token");
	expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:remote-1");
	await render(null);
	expect(revoked).toHaveBeenCalledWith("blob:remote-1");
	expect(requests[0].init?.signal?.aborted).toBe(true);
});

test.each([
	"https://external.invalid/image.png",
	"//external.invalid/image.png",
	"/api/shares/id/preview",
	"/api/fs/preview?path=/secret",
	"/same-origin.png",
])("stored image source %s never reaches DOM or native fetch", async (source) => {
	await render(
		<>
			<ImageProbe previewUrl={source} filePath="/secret.png" />
			<MarkdownImage src={source} alt="retained alt" />
		</>,
	);
	expect(container.querySelector("img")).toBeNull();
	expect(container.textContent).toContain("retained alt");
	expect(requests).toHaveLength(0);
});

test("stored unsafe source can recover only through an explicit upload id", async () => {
	await render(<ImageProbe previewUrl="https://external.invalid/image.png" imageId="image" />);
	expect(requests.map((request) => request.path)).toEqual(["/api/uploads/session/image"]);
	expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:remote-1");
});

test.each([
	"html",
	"pdf",
	"image",
	"audio",
	"video",
] as const)("historical %s shares keep an unsupported record without iframe, download, or fetch", async (kind) => {
	await render(
		<ShareFilePreview
			preview={{
				kind,
				filename: "old-file",
				mime: "text/html",
				url: "/api/shares/id/preview",
				downloadUrl: "/api/shares/id",
			}}
			height={160}
		/>,
	);
	expect(container.querySelector("[data-remote-unsupported]")?.textContent).toBe("unsupported");
	expect(container.querySelector("iframe,img,a,audio,video")).toBeNull();
	expect(requests).toHaveLength(0);
});

test.each([
	["TOKEN_EXPIRED", JSON.stringify({ code: "TOKEN_EXPIRED" })],
	["codeless 401", JSON.stringify({})],
])("edit attachment preview clears the stale session on %s", async (_label, body) => {
	respond = () =>
		new Response(body, { status: 401, headers: { "content-type": "application/json" } });
	await render(
		<QueuedImageThumb uploadNarratorId="owner" contextNarratorId="session" imageId="expired" />,
	);
	expect(token).toBeNull();
});

test("edit attachment preview keeps the session for a non-session 401", async () => {
	respond = () =>
		new Response(JSON.stringify({ code: "PASSKEY_AUTH_FAILED" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	await render(
		<QueuedImageThumb
			uploadNarratorId="owner"
			contextNarratorId="session"
			imageId="unauthorized"
		/>,
	);
	expect(token).toBe("test-token");
});

test("editor and queued thumbnails route through authorization rather than DOM API src", async () => {
	await render(
		<>
			<QueuedImageThumb uploadNarratorId="owner" contextNarratorId="session" imageId="queued" />
			<EditExistingImageThumb
				block={{
					imageId: "kept",
					previewUrl: "/api/uploads/owner/kept",
					uploadNarratorId: "owner",
				}}
				imageNarratorId="session"
				onRemove={() => {}}
			/>
		</>,
	);
	expect(requests).toHaveLength(2);
	for (const image of container.querySelectorAll("img"))
		expect(image.getAttribute("src")).toStartWith("blob:");
	await render(null);
	expect(revoked).toHaveBeenCalledTimes(2);
});

test("an unbounded media response is cancelled at 8 MiB before any Blob URL is created", async () => {
	let pulls = 0;
	const cancel = mock(() => {});
	respond = () =>
		new Response(
			new ReadableStream(
				{
					pull(controller) {
						pulls++;
						controller.enqueue(new Uint8Array(1024 * 1024));
					},
					cancel,
				},
				{ highWaterMark: 0 },
			),
			{ headers: { "content-type": "video/mp4" } },
		);
	await render(
		<MediaAttachment
			narratorId="session"
			block={{ type: "video", mediaId: "video", filename: "video.mp4" }}
		/>,
	);
	expect(requests).toHaveLength(0);
	await act(async () => container.querySelector("button")?.click());
	expect(pulls).toBe(9);
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(created).not.toHaveBeenCalled();
	expect(container.querySelector("video")).toBeNull();
	expect(container.querySelector("[role=alert]")?.textContent).toBe("mediaPreviewFailed");
});

test("unmount cancels a pending image stream without retaining an object URL", async () => {
	const cancel = mock(() => {});
	respond = () => new Response(new ReadableStream({ cancel }));
	await render(<ImageProbe imageId="pending" />);
	await render(null);
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(created).not.toHaveBeenCalled();
});

test("clipboard denies external and filesystem fallback before touching fetch", async () => {
	await expect(fetchImageBlob({ imageSrc: "https://external.invalid/image.png" })).rejects.toThrow(
		"unavailable",
	);
	await expect(
		fetchImageBlob({ imageSrc: "blob:allowed", savedPath: "/secret.png" }),
	).rejects.toThrow("unavailable");
	expect(requests).toHaveLength(0);
});
