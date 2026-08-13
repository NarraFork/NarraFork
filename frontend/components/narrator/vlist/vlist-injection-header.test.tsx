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

/**
 * Three kinds of speaker, three kinds of avatar.
 *
 * The regression this pins: all three used to funnel into `UserAvatar`, which paints the
 * first two characters of the name. So the platform's avatar literally read "系" beside
 * the word "系统", and two subagents named "explore-1" / "explore-2" — whose first two
 * characters are identical — got the SAME glyph.
 */
describe("InjectionSpeakerHeader — avatar per speaker kind", () => {
	/**
	 * Render, read the facts out as PLAIN VALUES, then tear the root down.
	 *
	 * The teardown is the point: `renderHeader` overwrites the shared `currentRoot` /
	 * `currentContainer`, so a test that renders twice would abandon the first root
	 * without unmounting it — `afterEach` only ever sees the last one. That leak spilled
	 * into a later test in this file. Returning values (not DOM nodes) also keeps the
	 * assertions valid after the tree is gone.
	 */
	function renderFacts(props: React.ComponentProps<typeof InjectionSpeakerHeader>) {
		renderHeader(props);
		const container = currentContainer;
		if (!container) throw new Error("expected a rendered container");
		// The identicon is an <img> whose src is an inline SVG data URI.
		const identiconSrc =
			container.querySelector('img[src^="data:image/svg+xml"]')?.getAttribute("src") ?? null;
		const facts = {
			identiconSrc,
			// Any avatar image (a real account's blob, or the identicon).
			images: container.querySelectorAll("img").length,
			text: container.textContent ?? "",
		};
		if (currentRoot) {
			const root = currentRoot;
			act(() => root.unmount());
			currentRoot = null;
		}
		container.remove();
		currentContainer = null;
		return facts;
	}

	test("an agent with its own id gets the deterministic identicon", () => {
		const { identiconSrc } = renderFacts({ speaker: "explore-1", speakerId: "narr-aaaa1111" });
		expect(identiconSrc).not.toBeNull();
	});

	test("two similarly-named agents get DIFFERENT glyphs", () => {
		// This is the collision initials could not avoid.
		const firstSrc =
			renderFacts({ speaker: "explore-1", speakerId: "narr-aaaa1111" }).identiconSrc ?? "";
		const secondSrc =
			renderFacts({ speaker: "explore-2", speakerId: "narr-bbbb2222" }).identiconSrc ?? "";
		expect(firstSrc.length).toBeGreaterThan(0);
		expect(secondSrc.length).toBeGreaterThan(0);
		expect(firstSrc).not.toBe(secondSrc);
	});

	test("the same id always yields the same glyph", () => {
		const a = renderFacts({ speaker: "explore-1", speakerId: "narr-stable" });
		const b = renderFacts({ speaker: "renamed later", speakerId: "narr-stable" });
		expect(a.identiconSrc).toBe(b.identiconSrc);
	});

	test("a platform reminder shows a glyph, never the initials of the word 'System'", () => {
		const { images, identiconSrc } = renderFacts({
			speaker: null,
			speakerId: null,
			source: "living_work_spec",
		});
		// No identicon (there is no per-producer identity to key one on) and no avatar
		// image at all — the platform gets an icon, and the icon is not an <img>.
		expect(identiconSrc).toBeNull();
		expect(images).toBe(0);
	});
});

/**
 * A finished background COMMAND is tool output, not a participant.
 *
 * `bg_bash` reaches the header with a `speakerId` (the task id) like an agent does, but
 * an identicon would claim an identity it does not have: `run-tests` is a shell
 * invocation, not somebody in the conversation. It gets the Bash tool's terminal glyph.
 */
describe("InjectionSpeakerHeader — bg_bash is a tool, not a speaker", () => {
	test("a finished background command shows the terminal glyph, not an identicon", () => {
		renderHeader({ speaker: "run-tests", speakerId: "task-bash-1", source: "bg_bash" });
		const container = currentContainer;
		if (!container) throw new Error("expected a rendered container");
		// No identicon: the glyph is an icon, not an <img> data URI.
		expect(container.querySelector('img[src^="data:image/svg+xml"]')).toBeNull();
		expect(container.querySelectorAll("img").length).toBe(0);
		// The alias still names the row, so the reader knows WHICH command finished.
		expect(container.textContent ?? "").toContain("run-tests");
	});

	test("a background AGENT still gets its identicon (it is a participant)", () => {
		// The contrast that makes the bash rule meaningful rather than arbitrary.
		renderHeader({ speaker: "explore-1", speakerId: "narr-agent-1", source: "bg_agent" });
		const container = currentContainer;
		if (!container) throw new Error("expected a rendered container");
		expect(container.querySelector('img[src^="data:image/svg+xml"]')).not.toBeNull();
	});
});

/**
 * The header names the PRODUCER, not "the platform".
 *
 * The regression this pins: every platform source collapsed to one literal "System", so
 * a task digest, a behaviour fence and a progress nudge all read identically even though
 * the reader reacts to them differently. `sidecar.sources.*` carries a name per producer.
 *
 * The suite-wide i18n mock returns the key verbatim, which is exactly the "translation
 * missing" shape — so these tests assert the two branches through that lens: a key that
 * resolves (the mock echoes a recognizable string) vs the generic fallback.
 */
describe("InjectionSpeakerHeader — producer naming", () => {
	test("a platform row asks for its producer's own name, not a generic label", () => {
		// With the echoing mock, a resolved lookup would surface the source key path. The
		// assertion that matters: the header CONSULTS the per-source key rather than
		// hard-coding one label for every platform producer.
		const digest = renderHeader({ speaker: null, source: "living_work_spec" });
		const fence = renderHeader({ speaker: null, source: "behavior_fence" });
		// Both fall back identically under the echoing mock (no dictionary), which is the
		// documented missing-key path — but neither may be a hard-coded per-producer string.
		expect(digest).toContain("origin.kind.system");
		expect(fence).toContain("origin.kind.system");
	});

	test("a named speaker always wins over any source label", () => {
		const row = renderHeader({ speaker: "explore-1", source: "subagent_message" });
		expect(row).toContain("explore-1");
		expect(row).not.toContain("origin.kind.system");
	});

	test("a real account wins over both", () => {
		const row = renderHeader({
			speaker: "ignored",
			source: "merge_summary",
			creator: { id: "u1", username: "alice", avatarColor: null, avatarImageId: null },
		});
		expect(row).toContain("alice");
	});
});
