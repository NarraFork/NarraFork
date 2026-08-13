/**
 * vlist-injection-header.test.tsx — who an injection bubble says is speaking.
 *
 * The bubble's whole premise is "somebody other than the reader said this", so the
 * identity in its header is load-bearing rather than decoration. Three distinct kinds of
 * speaker have to stay distinguishable:
 *
 *   - a real ACCOUNT (a merge is authored by whoever pressed the button) → that person's
 *     name and their actual avatar. Drawing an initials placeholder for a real account is
 *     the mirror image of the "System" bug this replaced.
 *   - the PLATFORM (a container came up, the scheduler pushed the next task) → one shared
 *     identity, because coining "Container" and "Scheduler" as participants would imply a
 *     cast of actors that does not exist.
 *   - an AGENT or task that named itself → its own name on a deterministic tint.
 *
 * And the fallback must never be "System": a nameless sender is an unknown participant,
 * and labelling it as the system erases the fact that somebody spoke.
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

// i18n returns raw keys so the label assertions are translation-stable.
mock.module("react-i18next", () => ({
	...realReactI18nextModule,
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
mock.module("@frontend/hooks/usePlatform", () => ({
	...realUsePlatformModule,
	useUploadCapability: () => ({ serveAvatars: { supported: false } }),
}));

const { InjectionSpeakerHeader, injectInjectionBubbleChrome, isPlatformSource, speakerTint } =
	await import("./vlist-injection-header");

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
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
		g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as Timer);
	}
	return win.document;
}

function renderHeader(props: React.ComponentProps<typeof InjectionSpeakerHeader>): string {
	const doc = setupDom();
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<MantineProvider>
				<InjectionSpeakerHeader {...props} />
			</MantineProvider>,
		);
	});
	const row = currentContainer.querySelector('[class*="mantine-Group-root"]');
	if (!row) throw new Error("expected the speaker row to render");
	return row.textContent ?? "";
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

const ACCOUNT = { id: "u1", username: "alice", avatarColor: "#f00", avatarImageId: null };

describe("InjectionSpeakerHeader — identity resolution", () => {
	test("a real account wins: its own name, not a coined one", () => {
		// merge_summary is authored by whoever pressed merge, and `creator` is already
		// loaded for system rows — so the row can name a real person.
		const text = renderHeader({ creator: ACCOUNT, source: "merge_summary", speaker: null });
		expect(text).toContain("alice");
		// Initials come from the account name, not from a producer tag.
		expect(text).toContain("AL");
	});

	test("an account wins even over a supplied speaker label", () => {
		const text = renderHeader({ creator: ACCOUNT, speaker: "merge_summary", source: null });
		expect(text).toContain("alice");
	});

	test("platform producers share ONE identity instead of a name per event", () => {
		for (const source of ["container_ready", "spec_continuation", "browser_session_lost"]) {
			const text = renderHeader({ source, speaker: null, creator: null });
			expect(text).toContain("origin.kind.system");
		}
	});

	test("an agent that named itself keeps its own name", () => {
		const text = renderHeader({ speaker: "explorer", source: "subagent_message" });
		expect(text).toContain("explorer");
		expect(text).not.toContain("origin.kind.system");
	});

	test("a nameless sender is UNKNOWN, never the system", () => {
		// Calling it "System" would erase the one fact the bubble exists to state.
		const text = renderHeader({ speaker: null, source: "subagent_message" });
		expect(text).toContain("sidecar.body.messageFromUnknown");
		expect(text).not.toContain("origin.kind.system");
	});

	test("shows the secondary descriptor and the broadcast marker", () => {
		const text = renderHeader({
			speaker: "alice",
			speakerKind: "primary",
			isBroadcast: true,
			source: "team_message",
		});
		expect(text).toContain("primary");
		expect(text).toContain("sidecar.body.messageBroadcast");
	});
});

describe("isPlatformSource", () => {
	test("recognizes platform-authored producers", () => {
		expect(isPlatformSource("container_ready")).toBe(true);
		expect(isPlatformSource("spec_continuation")).toBe(true);
	});

	test("does not claim agent or human producers", () => {
		for (const source of ["subagent_message", "team_message", "bg_agent", "merge_summary"]) {
			expect(isPlatformSource(source)).toBe(false);
		}
		expect(isPlatformSource(null)).toBe(false);
		expect(isPlatformSource(undefined)).toBe(false);
	});
});

describe("speakerTint", () => {
	test("is stable per name, so one agent reads as one participant", () => {
		expect(speakerTint("explorer")).toBe(speakerTint("explorer"));
	});

	test("returns a colour from the palette, never an invented value", () => {
		// Deliberately NOT "different names get different colours": with a fixed 5-colour
		// palette, ~20% of name pairs must collide by pigeonhole. The tint is a memory aid
		// for "same agent again", not an identity — identity is the NAME beside it. An
		// earlier version of this test asserted the impossible and failed on the first two
		// names tried (explorer / planner both hash to cyan).
		const seen = new Set(
			["explorer", "planner", "reviewer", "run-tests", "fmt", "alice"].map((n) => speakerTint(n)),
		);
		for (const tint of seen) expect(tint).toMatch(/^var\(--mantine-color-[a-z]+-6\)$/);
		// The palette is actually being spread, not collapsing to one colour.
		expect(seen.size).toBeGreaterThan(1);
	});
});

describe("injectInjectionBubbleChrome", () => {
	test("attaches the header and forwards the note only when one was measured", () => {
		const withNote: RenderExtra = { hasNote: true, speaker: "fmt" };
		injectInjectionBubbleChrome("injection-bubble", withNote, "truncated");
		expect(withNote.header).toBeDefined();
		expect(withNote.noteText).toBe("truncated");

		const withoutNote: RenderExtra = { speaker: "fmt" };
		injectInjectionBubbleChrome("injection-bubble", withoutNote, "truncated");
		expect(withoutNote.header).toBeDefined();
		expect(withoutNote.noteText).toBeUndefined();
	});

	test("is a no-op for every other kind", () => {
		for (const kind of ["message-bubble", "markdown", "tool-call"] as VListElementKind[]) {
			const extra: RenderExtra = { speaker: "fmt" };
			injectInjectionBubbleChrome(kind, extra, "truncated");
			expect(extra.header).toBeUndefined();
		}
	});
});
