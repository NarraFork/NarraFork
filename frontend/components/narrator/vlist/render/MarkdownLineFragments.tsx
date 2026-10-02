import {
	cloneElement,
	createRef,
	PureComponent,
	type ReactElement,
	type RefAttributes,
} from "react";

interface Props {
	/** Paint/layout identities; the snapshot runs before any descendant mutation. */
	markup: readonly (string | null)[] | null | undefined;
	layout: object;
	children: ReactElement<RefAttributes<HTMLDivElement>>;
}

interface BlockEndpoint {
	kind: "block";
	root: HTMLElement;
	text: string;
	offset: number;
}
type Endpoint =
	| BlockEndpoint
	| {
			kind: "direct";
			node: Node;
			offset: number;
			originalValue: string | null;
			originalChildCount: number;
	  };
interface Snapshot {
	anchor: Endpoint;
	focus: Endpoint;
	activeElement: Element | null;
}

function offsetIn(root: Node, node: Node, offset: number): number {
	const range = root.ownerDocument?.createRange();
	if (!range) return 0;
	range.selectNodeContents(root);
	range.setEnd(node, offset);
	return range.toString().length;
}

function captureEndpoint(node: Node, offset: number): Endpoint | null {
	const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
	const root = element?.closest<HTMLElement>("[data-vlist-inline-block]");
	if (!root)
		return {
			kind: "direct",
			node,
			offset,
			originalValue: node.nodeValue,
			originalChildCount: node.childNodes.length,
		};
	return {
		kind: "block",
		root,
		text: root.textContent ?? "",
		offset: offsetIn(root, node, offset),
	};
}

function atTextOffset(root: Node, offset: number): { node: Node; offset: number } {
	const walker = root.ownerDocument?.createTreeWalker(root, 4 /* SHOW_TEXT */);
	let remaining = offset;
	let last: Node | null = null;
	for (let node = walker?.nextNode(); node; node = walker?.nextNode()) {
		last = node;
		const length = node.textContent?.length ?? 0;
		if (remaining <= length) return { node, offset: remaining };
		remaining -= length;
	}
	return last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: root, offset: 0 };
}

function restoreEndpoint(endpoint: Endpoint): { node: Node; offset: number } | null {
	if (endpoint.kind === "direct") {
		if (
			!endpoint.node.isConnected ||
			endpoint.node.nodeValue !== endpoint.originalValue ||
			endpoint.node.childNodes.length !== endpoint.originalChildCount
		)
			return null;
		const limit =
			endpoint.node.nodeType === 3
				? (endpoint.node.textContent?.length ?? 0)
				: endpoint.node.childNodes.length;
		return { node: endpoint.node, offset: Math.min(endpoint.offset, limit) };
	}
	// The logical block and all line hosts remain stable across both painters.
	// Never reselect stale text after a genuine content rewrite.
	return endpoint.root.isConnected && endpoint.root.textContent === endpoint.text
		? atTextOffset(endpoint.root, endpoint.offset)
		: null;
}

/**
 * One selection boundary per logical block, not one class/Fiber per visual line.
 * The existing block and line hosts are retained; cloneElement only attaches a ref.
 * Snapshot-before-mutation precedes all descendant innerHTML replacements. Only
 * selection text is inspected, never layout/geometry.
 */
export class MarkdownLineFragments extends PureComponent<
	Props,
	Record<string, never>,
	Snapshot | null
> {
	#host = createRef<HTMLDivElement>();

	getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
		if (previous.markup === this.props.markup && previous.layout === this.props.layout) return null;
		const host = this.#host.current;
		const selection = host?.ownerDocument.getSelection?.();
		if (
			!host ||
			!selection?.rangeCount ||
			!selection.anchorNode ||
			!selection.focusNode ||
			(!host.contains(selection.anchorNode) && !host.contains(selection.focusNode))
		)
			return null;
		const anchor = captureEndpoint(selection.anchorNode, selection.anchorOffset);
		const focus = captureEndpoint(selection.focusNode, selection.focusOffset);
		return anchor && focus
			? { anchor, focus, activeElement: host.ownerDocument.activeElement }
			: null;
	}

	componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
		const host = this.#host.current;
		if (!snapshot || !host || host.ownerDocument.activeElement !== snapshot.activeElement) return;
		const anchor = restoreEndpoint(snapshot.anchor);
		const focus = restoreEndpoint(snapshot.focus);
		const selection = host.ownerDocument.getSelection?.();
		if (!anchor || !focus || !selection) return;
		try {
			selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
		} catch {
			// Another layout lifecycle may have removed/edited an endpoint after
			// restoration was planned. Selection preservation must never take down UI.
		}
	}

	render() {
		return cloneElement(this.props.children, { ref: this.#host });
	}
}
