import { createHash } from "node:crypto";
import type { AutoRouteSignals } from "@shared/auto-route-strategy";
import { parseModelId } from "@shared/model-id";
import { pluginProviderRegistry } from "../services/plugin-provider-registry";
import { autoSourceFacts } from "./agent/auto-route-signals";
import { getCodexManager } from "./codex-manager";
import {
	type ConnectedWorker,
	compiledWorkerSpecifiers,
	connectCompiledWorker,
} from "./compiled-worker";
import {
	getModelOptionsCatalogSource,
	getModelOverride,
	getModelOverridesRevision,
} from "./model-catalog";
import {
	captureModelOptionsArray,
	captureTemplateModelOptions,
	type ModelOptionInput,
	type ModelOptionSourceCandidate,
	type ModelOptionsCapture,
	ModelOptionsError,
	type ModelOptionsPage,
	type ModelOptionsQuery,
	modelOptionPrice,
	OPTIONS_BUDGET,
	optionInput,
} from "./model-options-contract";
import { getSettingsRevision, settings } from "./settings";
import { listSourceGroups } from "./sourcing/source-groups";
import { WorkerCleanupError } from "./worker-runtime/lifecycle";
import { TaskQueue, TaskQueueError } from "./worker-runtime/queue";

export interface ModelOptionsSnapshot {
	revision: string;
	catalog: ReturnType<typeof getModelOptionsCatalogSource>;
	captures: ModelOptionsCapture[];
	hidden: string[];
	excluded: string[];
	codex: boolean;
}
function boundedStrings(values: string[]): void {
	if (
		values.length > OPTIONS_BUDGET.rows ||
		values.some((value) => typeof value !== "string" || value.length > 1024)
	)
		throw new ModelOptionsError(
			"MODEL_OPTIONS_INPUT_LIMIT",
			"Model options configuration exceeds budget",
		);
}
/** Called only by an actual options request. Capturing does not list/map a provider's models. */
export function captureModelOptionsSnapshot(): ModelOptionsSnapshot {
	const catalog = getModelOptionsCatalogSource();
	if (
		(settings.customApiProviders?.length ?? 0) +
			(settings.nugProviders?.length ?? 0) +
			pluginProviderRegistry.modelOptionsOwnerCount +
			3 >
		1024
	)
		throw new ModelOptionsError("MODEL_OPTIONS_INPUT_LIMIT", "Too many model cache owners");
	const groups = listSourceGroups();
	if (groups.length > 1024)
		throw new ModelOptionsError("MODEL_OPTIONS_INPUT_LIMIT", "Too many model cache owners");
	boundedStrings(settings.agent.disabledProviders ?? []);
	const disabled = new Set(settings.agent.disabledProviders ?? []);
	for (const group of groups) if (group.disabled) disabled.add(group.prefix);
	// availableCount is a pure enabled-credential count, not quota/cooldown availability.
	const codexConfigured = getCodexManager().availableCount > 0;
	if (!codexConfigured) disabled.add("codex");
	const fallbackConfig = new Map<string, { defaultModel?: string }>();
	for (const [providers, requireBaseUrl] of [
		[settings.customApiProviders ?? [], false],
		[settings.nugProviders ?? [], true],
	] as const) {
		for (const provider of providers) {
			if (
				!provider.prefix?.trim() ||
				provider.disabled ||
				disabled.has(provider.prefix) ||
				!provider.apiKey?.trim() ||
				(requireBaseUrl && !provider.baseUrl?.trim()) ||
				fallbackConfig.has(provider.prefix)
			)
				continue;
			fallbackConfig.set(provider.prefix, { defaultModel: provider.defaultModel });
		}
	}
	if (codexConfigured) fallbackConfig.set("codex", {});
	if (settings.tokendance?.apiKey?.trim() && !settings.tokendance.disabled)
		fallbackConfig.set("tokendance", {});
	if (settings.commandCode?.apiKey?.trim() && !settings.commandCode.disabled)
		fallbackConfig.set("CommandCode", {});
	const captures: ModelOptionsCapture[] = [];
	const fallbackCaptures: ModelOptionsCapture[] = [];
	let codex = false;
	const prefixes = new Set<string>();
	for (const group of groups) {
		if (
			!group.prefix?.trim() ||
			group.disabled ||
			disabled.has(group.prefix) ||
			prefixes.has(group.prefix)
		)
			continue;
		prefixes.add(group.prefix);
		if (group.templateId === "codex") codex = true;
		const capture =
			group.templateId === "plugin"
				? pluginProviderRegistry.captureModelOptions(group)
				: captureTemplateModelOptions(group);
		captures.push(capture);
		// A populated discovery cache is authoritative: never revive a known-delisted pin.
		const configured = fallbackConfig.get(group.prefix);
		if (capture.count !== 0 || !configured) continue;
		const models: string[] = [];
		const add = (model: string | undefined) => {
			const raw = model?.trim();
			if (
				!raw ||
				["__default__", "__summary__", "__parent__"].includes(raw) ||
				raw.startsWith("__agg__:")
			)
				return;
			const upstream = raw.startsWith(`${group.prefix}:`)
				? raw.slice(group.prefix.length + 1)
				: raw;
			if (upstream.trim()) models.push(upstream);
		};
		add(configured.defaultModel);
		for (const pin of [settings.agent.defaultModel, settings.agent.summaryModel]) {
			if (pin?.startsWith(`${group.prefix}:`)) add(pin);
		}
		if (models.length)
			fallbackCaptures.push(
				captureModelOptionsArray(
					models,
					(model) => ({ ...optionInput(group, model), auto: false }),
					getSettingsRevision(),
				),
			);
	}
	const customCapture = captureModelOptionsArray(settings.agent.customModels, (row) => {
		const value = row.value.includes(":") ? row.value : `${row.provider ?? "openai"}:${row.value}`;
		const parsed = parseModelId(value);
		return {
			value,
			label: row.label || value,
			provider: parsed.provider ?? "openai",
			upstreamModelId: parsed.model,
		};
	});
	captures.push({
		...customCapture,
		readSlice: (offset, limit) =>
			customCapture.readSlice(offset, limit).filter((row) => !disabled.has(row.provider)),
	});
	captures.push(
		captureModelOptionsArray(settings.agent.modelAggregations, (row) => ({
			value: `__agg__:${row.id}`,
			label: row.name,
			provider: "__agg__",
			upstreamModelId: row.id,
			auto: false,
			aggregationMembers: row.models,
		})),
	);
	// First-wins worker deduplication must prefer explicit/discovered declarations.
	captures.push(...fallbackCaptures);
	const hidden = settings.agent.hiddenModels ?? [];
	const excluded = settings.agent.autoExcludedProviders ?? [];
	boundedStrings(hidden);
	boundedStrings(excluded);

	if (captures.reduce((sum, capture) => sum + capture.count, 0) > OPTIONS_BUDGET.rows)
		throw new ModelOptionsError("MODEL_OPTIONS_INPUT_LIMIT", "Too many model options");
	const signature = [
		getSettingsRevision(),
		pluginProviderRegistry.revision,
		catalog.version,
		codexConfigured,
		...captures.map((capture) => `${capture.generation}:${capture.count}`),
	].join("|");
	return {
		revision: createHash("sha256").update(signature).digest("hex"),
		catalog,
		captures,
		hidden,
		excluded,
		codex,
	};
}
interface Job {
	query: ModelOptionsQuery;
	signal: AbortSignal;
	deadline: number;
}
export interface ModelOptionsClientDependencies {
	capture(): ModelOptionsSnapshot;
	connect: typeof connectCompiledWorker;
	budgets?: { buildMs?: number; queryMs?: number; coldMs?: number };
}
/** A single demand-started worker and a bounded serial queue. No inline compute/fallback. */
export class ModelOptionsClient {
	private connection?: ConnectedWorker;
	private closing?: Promise<void>;
	private revision?: string;
	private nextId = 0;
	private readonly queue = new TaskQueue({
		concurrency: 1,
		maxQueued: OPTIONS_BUDGET.queue - 1,
		maxQueuedBytes: OPTIONS_BUDGET.queue * 4096,
		timeoutMs: OPTIONS_BUDGET.coldMs,
	});
	constructor(
		private readonly deps: ModelOptionsClientDependencies = {
			capture: captureModelOptionsSnapshot,
			connect: (...args) => connectCompiledWorker(...args),
		},
	) {}
	async query(query: ModelOptionsQuery, signal?: AbortSignal): Promise<ModelOptionsPage> {
		const deadlineAt = Date.now() + (this.deps.budgets?.coldMs ?? OPTIONS_BUDGET.coldMs);
		let permit: Awaited<ReturnType<TaskQueue["acquire"]>>;
		try {
			permit = await this.queue.acquire({
				signal,
				deadlineAt,
				bytes: Buffer.byteLength(JSON.stringify(query)),
			});
		} catch (error) {
			if (error instanceof TaskQueueError)
				throw new ModelOptionsError(
					error.code === "TASK_QUEUE_FULL" ? "MODEL_OPTIONS_BUSY" : "MODEL_OPTIONS_TIMEOUT",
					error.message,
				);
			throw error;
		}
		let cleanupPending = false;
		try {
			return await this.execute({ query, signal: permit.signal, deadline: permit.deadlineAt });
		} catch (error) {
			if (error instanceof WorkerCleanupError) {
				cleanupPending = true;
				void error.handle.exited.then(permit.release, () => {});
				throw new ModelOptionsError(
					"MODEL_OPTIONS_UNAVAILABLE",
					"Model options worker cleanup is pending",
				);
			}
			if (error instanceof TaskQueueError)
				throw new ModelOptionsError("MODEL_OPTIONS_TIMEOUT", error.message);
			if (error instanceof ModelOptionsError || signal?.aborted) throw error;
			throw new ModelOptionsError(
				"MODEL_OPTIONS_UNAVAILABLE",
				"Model options worker is unavailable",
			);
		} finally {
			if (!cleanupPending) permit.release();
		}
	}
	async close(): Promise<void> {
		this.revision = undefined;
		const connection = this.connection;
		this.connection = undefined;
		if (connection) {
			const closing = connection.handle.close();
			this.closing = closing;
			try {
				await closing;
			} catch (error) {
				void connection.handle.exited.then(() => {
					if (this.closing === closing) this.closing = undefined;
				});
				throw new WorkerCleanupError(connection.handle, error);
			}
			if (this.closing === closing) this.closing = undefined;
		}
	}
	private async execute(job: Job): Promise<ModelOptionsPage> {
		const signal = job.signal;
		const snapshot = this.deps.capture();
		const buildDeadline = Math.min(
			job.deadline,
			Date.now() + (this.deps.budgets?.buildMs ?? OPTIONS_BUDGET.buildMs),
		);
		try {
			if (this.closing) await this.closing;
			signal.throwIfAborted();
			if (this.connection?.handle.closed) await this.close();
			if (!this.connection) {
				this.connection = await this.deps.connect(
					compiledWorkerSpecifiers(
						"lib/model-options-worker.ts",
						"./model-options-worker.ts",
						import.meta.url,
					),
					{ signal, deadlineAt: buildDeadline, timeoutMs: Math.max(1, buildDeadline - Date.now()) },
				);
				this.connection.worker.unref();
			}
			if (snapshot.revision !== this.revision) {
				await this.rpc(
					{
						type: "begin",
						revision: snapshot.revision,
						catalog: snapshot.catalog,
					},
					buildDeadline,
					signal,
				);
				let inputBytes = 2;
				for (const filterKind of ["hidden", "excluded"] as const) {
					let values: string[] = [];
					let bytes = 2;
					for (const value of snapshot[filterKind]) {
						if (value.length > 1024)
							throw new ModelOptionsError(
								"MODEL_OPTIONS_INPUT_LIMIT",
								"Model options filter exceeds budget",
							);
						const size = Buffer.byteLength(JSON.stringify(value)) + 1;
						inputBytes += size;
						if (inputBytes > OPTIONS_BUDGET.bytes)
							throw new ModelOptionsError(
								"MODEL_OPTIONS_INPUT_LIMIT",
								"Model options input exceeds budget",
							);
						if (
							values.length === OPTIONS_BUDGET.batchRows ||
							bytes + size > OPTIONS_BUDGET.batchBytes - 1024
						) {
							await this.rpc(
								{ type: "filters", revision: snapshot.revision, filterKind, values },
								buildDeadline,
								signal,
							);
							values = [];
							bytes = 2;
						}
						values.push(value);
						bytes += size;
					}
					if (values.length)
						await this.rpc(
							{ type: "filters", revision: snapshot.revision, filterKind, values },
							buildDeadline,
							signal,
						);
				}
				if (snapshot.codex)
					await this.rpc(
						{ type: "seed-codex", revision: snapshot.revision },
						buildDeadline,
						signal,
					);
				let inputRows = 0;
				for (const capture of snapshot.captures) {
					for (let offset = 0; offset < capture.count; offset += OPTIONS_BUDGET.batchRows) {
						const rows = capture.readSlice(offset, OPTIONS_BUDGET.batchRows);
						let batch: ModelOptionInput[] = [];
						let bytes = 2;
						for (const row of rows) {
							if (
								row.aggregationMembers !== undefined &&
								(row.aggregationMembers.length > 20 ||
									row.aggregationMembers.some(
										(member) => typeof member !== "string" || !member || member.length > 1024,
									))
							)
								throw new ModelOptionsError(
									"MODEL_OPTIONS_INPUT_LIMIT",
									"Aggregation members exceed budget",
								);
							if (
								[
									row.value,
									row.label,
									row.provider,
									row.upstreamModelId,
									row.providerKey ?? "",
								].some((value) => typeof value !== "string" || value.length > 1024)
							)
								throw new ModelOptionsError(
									"MODEL_OPTIONS_INPUT_LIMIT",
									"Model option field exceeds budget",
								);
							const size = Buffer.byteLength(JSON.stringify(row)) + 1;
							inputBytes += size;
							inputRows++;
							if (inputBytes > OPTIONS_BUDGET.bytes || inputRows > OPTIONS_BUDGET.rows)
								throw new ModelOptionsError(
									"MODEL_OPTIONS_INPUT_LIMIT",
									"Model options input exceeds budget",
								);
							if (bytes + size > OPTIONS_BUDGET.batchBytes - 1024) {
								await this.rpc(
									{ type: "batch", revision: snapshot.revision, rows: batch },
									buildDeadline,
									signal,
								);
								batch = [];
								bytes = 2;
							}
							batch.push(row);
							bytes += size;
						}
						if (batch.length)
							await this.rpc(
								{ type: "batch", revision: snapshot.revision, rows: batch },
								buildDeadline,
								signal,
							);
					}
				}
				if (this.deps.capture().revision !== snapshot.revision)
					throw new ModelOptionsError(
						"MODEL_OPTIONS_SOURCE_CHANGED",
						"Model options changed during build",
					);
				await this.rpc({ type: "publish", revision: snapshot.revision }, buildDeadline, signal);
				this.revision = snapshot.revision;
			}
			const queryDeadline = Math.min(
				job.deadline,
				Date.now() + (this.deps.budgets?.queryMs ?? OPTIONS_BUDGET.queryMs),
			);
			let facts: AutoRouteSignals[] | undefined;
			const priceRevision = getModelOverridesRevision();
			if (job.query.sourceModelId) {
				const candidates = (await this.rpc(
					{ type: "sources", revision: snapshot.revision, sourceModelId: job.query.sourceModelId },
					queryDeadline,
					signal,
				)) as ModelOptionSourceCandidate[];
				if (candidates.length > 256)
					throw new ModelOptionsError("MODEL_OPTIONS_SOURCE_LIMIT", "Auto sources exceed budget");
				const now = Date.now();
				facts = candidates.map(({ value, provider, modelId, inputPrice, outputPrice }) => {
					if (Date.now() >= queryDeadline)
						throw new ModelOptionsError(
							"MODEL_OPTIONS_TIMEOUT",
							"Model options worker deadline exceeded",
						);
					const modelPrices = modelId ? getModelOverride("model", modelId)?.prices : undefined;
					const connectionPrices = getModelOverride("connection", value)?.prices;
					const input = modelOptionPrice(
						connectionPrices?.input ?? modelPrices?.input ?? inputPrice,
					);
					const output = modelOptionPrice(
						connectionPrices?.output ?? modelPrices?.output ?? outputPrice,
					);
					const referencePrice =
						typeof input === "number" && typeof output === "number" ? input + output : undefined;
					return {
						value,
						...autoSourceFacts(provider, now, value),
						...(referencePrice !== undefined && { referencePrice }),
					};
				});
			}
			const page = (await this.rpc(
				{ type: "query", revision: snapshot.revision, query: job.query, facts },
				queryDeadline,
				signal,
			)) as ModelOptionsPage;
			if (
				this.deps.capture().revision !== snapshot.revision ||
				(job.query.sourceModelId && getModelOverridesRevision() !== priceRevision)
			)
				throw new ModelOptionsError(
					"MODEL_OPTIONS_SOURCE_CHANGED",
					"Model options changed during query",
				);
			return page;
		} catch (error) {
			if (
				error instanceof ModelOptionsError &&
				(error.status === 400 ||
					error.status === 409 ||
					error.code === "MODEL_OPTIONS_OUTPUT_LIMIT")
			)
				throw error;
			// A blocked worker is terminated, never replaced with local computation.
			await this.close();
			throw error;
		}
	}
	private rpc(
		message: Record<string, unknown>,
		deadline: number,
		signal: AbortSignal,
	): Promise<unknown> {
		if (signal.aborted) return Promise.reject(signal.reason);
		if (Date.now() >= deadline)
			return Promise.reject(
				new ModelOptionsError("MODEL_OPTIONS_TIMEOUT", "Model options worker deadline exceeded"),
			);
		const connection = this.connection;
		if (!connection)
			return Promise.reject(
				new ModelOptionsError("MODEL_OPTIONS_UNAVAILABLE", "Model options worker is unavailable"),
			);
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			const worker = connection.worker;
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				worker.off("message", receive);
				worker.off("error", fail);
				worker.off("exit", exit);
			};
			const fail = (error: unknown) => {
				cleanup();
				reject(error);
			};
			const abort = () => fail(signal.reason);
			const exit = () =>
				fail(new ModelOptionsError("MODEL_OPTIONS_WORKER_EXITED", "Model options worker exited"));
			const receive = (reply: {
				id?: number;
				ok?: boolean;
				result?: unknown;
				code?: string;
				error?: string;
				status?: 400 | 409 | 503;
			}) => {
				if (reply.id !== id) return;
				cleanup();
				if (Date.now() > deadline) {
					reject(
						new ModelOptionsError(
							"MODEL_OPTIONS_TIMEOUT",
							"Model options worker deadline exceeded",
						),
					);
					return;
				}
				if (reply.ok) resolve(reply.result);
				else
					reject(
						new ModelOptionsError(
							reply.code ?? "MODEL_OPTIONS_WORKER_FAILED",
							reply.error ?? "Model options worker failed",
							reply.status,
						),
					);
			};
			const timer = setTimeout(
				() =>
					fail(
						new ModelOptionsError(
							"MODEL_OPTIONS_TIMEOUT",
							"Model options worker deadline exceeded",
						),
					),
				Math.max(0, deadline - Date.now()),
			);
			worker.on("message", receive);
			worker.once("error", fail);
			worker.once("exit", exit);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			try {
				worker.postMessage({ ...message, id });
			} catch (error) {
				fail(error);
			}
		});
	}
}
export const modelOptionsClient = new ModelOptionsClient();
