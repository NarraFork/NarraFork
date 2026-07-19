export class PluginUiSessionRecoveryBudget {
	private readonly used = new Set<string>();

	consume(panelInstanceId: string): boolean {
		if (this.used.has(panelInstanceId)) return false;
		this.used.add(panelInstanceId);
		return true;
	}

	reset(panelInstanceId: string): void {
		this.used.delete(panelInstanceId);
	}

	clear(): void {
		this.used.clear();
	}
}
