/**
 * Interactive tutorial state: catalog, progress, lesson sessions, step detection.
 *
 * The observation side deliberately reads the SAME WebSocket frames the product
 * already broadcasts. A tutorial-only signal would let a lesson report success
 * while the feature it teaches is broken, which is worse than a lesson that gets
 * stuck: the user would learn something untrue.
 *
 * Frames are accumulated in a ref rather than state. They arrive at streaming
 * frequency (a text delta per frame), and re-rendering the step rail on every one
 * would make the tutorial the slowest page in the app. Step evaluation is driven
 * by a coarse tick instead.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { TutorialLesson, TutorialLessonSummary, TutorialTrack } from "../lib/api/types";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import {
	activeStepId,
	isLessonComplete,
	satisfiedStepIds,
	TUTORIAL_FRAME_TYPES,
	type TutorialObservations,
	type TutorialObservedFrame,
} from "../lib/tutorial-completion";

const TUTORIAL_GC_TIME_MS = 60_000;

/**
 * How often observed frames are folded into step completion.
 *
 * A step advancing up to a second late is imperceptible; re-evaluating on every
 * streaming delta is not.
 */
const STEP_EVALUATION_INTERVAL_MS = 400;

/**
 * Cap on retained frames.
 *
 * Every predicate is a "has this ever happened" existence check, so old frames
 * only matter until the step that needs them is recorded. Without a cap a long
 * lesson would grow this array for the whole session — the tutorial page is the
 * last place that should leak memory while teaching people to trust the product.
 */
const MAX_OBSERVED_FRAMES = 500;

/**
 * How often the sandbox graph is re-read while a chapters lesson is open.
 *
 * Forking and merging happen on other pages, so there is no frame to react to.
 * Three seconds is slow enough to be a negligible load and fast enough that a step
 * appears to acknowledge the user's action; the query is disabled entirely outside
 * chapters lessons.
 */
const SANDBOX_GRAPH_POLL_MS = 3000;

/**
 * How often `spec://tasks.json` is re-read while the Dynamic Spec lesson is open.
 *
 * Faster than the graph poll because this one races the user's attention: the
 * write lands mid-turn, and a step that ticks four seconds after the card appeared
 * reads as broken rather than as delayed.
 */
const SANDBOX_SPEC_POLL_MS = 1500;

function tutorialIndexKey() {
	return ["tutorial", "index"] as const;
}

function tutorialLessonKey(lessonId: string) {
	return ["tutorial", "lesson", lessonId] as const;
}

/**
 * Edge kinds present in the sandbox project's graph.
 *
 * The fork/merge steps complete on real edges, so this reads the same
 * `GET /projects/:id/graph` the NarraFlow canvas uses rather than a
 * tutorial-specific endpoint. Polled while a chapters lesson is open because
 * forking and merging happen on OTHER pages (the graph, a chapter menu) — no
 * WebSocket frame arrives on the lesson's narrator to react to, so waiting for one
 * would leave the step permanently incomplete.
 */
export function useSandboxEdgeKinds(projectId: string | undefined, active: boolean) {
	const { data } = useQuery({
		queryKey: ["narraFlow", projectId],
		queryFn: () => api.getProjectGraph(projectId as string),
		enabled: !!projectId && active,
		gcTime: TUTORIAL_GC_TIME_MS,
		refetchInterval: active ? SANDBOX_GRAPH_POLL_MS : false,
	});

	return useMemo(() => {
		const edges = (data?.edges ?? []) as Array<{ type?: unknown }>;
		return [
			...new Set(
				edges
					.map((edge) => (typeof edge.type === "string" ? edge.type : ""))
					.filter((type) => type.length > 0),
			),
		];
	}, [data?.edges]);
}

/**
 * How many tasks sit in the lesson narrator's `spec://tasks.json`.
 *
 * Polled for the same reason as the graph: the write happens inside a tool call,
 * and the `spec_changed` frame it emits would still require a fetch to learn the
 * count — so one poll is simpler than a frame plus a fetch. Disabled unless the
 * open lesson actually has a Dynamic Spec step, which keeps every other lesson
 * from querying an endpoint it has no use for.
 */
export function useSandboxSpecTaskCount(narratorId: string | undefined, active: boolean) {
	const { data } = useQuery({
		queryKey: ["narrators", narratorId, "spec", "tasks"],
		queryFn: () => api.readSpecTasks(narratorId as string),
		enabled: !!narratorId && active,
		gcTime: TUTORIAL_GC_TIME_MS,
		refetchInterval: active ? SANDBOX_SPEC_POLL_MS : false,
	});
	return data?.document.tasks.length ?? 0;
}

/** Catalog + progress + sandbox state for the overview page. */
export function useTutorialIndex() {
	return useQuery({
		queryKey: tutorialIndexKey(),
		queryFn: () => api.getTutorialIndex(),
		gcTime: TUTORIAL_GC_TIME_MS,
	});
}

/** One lesson's steps plus this user's recorded progress for it. */
export function useTutorialLesson(lessonId: string | undefined) {
	return useQuery({
		queryKey: tutorialLessonKey(lessonId ?? ""),
		queryFn: () => api.getTutorialLesson(lessonId as string),
		enabled: !!lessonId,
		gcTime: TUTORIAL_GC_TIME_MS,
	});
}

/** Lessons grouped by track, in the canonical order. */
export function useTutorialTracks(): Array<{
	track: TutorialTrack;
	lessons: TutorialLessonSummary[];
}> {
	const { data } = useTutorialIndex();
	return useMemo(() => {
		const tracks = data?.tracks ?? [];
		const lessons = data?.lessons ?? [];
		return tracks
			.map((track) => ({
				track,
				lessons: lessons
					.filter((lesson) => lesson.track === track)
					.sort((a, b) => a.order - b.order),
			}))
			.filter((group) => group.lessons.length > 0);
	}, [data?.tracks, data?.lessons]);
}

/** Start a lesson: provisions what it needs and returns where to mount it. */
export function useStartTutorialLesson() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (lessonId: string) => api.startTutorialLesson(lessonId),
		onSuccess: () => {
			// The sandbox may have just been provisioned, which changes the overview's
			// sandbox card and (for chapter lessons) the project list.
			qc.invalidateQueries({ queryKey: tutorialIndexKey() });
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useResetTutorialLesson() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (lessonId: string) => api.resetTutorialLesson(lessonId),
		onSuccess: (_result, lessonId) => {
			qc.invalidateQueries({ queryKey: tutorialIndexKey() });
			qc.invalidateQueries({ queryKey: tutorialLessonKey(lessonId) });
		},
	});
}

export interface UseTutorialStepsOptions {
	lesson: TutorialLesson | undefined;
	/** The lesson's narrator, once started. */
	narratorId: string | undefined;
	/** Steps already recorded on the server. */
	recordedStepIds: readonly string[];
	/** Sandbox chapter, for the fork/merge conditions. */
	chapterEdgeKinds?: readonly string[];
	/** Task count in `spec://tasks.json`, for the Dynamic Spec condition. */
	specTaskCount?: number;
}

export interface UseTutorialStepsResult {
	/** Recorded ∪ currently-observed. */
	completedStepIds: string[];
	/** The step the user should be working on, or null when done. */
	activeStepId: string | null;
	complete: boolean;
	/** Advance a `manual` step the user clicked through. */
	markStepDone: (stepId: string) => void;
	/** Mark the whole lesson finished without per-step evidence. */
	markLessonComplete: () => void;
}

/**
 * Observe the lesson narrator and keep step completion in sync with the server.
 *
 * Newly satisfied steps are pushed to the server as they are observed, because
 * progress must survive a reload: the frame history does not, so a step proven by
 * a frame the page has since forgotten would otherwise become incomplete again.
 */
export function useTutorialSteps(options: UseTutorialStepsOptions): UseTutorialStepsResult {
	const { lesson, narratorId, recordedStepIds } = options;
	const qc = useQueryClient();

	const framesRef = useRef<TutorialObservedFrame[]>([]);
	const userSentMessageRef = useRef(false);
	const statusRef = useRef<string | undefined>(undefined);
	/** True once a live `status_change` frame has been seen for the current narrator. */
	const wsStatusSeenRef = useRef(false);
	/** Steps already sent to the server, so a re-observation is not re-posted. */
	const reportedRef = useRef<Set<string>>(new Set());
	const [locallyDone, setLocallyDone] = useState<string[]>([]);
	const [tick, setTick] = useState(0);

	const { data: narrator } = useQuery({
		queryKey: ["narrators", narratorId],
		queryFn: () => api.getNarrator(narratorId as string),
		enabled: !!narratorId,
		gcTime: TUTORIAL_GC_TIME_MS,
	});
	// Status ownership is a handoff, not a one-way ratchet: the query owns the
	// status UNTIL the first live `status_change` frame arrives, then the stream
	// owns it. Assigning on every render would keep restoring the value fetched
	// when the lesson opened — usually `idle`, which would report "the turn
	// finished" while the narrator is still working. But seeding only once (the
	// previous shape) had its own failure mode: this query does not refetch on a
	// timer, yet React Query CAN refetch on window focus, and a focus-triggered
	// `working` is more current than an `idle` seeded at mount. Following the query
	// before the handoff keeps the ref at the freshest known value in both cases;
	// after the handoff the WS frames are strictly fresher than any snapshot, so
	// the query is ignored.
	if (narrator?.status && !wsStatusSeenRef.current) statusRef.current = narrator.status;

	// A lesson restart hands us a different narrator; carrying the previous one's
	// frames over would satisfy steps with evidence from a session the user is no
	// longer looking at.
	//
	// The dependencies look "unnecessary" to the exhaustive-deps rule because the
	// body only writes refs and a setState — but running WHEN they change is the
	// entire purpose. Dropping them would leave stale evidence in place forever.
	// biome-ignore lint/correctness/useExhaustiveDependencies: identity change is the trigger
	useEffect(() => {
		framesRef.current = [];
		userSentMessageRef.current = false;
		statusRef.current = undefined;
		// A new narrator restarts the ownership handoff: its first live frame must
		// be able to take over from the query again.
		wsStatusSeenRef.current = false;
		reportedRef.current = new Set();
		setLocallyDone([]);
	}, [narratorId, lesson?.id]);

	useEffect(() => {
		if (!narratorId) return;
		// A listener alone receives nothing: `addListener` only registers a local
		// callback, while the server decides what to push based on `subscribe`. The
		// rail used to rely on `NarratorPanel` having subscribed, which made step
		// detection depend on another component's mount order — and silently stopped
		// working whenever the panel was not up yet. Subscriptions are ref-counted, so
		// asking for our own is cheap and independent.
		const subscription = narratorWSManager.subscribe([narratorId], { kind: "panel" });
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: [...TUTORIAL_FRAME_TYPES] },
			(data) => {
				const type = typeof data.type === "string" ? data.type : "";
				if (type === "status_change" && typeof data.status === "string") {
					statusRef.current = data.status;
					// From here on the stream owns the status; see the seeding above.
					wsStatusSeenRef.current = true;
				}
				// `user_message` IS the "user sent something" signal — the server emits it
				// only for user turns, so its arrival is the evidence and no role check is
				// possible (the frame carries no role field). `message` is kept in the
				// subscription for its role in advancing the manager's epoch, but reading
				// a role off it would never match: those rows are assistant output.
				if (type === "user_message") userSentMessageRef.current = true;
				framesRef.current.push({
					type,
					narratorId: typeof data.narratorId === "string" ? data.narratorId : undefined,
					decision: data.decision as "allow" | "deny" | "aborted" | undefined,
					toolName: typeof data.toolName === "string" ? data.toolName : undefined,
					status: typeof data.status === "string" ? data.status : undefined,
					subagentNarratorId:
						typeof data.subagentNarratorId === "string" ? data.subagentNarratorId : undefined,
				});
				if (framesRef.current.length > MAX_OBSERVED_FRAMES) {
					framesRef.current = framesRef.current.slice(-MAX_OBSERVED_FRAMES);
				}
			},
		);
		return () => {
			narratorWSManager.removeListener(handle);
			narratorWSManager.unsubscribe(subscription);
		};
	}, [narratorId]);

	// Coarse tick instead of re-rendering per frame. Only runs while a lesson is
	// open and unfinished.
	const stepsRemaining = !!lesson && !isLessonComplete(lesson.steps, recordedStepIds);
	useEffect(() => {
		if (!narratorId || !stepsRemaining) return;
		const timer = setInterval(() => setTick((n) => n + 1), STEP_EVALUATION_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [narratorId, stepsRemaining]);

	const progressMutation = useMutation({
		mutationFn: (input: { lessonId: string; completedStepIds: string[]; completed?: boolean }) =>
			api.updateTutorialProgress(input.lessonId, {
				completedStepIds: input.completedStepIds,
				...(input.completed !== undefined ? { completed: input.completed } : {}),
			}),
		onSuccess: (_result, input) => {
			qc.invalidateQueries({ queryKey: tutorialLessonKey(input.lessonId) });
			qc.invalidateQueries({ queryKey: tutorialIndexKey() });
		},
	});

	const observations = useMemo<TutorialObservations>(() => {
		// `tick` is the dependency that makes this recompute; the refs it reads are
		// mutated outside React on purpose (see the module header).
		void tick;
		return {
			narratorId: narratorId ?? "",
			narratorStatus: statusRef.current,
			userSentMessage: userSentMessageRef.current,
			frames: framesRef.current,
			...(options.chapterEdgeKinds ? { chapterEdgeKinds: options.chapterEdgeKinds } : {}),
			...(options.specTaskCount !== undefined ? { specTaskCount: options.specTaskCount } : {}),
		};
	}, [narratorId, tick, options.chapterEdgeKinds, options.specTaskCount]);

	const observed = useMemo(
		() => (lesson ? satisfiedStepIds(lesson.steps, observations) : []),
		[lesson, observations],
	);

	const completedStepIds = useMemo(() => {
		return [...new Set([...recordedStepIds, ...observed, ...locallyDone])];
	}, [recordedStepIds, observed, locallyDone]);

	// `mutate` is referentially stable across renders while the mutation object is
	// not, so depending on the function rather than the object keeps the effect
	// below from re-running every render.
	const reportProgress = progressMutation.mutate;

	// Persist newly observed steps. Progress must outlive the frame history that
	// proved it, and the server treats writes as additive so duplicates are safe.
	useEffect(() => {
		if (!lesson) return;
		const recorded = new Set(recordedStepIds);
		const pending = completedStepIds.filter(
			(id) => !recorded.has(id) && !reportedRef.current.has(id),
		);
		if (pending.length === 0) return;
		for (const id of pending) reportedRef.current.add(id);
		reportProgress({ lessonId: lesson.id, completedStepIds: pending });
	}, [lesson, completedStepIds, recordedStepIds, reportProgress]);

	const markStepDone = useCallback(
		(stepId: string) => {
			if (!lesson) return;
			setLocallyDone((previous) => (previous.includes(stepId) ? previous : [...previous, stepId]));
		},
		[lesson],
	);

	const markLessonComplete = useCallback(() => {
		if (!lesson) return;
		reportProgress({
			lessonId: lesson.id,
			completedStepIds: lesson.steps.map((s) => s.id),
			completed: true,
		});
	}, [lesson, reportProgress]);

	return {
		completedStepIds,
		activeStepId: lesson ? activeStepId(lesson.steps, completedStepIds, observations) : null,
		complete: !!lesson && isLessonComplete(lesson.steps, completedStepIds),
		markStepDone,
		markLessonComplete,
	};
}
