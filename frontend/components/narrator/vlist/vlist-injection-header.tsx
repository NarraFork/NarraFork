/**
 * vlist-injection-header.tsx — speaker row for an injection bubble.
 *
 * Same seam as `vlist-user-bubble-header`: the adapter carries height-neutral speaker
 * data on the spec, and the pure render/ layer forwards it without knowing what an
 * avatar is (that layer stays dependency-free so measure/render parity is auditable).
 * Building the node is the integration layer's job, and this module owns it.
 *
 * ## Why a non-human speaker still gets an avatar
 *
 * A subagent and a teammate occupy the same role in the conversation — somebody who
 * sent you something — so they get the same shape of header. What differs is the
 * identity glyph: a person has an account avatar, while a subagent or a background
 * task has only a name, so it gets initials on a deterministic tint. Using a person's
 * avatar component for both would claim an account that does not exist.
 */

import { NarratorAvatar } from "@frontend/components/narrator/NarratorAvatar";
import { UserAvatar } from "@frontend/components/UserAvatar";
import { Badge, Box, Group, Text, ThemeIcon } from "@mantine/core";
import {
	coerceInjectionTarget,
	type InjectionTarget,
} from "@shared/pretext-layout/injection-target";
import { PLATFORM_INJECTION_SOURCES as ADAPTER_PLATFORM_SOURCES } from "@shared/pretext-layout/segment-adapter";
import { IconBook2, IconChecklist, IconSparkles, IconTerminal2 } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ReminderFrequencySettings } from "./ReminderFrequencySettings";
import type { VListElementKind } from "./registry";
import type { RenderExtra } from "./render-registry";
import type { BubbleCreator } from "./vlist-user-bubble-header";

/**
 * Deterministic tint for a non-account speaker.
 *
 * Same name → same colour for the whole session, so several messages from one subagent
 * read as one participant. Height-neutral chrome.
 */
const SPEAKER_TINTS = [
	"var(--mantine-color-teal-6)",
	"var(--mantine-color-violet-6)",
	"var(--mantine-color-blue-6)",
	"var(--mantine-color-grape-6)",
	"var(--mantine-color-cyan-6)",
];

export function speakerTint(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return SPEAKER_TINTS[hash % SPEAKER_TINTS.length] as string;
}

/**
 * Speaker row: identity glyph + name + an optional broadcast marker.
 *
 * Sized to `INJECTION_HEADER_HEIGHT` by the measure pass, so everything here must be a
 * single line. The name truncates rather than wrapping — a long subagent title must not
 * change a committed row's height.
 */
/**
 * Producer tags whose speaker is the PLATFORM itself, not a person or an agent.
 *
 * A container coming up, a browser session dying, the scheduler pushing the next task —
 * these are things NarraFork says. They get one shared identity rather than a coined
 * name per event type, because inventing "Container" and "Scheduler" as participants
 * would imply a cast of actors that does not exist.
 *
 * ⚠️ The routine-reminder half is IMPORTED from the adapter rather than re-listed. This
 * file used to keep its own copy, and the two silently diverged the moment the platform
 * reminders became bubbles: the adapter routed `living_work_spec` as platform-authored
 * while this list had never heard of it, so every task digest rendered as "unknown
 * sender". One owner, one list.
 */
const PLATFORM_SOURCES = new Set([
	// Rows the adapter itself classifies as platform-authored reminders.
	...ADAPTER_PLATFORM_SOURCES,
	// Framed system cards + plain notices, which reach the header the same way but are
	// routed by block type rather than by injection source.
	"container_ready",
	"browser_session_lost",
	"spec_continuation",
	"spec_blocked_continuation",
	// A concluded review is announced BY the platform: the reviewer is a separate
	// chapter with its own narrator, and this row is NarraFork reporting its verdict
	// rather than that narrator speaking here. Missing from this list, it fell through
	// to "unknown sender" — which is what the reader actually saw on every review.
	"review_feedback",
	// ⚠️ These three do NOT reach this header yet, and their `sidecar.sources.*` keys are
	// therefore unused TODAY — do not delete either as orphans. The adapter deliberately
	// keeps them as standalone `system-text` cards because their buttons are wired by
	// matching that kind (see segment-adapter's FRAMED_SPEC_TASK_CARDS note); routing them
	// through `injection-bubble` before the action-injection seam reaches a nested payload
	// would silently unwire every button. Listed here so that when the seam lands, the
	// header names its producer instead of falling back to the generic "System".
	"spec_goal_added",
	"spec_fork_carryover",
	"spec_context_cleared",
	"info",
	"error",
]);

/** True when this producer speaks as the platform. */
export function isPlatformSource(source: string | null | undefined): boolean {
	return !!source && PLATFORM_SOURCES.has(source);
}

/**
 * Producers that speak FOR the Dynamic Spec, so they can wear the spec panel's own
 * icon and accent instead of the generic platform sparkle. The reader should see the
 * same object language in the row as in the panel it refers to.
 */
const SPEC_SOURCES = new Set([
	"spec_update",
	"living_work_spec",
	"todo_reminder",
	"spec_continuation",
	"spec_blocked_continuation",
	"spec_goal_added",
	"spec_fork_carryover",
	"spec_context_cleared",
]);

export function isSpecSource(source: string | null | undefined): boolean {
	return !!source && SPEC_SOURCES.has(source);
}

/**
 * Producers whose "speaker" is a knowledge-base ENTRY, not an agent.
 *
 * A knowledge hit reaches this header with a `speakerId` (the entry id) exactly like a
 * subagent does, so it used to land in the identicon branch — every injected entry wore a
 * randomly-generated glyph. That claims the wrong thing twice over: an identicon is this
 * app's mark for "a participant with its own session", and the pattern itself carries no
 * meaning a reader can use, while the object being cited already HAS a recognizable icon
 * everywhere else it appears (the nav item, the entry cards, the knowledge panel tab).
 *
 * So this is the same rule `bg_bash` follows — a non-participant gets its object's glyph
 * rather than an invented identity — and the glyph is chosen to match the knowledge
 * surfaces the row links to.
 */
const KNOWLEDGE_SOURCES = new Set(["knowledge_base_hint"]);

export function isKnowledgeSource(source: string | null | undefined): boolean {
	return !!source && KNOWLEDGE_SOURCES.has(source);
}

export function InjectionSpeakerHeader({
	speaker,
	speakerId,
	speakerKind,
	isBroadcast,
	creator,
	source,
	onOpenSession,
	openSessionLabel,
	narratorId,
}: {
	speaker?: string | null;
	/**
	 * The speaker's own id (a subagent narrator id, a background task id, a knowledge
	 * entry id). Seeds the identicon ONLY for producers that are actual participants —
	 * a command (`bg_bash`) and a document (`knowledge_base_hint`) carry an id too but
	 * are routed to their object's glyph instead. Absent for the platform and for real
	 * accounts, which have their own avatar treatments.
	 */
	speakerId?: string | null;
	/**
	 * Secondary descriptor beside the name. Carries a participant TYPE for inbound
	 * messages (`primary` / `subagent`) and a task STATUS for background completions —
	 * two different semantics in one slot, because both answer "what kind of speaker is
	 * this" at a glance. Anything added here must make sense for both.
	 */
	speakerKind?: string | null;
	isBroadcast?: boolean;
	/**
	 * The real account behind this row, when there is one (`merge_summary` is authored by
	 * whoever pressed merge). Present → the header shows that person's actual avatar
	 * instead of an initials placeholder, because they ARE an account and claiming
	 * otherwise would be the mirror image of the "System" bug this replaced.
	 */
	creator?: BubbleCreator | null;
	/** Producer tag, used only to recognize platform-authored rows. */
	source?: string | null;
	/**
	 * Open the speaker's own session (and jump to the message this row refers to).
	 *
	 * Supplied only for rows whose speaker really has one — a subagent that sent a
	 * message, a background AGENT that finished — and only by hosts that own a dockview
	 * surface. Absent leaves the row inert rather than offering a control that does
	 * nothing, the same rule the tool-card "open session" item follows.
	 */
	onOpenSession?: () => void;
	/** Localized tooltip / aria label for that affordance. */
	openSessionLabel?: string;
	/** Owning session, not the speaker's session; enables reminder frequency controls. */
	narratorId?: string;
}) {
	const { t } = useTranslation("narrator");
	// Identity resolution, in priority order:
	//   1. a real account (merge_summary) → that person's name and avatar
	//   2. the platform (container / scheduler / browser) → one shared NarraFork identity
	//   3. an agent or task that named itself → its own name, initials avatar
	//   4. nothing → an UNKNOWN participant, never "System": the row exists because
	//      somebody other than the reader spoke, and calling that the system would erase
	//      it and blur into the neutral notice cards.
	const platform = isPlatformSource(source);
	/**
	 * A platform row names its PRODUCER, not the platform.
	 *
	 * This used to collapse every platform source to one literal "System", so a task
	 * digest, a behaviour fence and a progress nudge — three different things the reader
	 * reacts to differently — were indistinguishable in the header. `sidecar.sources.*`
	 * already carries a name per producer ("任务摘要", "行为护栏", "进度提醒"); only fall
	 * back to the generic label when a producer has none, which is now a missing-key
	 * signal rather than the normal case.
	 */
	const sourceName = (() => {
		if (!source) return null;
		const key = `sidecar.sources.${source}`;
		const label = t(key);
		// i18next returns the key itself when the translation is missing.
		return label && label !== key ? label : null;
	})();
	const name = creator?.username?.trim()
		? creator.username
		: platform
			? // A platform row names its producer; the generic label is the missing-key path.
				(sourceName ?? t("origin.kind.system"))
			: // A non-platform producer normally names its speaker (a subagent title, a bash
				// alias). With no speaker, its SOURCE name still says what spoke — better than
				// "unknown sender", which is only right when nothing identifies the row at all.
				speaker?.trim() || sourceName || t("sidecar.body.messageFromUnknown");
	const row = (
		<Group gap={6} wrap="nowrap" h="100%" align="center">
			{/*
			 * Four kinds of speaker, four kinds of avatar. All of them used to funnel into
			 * UserAvatar, which renders the first two characters of the name — so the
			 * platform's avatar literally read "系"/"Sy" next to the word "系统", and two
			 * subagents called "explore-1" / "explore-2" got the SAME glyph.
			 */}
			{creator?.id ? (
				// A real account (a person pressed merge): their actual avatar.
				<UserAvatar
					username={name}
					avatarColor={creator.avatarColor ?? speakerTint(name)}
					avatarImageId={creator.avatarImageId ?? null}
					userId={creator.id}
					size={20}
					showTooltip={false}
				/>
			) : platform ? (
				/*
				 * The platform itself: a glyph, not initials of the word "System".
				 *
				 * Spec-family producers borrow the Dynamic Spec panel's OWN icon and accent
				 * (see SpecPanel's IconChecklist / indigo). A generic sparkle here made the
				 * row look unrelated to the panel the reader had just been editing, even
				 * though it is reporting exactly that file.
				 */
				<ThemeIcon
					size={20}
					radius="xl"
					variant="light"
					color={isSpecSource(source) ? "indigo" : "gray"}
				>
					{isSpecSource(source) ? <IconChecklist size={12} /> : <IconSparkles size={12} />}
				</ThemeIcon>
			) : isKnowledgeSource(source) ? (
				/*
				 * A cited knowledge ENTRY, which is a document rather than a participant.
				 *
				 * Same glyph and accent the knowledge surfaces use for a global entry (the
				 * entry cards on `/knowledge`, the knowledge panel tab this row opens), so
				 * the reader recognizes the object instead of decoding a random identicon
				 * pattern that means nothing.
				 */
				<ThemeIcon size={20} radius="sm" variant="light" color="blue">
					<IconBook2 size={12} />
				</ThemeIcon>
			) : source === "bg_bash" ? (
				/*
				 * A finished background command is TOOL OUTPUT, not a participant. Giving it
				 * an identicon claimed an identity it does not have — `run-tests` is a shell
				 * invocation, not somebody in the conversation. It gets the same terminal
				 * glyph the Bash tool card uses, so the reader reads "this is a command's
				 * result" rather than "this is a new speaker".
				 */
				<ThemeIcon size={20} radius="sm" variant="light" color="gray">
					<IconTerminal2 size={12} />
				</ThemeIcon>
			) : speakerId ? (
				// An AGENT with its own session id: the deterministic identicon, which stays
				// distinct where initials collide. Non-participants (a command, a document)
				// are routed to their object's glyph above rather than reaching this branch.
				<NarratorAvatar narratorId={speakerId} title={name} size={20} showTooltip={false} />
			) : (
				// No id to key a glyph on: fall back to initials rather than inventing one.
				<UserAvatar username={name} avatarColor={speakerTint(name)} size={20} showTooltip={false} />
			)}
			<Text size="xs" c="dimmed" fw={600} truncate>
				{name}
			</Text>
			{speakerKind ? (
				<Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap", opacity: 0.75 }}>
					{speakerKind}
				</Text>
			) : null}
			{isBroadcast ? (
				<Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
					{t("sidecar.body.messageBroadcast")}
				</Badge>
			) : null}
		</Group>
	);
	const identity = onOpenSession ? (
		<OpenSessionHeaderLink label={openSessionLabel ?? name} onOpen={onOpenSession}>
			{row}
		</OpenSessionHeaderLink>
	) : (
		row
	);
	if (!narratorId || (source !== "living_work_spec" && source !== "silent_progress")) {
		return identity;
	}
	return (
		<Group gap={6} wrap="nowrap" h="100%">
			<Box style={{ flex: 1, minWidth: 0, height: "100%", overflow: "hidden" }}>{identity}</Box>
			<ReminderFrequencySettings source={source} narratorId={narratorId} />
		</Group>
	);
}

/**
 * Makes a speaker row open its speaker's session.
 *
 * ## Why the whole row, and not an icon button beside the name
 *
 * The row IS the identity, and "who said this" / "show me where they said it" are one
 * question — a separate control would put two affordances for one intent inside a lane
 * that is exactly one line tall.
 *
 * ## Height neutrality is load-bearing
 *
 * The measure pass already committed `INJECTION_HEADER_HEIGHT` for this lane and never
 * learns whether the row is a link, so the wrapper must add nothing to the box: it
 * fills the reserved height (`height: 100%`) with no padding, no border, and hover
 * feedback expressed as a background tint. An underline or a border would move the
 * text baseline inside a box whose height is already fixed.
 *
 * Hover lives in React state rather than a CSS rule because this file owns no
 * stylesheet — and a tint swap re-renders only this row's header, which paints the
 * same geometry either way.
 *
 * A `role="button"` Box, not a real `<button>`: the row contains an avatar `<img>` and
 * badges, and nesting interactive content inside a button is invalid HTML that browsers
 * reparent. `SubagentActivityRow` refuses a `<button>` for exactly this reason (it
 * wraps a timing popover trigger), so this follows the same precedent.
 */
function OpenSessionHeaderLink({
	label,
	onOpen,
	children,
}: {
	label: string;
	onOpen: () => void;
	children: React.ReactNode;
}) {
	const [hovered, setHovered] = useState(false);
	return (
		<Box
			role="button"
			tabIndex={0}
			aria-label={label}
			title={label}
			data-injection-open-session
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onClick={(event) => {
				// Modifier-clicks belong to the list's selection system (toggle / range), the
				// same as every other block. Opening a panel on ⌘-click would steal a gesture
				// the reader uses to build a selection.
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				// The bubble sits inside the selection surface; without this a click would
				// both open the session and register as a block interaction.
				event.stopPropagation();
				event.preventDefault();
				onOpen();
			}}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.stopPropagation();
				event.preventDefault();
				onOpen();
			}}
			style={{
				height: "100%",
				cursor: "pointer",
				borderRadius: 4,
				background: hovered
					? "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-5))"
					: "transparent",
			}}
		>
			{children}
		</Box>
	);
}

/**
 * Attach the speaker row (and the localized trailing note) to an injection bubble's
 * render extra. Mutates `extra` in place and is a no-op for every other kind, so
 * callers can invoke it unconditionally per row.
 *
 * The note text is resolved here rather than in the adapter because it is pure chrome:
 * the measure pass already reserved a fixed line for it (`hasNote`), so the wording
 * cannot change the row's height.
 */
export function injectInjectionBubbleChrome(
	kind: VListElementKind,
	extra: RenderExtra,
	noteText: string | undefined,
	navigation?: InjectionNavigation,
	narratorId?: string,
): void {
	if (kind !== "injection-bubble") return;
	// Clickable only when BOTH exist: a resolvable target on the row, and a host that
	// can actually reach it. Either half missing leaves the row inert rather than
	// painting a live-looking control that does nothing.
	const target = coerceInjectionTarget(extra.target);
	const openSession = target ? resolveInjectionOpener(target, navigation) : undefined;
	extra.header = (
		<InjectionSpeakerHeader
			narratorId={narratorId}
			speaker={(extra.speaker as string | null | undefined) ?? null}
			speakerId={(extra.speakerId as string | null | undefined) ?? null}
			speakerKind={(extra.speakerKind as string | null | undefined) ?? null}
			isBroadcast={extra.isBroadcast === true}
			creator={(extra.creator as BubbleCreator | null | undefined) ?? null}
			source={(extra.source as string | null | undefined) ?? null}
			onOpenSession={openSession}
			openSessionLabel={target ? navigation?.labels?.[target.kind] : undefined}
		/>
	);
	if (extra.hasNote === true && noteText) extra.noteText = noteText;
}

/**
 * The host's ability to reach each kind of injection target.
 *
 * Every opener is OPTIONAL and independently so: a narrator page can open a child
 * session and a spec file but has no reason to be able to do everything, and a
 * detached canvas node can do neither. A missing opener disables that row's
 * affordance — the same rule the tool cards' "open session" item follows — rather
 * than routing to a fallback the reader did not ask for.
 */
export interface InjectionNavigation {
	/** Open a child session, optionally scrolled to one message. */
	onOpenNarrator?: (narratorId: string, messageId?: string) => void;
	/** Open a knowledge-base entry (global or personal). */
	onOpenKnowledge?: (entryId: string, scope: "global" | "personal") => void;
	/** Open the Dynamic Spec panel with one file selected. */
	onOpenSpec?: (uri: string) => void;
	/** Open a chapter. */
	onOpenChapter?: (chapterId: string) => void;
	/** Localized tooltip / aria label per target kind. */
	labels?: Partial<Record<InjectionTarget["kind"], string>>;
}

/**
 * Bind one target to the host's opener for that kind, or undefined when the host
 * cannot reach it.
 *
 * The `switch` is exhaustive on purpose: adding a target kind must be a compile error
 * here rather than a row that silently stops being clickable.
 */
function resolveInjectionOpener(
	target: InjectionTarget,
	navigation: InjectionNavigation | undefined,
): (() => void) | undefined {
	if (!navigation) return undefined;
	switch (target.kind) {
		case "narrator": {
			const open = navigation.onOpenNarrator;
			return open ? () => open(target.narratorId, target.messageId ?? undefined) : undefined;
		}
		case "knowledge": {
			const open = navigation.onOpenKnowledge;
			return open ? () => open(target.entryId, target.scope) : undefined;
		}
		case "spec": {
			const open = navigation.onOpenSpec;
			return open ? () => open(target.uri) : undefined;
		}
		case "chapter": {
			const open = navigation.onOpenChapter;
			return open ? () => open(target.chapterId) : undefined;
		}
	}
}
