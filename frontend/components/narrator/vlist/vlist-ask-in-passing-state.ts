/** List-owned interaction state. Virtual row mounting never creates or destroys drafts. */
export interface AskInPassingDraft {
	readonly value: string;
	readonly phase: "editing" | "submitting" | "cancelling";
	readonly focusRequested: boolean;
}

const EMPTY_DRAFT: AskInPassingDraft = Object.freeze({
	value: "",
	phase: "editing",
	focusRequested: false,
});

export class AskInPassingDraftStore {
	private drafts = new Map<string, AskInPassingDraft>();
	private listeners = new Set<() => void>();
	private terminal = new Set<string>();
	private focusIssued = new Set<string>();
	private revision = 0;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getSnapshot = (): number => this.revision;
	get(messageId: string): AskInPassingDraft {
		return this.drafts.get(messageId) ?? EMPTY_DRAFT;
	}
	private set(messageId: string, draft: AskInPassingDraft): void {
		this.drafts.set(messageId, draft);
		this.emit();
	}
	private emit(): void {
		this.revision++;
		for (const listener of this.listeners) listener();
	}
	setValue(messageId: string, value: string): void {
		if (this.terminal.has(messageId)) return;
		const previous = this.get(messageId);
		if (previous.phase !== "editing" || previous.value === value) return;
		this.set(messageId, { ...previous, value });
	}
	requestFocus(messageId: string): void {
		if (this.terminal.has(messageId) || this.focusIssued.has(messageId)) return;
		this.focusIssued.add(messageId);
		const previous = this.get(messageId);
		if (!previous.focusRequested) this.set(messageId, { ...previous, focusRequested: true });
	}
	consumeFocus(messageId: string): boolean {
		const previous = this.get(messageId);
		if (!previous.focusRequested) return false;
		this.set(messageId, { ...previous, focusRequested: false });
		return true;
	}
	/** Synchronous claim, so two clicks before React commits cannot start two requests. */
	begin(messageId: string, phase: "submitting" | "cancelling"): AskInPassingDraft | null {
		if (this.terminal.has(messageId)) return null;
		const previous = this.get(messageId);
		if (previous.phase !== "editing" || (phase === "submitting" && !previous.value.trim()))
			return null;
		this.set(messageId, { ...previous, phase, focusRequested: false });
		return previous;
	}
	/** Only restore the operation's own draft: a canonical deletion/resolution wins. */
	fail(messageId: string): void {
		const previous = this.drafts.get(messageId);
		if (!previous || previous.phase === "editing") return;
		this.set(messageId, { ...previous, phase: "editing" });
	}
	isTerminal(messageId: string): boolean {
		return this.terminal.has(messageId);
	}
	forget(messageId: string): void {
		const alreadyTerminal = this.terminal.has(messageId);
		this.terminal.add(messageId);
		const hadDraft = this.drafts.delete(messageId);
		if (hadDraft || !alreadyTerminal) this.emit();
	}
	/** Absence from a paged window is NOT deletion. Only explicit terminal data clears. */
	reconcile(messages: readonly { id?: unknown; contentJson?: unknown }[]): void {
		for (const message of messages) {
			if (typeof message.id !== "string" || !Array.isArray(message.contentJson)) continue;
			if (
				message.contentJson.some((block: unknown) => {
					if (!block || typeof block !== "object") return false;
					const data = block as { type?: unknown; status?: unknown };
					return data.type === "ask_in_passing" && data.status === "resolved";
				})
			)
				this.forget(message.id);
		}
	}
}
