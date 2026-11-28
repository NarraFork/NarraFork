import {
	type BuiltinPluginSummary,
	PLUGIN_UPDATE_ERROR_CODES,
	type PluginSource,
	type PluginSourceView,
	type PluginUpdateErrorCode,
	type PluginUpdateJob,
	type PluginUpdateView,
	pluginSourceIdSchema,
	pluginSourceSchema,
	type ResolvedPluginRelease,
} from "@shared/plugin-source";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { createUpdateFetchContext } from "../lib/net/update-fetch";
import { WorkerCleanupError } from "../lib/worker-runtime/lifecycle";
import {
	type DownloadedPluginArchive,
	downloadPluginArchive,
	PluginSourceCleanupError,
} from "./plugin-source-download";
import {
	assertPluginReleaseCompatible,
	comparePluginVersions,
	type LocalSourceDescriptor,
	type PluginSourceEnvironment,
	PluginSourceFailure,
	type PluginSourceTransport,
	resolvePluginSourceRelease,
	sourceAbortable,
	sourceAllowsAutomaticUpdate,
} from "./plugin-source-resolvers";
import {
	PluginSourceUpdateCache,
	type PluginUpdateSummaryStore,
	pluginUpdateSummaryView,
} from "./plugin-source-update-cache";

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
export const PLUGIN_SOURCE_SHUTDOWN_TIMEOUT_MS = 125_000;
const CANDIDATE_TTL_MS = 15 * 60_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const MANUAL_CHECK_INTERVAL_MS = 10_000;
const MAX_JOBS = 256;
const MAX_CACHE = 256;
const MAX_CANDIDATES = 256;
const TERMINAL = new Set<PluginUpdateJob["status"]>([
	"succeeded",
	"failed",
	"cancelled",
	"manual_required",
]);

export interface PluginSourceInstallation {
	pluginId: string;
	installed: boolean;
	current: { version: string; hash: string } | null;
	installationId: string | null;
	authorityInstallationId?: string | null;
	desiredState?: string;
}
export interface PluginSourceApplyOptions {
	pluginId: string;
	expectedCurrent: { version: string; hash: string };
	expectedSourceRevision: number;
	expectedInstallationId: string;
	expectedVersion: string;
	automatic: boolean;
	signal?: AbortSignal;
	allowTrustChange?: boolean;
	onCommit?: () => void;
}
export interface PluginSourceManager {
	isEnabled(): boolean;
	getStatus(pluginId: string): Promise<PluginSourceInstallation | undefined>;
	listStatuses(): Promise<PluginSourceInstallation[]>;
	getSource(pluginId: string): Promise<PluginSourceView>;
	setSource(
		pluginId: string,
		source: PluginSource | null,
		options: { expectedRevision: number },
	): Promise<PluginSourceView>;
	setAutoUpdate(
		pluginId: string,
		enabled: boolean,
		options: { expectedRevision: number },
	): Promise<PluginSourceView>;
	getHostApiVersion(): string;
	onSourceChanged?(listener: (pluginId: string) => void): () => void;
	updateFromSource(source: string, options: PluginSourceApplyOptions): Promise<unknown>;
	installBuiltin(
		descriptor: LocalSourceDescriptor,
		options?: { signal?: AbortSignal; onCommit?: () => void },
	): Promise<unknown>;
}
export interface PluginSourceBuiltinCatalog {
	get(pluginId: string): LocalSourceDescriptor | undefined;
	list(installed?: ReadonlyMap<string, string | null>): readonly BuiltinPluginSummary[];
}
export interface PluginSourceServiceOptions {
	manager?: PluginSourceManager;
	builtins?: PluginSourceBuiltinCatalog;
	transport?: () => PluginSourceTransport;
	environment?: () => PluginSourceEnvironment | Promise<PluginSourceEnvironment>;
	now?: () => number;
	random?: () => number;
	stagingRoot?: string;
	summaries?: PluginUpdateSummaryStore;
	checkTimeoutMs?: number;
	downloadTimeoutMs?: number;
	/** Total drain budget; main's shutdown step must allow a longer outer deadline. */
	shutdownTimeoutMs?: number;
	maxChecks?: number;
	maxDownloads?: number;
	maxQueued?: number;
	/** Isolated download dependency for failure-injection tests. */
	download?: typeof downloadPluginArchive;
}
interface InstallationBinding {
	pluginId: string;
	installationId: string;
	current: { version: string; hash: string };
	sourceRevision: number;
	source: PluginSource;
}
interface Candidate extends InstallationBinding {
	id: string;
	release: ResolvedPluginRelease;
	expiresAt: number;
}
interface CachedUpdate {
	binding: InstallationBinding;
	view: PluginUpdateView;
}
interface CheckSchedule {
	nextManualAt: number;
	nextAutomaticAt: number;
	failures: number;
	revision: number;
}
interface SourceTask {
	job: PluginUpdateJob;
	controller: AbortController;
	promise: Promise<PluginUpdateJob>;
	resolve: (job: PluginUpdateJob) => void;
	/** Kept separate from the result: a failed job can still own a live Worker. */
	retiring?: Promise<unknown>;
	binding?: InstallationBinding;
	candidate?: Candidate;
	automatic: boolean;
	allowTrustChange?: boolean;
	followUp?: Candidate;
}

function safeError(error: unknown, fallback: PluginUpdateErrorCode): PluginUpdateErrorCode {
	if (error instanceof PluginSourceFailure) return error.code;
	const code = (error as { code?: string } | null)?.code;
	if (code === "PLUGIN_UPDATE_MANUAL_REQUIRED") return "manual_required";
	if (code === "PLUGIN_SOURCE_REVISION_CONFLICT") return "source_changed";
	if (code === "PLUGIN_UPDATE_CURRENT_CONFLICT") return "installation_changed";
	if (code === "PLUGIN_UPDATE_NOT_NEWER" || code === "PLUGIN_IDENTITY_MISMATCH")
		return "identity_mismatch";
	return PLUGIN_UPDATE_ERROR_CODES.includes(code as PluginUpdateErrorCode)
		? (code as PluginUpdateErrorCode)
		: fallback;
}
function bindingEqual(a: InstallationBinding, b: InstallationBinding): boolean {
	return (
		a.pluginId === b.pluginId &&
		a.installationId === b.installationId &&
		a.current.hash === b.current.hash &&
		a.current.version === b.current.version &&
		a.sourceRevision === b.sourceRevision &&
		JSON.stringify(a.source) === JSON.stringify(b.source)
	);
}
function releaseSummary(release: ResolvedPluginRelease): NonNullable<PluginUpdateView["latest"]> {
	return {
		version: release.version,
		size: release.size,
		sha256: release.sha256,
		...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
		...(release.notes ? { notes: release.notes } : {}),
	};
}

/** HTTP control-plane service, independent of plugin runtime Host API negotiation. */
export class PluginSourceService {
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly summaries: PluginUpdateSummaryStore;
	private readonly jobs = new Map<string, SourceTask>();
	private readonly inflight = new Map<string, SourceTask>();
	private readonly cache = new Map<string, CachedUpdate>();
	private readonly candidates = new Map<string, Candidate>();
	private readonly schedules = new Map<string, CheckSchedule>();
	private queue: SourceTask[] = [];
	private activeChecks = 0;
	private activeDownloads = 0;
	private running = false;
	private closed = false;
	private timer?: ReturnType<typeof setTimeout>;
	private unwatch?: () => void;
	private starting?: Promise<void>;
	private stopping?: Promise<void>;
	private readonly executions = new Set<Promise<void>>();
	private readonly summaryOperations = new Set<Promise<void>>();
	private readonly sourceChanges = new Set<Promise<PluginSourceView>>();
	private lifecycleFailure: unknown;
	private automaticRun?: Promise<void>;
	private automaticCursor = "";

	constructor(private readonly options: PluginSourceServiceOptions = {}) {
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.summaries = options.summaries ?? new PluginSourceUpdateCache();
	}

	private async manager(): Promise<PluginSourceManager> {
		if (this.options.manager) return this.options.manager;
		return (await import("./plugin-manager")).pluginManager;
	}
	private async builtins(): Promise<PluginSourceBuiltinCatalog> {
		if (this.options.builtins) return this.options.builtins;
		return (await import("./builtin-plugin-catalog")).builtinPluginCatalog;
	}
	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}
	async isEnabled(): Promise<boolean> {
		return !this.closed && (await this.manager()).isEnabled();
	}
	private async enabled(): Promise<PluginSourceManager> {
		const manager = await this.manager();
		if (this.closed || !manager.isEnabled()) throw new PluginSourceFailure("cancelled");
		return manager;
	}
	private async environment(manager: PluginSourceManager): Promise<PluginSourceEnvironment> {
		if (this.options.environment) return this.options.environment();
		return {
			hostVersion: (await import("../lib/version")).APP_VERSION,
			hostApiVersion: manager.getHostApiVersion(),
			os: process.platform,
			arch: process.arch,
		};
	}

	/** One lifetime only, including late initialization and HMR calls after shutdown. */
	start(): void {
		if (this.running || this.closed || this.starting) return;
		this.running = true;
		this.starting = (async () => {
			const manager = await this.manager();
			if (!this.running || this.closed) return;
			this.unwatch = manager.onSourceChanged?.((pluginId) => this.invalidatePlugin(pluginId));
			this.armTimer();
		})()
			.catch((error: unknown) => {
				this.recordFailure(error);
				logger.warn("Plugin source scheduler initialization failed");
			})
			.finally(() => {
				this.starting = undefined;
			});
	}

	/** Actual owners, independent of closed, terminal jobs and the outcome of stop(). */
	hasPendingShutdownWork(): boolean {
		return (
			this.starting !== undefined ||
			this.automaticRun !== undefined ||
			this.sourceChanges.size !== 0 ||
			this.inflight.size !== 0 || // Includes queued tasks and unconfirmed Worker exits.
			this.executions.size !== 0 ||
			this.summaryOperations.size !== 0 ||
			(this.summaries.hasPendingShutdownWork?.() ?? false)
		);
	}

	beginShutdown(): void {
		if (this.closed) return;
		this.running = false;
		this.closed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		const unwatch = this.unwatch;
		this.unwatch = undefined;
		try {
			unwatch?.();
		} catch (error) {
			this.recordFailure(error);
		}
		for (const task of this.inflight.values())
			if (task.job.cancellable) this.cancelTask(task, "cancelled");
		this.candidates.clear();
	}

	/** Repeated callers observe the same result, even after timeout; ownership is never reset. */
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.beginShutdown();
		const timeout = new AbortController();
		const timer = setTimeout(
			() => timeout.abort(new Error("Plugin source shutdown timed out; owners are still retained")),
			Math.max(
				1,
				Math.min(
					PLUGIN_SOURCE_SHUTDOWN_TIMEOUT_MS,
					this.options.shutdownTimeoutMs ?? PLUGIN_SOURCE_SHUTDOWN_TIMEOUT_MS,
				),
			),
		);
		const drain = async () => {
			// Producers finish before capturing consumers and before the final summary flush.
			await Promise.all([this.starting, this.automaticRun]);
			await Promise.allSettled(this.sourceChanges);
			await Promise.all([...this.executions]);
			// Cancellation can retire a job before its summary IO settles. Retain that ownership
			// even with an injected store whose flush does not cover its outstanding operations.
			// The outer shutdown budget reports stalled IO without claiming it has completed.
			while (this.summaryOperations.size) await Promise.allSettled([...this.summaryOperations]);
			await this.summaryOperation(this.summaries.flush());
			if (this.lifecycleFailure !== undefined) throw this.lifecycleFailure;
		};
		this.stopping = sourceAbortable(drain(), timeout.signal).finally(() => clearTimeout(timer));
		return this.stopping;
	}

	private recordFailure(error: unknown): void {
		this.lifecycleFailure ??= error ?? new Error("Plugin source lifecycle failed");
	}

	private summaryOperation(operation: Promise<void>): Promise<void> {
		this.summaryOperations.add(operation);
		void operation.then(
			() => this.summaryOperations.delete(operation),
			(error: unknown) => {
				this.recordFailure(error);
				this.summaryOperations.delete(operation);
			},
		);
		return operation;
	}

	/** Source/UUID changes revoke ephemeral candidates and cancellable work, never reinstall. */
	invalidatePlugin(pluginId: string): void {
		if (this.closed) return;
		this.cache.delete(pluginId);
		this.schedules.delete(pluginId);
		void this.summaryOperation(this.summaries.remove(pluginId)).catch(() =>
			logger.warn("Plugin update summary invalidation failed"),
		);
		for (const [id, candidate] of this.candidates)
			if (candidate.pluginId === pluginId) this.candidates.delete(id);
		const task = this.inflight.get(pluginId);
		if (task?.job.cancellable) this.cancelTask(task, "source_changed");
	}

	async getSource(pluginId: string): Promise<PluginSourceView> {
		pluginSourceIdSchema.parse(pluginId);
		return (await this.manager()).getSource(pluginId);
	}
	private changeSource(
		pluginId: string,
		change: (manager: PluginSourceManager) => Promise<PluginSourceView>,
	): Promise<PluginSourceView> {
		if (this.closed) return Promise.reject(new PluginSourceFailure("cancelled"));
		const operation = (async () => {
			pluginSourceIdSchema.parse(pluginId);
			const view = await change(await this.enabled());
			this.invalidatePlugin(pluginId);
			return view;
		})();
		this.sourceChanges.add(operation);
		const retire = () => this.sourceChanges.delete(operation);
		void operation.then(retire, retire);
		return operation;
	}
	setSource(
		pluginId: string,
		source: PluginSource | null,
		expectedRevision: number,
	): Promise<PluginSourceView> {
		return this.changeSource(pluginId, (manager) =>
			manager.setSource(pluginId, source === null ? null : pluginSourceSchema.parse(source), {
				expectedRevision,
			}),
		);
	}
	setAutoUpdate(
		pluginId: string,
		autoUpdate: boolean,
		expectedRevision: number,
	): Promise<PluginSourceView> {
		return this.changeSource(pluginId, async (manager) => {
			const view = await manager.getSource(pluginId);
			if (autoUpdate && (!view.binding.source || !sourceAllowsAutomaticUpdate(view.binding.source)))
				throw new PluginSourceFailure(view.binding.source ? "manual_required" : "no_source");
			return manager.setAutoUpdate(pluginId, autoUpdate, { expectedRevision });
		});
	}

	async listBuiltins(): Promise<readonly BuiltinPluginSummary[]> {
		const manager = await this.manager();
		const installed = new Map<string, string>(
			(await manager.listStatuses()).flatMap<[string, string]>((state) =>
				state.installed && state.current ? [[state.pluginId, state.current.version]] : [],
			),
		);
		return (await this.builtins()).list(installed).map((item) => ({
			...item,
			canInstall: item.canInstall && !this.closed && manager.isEnabled(),
		}));
	}

	private async binding(pluginId: string): Promise<InstallationBinding> {
		const manager = await this.manager();
		const [state, source] = await Promise.all([
			manager.getStatus(pluginId),
			manager.getSource(pluginId),
		]);
		if (!state?.installed || !state.current || state.desiredState === "uninstalling")
			throw new PluginSourceFailure("installation_changed");
		if (!state.installationId) throw new PluginSourceFailure("manual_required");
		if (!source.binding.source) throw new PluginSourceFailure("no_source");
		return {
			pluginId,
			installationId: state.installationId,
			current: { ...state.current },
			sourceRevision: source.binding.revision,
			source: structuredClone(source.binding.source),
		};
	}

	async getUpdates(pluginId: string): Promise<PluginUpdateView> {
		pluginSourceIdSchema.parse(pluginId);
		const manager = await this.manager();
		const [state, source] = await Promise.all([
			manager.getStatus(pluginId),
			manager.getSource(pluginId),
		]);
		let cached = this.cache.get(pluginId);
		if (
			cached &&
			(!state?.installed ||
				!state.current ||
				state.current.hash !== cached.binding.current.hash ||
				state.installationId !== cached.binding.installationId ||
				source.binding.revision !== cached.binding.sourceRevision)
		) {
			this.invalidatePlugin(pluginId);
			cached = undefined;
		}
		if (
			!this.closed &&
			!cached &&
			state?.installed &&
			state.current &&
			state.installationId &&
			source.binding.source
		) {
			const stored = await this.summaries.get(pluginId);
			if (stored) {
				if (
					stored.installationId === state.installationId &&
					stored.current.hash === state.current.hash &&
					stored.current.version === state.current.version &&
					stored.sourceRevision === source.binding.revision
				) {
					try {
						const binding = await this.binding(pluginId);
						if (
							binding.installationId === stored.installationId &&
							binding.current.hash === stored.current.hash &&
							binding.sourceRevision === stored.sourceRevision
						) {
							cached = { binding, view: structuredClone(stored.view) };
							this.cache.set(pluginId, cached);
							this.trim();
						}
					} catch {
						/* A concurrent uninstall/source edit cannot restore a stale summary. */
					}
				} else if (!this.closed) {
					await this.summaryOperation(this.summaries.remove(pluginId)).catch(() =>
						logger.warn("Plugin update summary invalidation failed"),
					);
				}
			}
		}
		if (cached) {
			const view = structuredClone(cached.view);
			if (view.jobId && !this.jobs.has(view.jobId)) {
				delete cached.view.jobId;
				delete view.jobId;
			}
			const candidate = view.candidateId ? this.candidates.get(view.candidateId) : undefined;
			if (view.candidateId && (!candidate || candidate.expiresAt <= this.now())) {
				this.candidates.delete(view.candidateId);
				delete view.candidateId;
			}
			return view;
		}
		return {
			pluginId,
			status: source.binding.source ? "idle" : "no_source",
			installedVersion: state?.current?.version ?? null,
			checkedAt: null,
			latest: null,
			error: source.binding.source ? null : "no_source",
		};
	}

	private async persistUpdate(
		binding: InstallationBinding,
		view: PluginUpdateView,
		signal?: AbortSignal,
	): Promise<void> {
		const summary = pluginUpdateSummaryView(view);
		if (!summary) return;
		const writing = this.summaryOperation(
			this.summaries.save({
				pluginId: binding.pluginId,
				installationId: binding.installationId,
				current: binding.current,
				sourceRevision: binding.sourceRevision,
				view: summary,
			}),
		);
		if (signal?.aborted) {
			void writing.catch(() => logger.warn("Plugin update summary persistence failed"));
			return;
		}
		try {
			if (signal) await sourceAbortable(writing, signal);
			else await writing;
		} catch {
			if (!signal?.aborted) logger.warn("Plugin update summary persistence failed");
		}
	}

	async check(pluginId: string, options: { automatic?: boolean } = {}): Promise<{ jobId: string }> {
		pluginSourceIdSchema.parse(pluginId);
		await this.enabled();
		const existing = this.inflight.get(pluginId);
		if (existing) return { jobId: existing.job.id };
		const binding = await this.binding(pluginId);
		const coalesced = this.inflight.get(pluginId);
		if (coalesced) return { jobId: coalesced.job.id };
		const automatic = options.automatic ?? false;
		if (automatic && !sourceAllowsAutomaticUpdate(binding.source))
			throw new PluginSourceFailure("manual_required");
		const schedule = this.scheduleFor(pluginId, binding.sourceRevision);
		if (!automatic && schedule.nextManualAt > this.now())
			throw new PluginSourceFailure("rate_limited", schedule.nextManualAt - this.now());
		const task = this.enqueue(pluginId, "check", { binding, automatic });
		if (!automatic) schedule.nextManualAt = this.now() + MANUAL_CHECK_INTERVAL_MS;
		this.cache.set(pluginId, {
			binding,
			view: {
				pluginId,
				status: "checking",
				installedVersion: binding.current.version,
				checkedAt: null,
				latest: null,
				error: null,
				jobId: task.job.id,
			},
		});
		this.trim();
		return { jobId: task.job.id };
	}

	async apply(
		pluginId: string,
		candidateId: string,
		expectedRevision: number,
		options: { automatic?: boolean; allowTrustChange?: boolean } = {},
	): Promise<{ jobId: string }> {
		pluginSourceIdSchema.parse(pluginId);
		await this.enabled();
		const candidate = this.candidates.get(candidateId);
		if (
			!candidate ||
			candidate.pluginId !== pluginId ||
			candidate.expiresAt <= this.now() ||
			candidate.sourceRevision !== expectedRevision
		)
			throw new PluginSourceFailure("source_changed");
		const current = await this.binding(pluginId);
		if (!bindingEqual(current, candidate))
			throw new PluginSourceFailure(
				current.sourceRevision !== candidate.sourceRevision
					? "source_changed"
					: "installation_changed",
			);
		if (options.automatic && !sourceAllowsAutomaticUpdate(current.source))
			throw new PluginSourceFailure("manual_required");
		const existing = this.inflight.get(pluginId);
		if (existing) {
			if (existing.candidate?.id === candidateId) return { jobId: existing.job.id };
			throw new PluginSourceFailure("queue_full");
		}
		const task = this.enqueue(pluginId, "update", {
			binding: current,
			candidate,
			automatic: options.automatic ?? false,
			allowTrustChange: options.allowTrustChange,
		});
		const cached = this.cache.get(pluginId);
		if (cached) cached.view.jobId = task.job.id;
		return { jobId: task.job.id };
	}

	async installBuiltin(pluginId: string): Promise<{ jobId: string }> {
		pluginSourceIdSchema.parse(pluginId);
		const manager = await this.enabled();
		if (!(await this.builtins()).get(pluginId)) throw new PluginSourceFailure("local_missing");
		const state = await manager.getStatus(pluginId);
		if (state?.installed || state?.current) throw new PluginSourceFailure("installation_changed");
		const existing = this.inflight.get(pluginId);
		if (existing) return { jobId: existing.job.id };
		return { jobId: this.enqueue(pluginId, "install_builtin", { automatic: false }).job.id };
	}

	getJob(jobId: string): PluginUpdateJob | null {
		const task = this.jobs.get(jobId);
		return task ? structuredClone(task.job) : null;
	}
	async waitForJob(jobId: string): Promise<PluginUpdateJob | null> {
		return this.jobs.get(jobId)?.promise ?? null;
	}
	cancel(jobId: string): PluginUpdateJob | null {
		const task = this.jobs.get(jobId);
		if (!task) return null;
		if (task.job.cancellable && !TERMINAL.has(task.job.status)) this.cancelTask(task, "cancelled");
		return structuredClone(task.job);
	}
	private cancelTask(task: SourceTask, code: "cancelled" | "source_changed"): void {
		task.controller.abort(new PluginSourceFailure(code));
		if (task.job.status === "queued") {
			this.cache.delete(task.job.pluginId);
			this.queue = this.queue.filter((item) => item !== task);
			this.finish(task, "cancelled", code);
			this.pump();
		}
	}

	private enqueue(
		pluginId: string,
		kind: PluginUpdateJob["kind"],
		context: Pick<SourceTask, "automatic"> &
			Partial<Pick<SourceTask, "binding" | "candidate" | "allowTrustChange">>,
	): SourceTask {
		if (this.closed) throw new PluginSourceFailure("cancelled");
		if (this.queue.length >= Math.min(64, this.options.maxQueued ?? 64))
			throw new PluginSourceFailure("queue_full");
		const timestamp = this.timestamp();
		let resolve!: SourceTask["resolve"];
		const promise = new Promise<PluginUpdateJob>((done) => {
			resolve = done;
		});
		const task: SourceTask = {
			...context,
			job: {
				id: crypto.randomUUID(),
				pluginId,
				kind,
				status: "queued",
				phase: "queued",
				cancellable: true,
				downloadedBytes: 0,
				totalBytes: context.candidate?.release.size ?? null,
				error: null,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
			controller: new AbortController(),
			promise,
			resolve,
		};
		this.jobs.set(task.job.id, task);
		this.inflight.set(pluginId, task);
		this.queue.push(task);
		this.trim();
		queueMicrotask(() => this.pump());
		return task;
	}
	private pump(): void {
		if (this.closed) return;
		for (;;) {
			const index = this.queue.findIndex((task) =>
				task.job.kind === "check"
					? this.activeChecks < Math.min(2, this.options.maxChecks ?? 2)
					: this.activeDownloads < Math.min(1, this.options.maxDownloads ?? 1),
			);
			if (index < 0) return;
			const task = this.queue.splice(index, 1)[0];
			if (!task) return;
			if (task.job.kind === "check") this.activeChecks++;
			else this.activeDownloads++;
			task.job.status = "running";
			const execution = this.execute(task).finally(async () => {
				// A result is not a resource barrier. Failed termination keeps both the plugin
				// identity and its concurrency slot until the actual resource has exited.
				if (task.retiring) await task.retiring;
				if (this.inflight.get(task.job.pluginId) === task) this.inflight.delete(task.job.pluginId);
				if (task.job.kind === "check") this.activeChecks--;
				else this.activeDownloads--;
				this.pump();
				if (task.followUp && task.job.status === "succeeded" && !this.closed)
					void this.apply(task.job.pluginId, task.followUp.id, task.followUp.sourceRevision, {
						automatic: true,
					}).catch(() => {});
			});
			this.executions.add(execution);
			void execution.then(
				() => this.executions.delete(execution),
				(error: unknown) => {
					this.recordFailure(error);
					this.executions.delete(execution);
					// A rejected exit witness leaves the task in inflight and its slot occupied.
				},
			);
		}
	}
	private phase(task: SourceTask, phase: PluginUpdateJob["phase"]): void {
		task.job.phase = phase;
		task.job.updatedAt = this.timestamp();
	}
	private finish(
		task: SourceTask,
		status: PluginUpdateJob["status"],
		error: PluginUpdateErrorCode | null,
	): void {
		task.job.status = status;
		task.job.error = error;
		task.job.cancellable = false;
		this.phase(task, "completed");
		if (!task.retiring && this.inflight.get(task.job.pluginId) === task)
			this.inflight.delete(task.job.pluginId);
		task.resolve(structuredClone(task.job));
	}

	private async execute(task: SourceTask): Promise<void> {
		const budget =
			task.job.kind === "check"
				? Math.min(CHECK_TIMEOUT_MS, this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS)
				: Math.min(DOWNLOAD_TIMEOUT_MS, this.options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
		const timer = setTimeout(() => {
			if (task.job.cancellable)
				task.controller.abort(
					new PluginSourceFailure(task.job.kind === "check" ? "request_failed" : "apply_failed"),
				);
		}, budget);
		const began = this.now();
		try {
			const manager = await sourceAbortable(this.enabled(), task.controller.signal);
			const environment = await sourceAbortable(this.environment(manager), task.controller.signal);
			const builtins = await sourceAbortable(this.builtins(), task.controller.signal);
			const transport = (this.options.transport ?? createUpdateFetchContext)();
			if (task.job.kind === "check")
				await this.executeCheck(task, manager, builtins, transport, environment);
			else await this.executeApply(task, manager, builtins, transport, environment);
			if (task.job.cancellable) task.controller.signal.throwIfAborted();
			this.finish(task, "succeeded", null);
		} catch (error) {
			const cleanupFailed =
				error instanceof WorkerCleanupError || error instanceof PluginSourceCleanupError;
			if (error instanceof WorkerCleanupError) task.retiring = error.handle.exited;
			if (error instanceof PluginSourceCleanupError) {
				// A deferred rm can fail *after* the hash Worker's confirmed exit. Preserve the
				// lifecycle error below, not a permanently occupied slot for completed IO.
				const worker = error.cause instanceof WorkerCleanupError ? error.cause.handle : undefined;
				task.retiring = error.settled.catch(() => worker?.exited);
			}
			if (cleanupFailed) this.recordFailure(error);
			const code = cleanupFailed
				? "apply_failed"
				: safeError(
						task.job.cancellable && task.controller.signal.aborted
							? task.controller.signal.reason
							: error,
						task.job.kind === "check" ? "request_failed" : "apply_failed",
					);
			const cached = this.cache.get(task.job.pluginId);
			if (task.job.kind === "check") {
				task.followUp = undefined;
				for (const [id, candidate] of this.candidates)
					if (candidate.pluginId === task.job.pluginId) this.candidates.delete(id);
				if (cached) delete cached.view.candidateId;
			}
			if (task.binding && cached && bindingEqual(cached.binding, task.binding)) {
				cached.view.status = code === "manual_required" ? "manual_required" : "error";
				cached.view.error = code;
				cached.view.checkedAt = this.timestamp();
				await this.persistUpdate(task.binding, cached.view, task.controller.signal);
			}
			const schedule = this.schedules.get(task.job.pluginId);
			if (schedule) {
				schedule.failures++;
				const hint = error instanceof PluginSourceFailure ? error.retryAfterMs : 0;
				if (hint > 0) schedule.nextManualAt = Math.max(schedule.nextManualAt, this.now() + hint);
				schedule.nextAutomaticAt =
					this.now() +
					Math.max(
						hint,
						Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(schedule.failures - 1, 10)),
					);
			}
			this.finish(
				task,
				code === "manual_required"
					? "manual_required"
					: code === "cancelled" || code === "source_changed"
						? "cancelled"
						: "failed",
				code,
			);
		} finally {
			clearTimeout(timer);
			if (this.now() - began >= 1_000)
				logger.debug("Plugin source operation completed", {
					pluginId: task.job.pluginId,
					kind: task.job.kind,
					status: task.job.status,
					durationMs: this.now() - began,
				});
		}
	}

	private async assertBinding(task: SourceTask): Promise<InstallationBinding> {
		task.controller.signal.throwIfAborted();
		const current = await sourceAbortable(this.binding(task.job.pluginId), task.controller.signal);
		if (!task.binding || !bindingEqual(current, task.binding))
			throw new PluginSourceFailure(
				current.sourceRevision !== task.binding?.sourceRevision
					? "source_changed"
					: "installation_changed",
			);
		if (task.candidate && task.candidate.expiresAt <= this.now())
			throw new PluginSourceFailure("source_changed");
		return task.binding;
	}

	private async executeCheck(
		task: SourceTask,
		manager: PluginSourceManager,
		builtins: PluginSourceBuiltinCatalog,
		transport: PluginSourceTransport,
		environment: PluginSourceEnvironment,
	): Promise<void> {
		this.phase(task, "checking");
		const binding = await this.assertBinding(task);
		const release = await resolvePluginSourceRelease(
			binding.pluginId,
			binding.current.version,
			binding.source,
			{
				signal: task.controller.signal,
				transport,
				environment,
				getBuiltin: (id) => builtins.get(id),
			},
		);
		await this.assertBinding(task);
		if (!transport.isCurrent() || !manager.isEnabled())
			throw new PluginSourceFailure("source_changed");
		if (release) assertPluginReleaseCompatible(release, environment);
		const view: PluginUpdateView = {
			pluginId: binding.pluginId,
			status:
				!release || comparePluginVersions(release.version, binding.current.version) <= 0
					? "up_to_date"
					: "available",
			installedVersion: binding.current.version,
			checkedAt: this.timestamp(),
			latest: release ? releaseSummary(release) : null,
			error: null,
			jobId: task.job.id,
		};
		if (view.status === "available" && release) {
			const candidate: Candidate = {
				...binding,
				id: crypto.randomUUID(),
				release: structuredClone(release),
				expiresAt: this.now() + CANDIDATE_TTL_MS,
			};
			this.candidates.set(candidate.id, candidate);
			view.candidateId = candidate.id;
			if (task.automatic) task.followUp = candidate;
		}
		this.cache.set(binding.pluginId, { binding, view });
		await this.persistUpdate(binding, view, task.controller.signal);
		const schedule = this.scheduleFor(binding.pluginId, binding.sourceRevision);
		schedule.failures = 0;
		schedule.nextAutomaticAt = this.now() + this.autoInterval();
		this.trim();
	}

	private async executeApply(
		task: SourceTask,
		manager: PluginSourceManager,
		builtins: PluginSourceBuiltinCatalog,
		transport: PluginSourceTransport,
		environment: PluginSourceEnvironment,
	): Promise<void> {
		let release: ResolvedPluginRelease;
		let source: PluginSource;
		let definition: LocalSourceDescriptor | undefined;
		let binding: InstallationBinding | undefined;
		if (task.job.kind === "install_builtin") {
			const state = await manager.getStatus(task.job.pluginId);
			if (state?.installed || state?.current) throw new PluginSourceFailure("installation_changed");
			definition = builtins.get(task.job.pluginId);
			if (!definition) throw new PluginSourceFailure("local_missing");
			source = definition.source;
			const loaded = await sourceAbortable(
				definition.load(task.controller.signal),
				task.controller.signal,
			);
			release = {
				pluginId: definition.pluginId,
				version: definition.version,
				sha256: loaded.sha256,
				size: loaded.bytes.byteLength,
				artifact: { type: "local", builtinId: definition.pluginId },
			};
		} else {
			binding = await this.assertBinding(task);
			if (!task.candidate) throw new PluginSourceFailure("invalid_release");
			release = task.candidate.release;
			source = binding.source;
			assertPluginReleaseCompatible(release, environment);
		}
		task.job.totalBytes = release.size;
		this.phase(task, "downloading");
		let archive: DownloadedPluginArchive | undefined;
		try {
			let lastProgress = 0;
			archive = await (this.options.download ?? downloadPluginArchive)(source, release, {
				signal: task.controller.signal,
				transport,
				stagingRoot: this.options.stagingRoot,
				getBuiltin: (id) => builtins.get(id),
				onProgress: (downloadedBytes) => {
					task.job.downloadedBytes = downloadedBytes;
					if (this.now() - lastProgress >= 250 || downloadedBytes === release.size) {
						task.job.updatedAt = this.timestamp();
						lastProgress = this.now();
					}
				},
			});
			this.phase(task, "validating");
			if (!transport.isCurrent() || !manager.isEnabled())
				throw new PluginSourceFailure("source_changed");
			if (task.job.kind !== "install_builtin") await this.assertBinding(task);
			else if ((await manager.getStatus(task.job.pluginId))?.installed)
				throw new PluginSourceFailure("installation_changed");
			task.controller.signal.throwIfAborted();
			// The manager reports the actual irreversible CAS boundary, not merely
			// delegation: validation stays cancellable, committed results remain truthful.
			const onCommit = () => {
				task.controller.signal.throwIfAborted();
				task.job.cancellable = false;
				task.job.updatedAt = this.timestamp();
			};
			this.phase(task, "applying");
			if (definition)
				await manager.installBuiltin(definition, { signal: task.controller.signal, onCommit });
			else {
				if (!binding) throw new PluginSourceFailure("invalid_release");
				await manager.updateFromSource(archive.path, {
					pluginId: task.job.pluginId,
					expectedCurrent: binding.current,
					expectedSourceRevision: binding.sourceRevision,
					expectedInstallationId: binding.installationId,
					expectedVersion: release.version,
					automatic: task.automatic,
					signal: task.controller.signal,
					allowTrustChange: task.allowTrustChange,
					onCommit,
				});
			}
			this.candidates.delete(task.candidate?.id ?? "");
			this.cache.delete(task.job.pluginId);
			// The manager has committed the real result. Summary persistence must not delay
			// reporting it, but remains owned and checked by the shutdown barrier.
			void this.summaryOperation(this.summaries.remove(task.job.pluginId)).catch(() =>
				logger.warn("Plugin update summary invalidation failed"),
			);
		} finally {
			await archive?.cleanup().catch((error: unknown) => {
				// A staging cleanup failure cannot rewrite an already committed update result.
				// It still prevents shutdown from falsely reporting a clean lifecycle.
				this.recordFailure(error);
				logger.warn("Plugin update staging cleanup failed");
			});
		}
	}

	private autoInterval(): number {
		return (
			AUTO_CHECK_INTERVAL_MS + Math.floor(Math.min(1, Math.max(0, this.random())) * 30 * 60_000)
		);
	}
	private scheduleFor(pluginId: string, revision: number): CheckSchedule {
		let schedule = this.schedules.get(pluginId);
		if (!schedule || schedule.revision !== revision) {
			if (!schedule && this.schedules.size >= 1024) throw new PluginSourceFailure("queue_full");
			schedule = {
				revision,
				nextManualAt: 0,
				nextAutomaticAt: this.now() + this.autoInterval(),
				failures: 0,
			};
			this.schedules.set(pluginId, schedule);
		}
		return schedule;
	}

	/** One finite pass, exposed for clock-driven tests; never updates an uninstalled package. */
	runAutomaticChecks(): Promise<void> {
		if (this.automaticRun) return this.automaticRun;
		this.automaticRun = this.automaticChecks().finally(() => {
			this.automaticRun = undefined;
		});
		return this.automaticRun;
	}
	private async automaticChecks(): Promise<void> {
		if (!this.running || this.closed) return;
		const manager = await this.manager();
		if (!manager.isEnabled()) return;
		const states = (await manager.listStatuses())
			.filter((state) => state.installed && state.current && state.desiredState !== "uninstalling")
			.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
		const pending = states.filter((state) => state.pluginId > this.automaticCursor);
		const batch = (pending.length ? pending : states).slice(0, MAX_CACHE);
		const last = batch.at(-1)?.pluginId ?? "";
		this.automaticCursor = last === states.at(-1)?.pluginId ? "" : last;
		const installed = new Set(states.map((state) => state.pluginId));
		for (const id of this.schedules.keys()) if (!installed.has(id)) this.invalidatePlugin(id);
		for (const state of batch) {
			if (!this.running || this.closed || !manager.isEnabled()) break;
			const source = await manager.getSource(state.pluginId);
			if (!source.binding.autoUpdate || !source.binding.source) continue;
			const schedule = this.scheduleFor(state.pluginId, source.binding.revision);
			if (schedule.nextAutomaticAt > this.now() || this.inflight.has(state.pluginId)) continue;
			schedule.nextAutomaticAt = this.now() + this.autoInterval();
			try {
				await this.check(state.pluginId, { automatic: true });
			} catch (error) {
				schedule.nextAutomaticAt =
					this.now() +
					Math.max(60_000, error instanceof PluginSourceFailure ? error.retryAfterMs : 60_000);
			}
		}
	}
	private armTimer(): void {
		if (!this.running || this.closed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.runAutomaticChecks()
				.catch(() => logger.warn("Plugin source automatic check failed"))
				.finally(() => this.armTimer());
		}, 60_000);
		this.timer.unref?.();
	}
	private trim(): void {
		for (const [id, candidate] of this.candidates)
			if (candidate.expiresAt <= this.now()) this.candidates.delete(id);
		while (this.candidates.size > MAX_CANDIDATES) {
			const oldest = this.candidates.keys().next().value;
			if (oldest === undefined) break;
			this.candidates.delete(oldest);
		}
		while (this.cache.size > MAX_CACHE) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		if (this.jobs.size > MAX_JOBS)
			for (const [id, task] of this.jobs) {
				if (TERMINAL.has(task.job.status)) this.jobs.delete(id);
				if (this.jobs.size <= MAX_JOBS) break;
			}
	}
}

export const pluginSourceService = hotSafe(
	"narrafork.pluginSourceService",
	() => new PluginSourceService(),
);
