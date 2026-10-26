interface ServiceHealthMonitorOptions {
	isActive: () => boolean;
	/** 调用方提供有截止时间的探测；同一时刻最多执行一次。 */
	probe: () => Promise<boolean>;
	onLost: () => void;
	failureThreshold?: number;
}

/** 更新后的替换服务没有 child.exited，通过连续探测失败恢复管理器的操作入口。 */
export class ServiceHealthMonitor {
	private epoch = 0;
	private failures = 0;
	private pending?: Promise<void>;

	constructor(private readonly options: ServiceHealthMonitorOptions) {}

	/** 停止、重启、交接或地址变化后，旧探测不能再提交状态。 */
	reset(): void {
		this.epoch++;
		this.failures = 0;
	}

	async check(): Promise<void> {
		if (!this.options.isActive() || this.pending) return;
		const epoch = this.epoch;
		const pending = (async () => {
			const healthy = await this.options.probe().catch(() => false);
			if (epoch !== this.epoch || !this.options.isActive()) return;
			if (healthy) {
				this.failures = 0;
				return;
			}
			this.failures++;
			if (this.failures >= (this.options.failureThreshold ?? 3)) {
				this.reset();
				this.options.onLost();
			}
		})();
		this.pending = pending;
		try {
			await pending;
		} finally {
			if (this.pending === pending) this.pending = undefined;
		}
	}
}
