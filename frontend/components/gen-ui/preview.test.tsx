import { afterEach, beforeEach, expect, test } from "bun:test";
import { useGenUI } from "@frontend/hooks/useGenUI";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { loadGenUiPreview } from "./preview-loader";
import { createPreviewShell } from "./preview-shell";
import { fileReference, previewResult } from "./test-fixtures";

const originalFetch = globalThis.fetch;
const saved = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let current: ReturnType<typeof useGenUI>;
let requests: { url: string; init?: RequestInit }[];
let nextResponse: ((signal: AbortSignal) => Promise<Response>) | undefined;
let build: number;
function Probe() {
	current = useGenUI("narrator/id", fileReference);
	return current.bundle ? <iframe title="preview" /> : null;
}
function putGlobal(key: string, value: unknown) {
	if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

beforeEach(() => {
	const { window } = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		localStorage: { getItem: () => "private-login-token", removeItem: () => {} },
		IS_REACT_ACT_ENVIRONMENT: true,
	}))
		putGlobal(key, value);
	root = createRoot(document.getElementById("root") as HTMLElement);
	requests = [];
	build = 0;
	nextResponse = undefined;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.includes("/api/")) {
			build++;
			return nextResponse
				? nextResponse(init?.signal as AbortSignal)
				: Response.json(previewResult(`Build ${build}`));
		}
		return new Response(url.endsWith(".js") ? "trustedRuntime()" : ".button{color:blue}");
	}) as typeof fetch;
});
afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});

test("loads a bounded current build with authorization only on the API and refreshes from files", async () => {
	expect(requests).toHaveLength(0);
	await act(async () => root.render(<Probe />));
	expect(current.bundle?.js).toContain("Build 1");
	expect(document.querySelectorAll("iframe")).toHaveLength(1);
	expect(requests[0].url).toBe(
		"/api/narrators/narrator%2Fid/gen-ui/preview/tool%2F1?toolCallId=call%2F1",
	);
	expect(new Headers(requests[0].init?.headers).get("Authorization")).toBe(
		"Bearer private-login-token",
	);
	for (const request of requests.slice(1)) {
		expect(request.init?.credentials).toBe("omit");
		expect(new Headers(request.init?.headers).has("Authorization")).toBe(false);
	}
	await act(async () => current.reload());
	expect(current.bundle?.js).toContain("Build 2");
	expect(build).toBe(2);
});

test("closing/unmounting aborts a pending build and discards a late successful response", async () => {
	let resolve: (response: Response) => void = () => {};
	let signal: AbortSignal | undefined;
	nextResponse = (value) => {
		signal = value;
		return new Promise((done) => {
			resolve = done;
		});
	};
	await act(async () => root.render(<Probe />));
	expect(signal?.aborted).toBe(false);
	await act(async () => root.render(null));
	expect(signal?.aborted).toBe(true);
	await act(async () => resolve(Response.json(previewResult("late"))));
	expect(requests).toHaveLength(1);
	expect(document.querySelector("iframe")).toBeNull();
});

test("refresh drops the old iframe immediately and aborts any obsolete request", async () => {
	await act(async () => root.render(<Probe />));
	let signal: AbortSignal | undefined;
	nextResponse = (value) => {
		signal = value;
		return new Promise((_resolve, reject) =>
			value.addEventListener("abort", () => reject(new Error("aborted"))),
		);
	};
	await act(async () => current.reload());
	expect(current.bundle).toBeNull();
	expect(document.querySelector("iframe")).toBeNull();
	const previous = signal;
	await act(async () => current.reload());
	expect(previous?.aborted).toBe(true);
	expect(signal?.aborted).toBe(false);
});

test("API build diagnostics are visible and malformed/oversize responses are rejected", async () => {
	nextResponse = async () =>
		Response.json({ error: "App.tsx:7: Expected closing tag" }, { status: 422 });
	await act(async () => root.render(<Probe />));
	expect(current.error).toContain("App.tsx:7");
	expect(current.bundle).toBeNull();
	nextResponse = async () => Response.json({ error: "Preview permission denied" }, { status: 401 });
	await expect(loadGenUiPreview("n", fileReference, new AbortController().signal)).rejects.toThrow(
		"Preview permission denied",
	);
	nextResponse = async () => Response.json({ js: "bad" });
	await expect(loadGenUiPreview("n", fileReference, new AbortController().signal)).rejects.toThrow(
		"Invalid preview",
	);
	nextResponse = async () => new Response("x", { headers: { "content-length": "999999999" } });
	await expect(loadGenUiPreview("n", fileReference, new AbortController().signal)).rejects.toThrow(
		"size limit",
	);
});

test("rejects a kit changed between compilation and runtime loading", async () => {
	globalThis.fetch = (async (input) => {
		const url = String(input);
		if (url.endsWith("/bundle"))
			return Response.json({ hash: "new-runtime", js: "runtime()", css: "" });
		if (url.endsWith("/kit")) return Response.json({ status: { hash: "new-runtime" } });
		return Response.json({ ...previewResult(), kit: { hash: "compiled-runtime" } });
	}) as typeof fetch;
	await expect(
		loadGenUiPreview("kit-mismatch", fileReference, new AbortController().signal),
	).rejects.toThrow("component kit changed");
});

test("accepts the exact kit used by the compilation", async () => {
	globalThis.fetch = (async (input) => {
		const url = String(input);
		if (url.endsWith("/bundle"))
			return Response.json({ hash: "same-runtime", js: "runtime()", css: "" });
		if (url.endsWith("/kit")) return Response.json({ status: { hash: "same-runtime" } });
		return Response.json({ ...previewResult(), kit: { hash: "same-runtime" } });
	}) as typeof fetch;
	const preview = await loadGenUiPreview("kit-match", fileReference, new AbortController().signal);
	expect(preview.kitRuntime).toBe(true);
	expect(preview.runtimeJs).toBe("runtime()");
});

test("shell safely embeds JS/CSS with no host credentials and restricted resource connections", () => {
	const js = 'globalThis.test = "</script><script>parent.stolen=1</script>"';
	const css = '/* </style><img src="https://example.invalid/leak"> */';
	const html = createPreviewShell(
		{ ...previewResult(), js, css, runtimeJs: "runtime()", runtimeCss: css },
		{ colorScheme: "dark", tokenCss: ":root{--mantine-color-body:#000}" },
		"Render failed",
	);
	expect(html.match(/<script>/g)).toHaveLength(1);
	expect(html.match(/<\/script>/g)).toHaveLength(1);
	expect(html).not.toContain('<img src="https://example.invalid/leak">');
	expect(html).toContain("\\u003c/script\\u003e");
	expect(html).toContain("default-src 'none'");
	expect(html).toContain("connect-src 'none'");
	expect(html).toContain("MantineCore.v8CssVariablesResolver");
	expect(html).toContain("theme: builtin.theme");
	expect(html).toContain("event.source !== parent");
	expect(html).not.toContain("private-login-token");
	expect(html).not.toContain("narrafork:ui-connect");
});
