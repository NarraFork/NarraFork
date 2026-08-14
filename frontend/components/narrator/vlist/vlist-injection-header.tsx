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
import { Badge, Group, Text, ThemeIcon } from "@mantine/core";
import { PLATFORM_INJECTION_SOURCES as ADAPTER_PLATFORM_SOURCES } from "@shared/pretext-layout/segment-adapter";
import { IconChecklist, IconSparkles, IconTerminal2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
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

export function InjectionSpeakerHeader({
	speaker,
	speakerId,
	speakerKind,
	isBroadcast,
	creator,
	source,
}: {
	speaker?: string | null;
	/**
	 * The speaker's own id (a subagent narrator id, a background task id, a knowledge
	 * entry id) — the identicon seed. Absent for the platform and for real accounts,
	 * which have their own avatar treatments.
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
	return (
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
				// An agent / task / entry that has its own id: the deterministic identicon,
				// which stays distinct where initials collide.
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
): void {
	if (kind !== "injection-bubble") return;
	extra.header = (
		<InjectionSpeakerHeader
			speaker={(extra.speaker as string | null | undefined) ?? null}
			speakerId={(extra.speakerId as string | null | undefined) ?? null}
			speakerKind={(extra.speakerKind as string | null | undefined) ?? null}
			isBroadcast={extra.isBroadcast === true}
			creator={(extra.creator as BubbleCreator | null | undefined) ?? null}
			source={(extra.source as string | null | undefined) ?? null}
		/>
	);
	if (extra.hasNote === true && noteText) extra.noteText = noteText;
}
