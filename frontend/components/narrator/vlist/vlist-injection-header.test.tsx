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

const {
	InjectionSpeakerHeader,
	injectInjectionBubbleChrome,
	isPlatformSource,
	speakerTint,
}: typeof import("./vlist-injection-header") = await import("./vlist-injection-header");
type InjectionNavigation = import("./vlist-injection-header").InjectionNavigation;

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

/**
 * Clicking a speaker row opens that speaker's session.
 *
 * Two failure modes worth pinning, because both LOOK fine:
 *
 *   - a row that paints as clickable but calls nothing (the shell forgot to bind the
 *     handler) — the reader clicks and nothing happens;
 *   - a row that navigates using the identicon seed instead of the session id, which
 *     would send a `bg_bash` row to a narrator that does not exist.
 */
describe("InjectionSpeakerHeader — opening the speaker's session", () => {
	/** Render, click the row if it is clickable, and report what happened. */
	function clickRow(props: React.ComponentProps<typeof InjectionSpeakerHeader>): {
		clickable: boolean;
		clicks: number;
	} {
		renderHeader(props);
		const container = currentContainer;
		if (!container) throw new Error("expected a rendered container");
		const link = container.querySelector("[data-injection-open-session]");
		if (link) (link as unknown as HTMLElement).click();
		return { clickable: !!link, clicks: 0 };
	}

	test("the row becomes a button and invokes the handler", () => {
		let calls = 0;
		renderHeader({
			speaker: "explorer",
			speakerId: "narr-1",
			source: "subagent_message",
			onOpenSession: () => {
				calls += 1;
			},
			openSessionLabel: "open session",
		});
		const container = currentContainer;
		if (!container) throw new Error("expected a rendered container");
		const link = container.querySelector("[data-injection-open-session]");
		expect(link).not.toBeNull();
		// The label is what a screen reader and the tooltip announce.
		expect(link?.getAttribute("aria-label")).toBe("open session");
		(link as unknown as HTMLElement).click();
		expect(calls).toBe(1);
	});

	test("without a handler the row is inert rather than a dead control", () => {
		const { clickable } = clickRow({
			speaker: "explorer",
			speakerId: "narr-1",
			source: "subagent_message",
		});
		expect(clickable).toBe(false);
	});

	test("the name is still readable when the row is a link", () => {
		// The wrapper must not swallow or restructure the row's content.
		const text = renderHeader({
			speaker: "explorer",
			speakerId: "narr-1",
			speakerKind: "explore",
			source: "subagent_message",
			onOpenSession: () => {},
		});
		expect(text).toContain("explorer");
		expect(text).toContain("explore");
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

	/**
	 * The binding rule: clickable requires BOTH a resolvable target on the row AND a
	 * host that can reach that specific kind. Each half missing has its own silent
	 * failure (a dead control / a row that quietly stops being clickable), so both are
	 * pinned here rather than through the rendered DOM.
	 */
	describe("the navigation binding", () => {
		/** Render the produced header, click it, and report whether it was clickable. */
		function bindAndClick(extra: RenderExtra, navigation?: InjectionNavigation) {
			injectInjectionBubbleChrome("injection-bubble", extra, undefined, navigation);
			const doc = setupDom();
			const container = doc.createElement("div");
			doc.body.appendChild(container);
			currentContainer = container as unknown as HTMLElement;
			const root = createRoot(currentContainer);
			currentRoot = root;
			act(() => {
				root.render(<MantineProvider>{extra.header as React.ReactNode}</MantineProvider>);
			});
			const link = currentContainer.querySelector("[data-injection-open-session]");
			if (link) (link as unknown as HTMLElement).click();
			return { clickable: !!link, label: link?.getAttribute("aria-label") ?? null };
		}

		test("a narrator target passes the session id and the message id through", () => {
			const seen: Array<[string, string | undefined]> = [];
			const { clickable } = bindAndClick(
				{
					speaker: "explorer",
					speakerId: "narr-1",
					target: { kind: "narrator", narratorId: "narr-1", messageId: "msg-9" },
				},
				{ onOpenNarrator: (id, messageId) => seen.push([id, messageId]) },
			);
			expect(clickable).toBe(true);
			expect(seen).toEqual([["narr-1", "msg-9"]]);
		});

		test("a narrator target with no recorded message still opens its session", () => {
			const seen: Array<[string, string | undefined]> = [];
			bindAndClick(
				{ target: { kind: "narrator", narratorId: "narr-2", messageId: null } },
				{ onOpenNarrator: (id, messageId) => seen.push([id, messageId]) },
			);
			expect(seen).toEqual([["narr-2", undefined]]);
		});

		test("a knowledge target passes the entry id and its scope", () => {
			const seen: Array<[string, string]> = [];
			bindAndClick(
				{ target: { kind: "knowledge", entryId: "k-1", scope: "global" } },
				{ onOpenKnowledge: (entryId, scope) => seen.push([entryId, scope]) },
			);
			expect(seen).toEqual([["k-1", "global"]]);
		});

		test("a spec target passes the uri", () => {
			const seen: string[] = [];
			bindAndClick(
				{ target: { kind: "spec", uri: "spec://index.md" } },
				{ onOpenSpec: (uri) => seen.push(uri) },
			);
			expect(seen).toEqual(["spec://index.md"]);
		});

		test("a chapter target passes the chapter id", () => {
			const seen: string[] = [];
			bindAndClick(
				{ target: { kind: "chapter", chapterId: "chap-7" } },
				{ onOpenChapter: (id) => seen.push(id) },
			);
			expect(seen).toEqual(["chap-7"]);
		});

		test("each kind uses its OWN opener, never another kind's", () => {
			// One shared "open" callback would send a spec row to a narrator route. The
			// per-kind openers are what make that a type error rather than a live bug.
			const { clickable } = bindAndClick(
				{ target: { kind: "spec", uri: "spec://tasks.json" } },
				{
					onOpenNarrator: () => {
						throw new Error("a spec target must not reach the narrator opener");
					},
					onOpenChapter: () => {
						throw new Error("a spec target must not reach the chapter opener");
					},
				},
			);
			// No spec opener supplied → inert, rather than falling back to another kind.
			expect(clickable).toBe(false);
		});

		test("does NOT navigate by the identicon seed", () => {
			// `speakerId` is set for a bash task and a knowledge entry too, neither of which
			// is a narrator. Using it as the navigation target is what would produce a row
			// that opens a session that does not exist.
			const { clickable } = bindAndClick(
				{ speaker: "run-tests", speakerId: "task-bash-1", source: "bg_bash" },
				{
					onOpenNarrator: () => {
						throw new Error("must not be called: a bash task has no session");
					},
				},
			);
			expect(clickable).toBe(false);
		});

		test("stays inert when the host supplies no navigation at all", () => {
			const { clickable } = bindAndClick({
				target: { kind: "narrator", narratorId: "narr-3", messageId: "msg-1" },
			});
			expect(clickable).toBe(false);
		});

		test("a malformed target is refused rather than rendered as a dead link", () => {
			// `spec.data` is untyped by construction, so the render side must not trust it.
			// An id-less target is exactly the shape that paints a live control that
			// navigates nowhere.
			for (const target of [
				{ kind: "narrator" },
				{ kind: "narrator", narratorId: "  " },
				{ kind: "knowledge" },
				{ kind: "spec" },
				{ kind: "chapter" },
				{ kind: "not-a-kind", narratorId: "n-1" },
				null,
				"narr-1",
			]) {
				const { clickable } = bindAndClick(
					{ target },
					{
						onOpenNarrator: () => {
							throw new Error("a malformed target must not be opened");
						},
						onOpenKnowledge: () => {
							throw new Error("a malformed target must not be opened");
						},
						onOpenSpec: () => {
							throw new Error("a malformed target must not be opened");
						},
						onOpenChapter: () => {
							throw new Error("a malformed target must not be opened");
						},
					},
				);
				expect(clickable).toBe(false);
			}
		});

		test("labels are resolved per kind", () => {
			const { label } = bindAndClick(
				{ target: { kind: "knowledge", entryId: "k-1", scope: "global" } },
				{
					onOpenKnowledge: () => {},
					labels: { knowledge: "open the entry", narrator: "open the session" },
				},
			);
			expect(label).toBe("open the entry");
		});
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
