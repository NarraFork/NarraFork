interface TrayLifecycleOptions {
	add: () => boolean;
	remove: () => void;
	onUnavailable: () => void;
}

/**
 * Shell 重建会丢弃原图标；退出/交接后的迟到广播则不能再把它加回来。
 * DPI/分辨率变化也会广播 TaskbarCreated，但图标还在。add() 必须把“图标仍在”当成成功，
 * 否则这里会误报托盘不可用。
 */
export class TrayLifecycle {
	private retired = false;
	private present = false;

	constructor(private readonly options: TrayLifecycleOptions) {}

	get added(): boolean {
		return this.present;
	}

	restore(): void {
		if (this.retired) return;
		this.present = false;
		this.present = this.options.add();
		if (!this.present) this.options.onUnavailable();
	}

	dispose(): void {
		if (this.retired) return;
		this.retired = true;
		if (this.present) this.options.remove();
		this.present = false;
	}
}
