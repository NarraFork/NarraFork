const INSTALL_MARKER = "__narraforkDomMutationGuardInstalled";

/**
 * React owns the DOM tree under #root, but browser translators and extensions can
 * rewrite/move text nodes behind React's back. During the next commit React may
 * then call removeChild/insertBefore with a stale child/reference node and crash
 * the whole app with a NotFoundError.
 *
 * Keep normal DOM semantics for valid operations, but make the two mismatch
 * cases idempotent so a third-party DOM rewrite cannot take down the UI.
 */
export function installDomMutationGuard(): void {
	const state = globalThis as typeof globalThis &
		Record<typeof INSTALL_MARKER, boolean | undefined>;
	if (state[INSTALL_MARKER] || typeof Node === "undefined") return;

	state[INSTALL_MARKER] = true;
	const nativeRemoveChild = Node.prototype.removeChild;
	const nativeInsertBefore = Node.prototype.insertBefore;

	Node.prototype.removeChild = function guardedRemoveChild<T extends Node>(
		this: Node,
		child: T,
	): T {
		if (child.parentNode !== this) {
			return child;
		}
		return nativeRemoveChild.call(this, child) as T;
	};

	Node.prototype.insertBefore = function guardedInsertBefore<T extends Node>(
		this: Node,
		newNode: T,
		referenceNode: Node | null,
	): T {
		if (referenceNode && referenceNode.parentNode !== this) {
			return this.appendChild(newNode) as T;
		}
		return nativeInsertBefore.call(this, newNode, referenceNode) as T;
	};
}

installDomMutationGuard();
