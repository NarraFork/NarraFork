import vm from "node:vm";
import type { RuntimeContract } from "./contract";
import type { EvalOutcome, MockState, MockTask } from "./fixtures";

// Only this runtime source is mounted; type-only imports are erased by Bun.
// Public help arrives as JSON data, never as outer-realm objects/functions.
// No credentials, hidden grader, or reference solutions are mounted.
function installEnvironment(state: any, contract: RuntimeContract) {
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const clone = (value: any) => parse(stringify(value));
	const handles = new WeakMap<object, any>();
	const pages = new WeakMap<object, any>();
	const logs: string[] = [];
	let calls = 0;
	let last: any = null;
	let phase = "running";
	let buildingDelivery = false;
	let deliveryJson: string | undefined;
	let deliverySummary: string | undefined;
	let deliveryFailure: { code: string; message: string } | undefined;
	const charCodeAt = String.prototype.charCodeAt;
	state.evalNumber++;
	const evalNumber = state.evalNumber;

	function fault(code: string, message: string): never {
		const error: any = new Error(message);
		error.code = code;
		throw error;
	}
	function perform(op: string, key: string | undefined, args: any, action: () => any): any {
		if (contract.delivery && (buildingDelivery || deliveryJson !== undefined || deliveryFailure)) {
			deliveryFailure ??= {
				code: "DELIVERY_CLOSED",
				message: "交付必须是最后一个 API 动作；本次交付无效，之前成功的工作不会回滚。",
			};
			if (state.trace.length < 256)
				state.trace.push({
					eval: evalNumber,
					op,
					...(key ? { key } : {}),
					args: null,
					ok: false,
					error: { ...deliveryFailure },
				});
			fault(deliveryFailure.code, deliveryFailure.message);
		}
		if (phase !== "running") fault("RESULT_EFFECT", "结果序列化阶段不能新增操作");
		if (++calls > 64 || state.trace.length >= 256) fault("CALL_LIMIT", "本次调用数量超过上限");
		const entry: any = {
			eval: evalNumber,
			op,
			...(key ? { key } : {}),
			args: clone(args ?? null),
			ok: false,
		};
		state.trace.push(entry);
		try {
			const value = action();
			entry.ok = true;
			last = value;
			return value;
		} catch (error: any) {
			entry.error = {
				code: error.code ?? "MOCK_ERROR",
				message: String(error.message).slice(0, 400),
			};
			throw error;
		}
	}
	function row(key: string, allowArchived = false): any {
		const item = state.tasks.find((t: any) => t.key === key);
		if (!item) fault("NOT_FOUND", `没有任务 ${key}`);
		if (item.team !== state.team) fault("CROSS_TEAM", "不能读取其他 team");
		if (item.archived && !allowArchived)
			fault("TASK_ARCHIVED", "任务已归档；请显式使用 archived: include");
		return item;
	}
	function actorMayManage(item: any): boolean {
		return state.actor.role === "primary" || item.manager === state.actor.id;
	}
	function executor(item: any) {
		if (item.assignee !== state.actor.id)
			fault(
				"FORBIDDEN",
				`你不是此任务的执行者，本次动作未修改任务。${
					actorMayManage(item) && item.status === "submitted"
						? contract.flows.review
						: "查看同团队任务不授予执行权；停止对该任务的执行动作。"
				}`,
			);
		if (item.paused || item.archived) fault("INVALID_TRANSITION", "任务当前不可执行");
	}
	function manager(item: any) {
		if (!actorMayManage(item))
			fault(
				"FORBIDDEN",
				"你不是负责人，本次管理动作未修改任务。读取或执行自己的分派工作，不等于有权代负责人验收或管理。",
			);
	}
	function workflow(item: MockTask) {
		const actions: string[] = [];
		let kind = "read_only";
		let note = "仅查看此任务；读取不授予执行权。";
		const manages = actorMayManage(item);
		if (item.archived) {
			if (manages) actions.push("task.restore");
			note = "归档内容可直接读取；仅查询无需 restore。恢复可见性也不等于恢复执行。";
		} else if (item.status === "submitted") {
			kind = manages ? "review" : "waiting";
			if (manages) actions.push("task.accept");
			note = manages
				? contract.flows.review
				: "工作已提交，等待负责人验收；不要重复 finish 或自行 accept。";
		} else if (["done", "cancelled"].includes(item.status)) {
			kind = "complete";
			if (manages) actions.push("task.archive");
			note = "任务已终结；无需重复执行或报告。只有明确需要归档时才 archive。";
		} else if (item.paused || item.status === "blocked") {
			kind = "inactive";
			note = "当前不适合继续执行；先核对暂停/阻塞原因，不自行重跑或解除。";
		} else if (item.assignee === state.actor.id) {
			kind = "execute";
			if (item.status === "todo") actions.push("task.start", "task.block");
			if (item.status === "doing") {
				if (
					!state.tasks.some(
						(t: MockTask) => t.parent === item.key && !["done", "cancelled"].includes(t.status),
					)
				)
					actions.push("task.finish");
				actions.push("task.block");
			}
			note = `${contract.flows.execute}只查询或列计划时不要执行这些动作。`;
		}
		return { kind, actions, note };
	}
	function synopsis(item: any): any {
		return {
			key: item.key,
			text: item.text,
			status: item.status,
			paused: item.paused,
			archived: item.archived,
		};
	}

	function taskObject(key: string, allowArchived = false): any {
		const first = row(key, allowArchived);
		const observed = {
			version: first.version,
			contract: first.contractVersion,
			submission: null as string | null,
			snapshot: synopsis(first),
		};
		let api: any;
		function refresh(item: any) {
			observed.version = item.version;
			observed.contract = item.contractVersion;
			observed.snapshot = synopsis(item);
		}
		function forbiddenSet() {
			return perform("set", key, null, () =>
				fault("READ_ONLY_PROPERTY", "只读属性不能赋值；请调用任务对象方法"),
			);
		}
		api = {
			get key() {
				return key;
			},
			set key(_v: unknown) {
				forbiddenSet();
			},
			get text() {
				return observed.snapshot.text;
			},
			set text(_v: unknown) {
				forbiddenSet();
			},
			get status() {
				return observed.snapshot.status;
			},
			set status(_v: unknown) {
				forbiddenSet();
			},
			get paused() {
				return observed.snapshot.paused;
			},
			set paused(_v: unknown) {
				forbiddenSet();
			},
			get archived() {
				return observed.snapshot.archived;
			},
			set archived(_v: unknown) {
				forbiddenSet();
			},
			get children() {
				return collection(key, allowArchived);
			},
			read() {
				return perform("read", key, null, () => {
					const item = row(key, allowArchived);
					refresh(item);
					observed.submission = item.submission;
					return {
						...synopsis(item),
						description: item.description,
						acceptance: item.acceptance,
						result: item.result,
						workflow: workflow(item),
					};
				});
			},
			start() {
				return perform("start", key, null, () => {
					const item = row(key);
					executor(item);
					if (item.status !== "todo" && item.status !== "doing")
						fault("INVALID_TRANSITION", "只能开始 todo 任务");
					item.status = "doing";
					item.version++;
					refresh(item);
					return api;
				});
			},
			finish(summary: string) {
				return perform("finish", key, { summary }, () => {
					const item = row(key);
					executor(item);
					if (
						observed.contract !== item.contractVersion ||
						(state.caseId === "5" && state.testedVersion !== item.contractVersion)
					) {
						fault(
							"CONTRACT_CHANGED",
							contract.feedback?.contractChanged ??
								"任务目标已改变，本次未提交，生命周期保持原状。这不是 TEST_FAILURE，不要自动 block。用当前对象 read() 返回最新 acceptance 供判断，不用旧结果重试；此前成功操作不回滚。",
						);
					}
					if (item.status !== "doing") fault("INVALID_TRANSITION", "当前任务不在 doing 状态");
					if (typeof summary !== "string" || !summary.trim())
						fault("INVALID_ARGUMENT", "finish 需要结果摘要字符串");
					if (
						state.tasks.some(
							(t: any) => t.parent === key && !["done", "cancelled"].includes(t.status),
						)
					)
						fault("OPEN_CHILDREN", "还有未完成的子项");
					item.status = item.manager === state.actor.id ? "done" : "submitted";
					item.result = summary;
					item.submission = `submission-${key}-${item.version}`;
					item.version++;
					refresh(item);
					return api;
				});
			},
			block(reason: string) {
				return perform("block", key, { reason }, () => {
					const item = row(key);
					executor(item);
					if (typeof reason !== "string" || !reason.trim())
						fault("INVALID_ARGUMENT", "block 需要实际原因字符串");
					if (!["doing", "todo"].includes(item.status))
						fault("INVALID_TRANSITION", "不能阻塞已提交或已完成任务");
					item.status = "blocked";
					item.blockReason = reason;
					item.version++;
					refresh(item);
					return api;
				});
			},
			accept() {
				return perform("accept", key, null, () => {
					const item = row(key);
					manager(item);
					if (item.status !== "submitted") fault("INVALID_TRANSITION", "没有待验收的提交");
					if (!observed.submission || observed.submission !== item.submission)
						fault("READ_REQUIRED", `当前对象未读最新提交，本次未验收。${contract.flows.review}`);
					item.status = "done";
					item.version++;
					refresh(item);
					return api;
				});
			},
			archive() {
				return perform("archive", key, null, () => {
					const item = row(key);
					manager(item);
					if (!["done", "cancelled"].includes(item.status))
						fault("INVALID_TRANSITION", "未完成任务不能直接归档");
					item.archived = true;
					item.version++;
					refresh(item);
					return api;
				});
			},
			restore() {
				return perform("restore", key, null, () => {
					const item = row(key, true);
					manager(item);
					item.archived = false;
					item.paused = true;
					item.version++;
					refresh(item);
					return api;
				});
			},
		};
		handles.set(api, observed);
		return Object.freeze(api);
	}

	function collection(parent: string | null = null, inheritedHistory = false): any {
		function listPage(options: any, offset: number, op: "list" | "next"): any {
			return perform(op, parent ?? undefined, options, () => {
				for (const key of Object.keys(options))
					if (!["scope", "agent", "relation", "archived", "search"].includes(key))
						fault("INVALID_ARGUMENT", `未知查询参数 ${key}`);
				if (options.scope && options.agent) fault("INVALID_ARGUMENT", "scope 与 agent 二选一");
				const archived = options.archived ?? (inheritedHistory ? "include" : "exclude");
				let matches = state.tasks.filter((t: any) => t.team === state.team);
				if (parent) matches = matches.filter((t: any) => t.parent === parent);
				if (options.agent) {
					matches = matches.filter((t: any) =>
						options.relation === "participated"
							? t.participants.includes(options.agent)
							: options.relation === "creator"
								? t.creator === options.agent
								: t.assignee === options.agent,
					);
				} else if (
					!parent &&
					(options.scope === "self" || (!options.scope && state.actor.role === "subagent"))
				) {
					matches = matches.filter((t: any) => t.assignee === state.actor.id);
				}
				if (archived === "exclude") matches = matches.filter((t: any) => !t.archived);
				else if (archived === "only") matches = matches.filter((t: any) => t.archived);
				else if (archived !== "include")
					fault("INVALID_ARGUMENT", "archived 只能是 exclude/include/only");
				if (options.search) matches = matches.filter((t: any) => t.text.includes(options.search));
				const selected = matches.slice(offset, offset + state.pageSize);
				const page: any = {
					items: Object.freeze(selected.map((t: any) => taskObject(t.key, archived !== "exclude"))),
					hasMore: offset + selected.length < matches.length,
					next: () => listPage(options, offset + state.pageSize, "next"),
				};
				pages.set(page, true);
				return Object.freeze(page);
			});
		}
		return Object.freeze({
			list(options = {}) {
				return listPage(options, 0, "list");
			},
			get(key: string, options: any = {}) {
				return perform("get", key, options, () =>
					taskObject(
						key,
						options.archived === "include" || options.archived === "only" || inheritedHistory,
					),
				);
			},
			add(text: string, options: any = {}) {
				return perform(
					"add",
					parent ?? undefined,
					{ text, children: options.children ?? [] },
					() => {
						const parentKey = parent ?? (state.actor.role === "subagent" ? state.currentKey : null);
						if (parentKey) {
							const p = row(parentKey);
							if (!actorMayManage(p) && p.assignee !== state.actor.id)
								fault("FORBIDDEN", "不在可拆分范围");
							if (["done", "cancelled"].includes(p.status))
								fault("INVALID_TRANSITION", "父项已终结");
						}
						const titles = [text, ...(options.children ?? [])];
						if (
							Object.keys(options).some((k) => k !== "children") ||
							!Array.isArray(options.children ?? []) ||
							titles.length > 16 ||
							titles.some((t) => typeof t !== "string" || !t.trim() || t.length > 200)
						)
							fault("INVALID_ARGUMENT", "add 需要标题及可选 children 字符串数组");
						if (state.tasks.length + titles.length > 100)
							fault("TASK_LIMIT", "任务数量超过本实验限制");
						const root = `T${state.nextKey++}`;
						for (let i = 0; i < titles.length; i++) {
							state.tasks.push({
								key: i === 0 ? root : `T${state.nextKey++}`,
								text: titles[i],
								status: "todo",
								parent: i === 0 ? parentKey : root,
								team: state.team,
								assignee: state.actor.id,
								manager: state.actor.id,
								creator: state.actor.id,
								participants: [state.actor.id],
								archived: false,
								paused: false,
								version: 1,
								contractVersion: 1,
								acceptance: "",
								description: "",
								result: null,
								submission: null,
							});
						}
						return taskObject(root);
					},
				);
			},
		});
	}

	(globalThis as any).tasks = collection();
	(globalThis as any).task = taskObject(state.currentKey);
	(globalThis as any).tools = Object.freeze({
		Bash(args: any) {
			return perform("Bash", undefined, args, () => {
				if (args?.command !== state.testCommand) fault("UNKNOWN_COMMAND", "本挑战没有这个模拟命令");
				const current = row(state.currentKey);
				state.testedVersion = current.contractVersion;
				if (!state.testPass) fault("TEST_FAILURE", "checkout: amount rounding assertion failed");
				if (state.caseId === "5" && !state.contractChanged) {
					current.contractVersion++;
					current.version++;
					current.acceptance = "新增要求：必须覆盖 refresh-token 过期与撤销两种边界。";
					state.contractChanged = true;
				}
				return { output: `${args.command}: PASS` };
			});
		},
		Read(args: any) {
			return perform("Read", undefined, args, () => {
				if (args?.file_path !== "/work/report.txt") fault("UNKNOWN_FILE", "没有这个模拟文件");
				return { output: "键盘可访问：通过。对比度检查：通过。" };
			});
		},
	});
	(globalThis as any).help = (topic: string) =>
		perform("help", undefined, { topic }, () => {
			if (["task", "tasks", "task.children", "page", "tools"].includes(topic)) {
				const prefix = `${topic}.`;
				const methods = Object.keys(contract.help).filter((name) => name.startsWith(prefix));
				return `方法目录：${methods.join("、")}。用 help(完整方法名) 查询；可见方法不等于拥有写权限。`;
			}
			if (Object.hasOwn(contract.help, topic)) return contract.help[topic];
			fault(
				"UNKNOWN_HELP",
				'没有这个帮助主题；用 help("task")、help("tasks") 或 help("tools") 查看已实现方法。',
			);
		});
	(globalThis as any).console = Object.freeze({
		log: (...values: any[]) => {
			if (logs.length < 20)
				logs.push(
					values
						.map((v) => (typeof v === "string" ? v : stringify(v)))
						.join(" ")
						.slice(0, 1000),
				);
		},
	});

	function utf8Bytes(text: string, limit: number) {
		let bytes = 0;
		for (let i = 0; i < text.length; i++) {
			const code = charCodeAt.call(text, i);
			if (code <= 0x7f) bytes++;
			else if (code <= 0x7ff) bytes += 2;
			else if (
				code >= 0xd800 &&
				code <= 0xdbff &&
				charCodeAt.call(text, i + 1) >= 0xdc00 &&
				charCodeAt.call(text, i + 1) <= 0xdfff
			) {
				bytes += 4;
				i++;
			} else bytes += 3;
			if (bytes > limit) fault("DELIVERY_LIMIT", "交付正文超过 UTF-8 字节上限");
		}
		return bytes;
	}
	if (contract.delivery) {
		const limits = contract.delivery;
		Object.defineProperty(globalThis, "deliver", {
			value(value: unknown, summary?: string) {
				return perform("deliver", undefined, { hasSummary: summary !== undefined }, () => {
					try {
						if (value === undefined) fault("DELIVERY_ARGUMENT", "deliver 需要明确的交付值");
						if (
							summary !== undefined &&
							(typeof summary !== "string" || summary.length > limits.maxSummaryChars)
						)
							fault("DELIVERY_ARGUMENT", "summary 必须是有界的说明字符串");
						buildingDelivery = true;
						phase = "serializing";
						const encoded = stringify(encode(value));
						utf8Bytes(encoded, limits.maxBytes);
						if (deliveryFailure) fault(deliveryFailure.code, deliveryFailure.message);
						deliveryJson = encoded;
						deliverySummary = summary;
						phase = "delivered";
						return undefined;
					} catch (error) {
						deliveryFailure ??= {
							code: "DELIVERY_INVALID",
							message: "交付封存失败；不能吞掉异常后声称交付成功，请在下一 Eval 修正。",
						};
						phase = "delivery_failed";
						throw error;
					} finally {
						buildingDelivery = false;
					}
				});
			},
			writable: false,
			configurable: false,
		});
	}

	function encode(value: any, depth = 0): any {
		if (
			buildingDelivery &&
			(value === undefined || (typeof value === "number" && !Number.isFinite(value)))
		)
			fault("OUTPUT_TYPE", "交付值必须是明确的 JSON 值，数字必须有限");
		if (depth > 20) fault("OUTPUT_LIMIT", "返回值嵌套过深");
		if (value === undefined) return null;
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		)
			return value;
		if (handles.has(value)) return { ...handles.get(value).snapshot };
		if (pages.has(value))
			return { items: value.items.map((t: any) => encode(t, depth + 1)), hasMore: value.hasMore };
		if (Array.isArray(value)) return value.map((v) => encode(v, depth + 1));
		if (typeof value !== "object" || typeof value.then === "function")
			fault("OUTPUT_TYPE", "仅支持同步 JSON/Task/页面结果");
		const result: any = Object.create(null);
		for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (desc.get || desc.set) fault("OUTPUT_TYPE", "返回值不能有 getter/setter");
			result[key] = encode(desc.value, depth + 1);
		}
		return result;
	}
	for (const object of [
		Object.prototype,
		Array.prototype,
		Function.prototype,
		Error.prototype,
		Map.prototype,
		Set.prototype,
		JSON,
	])
		Object.freeze(object);
	(globalThis as any).Promise = undefined;
	return Object.freeze({
		seal() {
			phase = "serializing";
		},
		encode(value: any) {
			if (deliveryFailure) fault(deliveryFailure.code, deliveryFailure.message);
			if (deliveryJson !== undefined) return deliveryJson;
			return stringify(encode(value === undefined ? last : value));
		},
		inspect() {
			return stringify({
				state,
				logs,
				...(deliveryJson !== undefined && !deliveryFailure
					? { delivery: { summary: deliverySummary } }
					: {}),
			});
		},
	});
}

// Direct imports are for trusted, fixed tests only; node:vm is not an isolation boundary.
// Model-generated code must still use the separate CLI inside the Podman sandbox.
export function evaluateChallenge(input: {
	state: MockState;
	code: string;
	contract: RuntimeContract;
}): EvalOutcome & { delivery?: { summary?: string } } {
	if (JSON.stringify(input).length > 250_000) throw new Error("INPUT_LIMIT");
	if (typeof input.code !== "string" || input.code.length > 16_000) throw new Error("CODE_LIMIT");
	const context = vm.createContext(Object.create(null), {
		codeGeneration: { strings: false, wasm: false },
	});
	const bootstrap = `(${installEnvironment.toString()})(JSON.parse(${JSON.stringify(JSON.stringify(input.state))}), JSON.parse(${JSON.stringify(JSON.stringify(input.contract))}))`;
	const control = vm.runInContext(bootstrap, context, { timeout: 1000 });
	let ok = true;
	let value: unknown;
	let error: { code: string; message: string } | undefined;
	try {
		const source = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
			`(() => { "use strict";\n${input.code}\n})()`,
		);
		const result = vm.runInContext(source, context, { timeout: 1200 });
		control.seal();
		value = JSON.parse(control.encode(result));
	} catch (caught: any) {
		ok = false;
		error = {
			code: caught.code ?? "SCRIPT_ERROR",
			message: String(caught.message ?? caught).slice(0, 1000),
		};
		control.seal();
	}
	const snapshot = JSON.parse(control.inspect());
	const output = JSON.stringify({
		...snapshot,
		ok,
		value,
		error,
		delivery: ok ? snapshot.delivery : undefined,
	});
	if (output.length > 250_000) throw new Error("OUTPUT_LIMIT");
	return JSON.parse(output);
}

if (import.meta.main) {
	const raw = await Bun.stdin.text();
	if (raw.length > 250_000) throw new Error("INPUT_LIMIT");
	process.stdout.write(JSON.stringify(evaluateChallenge(JSON.parse(raw))));
}
