/**
 * vlist-user-bubble-header.test.tsx — regression guard for the user-bubble header.
 *
 * The bug this locks down: `resolveRenderExtra` only FORWARDS the adapter's raw
 * `creator` / `createdAt` (the pure render/ layer must not import UserAvatar), so
 * the header node has to be built by the integration layer and attached as
 * `extra.header`. When that injection step is missing, `measureMessageBubble`
 * still reserves USER_HEADER_HEIGHT but `RenderMessageBubble` skips the header
 * (`header != null` is false) — the avatar + username + timestamp row silently
 * vanishes in the virtual list while the classic renderer still shows it.
 *
 * Asserts the injection contract (which kinds/roles get a header) and that the
 * built node actually carries the avatar + name + time, using a real DOM render.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VListElementKind } from "./registry";
import type { RenderExtra } from "./render-registry";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };

// i18n returns raw keys so the fallback username assertion is label-stable.
mock.module("react-i18next", () => ({
	...realReactI18nextModule,
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
// UserAvatar's blob-url hook queries the upload capability; keep it offline.
mock.module("@frontend/hooks/usePlatform", () => ({
	...realUsePlatformModule,
	useUploadCapability: () => ({ serveAvatars: { supported: false } }),
}));

const { injectUserBubbleHeader } = await import("./vlist-user-bubble-header");

const CREATOR = { id: "u1", username: "alice", avatarColor: "#f00", avatarImageId: null };

function userExtra(overrides: RenderExtra = {}): RenderExtra {
	return { role: "user", hasHeader: true, creator: CREATOR, createdAt: null, ...overrides };
}

describe("injectUserBubbleHeader — injection contract", () => {
	test("attaches a header node to a user message-bubble", () => {
		const extra = userExtra();
		injectUserBubbleHeader("message-bubble", extra);
		expect(extra.header).toBeDefined();
	});

	test("skips assistant bubbles (no header row is measured for them)", () => {
		const extra: RenderExtra = { role: "assistant" };
		injectUserBubbleHeader("message-bubble", extra);
		expect(extra.header).toBeUndefined();
	});

	test("skips when hasHeader is false so paint matches the measured height", () => {
		const extra = userExtra({ hasHeader: false });
		injectUserBubbleHeader("message-bubble", extra);
		expect(extra.header).toBeUndefined();
	});

	test("is a no-op for non message-bubble kinds", () => {
		for (const kind of ["markdown", "tool-call", "subagent-card"] as VListElementKind[]) {
			const extra = userExtra();
			injectUserBubbleHeader(kind, extra);
			expect(extra.header).toBeUndefined();
		}
	});

	test("still builds a header when the message carries no creator (own messages)", () => {
		const extra = userExtra({ creator: undefined });
		injectUserBubbleHeader("message-bubble", extra);
		expect(extra.header).toBeDefined();
	});
});

// ── DOM: the injected node paints avatar + username + timestamp ───────────────

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

function setupDom() {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	// The origin badge wraps its icon in a Mantine Tooltip (floating-ui), which
	// schedules through rAF. linkedom provides no animation-frame API, so React's
	// act() cleanup throws without these.
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
		g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as Timer);
	}
	return win.document;
}

/**
 * Render the injected header and return ONLY the header row's own text.
 *
 * MantineProvider emits its responsive stylesheet as a <style> node inside the
 * same subtree, and that CSS contains digits (`35.99375em`). Reading the whole
 * container's textContent would let a "no timestamp" assertion match the
 * stylesheet instead of the header, so scope to the Group root the component
 * renders.
 */
function renderHeader(extra: RenderExtra): string {
	const doc = setupDom();
	injectUserBubbleHeader("message-bubble", extra);
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(<MantineProvider>{extra.header as React.ReactNode}</MantineProvider>);
	});
	const headerRow = currentContainer.querySelector('[class*="mantine-Group-root"]');
	if (!headerRow) throw new Error("expected the header Group row to render");
	return headerRow.textContent ?? "";
}

afterEach(() => {
	if (currentRoot) {
		const root = currentRoot;
		act(() => root.unmount());
		currentRoot = null;
	}
	currentContainer?.remove();
	currentContainer = null;
});

afterAll(() => {
	mock.restore();
});

describe("injectUserBubbleHeader — painted content", () => {
	test("renders the creator username and the avatar initials", () => {
		const text = renderHeader(userExtra());
		expect(text).toContain("alice");
		// UserAvatar falls back to initials when no blob url is available.
		expect(text).toContain("AL");
	});

	test("falls back to the 'you' label when the message has no creator", () => {
		const text = renderHeader(userExtra({ creator: undefined }));
		expect(text).toContain("you");
	});

	test("renders a timestamp when createdAt is present", () => {
		const text = renderHeader(userExtra({ createdAt: "2026-01-01T12:34:00.000Z" }));
		// Locale-dependent formatting; assert the shape (contains a H:MM separator).
		expect(text).toMatch(/\d{1,2}[:.]\d{2}/);
	});

	test("omits the timestamp when createdAt is absent", () => {
		const text = renderHeader(userExtra({ createdAt: null }));
		expect(text).not.toMatch(/\d{1,2}[:.]\d{2}/);
	});

	test("ignores an unparseable createdAt instead of painting 'Invalid Date'", () => {
		const text = renderHeader(userExtra({ createdAt: "not-a-date" }));
		expect(text).not.toContain("Invalid");
	});
});

// ── attribution: the header must not claim the local user wrote everything ────
//
// The header previously read `creator?.username ?? t("you")`, so any message
// without a recorded sender was labelled "you" — including IM-gateway messages
// and every system-injected turn. `origin` / `originLabel` fix that.

describe("injectUserBubbleHeader — origin attribution", () => {
	test("names the source instead of 'you' when there is no account creator", () => {
		const text = renderHeader(
			userExtra({ creator: undefined, originLabel: "gateway:telegram @foo" }),
		);
		expect(text).toContain("origin.source.gateway");
		expect(text).not.toContain("you");
	});

	test("keeps the account username when one is known, and adds the source marker", () => {
		// IM-gateway messages bind to a NarraFork user, so the avatar/name stay and
		// the badge only marks the channel.
		const text = renderHeader(userExtra({ originLabel: "gateway:telegram @foo" }));
		expect(text).toContain("alice");
	});

	test("still says 'you' for a plain in-app message with no recorded sender", () => {
		const text = renderHeader(userExtra({ creator: undefined }));
		expect(text).toContain("you");
	});

	test("labels a system-injected turn by its origin kind when no source is given", () => {
		const text = renderHeader(userExtra({ creator: undefined, origin: "system" }));
		expect(text).toContain("origin.kind.system");
		expect(text).not.toContain("you");
	});

	test("surfaces an unrecognized label rather than dropping the attribution", () => {
		const text = renderHeader(userExtra({ creator: undefined, originLabel: "futureSource:x" }));
		expect(text).toContain("futureSource:x");
	});
});
