import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { Loader } from "@mantine/core";
import {
	type ReasoningTranslationEvidence,
	reasoningTranslationTargetForRange,
} from "@shared/pretext-layout/reasoning-translation-sources";
import {
	MAX_REASONING_TRANSLATION_VISIBLE_TARGETS,
	type ReasoningTranslationStatusFrame,
	type ReasoningTranslationVisibilityTarget,
	reasoningTranslationTargetKey,
} from "@shared/reasoning-translation";
import { nanoid } from "nanoid";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

class VisibleReasoningBodies {
	private readonly bodies = new Map<
		Element,
		{
			target: ReasoningTranslationVisibilityTarget;
			visible: boolean;
		}
	>();
	private observer?: IntersectionObserver;
	private frame?: number;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private ready = false;
	private id?: string;
	private sent = "";
	private targets = new Map<string, ReasoningTranslationVisibilityTarget>();
	private states = new Map<string, "queued" | "running">();
	private listeners = new Set<() => void>();

	constructor(private readonly narratorId: string) {}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	status(key: string) {
		return this.states.get(key);
	}

	receive = (frame: ReasoningTranslationStatusFrame) => {
		const key = reasoningTranslationTargetKey(frame.target);
		if (frame.visibilityId !== this.id || !this.targets.has(key)) return;
		if (frame.status === "deferred") {
			if (this.retryTimer === undefined) {
				this.retryTimer = setTimeout(
					() => {
						this.retryTimer = undefined;
						this.sent = "";
						this.schedule();
					},
					2000 + Math.random() * 1000,
				);
			}
			return;
		}
		if (frame.status === "idle") this.states.delete(key);
		else this.states.set(key, frame.status);
		this.emit();
	};

	private emit() {
		for (const listener of this.listeners) listener();
	}

	resume = () => {
		if (this.ready) return;
		this.ready = true;
		this.schedule();
	};

	pause = () => {
		this.cancel();
		this.ready = false;
		this.sent = "";
		this.targets.clear();
		this.states.clear();
		this.emit();
	};

	stop = () => {
		this.cancel();
		this.report(new Map());
		this.pause();
	};

	private report(targets: Map<string, ReasoningTranslationVisibilityTarget>) {
		if (!this.ready) return;
		const signature = JSON.stringify([...targets.keys()]);
		if (signature === this.sent || (!this.id && !targets.size)) return;
		this.id ??= nanoid();
		if (
			!narratorWSManager.send({
				type: "reasoning_translation_visibility",
				narratorId: this.narratorId,
				visibilityId: this.id,
				targets: [...targets.values()],
			})
		)
			return;
		this.sent = signature;
		this.targets = targets;
		for (const key of this.states.keys()) if (!targets.has(key)) this.states.delete(key);
		this.emit();
	}

	register(node: Element, target: ReasoningTranslationVisibilityTarget): () => void {
		if (typeof IntersectionObserver !== "function") return () => {};
		// An edge-touch has isIntersecting=true but no visible pixels. Observe the
		// transition from zero to a positive ratio as the expanding body is unclipped.
		this.observer ??= new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const body = this.bodies.get(entry.target);
					if (body)
						body.visible =
							entry.isIntersecting &&
							entry.intersectionRect.width > 0 &&
							entry.intersectionRect.height > 0;
				}
				this.schedule();
			},
			{ threshold: [0, 0.001] },
		);
		this.bodies.set(node, { target, visible: false });
		this.observer.observe(node);
		return () => {
			this.observer?.unobserve(node);
			this.bodies.delete(node);
			this.schedule();
		};
	}

	schedule = () => {
		if (this.frame !== undefined) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = undefined;
			const visible = new Map<string, ReasoningTranslationVisibilityTarget>();
			if (document.visibilityState === "visible") {
				for (const { target, visible: intersects } of this.bodies.values()) {
					if (intersects) visible.set(reasoningTranslationTargetKey(target), target);
					if (visible.size >= MAX_REASONING_TRANSLATION_VISIBLE_TARGETS) break;
				}
			}
			this.report(visible);
		});
	};

	cancel(): void {
		if (this.frame !== undefined) cancelAnimationFrame(this.frame);
		this.frame = undefined;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	visibilityChanged = () => {
		if (document.visibilityState === "visible") this.schedule();
		else {
			this.cancel();
			this.report(new Map());
		}
	};
}

export const ReasoningTranslationVisibilityContext = createContext<VisibleReasoningBodies | null>(
	null,
);

export function useReasoningTranslationVisibility(narratorId: string | undefined) {
	const observer = useMemo(
		() => (narratorId ? new VisibleReasoningBodies(narratorId) : null),
		[narratorId],
	);
	useEffect(() => {
		if (!observer) return;
		const unsubscribe = narratorWSManager.onConnectionChange((connected) => {
			if (!connected) observer.pause();
		});
		document.addEventListener("visibilitychange", observer.visibilityChanged);
		return () => {
			unsubscribe();
			document.removeEventListener("visibilitychange", observer.visibilityChanged);
			observer.stop();
		};
	}, [observer]);
	return observer;
}

export function* reasoningTranslationNodes(
	node: Element,
	evidence: readonly ReasoningTranslationEvidence[],
	showSource?: boolean,
	step?: number,
) {
	const lines = node.querySelectorAll(
		showSource ? "[data-vlist-source-line]" : "[data-vlist-line], [data-vlist-code-line]",
	);
	for (let i = 0; i < Math.min(512, lines.length); i++) {
		const line = lines[i];
		const origin = line.closest("[data-vlist-source-start][data-vlist-source-end]");
		if (!origin || !node.contains(origin) || !line.textContent?.trim()) continue;
		const target = reasoningTranslationTargetForRange(
			evidence,
			Number(origin.getAttribute("data-vlist-source-start")),
			Number(origin.getAttribute("data-vlist-source-end")),
			step,
		);
		if (target) yield { line, target };
	}
}

export function useVisibleReasoningSource<T extends Element>(
	target: ReasoningTranslationVisibilityTarget | undefined,
	evidence?: readonly ReasoningTranslationEvidence[],
	contentVersion?: unknown,
	showSource?: boolean,
	step?: number,
) {
	const observer = useContext(ReasoningTranslationVisibilityContext);
	const { ownerNarratorId, messageId, blockId, blockRevision, elementId } = target ?? {};
	return useCallback(
		(node: T | null) => {
			if (!observer || !node) return;
			if (evidence && contentVersion) {
				const cleanups: (() => void)[] = [];
				for (const { line, target } of reasoningTranslationNodes(
					node,
					evidence,
					showSource,
					step,
				)) {
					cleanups.push(observer.register(line, target));
				}
				return () => {
					for (const cleanup of cleanups) cleanup();
				};
			}
			if (ownerNarratorId && messageId && blockId && blockRevision !== undefined && elementId)
				return observer.register(node, {
					ownerNarratorId,
					messageId,
					blockId,
					blockRevision,
					elementId,
				});
		},
		[
			observer,
			ownerNarratorId,
			messageId,
			blockId,
			blockRevision,
			elementId,
			evidence,
			contentVersion,
			showSource,
			step,
		],
	);
}

const noSubscribe = () => () => {};

export function ReasoningTranslationIndicator({
	target,
	evidence,
}: {
	target?: ReasoningTranslationVisibilityTarget;
	evidence?: readonly ReasoningTranslationEvidence[];
}) {
	const observer = useContext(ReasoningTranslationVisibilityContext);
	const status = useSyncExternalStore(observer?.subscribe ?? noSubscribe, () => {
		if (target) return observer?.status(reasoningTranslationTargetKey(target));
		let queued = false;
		for (const entry of evidence ?? []) {
			if (!entry.target) continue;
			const current = observer?.status(reasoningTranslationTargetKey(entry.target));
			if (current === "running") return current;
			if (current === "queued") queued = true;
		}
		return queued ? "queued" : undefined;
	});
	const { t } = useTranslation("narrator");
	if (!status) return null;
	const label = t(status === "queued" ? "reasoningTranslationQueued" : "reasoningTranslating");
	return (
		<span
			role="status"
			aria-label={label}
			title={label}
			style={{ position: "absolute", top: 4, right: 4 }}
		>
			<Loader size={12} color="grape" aria-hidden />
		</span>
	);
}
