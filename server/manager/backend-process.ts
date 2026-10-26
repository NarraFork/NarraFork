import { probeHost } from "@shared/server-host";
import { MANAGER_TOKEN_ENV } from "../lib/manager-token";
import { getLanAddresses } from "../lib/net/lan-addresses";
import { HANDOFF_COMPLETE_MESSAGE } from "../lib/restart-handoff";
import { isCompiledRuntime } from "../lib/runtime-target";
import { parseServiceLogLine } from "./listen-log";
import { managerFetch } from "./manager-fetch";
import { t } from "./manager-i18n";

export type BackendState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ListenTarget {
	host: string;
	port: number;
	tls: boolean;
}

export interface BackendProcessOptions extends ListenTarget {
	/** 只放进服务子进程的环境变量，不写进面板自己的 process.env。 */
	managerToken: string;
	/** 子进程的每一行输出（已去掉行尾）。 */
	onLine: (line: string) => void;
	/** 状态变化；`detail` 用于异常退出等需要说明的情形。 */
	onState: (state: BackendState, detail?: string) => void;
}

/** 健康检查间隔；超过提示时间仍未就绪只记一次日志（多半在迁移数据库），不判失败。 */
const READY_POLL_MS = 700;
export const SLOW_START_HINT_MS = 90_000;
/** 等待服务自报监听地址的上限；超过后回退到配置端口探测，避免解析失败时一路悬空。 */
const ADDRESS_WAIT_MS = 15_000;
/**
 * 实例锁冲突后等待旧进程退出的上限。旧服务关闭时先关监听、最后才释放实例锁，
 * 接管/交接时新进程可能恰好落在这段窗口里。
 */
const LOCK_HOLDER_EXIT_WAIT_MS = 60_000;
/** 优雅停止之后，进程仍在就结束整棵进程树。 */
const GRACEFUL_STOP_MS = 15_000;

/** 探测给定地址上是否已有 NarraFork 服务在响应（供识别外部启动的实例）。 */
export async function probeServiceHealth(
	host: string,
	port: number,
	tls = false,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const response = await managerFetch(
			`${tls ? "https" : "http"}://${probeHost(host, getLanAddresses())}:${port}/api/health`,
			{
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(1500)])
					: AbortSignal.timeout(1500),
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}

/** 数据目录：直接复用 server 侧实现 —— 环境变量约定只能有一处。 */
export { getNarraforkHome as resolveNarraforkHome } from "../lib/narrafork-home";

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM：进程存在但无权发信号。
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

type ManagedChild = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface BackendRun {
	controller: AbortController;
	lockRetryAvailable: boolean;
}

export class BackendProcess {
	private child?: ManagedChild;
	private state: BackendState = "stopped";
	/** 每次启动独立持有取消信号，迟到的探测、日志与锁重试不能影响下一轮。 */
	private run?: BackendRun;
	private lifecycle = 0;
	private stopTask?: Promise<void>;
	private disposed = false;
	private target: ListenTarget;

	constructor(private readonly options: BackendProcessOptions) {
		this.target = { host: options.host, port: options.port, tls: options.tls };
	}

	get current(): BackendState {
		return this.state;
	}

	/** 服务当前监听的端口（未观测到时为配置值）。 */
	get listeningPort(): number {
		return this.probePort();
	}

	/** 服务实际监听的主机名（未解析到时为配置值）。 */
	get listeningHost(): string {
		return this.observedHost ?? this.target.host;
	}

	/** 健康检查和打开面板使用的协议。日志里出现 https 时以日志为准。 */
	get listeningTls(): boolean {
		if (this.observedProtocol) return this.observedProtocol === "https";
		return this.target.tls;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/**
	 * 用户改了监听配置。清掉上一次观测，面板立刻按新目标显示；
	 * 服务重绑后的 `running on` 日志会再把实际地址写回来。
	 */
	setTarget(next: ListenTarget): void {
		const changed =
			next.host !== this.target.host ||
			next.port !== this.target.port ||
			next.tls !== this.target.tls;
		this.target = { host: next.host, port: next.port, tls: next.tls };
		if (!changed) return;
		this.observedHost = undefined;
		this.observedPort = 0;
		this.observedProtocol = undefined;
	}

	/** 按当前观测地址做一次健康检查。 */
	checkHealth(signal?: AbortSignal): Promise<boolean> {
		return probeServiceHealth(this.listeningHost, this.listeningPort, this.listeningTls, signal);
	}

	private setState(state: BackendState, detail?: string): void {
		this.state = state;
		this.options.onState(state, detail);
	}

	/**
	 * 启动后端；已在运行时直接返回。
	 *
	 * `handoffEnv` 是更新交接的一次性环境变量：子进程会先让旧服务退出再绑定端口。
	 * 交接完成前旧服务仍在应答健康检查，所以此期间不探测端口。
	 */
	async start(options?: { handoffEnv?: Record<string, string> }): Promise<void> {
		if (this.child || this.run || this.stopTask || this.state === "stopping" || this.disposed) {
			return;
		}
		const run: BackendRun = { controller: new AbortController(), lockRetryAvailable: true };
		this.run = run;
		this.lifecycle++;
		this.setState("starting");
		// 实例锁冲突只重试一次；重试沿用交接环境，避免丢失更新的续跑清单。
		for (;;) {
			if (!this.isCurrentRun(run)) return;
			const child = this.spawnChild(run, options?.handoffEnv);
			if (!child) return;
			const holderPid = await this.waitUntilReady(run, child);
			if (!this.ownsChild(run, child) || holderPid === undefined) return;
			const retry = await this.waitForLockHolderExit(run, child, holderPid);
			if (!this.isCurrentRun(run)) return;
			if (!retry) {
				this.cancelRun();
				this.setState("error", t("error.instanceLockConflict", { pid: holderPid }));
				return;
			}
		}
	}

	private isCurrentRun(run: BackendRun): boolean {
		return this.run === run && !run.controller.signal.aborted && !this.disposed;
	}

	private ownsChild(run: BackendRun, child: ManagedChild): boolean {
		return this.isCurrentRun(run) && this.child === child;
	}

	private cancelRun(): void {
		const run = this.run;
		this.run = undefined;
		run?.controller.abort();
	}

	/** 拉起一个服务子进程；失败时已报告错误状态。 */
	private spawnChild(
		run: BackendRun,
		handoffEnv: Record<string, string> | undefined,
	): ManagedChild | undefined {
		this.lockConflictPid = undefined;
		this.awaitingHandoff = handoffEnv !== undefined;
		this.observedHost = undefined;
		this.observedPort = 0;
		this.observedProtocol = undefined;
		const args = isCompiledRuntime() ? ["--serve"] : ["server/index.ts", "--serve"];
		try {
			this.child = Bun.spawn([process.execPath, ...args], {
				cwd: process.cwd(),
				windowsHide: true,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					...handoffEnv,
					NARRAFORK_MANAGER_MANAGED: "1",
					[MANAGER_TOKEN_ENV]: this.options.managerToken,
				},
			});
		} catch (error) {
			this.cancelRun();
			this.setState("error", error instanceof Error ? error.message : String(error));
			return undefined;
		}

		const child = this.child;
		void this.pipeLines(run, child, child.stdout, "stdout");
		void this.pipeLines(run, child, child.stderr, "stderr");

		void child.exited.then((code) => {
			if (!this.ownsChild(run, child)) return;
			// 锁冲突退出交由 start() 处理，等待期间仍保留 child 身份以便 stop/dispose 取消。
			if (this.state === "starting" && this.lockConflictPid !== undefined) return;
			this.child = undefined;
			this.cancelRun();
			// 主动停止已经取消该轮；这里只处理“自己退出”。
			this.setState("stopped", code === 0 ? undefined : t("error.exitedWithCode", { code }));
		});
		return child;
	}

	/**
	 * 等实例锁持有者退出。只在仍处于启动中且还有重试机会时等待；
	 * 返回 true 表示可以重新拉起。
	 */
	private async waitForLockHolderExit(
		run: BackendRun,
		child: ManagedChild,
		pid: number,
	): Promise<boolean> {
		const retryAvailable = run.lockRetryAvailable;
		run.lockRetryAvailable = false;
		await child.exited.catch(() => undefined);
		if (!this.ownsChild(run, child)) return false;
		this.child = undefined;
		if (!retryAvailable) return false;
		this.options.onLine(t("log.waitingLockHolder", { pid }));
		const deadline = Date.now() + LOCK_HOLDER_EXIT_WAIT_MS;
		while (Date.now() < deadline) {
			if (!this.isCurrentRun(run) || this.child || this.state !== "starting") return false;
			if (!isProcessAlive(pid)) {
				this.options.onLine(t("log.lockHolderExited", { pid }));
				return this.isCurrentRun(run);
			}
			await this.sleep(READY_POLL_MS, run.controller.signal);
		}
		return false;
	}

	/**
	 * 服务实际监听的端口。
	 *
	 * 启动时目标端口被占用的话，服务会自动换一个可用端口（自身 fallback），此时按
	 * 配置端口做健康检查会永远失败、状态卡在"启动中"；以服务输出里的真实地址为准。
	 */
	private observedPort = 0;

	/** 服务实际监听的主机名（`running on` 那一行里的值）。 */
	private observedHost: string | undefined;

	private observedProtocol: "http" | "https" | undefined;

	/**
	 * 实例锁冲突：同一数据目录已有另一个 NarraFork 在运行（服务输出会报出持有者 PID）。
	 * 每次 start() 清空，否则上一次冲突会让随后的启动立刻失败。
	 */
	private lockConflictPid: number | undefined;

	/** 更新交接进行中：旧服务还占着端口，健康检查会误判成新进程已就绪。 */
	private awaitingHandoff = false;

	/** 交接完成（或非交接启动）的时间，监听地址等待从这里起算。 */
	private addressWaitStartedAt = 0;

	/** 健康检查应使用的端口。 */
	private probePort(): number {
		return this.observedPort > 0 ? this.observedPort : this.target.port;
	}

	/** 从服务输出里解析实际监听地址与实例锁冲突。 */
	private observeListenerAddress(line: string): void {
		if (this.awaitingHandoff && line.includes(HANDOFF_COMPLETE_MESSAGE)) {
			this.awaitingHandoff = false;
			this.addressWaitStartedAt = Date.now();
			return;
		}
		const event = parseServiceLogLine(line);
		if (!event) return;
		if (event.kind === "lock") {
			this.lockConflictPid = event.pid;
			return;
		}
		this.observedProtocol = event.protocol;
		this.observedHost = event.host;
		this.observedPort = event.port;
	}

	/**
	 * 轮询健康检查直到就绪，或子进程退出。
	 *
	 * 不设启动期限：数据库迁移在大库上可能要好几分钟，期间服务不监听端口，按时间判失败只会
	 * 把仍在正常迁移的进程标成故障，引导用户重启——中途结束迁移。进程还活着就继续等，
	 * 真正的失败表现为进程退出（带退出码）。
	 * 遇到实例锁冲突时返回持有者 PID，由调用方决定是否等待后重试。
	 */
	private async waitUntilReady(run: BackendRun, child: ManagedChild): Promise<number | undefined> {
		const startedAt = Date.now();
		this.addressWaitStartedAt = startedAt;
		let hinted = false;
		for (;;) {
			if (!this.ownsChild(run, child) || this.state !== "starting") return undefined;
			if (!hinted && Date.now() - startedAt > SLOW_START_HINT_MS) {
				hinted = true;
				this.options.onLine(t("log.slowStart"));
				if (!this.ownsChild(run, child)) return undefined;
			}
			// 实例锁冲突：服务会立即退出，直接给出原因，不必等超时。
			if (this.lockConflictPid !== undefined) return this.lockConflictPid;
			if (this.awaitingHandoff) {
				await this.sleep(READY_POLL_MS, run.controller.signal);
				continue;
			}
			// 先等服务自己报告监听地址再探测端口：直接探测会把“已在运行的外部实例”
			// 误当成刚启动的这个。等待有上限，解析失败时回退到配置端口。
			if (this.observedPort <= 0 && Date.now() - this.addressWaitStartedAt < ADDRESS_WAIT_MS) {
				await this.sleep(READY_POLL_MS, run.controller.signal);
				continue;
			}
			const healthy = await this.checkHealth(run.controller.signal);
			if (!this.ownsChild(run, child) || this.state !== "starting") return undefined;
			if (this.lockConflictPid !== undefined) return this.lockConflictPid;
			if (healthy) {
				this.setState("running");
				return undefined;
			}
			await this.sleep(READY_POLL_MS, run.controller.signal);
		}
	}

	/** 每个等待独立绑定取消信号，旧轮次不能唤醒或覆盖新轮次的定时器。 */
	private sleep(ms: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, ms);
			signal.addEventListener("abort", finish, { once: true });
		});
	}

	/** 逐块解码子进程输出并按行回调；流结束时冲掉最后的不完整行。 */
	private async pipeLines(
		run: BackendRun,
		child: ManagedChild,
		stream: ReadableStream<Uint8Array> | undefined,
		channel: "stdout" | "stderr",
	): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		let buffer = "";
		const reader = stream.getReader();
		const cancel = () => void reader.cancel().catch(() => undefined);
		run.controller.signal.addEventListener("abort", cancel, { once: true });
		const emit = (line: string) => {
			if (!line || !this.ownsChild(run, child)) return;
			// 监听地址走 stdout，实例锁冲突走 stderr；尾部不完整行也使用同样的归属检查。
			this.observeListenerAddress(line);
			this.options.onLine(channel === "stderr" ? `! ${line}` : line);
		};
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (!this.ownsChild(run, child)) return;
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) emit(line);
			}
			emit(buffer + decoder.decode());
		} catch {
			// 子进程被终止时流会中断，属正常路径。
		} finally {
			run.controller.signal.removeEventListener("abort", cancel);
			reader.releaseLock();
		}
	}

	/**
	 * 停止后端并等待进程真正退出。
	 *
	 * `graceful` 时先等进程自己退出（调用方应已请求 HTTP 关闭），超时再结束进程树。
	 */
	stop(options?: { graceful?: boolean }): Promise<void> {
		this.lifecycle++;
		this.cancelRun();
		if (this.disposed) return Promise.resolve();
		if (this.stopTask) return this.stopTask;
		const child = this.child;
		if (!child) {
			this.setState("stopped");
			return Promise.resolve();
		}
		this.setState("stopping");
		const task = this.stopChild(child, options?.graceful === true);
		this.stopTask = task;
		const clear = () => {
			if (this.stopTask === task) this.stopTask = undefined;
		};
		void task.then(clear, clear);
		return task;
	}

	private async stopChild(child: ManagedChild, graceful: boolean): Promise<void> {
		if (graceful) {
			const controller = new AbortController();
			let exited: boolean;
			try {
				exited = await Promise.race([
					child.exited.then(
						() => true,
						() => true,
					),
					this.sleep(GRACEFUL_STOP_MS, controller.signal).then(() => false),
				]);
			} finally {
				controller.abort();
			}
			if (!this.disposed && this.child === child && !exited) this.forceKill(child);
		} else {
			this.forceKill(child);
		}
		await child.exited.catch(() => undefined);
		if (this.disposed || this.child !== child) return;
		this.child = undefined;
		this.setState("stopped");
	}

	async restart(): Promise<void> {
		const stopped = this.stop({ graceful: true });
		const lifecycle = this.lifecycle;
		await stopped;
		if (this.disposed || this.lifecycle !== lifecycle) return;
		await this.start();
	}

	/** 管理器退出时调用：不等待、不回报状态。 */
	dispose(): void {
		this.disposed = true;
		this.lifecycle++;
		this.cancelRun();
		const child = this.child;
		this.child = undefined;
		if (child) this.forceKill(child);
	}

	private forceKill(child: Bun.Subprocess): void {
		if (process.platform === "win32" && child.pid) {
			Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
				stdout: "ignore",
				stderr: "ignore",
				windowsHide: true,
			});
		}
		try {
			child.kill();
		} catch {
			// 进程已经退出。
		}
	}
}
