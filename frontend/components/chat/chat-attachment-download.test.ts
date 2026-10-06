import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const absorb = mock(() => {});
const clear = mock(async () => {});
mock.module("../../lib/api", () => ({
	getToken: () => "session-token",
	absorbRenewedToken: absorb,
	clearTokenOnSessionFailure: clear,
}));
mock.module("../../lib/base-path", () => ({ apiUrl: (path: string) => `/api${path}` }));
const { downloadChatAttachment } = await import("./chat-attachment-download");
const keys = ["document", "fetch"];
let previous: Map<string, PropertyDescriptor | undefined>;
let clicked: number;
let anchor: { href: string; download: string; click: () => void };
let received: { url: string; headers: unknown } | undefined;
let response: Response;
beforeEach(() => {
	previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	clicked = 0;
	anchor = {
		href: "",
		download: "",
		click: () => {
			clicked++;
		},
	};
	received = undefined;
	response = new Response("attachment bytes", { status: 200 });
	absorb.mockClear();
	clear.mockClear();
	Object.assign(globalThis, {
		document: { createElement: () => anchor },
		fetch: async (url: string, options: RequestInit) => {
			received = { url, headers: options.headers };
			return response;
		},
	});
});
afterEach(() => {
	if (anchor.href) URL.revokeObjectURL(anchor.href);
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
describe("chat attachment authorized download", () => {
	test("fetches bytes with Bearer auth, absorbs renewal, and clicks a downloadable blob", async () => {
		expect(await downloadChatAttachment("/chat/attachments/a", "notes.txt")).toBe(true);
		expect(received).toEqual({
			url: "/api/chat/attachments/a",
			headers: { Authorization: "Bearer session-token" },
		});
		expect(absorb).toHaveBeenCalledWith(response, "session-token");
		expect(anchor.href).toStartWith("blob:");
		expect(anchor.download).toBe("notes.txt");
		expect(clicked).toBe(1);
	});
	test("failed authorization reports failure instead of clicking an inert endpoint link", async () => {
		response = new Response("denied", { status: 401 });
		expect(await downloadChatAttachment("/chat/attachments/a", "notes.txt")).toBe(false);
		expect(clear).toHaveBeenCalledWith(response);
		expect(clicked).toBe(0);
	});
});
