import {
	getValidReasoningTranslationParts,
	REASONING_TRANSLATION_VISIBILITY_LIMITS,
	type ReasoningTranslationPart,
	type ReasoningTranslationState,
	type ReasoningTranslationStatus,
	type ReasoningTranslationVisibilityGroup,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import {
	type ReasoningTranslationResponse,
	ReasoningTranslationScheduler,
	type TranslationTask,
} from "./reasoning-translation-scheduler";

export interface TranslationViewer {
	narratorId: string;
	userId: string;
	isCurrent: () => boolean;
	status?: (status: ReasoningTranslationStatus) => void;
	authorize: (
		target: ReasoningTranslationVisibilityTarget,
		signal: AbortSignal,
	) => Promise<boolean>;
}
export interface VisibleTranslationSource {
	target: ReasoningTranslationVisibilityTarget;
	text: string;
	generation: string;
	locale: string;
	parts?: ReasoningTranslationPart[];
	version: string;
	parentToolUseId?: string;
	reload?: boolean;
	completed?: boolean;
	/** Explicit sealed ranges; [] means the entire live tail is ineligible. */
	allowedRanges?: Array<{ start: number; end: number }>;
	/** Derived only from persisted, adjacent original reasoning elements. */
	runAnchor?: ReasoningTranslationVisibilityTarget;
	runKey?: string;
	order?: number;
}
interface Holder {
	viewer: TranslationViewer;
	visibilityId: string;
	revision: number;
	groups: Array<{ group: ReasoningTranslationVisibilityGroup; keys: string[] }>;
	lastStatus?: string;
	verifiedViewer?: TranslationViewer;
	keys: Set<string>;
	completion?: {
		connection: object;
		timer: ReturnType<typeof setTimeout>;
		ranges: Array<{ start: number; end: number }>;
		generation?: string;
	};
}
interface Demand {
	target: ReasoningTranslationVisibilityTarget;
	holders: Set<Holder>;
	controller: AbortController;
	response?: ReasoningTranslationResponse;
	source?: VisibleTranslationSource;
	responseViewer?: TranslationViewer;
	eligibleKey?: string;
	reading?: Promise<void>;
	dirty: boolean;
	followUp?: boolean;
	state?: ReasoningTranslationState;
	authorization?: AuthorizationRound;
}
type AuthorizationRound = Promise<Map<Demand, TranslationViewer | undefined>>;
interface LoadRequest {
	demand: Demand;
	viewer: TranslationViewer;
	resolve: (value: { source: VisibleTranslationSource | null; release: () => void }) => void;
	reject: (error: unknown) => void;
}
export interface VisibleTranslationDependencies {
	loadMany?: (
		targets: readonly ReasoningTranslationVisibilityTarget[],
		viewer: TranslationViewer,
		signal: AbortSignal,
	) => Promise<Array<VisibleTranslationSource | null>>;
	translateBatch?: (
		source: VisibleTranslationSource,
		viewer: TranslationViewer,
		tasks: readonly TranslationTask[],
		signal: AbortSignal,
		onDelta: (text: string) => void,
	) => Promise<string>;
	load: (
		target: ReasoningTranslationVisibilityTarget,
		viewer: TranslationViewer,
		signal: AbortSignal,
	) => Promise<VisibleTranslationSource | null>;
	translate: (
		source: VisibleTranslationSource,
		viewer: TranslationViewer,
		task: TranslationTask,
		signal: AbortSignal,
		onDelta: (text: string) => void,
	) => Promise<string>;
	apply: (
		source: VisibleTranslationSource,
		viewer: TranslationViewer,
		part: ReasoningTranslationPart,
		signal: AbortSignal,
	) => Promise<unknown | null>;
	publish: (viewer: TranslationViewer, source: VisibleTranslationSource, result: unknown) => void;
	enabled: () => boolean;
	permits?: (source: VisibleTranslationSource, start: number, end: number) => boolean;
	/** Synchronous, exact durable boundary at this completion event. */
	completedRanges?: (
		target: ReasoningTranslationVisibilityTarget,
	) => Array<{ start: number; end: number }> | undefined;
}
function targetKey(target: ReasoningTranslationVisibilityTarget): string {
	return JSON.stringify([
		target.ownerNarratorId,
		target.messageId,
		target.blockId,
		target.elementId ?? null,
		target.legacyIndex ?? null,
		target.legacyVersion ?? null,
	]);
}

/** Connection-local holders share one cancellable job for each persistent source. */
export class ReasoningTranslationVisibility {
	private readonly connections = new Map<object, Map<string, Holder>>();
	private readonly demands = new Map<string, Demand>();
	private readonly viewers = new Map<object, Map<string, TranslationViewer>>();
	private readonly running = new Set<Promise<void>>();
	private holders = 0;
	private stopping = false;
	private loads: LoadRequest[] = [];
	constructor(
		private readonly dependencies: VisibleTranslationDependencies,
		private readonly scheduler = new ReasoningTranslationScheduler(),
		private readonly limits: {
			[K in keyof typeof REASONING_TRANSLATION_VISIBILITY_LIMITS]: number;
		} = REASONING_TRANSLATION_VISIBILITY_LIMITS,
	) {}

	/** Transcript subscriptions exist independently of body mounting/visibility. */
	watch(connection: object, viewer: TranslationViewer): void {
		if (this.stopping) return;
		let viewers = this.viewers.get(connection);
		if (!viewers) {
			viewers = new Map();
			this.viewers.set(connection, viewers);
		}
		viewers.set(viewer.narratorId, viewer);
	}

	/** Completion can promote current text visibility, never a transcript subscription. */
	complete(
		target: ReasoningTranslationVisibilityTarget,
		displayedNarratorId = target.ownerNarratorId,
	): void {
		if (this.stopping || !this.dependencies.enabled()) return;
		const key = targetKey(target);
		const demand = this.demands.get(key);
		if (!demand) return;
		const ranges = this.dependencies.completedRanges?.(target) ?? demand.source?.allowedRanges;
		if (!ranges?.length) return;
		let promoted = false;
		for (const [connection, holders] of this.connections) {
			for (const holder of [...holders.values()]) {
				const viewer = holder.viewer;
				if (
					holder.completion ||
					!holder.keys.has(key) ||
					!viewer.isCurrent() ||
					(viewer.narratorId !== target.ownerNarratorId &&
						viewer.narratorId !== displayedNarratorId)
				)
					continue;
				promoted =
					this.keepCompletion(
						connection,
						viewer,
						demand,
						ranges,
						demand.source?.generation,
						holder,
					) || promoted;
			}
		}
		if (promoted) this.refreshAll([demand]);
	}

	private keepCompletion(
		connection: object,
		viewer: TranslationViewer,
		demand: Demand,
		ranges: readonly { start: number; end: number }[],
		generation?: string,
		origin?: Holder,
	): boolean {
		const id = `\u0000completed:${viewer.narratorId}:${targetKey(demand.target)}`;
		const holders = this.connections.get(connection);
		if (!holders) return false;
		let holder = holders.get(id);
		const previous = holder?.completion;
		const merged: Array<{ start: number; end: number }> = [];
		const candidates = [
			...(previous && previous.generation === generation ? previous.ranges : []),
			...ranges,
		].sort((a, b) => a.start - b.start);
		for (const range of candidates) {
			if (
				!Number.isSafeInteger(range.start) ||
				!Number.isSafeInteger(range.end) ||
				range.start < 0 ||
				range.end <= range.start
			)
				continue;
			const last = merged.at(-1);
			if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
			else if (merged.length < this.limits.targets) merged.push({ ...range });
		}
		if (!merged.length) return false;
		if (!holder) {
			if (holders.size >= this.limits.holdersPerConnection || this.holders >= this.limits.holders)
				return false;
			holder = {
				viewer,
				visibilityId: id,
				revision: 0,
				groups: [],
				keys: new Set([targetKey(demand.target)]),
			};
			holders.set(id, holder);
			demand.holders.add(holder);
			this.holders++;
		}
		// Retention attaches to the existing job; it must not enqueue another read
		// or hold the scheduler barrier while that same job is being installed.
		holder.viewer = viewer;
		const key = targetKey(demand.target);
		const groups = origin?.groups.filter((entry) => entry.keys.includes(key));
		if (groups?.length)
			holder.groups = groups.slice(0, this.limits.targets).map(({ group }) => ({
				group: { ...group, targetIndexes: [0] },
				keys: [key],
			}));
		// Group metadata is only a candidate. batchKey rechecks the persisted run
		// anchor and this holder's ACL; it never contributes text visibility/ranges.
		if (previous) clearTimeout(previous.timer);
		holder.completion = {
			connection,
			generation,
			ranges: merged,
			timer: setTimeout(() => this.release(connection, id), 35_000),
		};
		return true;
	}

	private visible(demand: Demand): boolean {
		return [...demand.holders].some(
			(holder) =>
				!holder.completion && holder.verifiedViewer === holder.viewer && holder.viewer.isCurrent(),
		);
	}

	private eligibleRanges(
		demand: Demand,
		source: VisibleTranslationSource,
	): Array<{ start: number; end: number }> {
		const allowed = source.allowedRanges ?? [{ start: 0, end: source.text.length }];
		if (this.visible(demand)) return allowed;
		const result: Array<{ start: number; end: number }> = [];
		for (const holder of demand.holders) {
			const completion = holder.completion;
			if (!completion || holder.verifiedViewer !== holder.viewer || !holder.viewer.isCurrent())
				continue;
			completion.generation ??= source.generation;
			if (completion.generation !== source.generation) continue;
			for (const range of completion.ranges)
				for (const permitted of allowed) {
					const start = Math.max(range.start, permitted.start);
					const end = Math.min(range.end, permitted.end);
					if (start < end) result.push({ start, end });
				}
		}
		return this.unionRanges(result);
	}

	private unionRanges(
		ranges: readonly { start: number; end: number }[],
	): Array<{ start: number; end: number }> {
		const result: Array<{ start: number; end: number }> = [];
		for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
			const previous = result.at(-1);
			if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
			else result.push({ start: range.start, end: range.end });
		}
		return result;
	}

	private scheduledRanges(
		source: VisibleTranslationSource,
		response: ReasoningTranslationResponse,
	): Array<{ start: number; end: number }> {
		if (response.cancelled) return [];
		const ranges: Array<{ start: number; end: number }> = [];
		for (const block of response.blocks.values()) {
			if (block.generation !== source.generation) continue;
			if (
				block.active &&
				!block.active.signal.aborted &&
				block.activeRange &&
				this.permits(source, block.activeRange.start, block.activeRange.end)
			)
				ranges.push(block.activeRange);
			if (block.tail && this.permits(source, block.tail.start, block.tail.end))
				ranges.push({ start: block.tail.start, end: block.tail.end });
		}
		return ranges;
	}

	private releaseCompleted(demand: Demand): void {
		if (demand.reading || demand.dirty || demand.followUp || demand.response?.pending) return;
		for (const holder of [...demand.holders]) {
			if (holder.completion) this.release(holder.completion.connection, holder.visibilityId);
		}
	}

	private permits(source: VisibleTranslationSource, start: number, end: number): boolean {
		const demand = this.demands.get(targetKey(source.target));
		return (
			!!demand &&
			this.eligibleRanges(demand, source).some(
				(range) => range.start <= start && end <= range.end,
			) &&
			(this.dependencies.permits?.(source, start, end) ?? true)
		);
	}

	private freezeAllowed(
		demand: Demand,
		source: VisibleTranslationSource,
		response: ReasoningTranslationResponse,
	): void {
		const allowed = source.allowedRanges ?? [{ start: 0, end: source.text.length }];
		const parts = getValidReasoningTranslationParts(
			source.text,
			source.generation,
			source.parts,
		).filter(
			(part) =>
				allowed.some((range) => range.start <= part.start && part.end <= range.end) &&
				(this.dependencies.permits?.(source, part.start, part.end) ?? true),
		);
		// A newly released terminal scope may have a different start key. Treat
		// live reservations as covered too, until their independent writes settle.
		const covered = this.unionRanges([...parts, ...this.scheduledRanges(source, response)]);
		response.settled = false;
		const eligible = this.eligibleRanges(demand, source);
		demand.eligibleKey = JSON.stringify(eligible);
		for (const range of eligible) {
			let start = range.start;
			for (const part of [
				...covered.filter((part) => part.start < range.end && range.start < part.end),
				{ start: range.end, end: range.end },
			]) {
				if (part.end <= start || part.start > range.end) continue;
				const end = Math.min(part.start, range.end);
				if (end > start && source.text.slice(start, end).trim() && this.permits(source, start, end))
					this.scheduler.freeze(response, {
						elementId: `${source.target.elementId ?? "legacy"}:${start}`,
						messageId: source.target.messageId,
						generation: source.generation,
						text: source.text,
						start,
						end,
						reason: source.allowedRanges || source.completed !== false ? "final" : "summary",
					});
				start = Math.min(range.end, Math.max(start, part.end));
			}
		}
		if (source.allowedRanges && response.pending > 0) {
			const scheduled = this.scheduledRanges(source, response);
			for (const [connection, holders] of this.connections)
				for (const holder of [...holders.values()]) {
					if (
						holder.completion ||
						!demand.holders.has(holder) ||
						holder.verifiedViewer !== holder.viewer ||
						!holder.viewer.isCurrent()
					)
						continue;
					this.keepCompletion(
						connection,
						holder.viewer,
						demand,
						scheduled,
						source.generation,
						holder,
					);
				}
		}
		this.scheduler.settle(response);
	}

	replace(
		connection: object,
		visibilityId: string,
		viewer: TranslationViewer,
		targets: readonly ReasoningTranslationVisibilityTarget[],
		groups: readonly ReasoningTranslationVisibilityGroup[] = [],
		revision = 0,
	): boolean {
		if (
			this.stopping ||
			targets.length > this.limits.targets ||
			groups.length > this.limits.targets ||
			groups.some((group) =>
				group.targetIndexes.some(
					(index) => !Number.isInteger(index) || index < 0 || index >= targets.length,
				),
			)
		)
			return false;
		if (viewer.isCurrent()) this.watch(connection, viewer);
		let holders = this.connections.get(connection);
		const previous = holders?.get(visibilityId);
		if (previous && revision < previous.revision) return false;
		if (!targets.length) {
			if (previous) {
				previous.viewer = viewer;
				previous.revision = revision;
				previous.lastStatus = undefined;
				this.release(connection, visibilityId);
			} else if (viewer.isCurrent())
				viewer.status?.({
					type: "reasoning_translation_status",
					narratorId: viewer.narratorId,
					visibilityId,
					revision,
					groups: [],
				});
			return true;
		}
		if (
			!previous &&
			((holders?.size ?? 0) >= this.limits.holdersPerConnection ||
				this.holders >= this.limits.holders)
		)
			return false;
		const next = new Map(targets.map((target) => [targetKey(target), target]));
		const additions = [...next.keys()].filter((key) => !this.demands.has(key)).length;
		if (this.demands.size + additions > this.limits.uniqueTargets) return false;
		if (!holders) {
			holders = new Map();
			this.connections.set(connection, holders);
		}
		const holder: Holder = previous ?? {
			viewer,
			keys: new Set(),
			groups: [],
			visibilityId,
			revision,
		};
		holder.revision = revision;
		holder.groups = groups.map((group) => ({
			group,
			keys: group.targetIndexes.map((index) => targetKey(targets[index])),
		}));
		holder.lastStatus = undefined;
		// Updating the viewer also invalidates authorization work started by a previous frame.
		holder.viewer = viewer;
		if (!previous) this.holders++;
		holders.set(visibilityId, holder);
		for (const key of holder.keys) {
			if (!next.has(key)) this.detach(key, holder);
		}
		holder.keys = new Set(next.keys());
		const refresh: Demand[] = [];
		for (const [key, target] of next) {
			let demand = this.demands.get(key);
			if (!demand) {
				demand = { target, holders: new Set(), controller: new AbortController(), dirty: false };
				this.demands.set(key, demand);
			}
			demand.holders.add(holder);
			refresh.push(demand);
		}
		this.refreshAll(refresh);
		this.emitStatus(holder);
		return true;
	}

	release(connection: object, visibilityId?: string, narratorId?: string): void {
		if (visibilityId === undefined) {
			if (narratorId === undefined) this.viewers.delete(connection);
			else {
				const viewers = this.viewers.get(connection);
				viewers?.delete(narratorId);
				if (!viewers?.size) this.viewers.delete(connection);
			}
		}
		const holders = this.connections.get(connection);
		if (!holders) return;
		for (const [id, holder] of holders) {
			if (visibilityId !== undefined && visibilityId !== id) continue;
			if (narratorId !== undefined && holder.viewer.narratorId !== narratorId) continue;
			this.emitStatus(holder, true);
			if (holder.completion) clearTimeout(holder.completion.timer);
			holders.delete(id);
			this.holders--;
			for (const key of holder.keys) this.detach(key, holder);
		}
		if (!holders.size) this.connections.delete(connection);
	}

	/** Only durable source writes wake existing observers; this never creates demand. */
	notify(messageId?: string): void {
		this.refreshAll(
			Array.from(this.demands.values()).filter(
				(demand) => messageId === undefined || demand.target.messageId === messageId,
			),
		);
	}

	private refreshAll(demands: readonly Demand[]): void {
		if (this.stopping || !demands.length) return;
		// Establish the frame's barrier before even the first asynchronous ACL lookup.
		// Every member then enters the shared snapshot loader in the same turn, including
		// sources whose real worker-backed authorization completes much later.
		const resume = this.scheduler.hold();
		const authorization: AuthorizationRound = Promise.all(
			demands.map(async (demand) => [demand, await this.authorized(demand)] as const),
		).then((entries) => new Map(entries));
		for (const demand of demands) this.refresh(demand, authorization);
		const work = Promise.allSettled([authorization, ...demands.map((demand) => demand.reading)])
			.then(() => undefined)
			.finally(resume);
		this.running.add(work);
		void work.then(
			() => this.running.delete(work),
			() => this.running.delete(work),
		);
	}

	private detach(key: string, holder: Holder): void {
		const demand = this.demands.get(key);
		if (!demand) return;
		demand.holders.delete(holder);
		if (demand.holders.size) return;
		this.demands.delete(key);
		demand.controller.abort();
		if (demand.response) this.scheduler.cancel(demand.response);
	}

	private emitStatus(holder: Holder, idle = false): void {
		if (holder.completion || !holder.viewer.isCurrent() || !holder.viewer.status) return;
		const groups = holder.groups.map(({ group, keys }) => {
			const states = idle
				? []
				: keys.map((key) => {
						const demand = this.demands.get(key);
						return demand?.source?.runAnchor &&
							targetKey(demand.source.runAnchor) === targetKey(group.anchor)
							? demand.state
							: "idle";
					});
			const state: ReasoningTranslationState = states.includes("running")
				? "running"
				: states.includes("queued")
					? "queued"
					: "idle";
			return { groupId: group.groupId, state };
		});
		const signature = JSON.stringify(groups);
		if (signature === holder.lastStatus) return;
		holder.lastStatus = signature;
		holder.viewer.status({
			type: "reasoning_translation_status",
			narratorId: holder.viewer.narratorId,
			visibilityId: holder.visibilityId,
			revision: holder.revision,
			groups,
		});
	}

	private state(demand: Demand, state: ReasoningTranslationState): void {
		demand.state = state;
		for (const holder of demand.holders) this.emitStatus(holder);
	}

	private batchKey(
		demand: Demand,
		source: VisibleTranslationSource,
		viewer: TranslationViewer,
	): string | undefined {
		if (
			!this.dependencies.translateBatch ||
			(source.completed === false && !source.allowedRanges) ||
			!this.eligibleRanges(demand, source).length
		)
			return undefined;
		for (const holder of demand.holders) {
			if (
				holder.verifiedViewer !== holder.viewer ||
				!holder.viewer.isCurrent() ||
				holder.viewer.userId !== viewer.userId ||
				holder.viewer.narratorId !== viewer.narratorId
			)
				continue;
			for (const { group, keys } of holder.groups) {
				if (
					!keys.includes(targetKey(demand.target)) ||
					!source.runAnchor ||
					targetKey(source.runAnchor) !== targetKey(group.anchor)
				)
					continue;
				return JSON.stringify([
					source.target.ownerNarratorId,
					source.target.messageId,
					source.runKey,
					group.groupId,
					source.locale,
					viewer.userId,
					viewer.narratorId,
				]);
			}
		}
		// Old clients keep source-level compatibility while completed gaps still share a request.
		return JSON.stringify([
			targetKey(source.target),
			source.locale,
			viewer.userId,
			viewer.narratorId,
		]);
	}

	private load(
		demand: Demand,
		viewer: TranslationViewer,
	): Promise<{ source: VisibleTranslationSource | null; release: () => void }> {
		return new Promise((resolve, reject) => {
			this.loads.push({ demand, viewer, resolve, reject });
			if (this.loads.length === 1) queueMicrotask(() => this.flushLoads());
		});
	}

	private flushLoads(): void {
		const requests = this.loads;
		this.loads = [];
		const batches = new Map<string, LoadRequest[]>();
		const viewers = new Map<TranslationViewer, number>();
		for (const request of requests) {
			const { target } = request.demand;
			if (!viewers.has(request.viewer)) viewers.set(request.viewer, viewers.size);
			const key = JSON.stringify([
				viewers.get(request.viewer),
				request.viewer.userId,
				request.viewer.narratorId,
				target.ownerNarratorId,
				target.messageId,
			]);
			const batch = batches.get(key) ?? [];
			batch.push(request);
			batches.set(key, batch);
		}
		// Keep the queue held until every member has installed its cache snapshot and frozen
		// its missing intervals. Fast worker reads cannot launch a partial group request.
		const resume = this.scheduler.hold();
		let outstanding = requests.length;
		const release = () => {
			if (--outstanding === 0) resume();
		};
		const chunks: LoadRequest[][] = [];
		for (const batch of batches.values()) {
			for (let offset = 0; offset < batch.length; offset += this.limits.targets)
				chunks.push(batch.slice(offset, offset + this.limits.targets));
		}
		for (const batch of chunks) {
			const controller = new AbortController();
			const onAbort = () => {
				if (batch.every((item) => item.demand.controller.signal.aborted)) controller.abort();
			};
			for (const item of batch)
				item.demand.controller.signal.addEventListener("abort", onAbort, { once: true });
			onAbort();
			const work = (async () => {
				try {
					const sources = this.dependencies.loadMany
						? await this.dependencies.loadMany(
								batch.map((item) => item.demand.target),
								batch[0].viewer,
								controller.signal,
							)
						: await Promise.all(
								batch.map((item) =>
									this.dependencies.load(
										item.demand.target,
										item.viewer,
										item.demand.controller.signal,
									),
								),
							);
					for (let index = 0; index < batch.length; index++)
						batch[index].resolve({ source: sources[index] ?? null, release });
				} catch (error) {
					for (const item of batch) {
						release();
						item.reject(error);
					}
				} finally {
					for (const item of batch)
						item.demand.controller.signal.removeEventListener("abort", onAbort);
				}
			})();
			this.running.add(work);
			void work.finally(() => this.running.delete(work));
		}
	}

	private async authorized(
		demand: Demand,
		preferred?: TranslationViewer,
	): Promise<TranslationViewer | undefined> {
		// Every retained scope needs its own current proof. Returning after the first
		// viewer would lose another viewer's legitimately completed, larger prefix.
		const holders = [...demand.holders].sort(
			(a, b) => Number(!!a.completion) - Number(!!b.completion),
		);
		const checks = new Map<TranslationViewer, Promise<boolean>>();
		const viewers = await Promise.all(
			holders.map(async (holder) => {
				const viewer = holder.viewer;
				if (!viewer.isCurrent() || demand.controller.signal.aborted) return undefined;
				let check = checks.get(viewer);
				if (!check) {
					check = viewer.authorize(demand.target, demand.controller.signal).catch(() => false);
					checks.set(viewer, check);
				}
				const allowed = await check;
				if (
					allowed &&
					holder.viewer === viewer &&
					demand.holders.has(holder) &&
					viewer.isCurrent() &&
					!demand.controller.signal.aborted
				) {
					holder.verifiedViewer = viewer;
					return viewer;
				}
				if (holder.verifiedViewer === viewer) holder.verifiedViewer = undefined;
				return undefined;
			}),
		);
		return (
			(preferred &&
				viewers.find(
					(viewer) =>
						viewer?.userId === preferred.userId && viewer.narratorId === preferred.narratorId,
				)) ??
			viewers.find((viewer) => viewer !== undefined)
		);
	}

	private refresh(demand: Demand, authorization?: AuthorizationRound): void {
		if (this.stopping || demand.controller.signal.aborted) return;
		if (authorization) demand.authorization = authorization;
		demand.dirty = true;
		if (demand.reading) return;
		const work = (async () => {
			while (demand.dirty && !demand.controller.signal.aborted && !this.stopping) {
				demand.dirty = false;
				if (!this.dependencies.enabled()) {
					if (demand.response) this.scheduler.cancel(demand.response);
					demand.response = undefined;
					continue;
				}
				const authorization = demand.authorization;
				let viewer = authorization
					? (await authorization).get(demand)
					: await this.authorized(demand);
				if (demand.authorization === authorization) demand.authorization = undefined;
				if (!viewer) {
					if (demand.response) this.scheduler.cancel(demand.response);
					demand.response = undefined;
					continue;
				}
				const pendingAtRead = demand.response?.pending ?? 0;
				const loaded = await this.load(demand, viewer);
				try {
					const source = loaded.source;
					if (
						!source ||
						!viewer.isCurrent() ||
						demand.controller.signal.aborted ||
						!(await this.authorized(demand))
					) {
						if (demand.response) this.scheduler.cancel(demand.response);
						demand.response = undefined;
						continue;
					}
					const responseViewer = demand.responseViewer;
					const retainedViewer =
						responseViewer &&
						[...demand.holders].find(
							(holder) =>
								holder.verifiedViewer === holder.viewer &&
								holder.viewer.isCurrent() &&
								holder.viewer.userId === responseViewer.userId &&
								holder.viewer.narratorId === responseViewer.narratorId,
						)?.viewer;
					if (retainedViewer) viewer = retainedViewer;
					const sameViewer =
						!responseViewer ||
						(responseViewer.userId === viewer.userId &&
							responseViewer.narratorId === viewer.narratorId);
					const nextBatchKey = this.batchKey(demand, source, viewer);
					const previous = demand.source;
					const sameLineage =
						previous?.generation === source.generation && previous.locale === source.locale;
					if (sameLineage && sameViewer && demand.response && !demand.response.cancelled)
						this.scheduler.configureBatch(demand.response, nextBatchKey);
					if (
						sameLineage &&
						sameViewer &&
						previous?.text === source.text &&
						(previous.completed !== false) === (source.completed !== false) &&
						JSON.stringify(previous.allowedRanges) === JSON.stringify(source.allowedRanges) &&
						demand.eligibleKey === JSON.stringify(this.eligibleRanges(demand, source)) &&
						demand.response &&
						!demand.response.cancelled
					) {
						// Keep frozen work/attempts; refresh its exact-content snapshot for legacy CAS.
						Object.assign(previous, source);
						continue;
					}
					if (
						sameLineage &&
						sameViewer &&
						previous &&
						source.allowedRanges &&
						source.text.startsWith(previous.text) &&
						demand.response &&
						!demand.response.cancelled
					) {
						Object.assign(previous, source);
						this.scheduler.retain(demand.response, (start, end) =>
							this.permits(previous, start, end),
						);
						this.freezeAllowed(demand, previous, demand.response);
						continue;
					}
					const append =
						sameLineage &&
						previous !== undefined &&
						source.text.length > previous.text.length &&
						source.text.startsWith(previous.text);
					const completed =
						sameLineage && previous?.completed === false && source.completed !== false;
					if (
						(append || completed) &&
						sameViewer &&
						pendingAtRead > 0 &&
						demand.response &&
						!demand.response.cancelled
					) {
						demand.followUp = true;
						if (completed) this.scheduler.discardQueued(demand.response);
						// An idle transition during the worker read needs a fresh cache snapshot too.
						if (!demand.response.pending) {
							demand.followUp = false;
							demand.dirty = true;
						}
						continue;
					}
					const spent =
						sameLineage && demand.response
							? {
									sourceBytes: demand.response.sourceBytes,
									outputBytes: demand.response.outputBytes,
									tasks: demand.response.tasks,
									queuedAt: demand.response.queuedAt,
								}
							: undefined;
					demand.followUp = false;
					if (demand.response) this.scheduler.cancel(demand.response);
					demand.source = source;
					if (source.locale === "en" || !source.text.trim()) continue;
					const batchKey = nextBatchKey;
					const responseObserver = viewer;
					demand.responseViewer = responseObserver;
					let invocationViewer = responseObserver;
					const response = this.scheduler.create({
						batchKey,
						order: source.order,
						permitsTask: (task) =>
							invocationViewer.isCurrent() &&
							this.dependencies.enabled() &&
							this.permits(source, task.start, task.end),
						canTranslate: async (signal) => {
							const current = await this.authorized(demand, responseObserver);
							if (current) invocationViewer = current;
							return Boolean(
								current &&
									current.userId === responseObserver.userId &&
									current.narratorId === responseObserver.narratorId &&
									!signal.aborted &&
									demand.response === response &&
									this.dependencies.enabled(),
							);
						},
						translateBatch: this.dependencies.translateBatch
							? async (tasks, signal, onDelta) => {
									// The scheduler just re-authorized every response and filtered each
									// member's live range. Do not insert another await before the call:
									// reopening one member must not discard its valid batch siblings.
									const translate = this.dependencies.translateBatch;
									if (
										!translate ||
										signal.aborted ||
										!invocationViewer.isCurrent() ||
										!this.dependencies.enabled()
									)
										return "";
									return translate(source, invocationViewer, tasks, signal, onDelta);
								}
							: undefined,
						onState: (state) => {
							if (demand.response === response) this.state(demand, state);
						},
						onIdle: () => {
							if (demand.response === response && demand.followUp && !response.cancelled) {
								demand.followUp = false;
								this.refresh(demand);
							}
							this.releaseCompleted(demand);
						},
						sessionId: source.target.ownerNarratorId,
						translate: async (task, signal, onDelta) => {
							const current = await this.authorized(demand);
							if (
								!current ||
								signal.aborted ||
								!this.dependencies.enabled() ||
								!this.permits(source, task.start, task.end)
							)
								return "";
							return this.dependencies.translate(source, current, task, signal, onDelta);
						},
						apply: async (_task, part, signal) => {
							let current = await this.authorized(demand);
							if (
								!current ||
								signal.aborted ||
								demand.response !== response ||
								!this.dependencies.enabled() ||
								!this.permits(source, part.start, part.end)
							)
								return false;
							const version = source.version;
							const exactRevision = source.reload || !source.target.elementId;
							let result = await this.dependencies.apply(source, current, part, signal);
							if (!result && exactRevision && !signal.aborted && demand.response === response) {
								// Refresh may rebase an exact-content legacy snapshot before durable notify arrives.
								// Retry only this write once with its returned translation, never the provider task.
								if (!demand.reading) this.refresh(demand);
								if (demand.reading) {
									const aborted = Promise.withResolvers<void>();
									const onAbort = () => aborted.resolve();
									signal.addEventListener("abort", onAbort, { once: true });
									try {
										await Promise.race([demand.reading, aborted.promise]);
									} finally {
										signal.removeEventListener("abort", onAbort);
									}
								}
								if (signal.aborted || demand.response !== response) return false;
								current = await this.authorized(demand);
								if (
									!current ||
									signal.aborted ||
									demand.response !== response ||
									!this.dependencies.enabled()
								)
									return false;
								if (source.version !== version)
									result = await this.dependencies.apply(source, current, part, signal);
							}
							if (
								!result ||
								signal.aborted ||
								demand.controller.signal.aborted ||
								demand.response !== response
							)
								return false;
							const published = new Set<string>();
							for (const holder of demand.holders) {
								const observer = holder.viewer;
								if (published.has(observer.narratorId)) continue;
								const allowed = await observer.authorize(demand.target, signal).catch(() => false);
								if (
									allowed &&
									holder.viewer === observer &&
									demand.holders.has(holder) &&
									observer.isCurrent() &&
									!signal.aborted
								) {
									published.add(observer.narratorId);
									this.dependencies.publish(observer, source, result);
								}
							}
							return true;
						},
					});
					if (spent) Object.assign(response, spent);
					demand.response = response;
					this.freezeAllowed(demand, source, response);
				} finally {
					loaded.release();
				}
			}
		})()
			.catch(() => {
				// Unavailable or over-budget history leaves the source text visible.
				if (demand.response) this.scheduler.cancel(demand.response);
				demand.response = undefined;
				demand.followUp = false;
			})
			.finally(() => {
				demand.reading = undefined;
				this.running.delete(work);
				if (demand.dirty) this.refresh(demand);
				else this.releaseCompleted(demand);
			});
		demand.reading = work;
		this.running.add(work);
	}

	async stop(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
		this.stopping = true;
		const deadlineAt = Date.now() + (options.timeoutMs ?? 5_000);
		for (const connection of this.connections.keys()) this.release(connection);
		this.viewers.clear();
		await this.scheduler.stop(options);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled([...this.running]),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Reasoning translation visibility drain deadline exceeded")),
						Math.max(0, deadlineAt - Date.now()),
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}
