/**
 * Tree walk → normalized outline.
 *
 * One traversal produces everything the read modes need: `outline` prints it,
 * `api` filters it to exported entries, `extract` and `enclosing` search it. That
 * is why nodes carry byte offsets alongside line numbers even though the outline
 * itself only prints lines — the same walk has to be able to hand StructSed an
 * editable range later.
 */
import { type DeclarationRule, getLanguageSpec, type LanguageSpec } from "./languages";
import type { OutlineNode, StructKind } from "./provider";

/** Structural node shape we need from web-tree-sitter, kept minimal for testability. */
export interface SyntaxNode {
	type: string;
	text: string;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	childCount: number;
	namedChildCount: number;
	isNamed: boolean;
	parent: SyntaxNode | null;
	child(index: number): SyntaxNode | null;
	namedChild(index: number): SyntaxNode | null;
	childForFieldName(field: string): SyntaxNode | null;
	previousSibling: SyntaxNode | null;
	nextSibling: SyntaxNode | null;
}

/** Outline node plus the offsets `extract`/`locate` need. */
export interface RichOutlineNode extends OutlineNode {
	startIndex: number;
	endIndex: number;
	/** Dotted path from the file root. */
	symbolPath: string;
	children?: RichOutlineNode[];
}

const MAX_SIGNATURE_CHARS = 120;

export interface BuildOutlineOptions {
	/** Stop descending past this depth. 0 = top level only. */
	maxDepth?: number;
	/** Hard cap on emitted nodes, to bound output for generated files. */
	maxNodes?: number;
	signal?: AbortSignal;
}

export interface BuildOutlineResult {
	nodes: RichOutlineNode[];
	/** True when `maxNodes` cut the walk short. */
	truncated: boolean;
}

/** Walk a parsed tree into a normalized outline. */
export function buildOutline(
	root: SyntaxNode,
	languageId: string,
	options: BuildOutlineOptions = {},
): BuildOutlineResult {
	const spec = getLanguageSpec(languageId);
	if (!spec) return { nodes: [], truncated: false };

	const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
	const maxNodes = options.maxNodes ?? 5000;
	const state: WalkState = { spec, emitted: 0, maxNodes, maxDepth, truncated: false };

	const nodes = walkChildren(root, state, {
		depth: 0,
		exported: false,
		symbolPrefix: "",
		signal: options.signal,
	});

	return { nodes, truncated: state.truncated };
}

interface WalkState {
	spec: LanguageSpec;
	emitted: number;
	maxNodes: number;
	maxDepth: number;
	truncated: boolean;
}

interface WalkContext {
	depth: number;
	/** Inherited from an `export` wrapper or an enclosing exported declaration. */
	exported: boolean;
	symbolPrefix: string;
	/**
	 * Transparent wrapper this declaration sits inside (`export ...`, a decorated
	 * definition, a grouped Go declaration).
	 *
	 * Carried because the wrapper, not the declaration, is the node whose siblings
	 * hold the doc comment: for `/** doc *␘/\nexport class C`, the comment is a
	 * sibling of `export_statement`, so looking only at the class's own siblings
	 * finds nothing and `extract` silently drops the docs.
	 */
	wrapper?: SyntaxNode;
	signal?: AbortSignal;
}

function walkChildren(node: SyntaxNode, state: WalkState, ctx: WalkContext): RichOutlineNode[] {
	const results: RichOutlineNode[] = [];
	if (ctx.signal?.aborted) return results;

	for (let i = 0; i < node.childCount; i++) {
		if (state.emitted >= state.maxNodes) {
			state.truncated = true;
			break;
		}
		const child = node.child(i);
		if (!child?.isNamed) continue;
		results.push(...visit(child, state, ctx));
	}
	return results;
}

function visit(node: SyntaxNode, state: WalkState, ctx: WalkContext): RichOutlineNode[] {
	const rule = state.spec.declarations[node.type];

	// Pass-through wrappers (`export ...`, decorated defs, grouped Go decls) do not
	// occupy an outline slot: their child is the declaration a reader cares about.
	// Depth is intentionally unchanged so `export function f` sits at the same level
	// as a bare `function f`.
	if (rule?.transparent) {
		const produced = walkChildren(node, state, {
			...ctx,
			exported: ctx.exported || rule.marksExported === true,
			wrapper: node,
		});
		// When the wrapper produced exactly one top-level declaration, the wrapper's
		// span IS that declaration's span, so the range is widened to include the
		// wrapper's own tokens (`export`, `declare`, decorators, Java `private int`).
		// Otherwise `extract` would hand back a `function foo()` stripped of its
		// `export` — text that no longer means what it meant in the file.
		//
		// Multi-declaration wrappers (Go `type (A; B)`, Java `int x = 1, y = 2`) produce
		// more than one node, and widening any of them to the shared wrapper would make
		// every sibling claim the whole group.
		const only = produced.length === 1 ? produced[0] : undefined;
		if (only && only.depth === ctx.depth && node.startIndex < only.startIndex) {
			only.startIndex = node.startIndex;
			only.startLine = Math.min(only.startLine, node.startPosition.row + 1);
		}
		return produced;
	}

	if (!rule) {
		// Statement-level bare calls: not declarations, but for whole categories of file
		// they are the structure (effects, test blocks, route registrations).
		const asCall = readStatementCall(node, state.spec);
		if (asCall) {
			state.emitted++;
			const callName = asCall.node.name;
			const symbolPath = ctx.symbolPrefix ? `${ctx.symbolPrefix}.${callName}` : callName;
			const callNode: RichOutlineNode = {
				...asCall.node,
				symbolPath,
				depth: ctx.depth,
				exported: false,
			};
			// Recurse into the callback body so a `describe` shows its `it`s and an effect
			// shows any declarations it sets up. Without this, a test file's outline would
			// list only top-level suites.
			if (ctx.depth < state.maxDepth && asCall.callbackBody) {
				const children = walkChildren(asCall.callbackBody, state, {
					...ctx,
					depth: ctx.depth + 1,
					exported: false,
					symbolPrefix: symbolPath,
				});
				if (children.length > 0) callNode.children = children;
			}
			return [callNode];
		}

		// Not a declaration. Descend only through known containers so we never walk
		// into function bodies looking for declarations that would confuse the outline.
		if (state.spec.containerTypes.includes(node.type)) {
			// A container is not a wrapper: `lexical_declaration` inside
			// `export_statement` must not shadow the export node whose siblings hold
			// the doc comment, so the wrapper is passed through untouched.
			return walkChildren(node, state, ctx);
		}
		return [];
	}

	const name = readName(node, rule.nameField ?? "name", rule.nameFallback);
	// An unnamed declaration is real in some grammars (Rust `impl`), so it gets a
	// synthesized label rather than being dropped.
	const label = name ?? synthesizeName(node, state.spec);
	if (!label) return walkChildren(node, state, ctx);

	const kind = refineKind(node, rule.kind, state.spec);
	const exported = ctx.exported || isExported(node, label, state.spec);
	const modifiers = readModifiers(node);
	const symbolPath = ctx.symbolPrefix ? `${ctx.symbolPrefix}.${label}` : label;

	const nameNode = resolveNameNode(node, rule.nameField ?? "name", rule.nameFallback);
	const bindings = nameNode ? readBindings(nameNode) : null;
	const initializer = readInitializer(node);

	const startNode = expandStart(node, rule.includeLeadingSiblings, state.spec, ctx.wrapper);
	const outlineNode: RichOutlineNode = {
		kind,
		name: label,
		symbolPath,
		startLine: startNode.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		startIndex: startNode.startIndex,
		endIndex: node.endIndex,
		depth: ctx.depth,
		exported,
		...(modifiers.length > 0 ? { modifiers } : {}),
		...(bindings && bindings.length > 0 ? { bindings } : {}),
		...(initializer ? { initializer } : {}),
	};

	const signature = readSignature(node, rule.signatureFields, kind);
	if (signature) outlineNode.signature = signature;

	state.emitted++;

	if (ctx.depth < state.maxDepth) {
		const body = findBody(node);
		if (body) {
			const children = walkChildren(body, state, {
				...ctx,
				depth: ctx.depth + 1,
				// Membership does not imply visibility: a public class can hold private
				// methods, so nested nodes re-derive their own export status instead of
				// inheriting `exported`. Only the syntactic `export` wrapper propagates.
				exported: false,
				symbolPrefix: symbolPath,
			});
			if (children.length > 0) outlineNode.children = children;
		}
	} else if (findBody(node)) {
		state.truncated = true;
	}

	return [outlineNode];
}

/**
 * Body/member-list child, if this declaration has one.
 *
 * Statement blocks ARE traversed: a function's locals and its statement-level hooks
 * are wanted in the outline (that is how `useEffect` entries and nested helpers get
 * reported). The only special case is `pair`, below.
 */
function findBody(node: SyntaxNode): SyntaxNode | null {
	// `pair` and `variable_declarator` reach their contents through the VALUE rather
	// than a `body` field, so without this an object literal's members are unreachable:
	// the object is the value, and the walk never looks there.
	if (node.type === "pair" || node.type === "variable_declarator") {
		const value = node.childForFieldName("value");
		if (value?.type === "object") return value;
		if (
			value?.type === "arrow_function" ||
			value?.type === "function_expression" ||
			value?.type === "function"
		) {
			// The function's statements, so locals and hooks inside `const f = () => {…}`
			// are reported under `f` instead of being lost.
			return value.childForFieldName("body");
		}
		return null;
	}

	const body = node.childForFieldName("body");
	if (body) return body;
	// Rust `impl`/`trait` and Go grouped declarations expose their members through a
	// typed child rather than a `body` field.
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (
			child.type === "declaration_list" ||
			child.type === "class_body" ||
			child.type === "interface_body" ||
			child.type === "enum_body" ||
			child.type === "block"
		) {
			return child;
		}
	}
	return null;
}

/** How many destructured bindings to name before collapsing the rest to a count. */
const MAX_SHOWN_BINDINGS = 4;

/** Identifier node types used by the positional name fallback. */
const IDENTIFIER_TYPE = /(^|_)identifier$/;

/**
 * Resolve a declaration's name node, applying the rule's fallback when there is no
 * `name` field.
 *
 * Kotlin and Swift are why the fallback exists: their declaration node types are
 * conventional, but the identifier is positional with no field, so a field-only read
 * silently returns nothing for every declaration in the file.
 */
function resolveNameNode(
	node: SyntaxNode,
	field: string,
	fallback: DeclarationRule["nameFallback"],
): SyntaxNode | null {
	const direct = node.childForFieldName(field);
	if (direct) return direct;
	if (!fallback) return null;

	if (fallback === "declarator") {
		// C/C++: `int f(void)` puts `f` inside function_declarator, sometimes wrapped in
		// a pointer declarator. Walk declarators until an identifier turns up.
		let cursor: SyntaxNode | null = node.childForFieldName("declarator");
		for (let depth = 0; cursor && depth < 5; depth++) {
			const inner = cursor.childForFieldName("declarator");
			const identifier = firstIdentifierChild(cursor);
			if (identifier) return identifier;
			cursor = inner;
		}
		return null;
	}

	return firstIdentifierChild(node);
}

function firstIdentifierChild(node: SyntaxNode): SyntaxNode | null {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (IDENTIFIER_TYPE.test(child.type)) return child;
	}
	return null;
}

function readName(
	node: SyntaxNode,
	field: string,
	fallback?: DeclarationRule["nameFallback"],
): string | null {
	const nameNode = resolveNameNode(node, field, fallback);
	if (!nameNode) return null;
	// A destructuring pattern is not a name. Taking its text verbatim put 30 lines of
	// raw source (newlines and tabs included) into the `name` field, which made the
	// entry unmatchable by `extract`/`locate` and polluted every symbolPath below it.
	const bindings = readBindings(nameNode);
	if (bindings) return collapseBindings(bindings, nameNode.type);
	const text = nameNode.text.trim();
	return text.length > 0 ? text : null;
}

/**
 * The individual names bound by a destructuring pattern, or null if not a pattern.
 *
 * Returned separately from the display label so callers can still search the full
 * list: `{ a, b, …+24 }` is readable, but a model looking for `viewers` has to be
 * able to find the declaration that binds it.
 */
export function readBindings(nameNode: SyntaxNode): string[] | null {
	if (nameNode.type !== "object_pattern" && nameNode.type !== "array_pattern") return null;

	const names: string[] = [];
	const visit = (node: SyntaxNode): void => {
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (!child?.isNamed) continue;
			switch (child.type) {
				case "shorthand_property_identifier_pattern":
				case "identifier":
					names.push(child.text.trim());
					break;
				case "pair_pattern": {
					// `{ c: d }` binds `d`, not `c` — the local name is what a reader greps for.
					const value = child.childForFieldName("value") ?? child.child(child.childCount - 1);
					if (value) {
						const nested = readBindings(value);
						if (nested) names.push(...nested);
						else names.push(value.text.trim());
					}
					break;
				}
				case "rest_pattern":
					names.push(child.text.trim());
					break;
				case "object_assignment_pattern": {
					// `{ a = 1 }` — the binding is the left side, the default is noise here.
					const left = child.childForFieldName("left") ?? child.child(0);
					if (left) names.push(left.text.trim());
					break;
				}
				case "object_pattern":
				case "array_pattern":
					visit(child);
					break;
				default:
					break;
			}
		}
	};
	visit(nameNode);
	return names.filter((name) => name.length > 0);
}

function collapseBindings(bindings: string[], patternType: string): string {
	const [open, close] = patternType === "array_pattern" ? ["[", "]"] : ["{", "}"];
	if (bindings.length === 0) return `${open}${close}`;
	if (bindings.length <= MAX_SHOWN_BINDINGS) return `${open} ${bindings.join(", ")} ${close}`;
	const shown = bindings.slice(0, MAX_SHOWN_BINDINGS).join(", ");
	return `${open} ${shown}, …+${bindings.length - MAX_SHOWN_BINDINGS} ${close}`;
}

/**
 * What a declaration is initialized from, as a short label (`useState`, `useMemo`).
 *
 * For a destructured hook result this is the single most useful fact about the line —
 * `{ a, b, …+24 } = useNarratorPanelWS(…)` says where the 27 names come from, which
 * the binding list alone does not.
 */
function readInitializer(node: SyntaxNode): string | null {
	const value = node.childForFieldName("value");
	if (!value) return null;
	if (value.type === "call_expression") {
		const fn = value.childForFieldName("function");
		if (fn) return `${collapseWhitespace(fn.text)}(…)`;
	}
	if (value.type === "await_expression") {
		const inner = value.child(value.childCount - 1);
		if (inner?.type === "call_expression") {
			const fn = inner.childForFieldName("function");
			if (fn) return `await ${collapseWhitespace(fn.text)}(…)`;
		}
	}
	return null;
}

/**
 * Label for a declaration with no name field.
 *
 * Rust's `impl Trait for Type` is the motivating case: it is a real outline entry
 * whose identity is the trait/type pair, not a name.
 */
function synthesizeName(node: SyntaxNode, spec: LanguageSpec): string | null {
	if (spec.id !== "rust" || node.type !== "impl_item") return null;
	const typeNode = node.childForFieldName("type");
	const traitNode = node.childForFieldName("trait");
	if (traitNode && typeNode) return `${traitNode.text} for ${typeNode.text}`;
	if (typeNode) return typeNode.text;
	return null;
}

/**
 * Sharpen a kind using the node's contents.
 *
 * `const f = () => {}` is a function to anyone reading the file, and reporting it
 * as a variable would make the outline actively misleading — that form is how most
 * modern JS/TS code declares functions.
 */
function refineKind(node: SyntaxNode, base: StructKind, spec: LanguageSpec): StructKind {
	// `{ handler: () => {} }` is a method to anyone reading the object, while
	// `{ retries: 3 }` is a property. Reporting both as "property" would flatten the
	// distinction that makes a handler map readable.
	if (node.type === "pair") {
		const value = node.childForFieldName("value");
		if (
			value?.type === "arrow_function" ||
			value?.type === "function_expression" ||
			value?.type === "function"
		) {
			return "method";
		}
		return base;
	}

	if (node.type === "variable_declarator" && spec.id !== "java") {
		const value = node.childForFieldName("value");
		if (value) {
			if (value.type === "arrow_function" || value.type === "function_expression") {
				return "function";
			}
			if (value.type === "class") return "class";
		}
		return base;
	}

	if (node.type === "method_definition") {
		// A getter/setter reads as a property at the call site, so the distinction is
		// worth keeping in the outline.
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (!child) continue;
			if (child.type === "get") return "getter";
			if (child.type === "set") return "setter";
		}
		const name = readName(node, "name");
		if (name === "constructor") return "constructor";
	}

	if (spec.id === "go" && node.type === "type_spec") {
		const typeNode = node.childForFieldName("type");
		if (typeNode?.type === "struct_type") return "struct";
		if (typeNode?.type === "interface_type") return "interface";
	}

	return base;
}

/** Single-word modifiers worth showing (async/static/abstract/pub/...). */
function readModifiers(node: SyntaxNode): string[] {
	const found = new Set<string>();
	const interesting = new Set([
		"async",
		"static",
		"abstract",
		"readonly",
		"private",
		"protected",
		"public",
		"final",
		"override",
		"export",
		"default",
		"const",
	]);

	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (interesting.has(child.type)) {
			found.add(child.type);
			continue;
		}
		// Java collapses all keywords into one `modifiers` node.
		if (child.type === "modifiers") {
			for (let j = 0; j < child.childCount; j++) {
				const mod = child.child(j);
				if (mod && interesting.has(mod.type)) found.add(mod.type);
			}
			continue;
		}
		if (child.type === "visibility_modifier") {
			found.add(child.text.trim());
		}
	}

	// Grammars model `*` as an anonymous child rather than a `generator` keyword.
	if (node.type === "generator_function_declaration") found.add("generator");
	return [...found];
}

function readSignature(
	node: SyntaxNode,
	fields: string[] | undefined,
	kind: StructKind,
): string | null {
	// `const f = (a: number) => a` carries its parameters on the arrow, not the
	// declarator, so a declarator refined into a function reads through to the value.
	// Without this, the dominant modern way of declaring a function shows up in the
	// outline with no signature at all.
	// Same for `{ handler: (req) => {} }`: the signature lives on the value, not on the
	// pair, so a pair refined into a method reads through as well.
	const readsThroughValue =
		(kind === "function" && node.type === "variable_declarator") ||
		(kind === "method" && node.type === "pair");
	const source = readsThroughValue ? (node.childForFieldName("value") ?? node) : node;
	const effectiveFields =
		source === node ? fields : ["type_parameters", "parameters", "return_type"];

	if (!effectiveFields || effectiveFields.length === 0) return null;
	const parts: string[] = [];
	for (const field of effectiveFields) {
		const child = source.childForFieldName(field);
		if (!child) continue;
		parts.push(collapseWhitespace(child.text));
	}
	if (parts.length === 0) return null;
	const joined = parts.join(" ");
	return joined.length > MAX_SIGNATURE_CHARS ? `${joined.slice(0, MAX_SIGNATURE_CHARS)}…` : joined;
}

function collapseWhitespace(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * Is this declaration part of the module's public surface?
 *
 * Each language answers differently, and none of the answers is a keyword search
 * on the source text: Go uses capitalization, Rust a `pub` modifier, Java explicit
 * `public`, Python the leading-underscore convention. TS/JS rely purely on the
 * `export` wrapper, which the walk already tracks as inherited context.
 */
function isExported(node: SyntaxNode, name: string, spec: LanguageSpec): boolean {
	switch (spec.exportRule) {
		case "uppercase-initial": {
			if (spec.id === "python") return !name.startsWith("_");
			const first = name[0];
			return first !== undefined && first === first.toUpperCase() && /[A-Z]/.test(first);
		}
		case "visibility-modifier": {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "visibility_modifier") return true;
			}
			return false;
		}
		case "java-modifiers": {
			const modifiers = node.childForFieldName("modifiers") ?? findChildOfType(node, "modifiers");
			if (!modifiers) return false;
			return modifiers.text.includes("public") || modifiers.text.includes("protected");
		}
		default:
			return false;
	}
}

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.type === type) return child;
	}
	return null;
}

/**
 * Walk backwards over attached decorators/annotations/doc comments.
 *
 * Without this, extracting a decorated method returns the method minus its
 * decorators — which for a route handler or a test case is not the same code.
 * Only immediately adjacent siblings count; a blank line ends the run, because a
 * comment separated by whitespace belongs to the file, not to this declaration.
 */
function expandStart(
	node: SyntaxNode,
	extraTypes: string[] | undefined,
	spec: LanguageSpec,
	wrapper: SyntaxNode | undefined,
): SyntaxNode {
	const attachable = new Set([...(extraTypes ?? []), ...spec.commentTypes]);
	if (attachable.size === 0) return node;

	// Scan from the outermost node that represents this declaration in the tree. For
	// `export class C`, that is the `export_statement`; the class's own previousSibling
	// is inside the wrapper and never reaches the comment.
	const anchor = wrapper && wrapper.startIndex <= node.startIndex ? wrapper : node;

	let start = node;
	let cursor = anchor.previousSibling;
	while (cursor) {
		if (!attachable.has(cursor.type)) break;
		// A blank line ends the run: a comment separated by whitespace belongs to the
		// file (or to the previous declaration), not to this one.
		if (cursor.endPosition.row + 1 < start.startPosition.row) break;
		start = cursor;
		cursor = cursor.previousSibling;
	}
	return start;
}

/**
 * Read a statement-level bare call as an outline entry, or null if it is not one.
 *
 * Deliberately selective. Every `foo();` in a file becoming an outline row would be
 * pure noise, so the bar is "takes a function argument" — that is what separates a
 * structural construct (an effect, a test block, a subscription, a route with a
 * handler) from an ordinary one-line side effect. `obj.method(1)` stays out;
 * `useEffect(() => {...}, [deps])` comes in.
 */
interface StatementCallResult {
	node: Omit<RichOutlineNode, "symbolPath" | "depth" | "exported">;
	/** The callback's body, so the walk can descend into nested constructs. */
	callbackBody: SyntaxNode | null;
}

function readStatementCall(node: SyntaxNode, spec: LanguageSpec): StatementCallResult | null {
	const kinds = spec.statementCallKinds;
	if (!kinds || node.type !== kinds.statementType) return null;

	let call: SyntaxNode | null = null;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.type === kinds.callType) {
			call = child;
			break;
		}
	}
	if (!call) return null;

	const fnNode = call.childForFieldName("function");
	const name = fnNode ? collapseWhitespace(fnNode.text) : null;
	if (!name) return null;

	const args = call.childForFieldName("arguments");
	if (!args) return null;

	let callbackBody: SyntaxNode | null = null;
	let hasCallback = false;
	let label: string | null = null;
	let deps: string | null = null;
	for (let i = 0; i < args.childCount; i++) {
		const arg = args.child(i);
		if (!arg?.isNamed) continue;
		if (
			arg.type === "arrow_function" ||
			arg.type === "function_expression" ||
			arg.type === "function" ||
			arg.type === "lambda"
		) {
			hasCallback = true;
			// First callback only: `useEffect(setup, [])` has one, and a cleanup returned
			// from inside it is part of that same body.
			callbackBody ??= arg.childForFieldName("body");
			continue;
		}
		// A leading string is the construct's own label: `describe("payment flow", …)`.
		if (!label && (arg.type === "string" || arg.type === "template_string")) {
			label = stripQuotes(collapseWhitespace(arg.text));
		}
		// The last array argument is the dependency list in the React idiom; for other
		// constructs it is simply the array they were handed, which is equally worth showing.
		if (arg.type === "array" || arg.type === "list") {
			deps = collapseWhitespace(arg.text);
		}
	}
	if (!hasCallback) return null;

	const parts: string[] = [];
	if (label) parts.push(`"${label}"`);
	if (deps) parts.push(deps);
	const signature = parts.length > 0 ? parts.join(" ") : undefined;

	return {
		node: {
			kind: "call",
			name,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			startIndex: node.startIndex,
			endIndex: node.endIndex,
			...(signature ? { signature: truncateSignature(signature) } : {}),
		},
		callbackBody,
	};
}

function stripQuotes(text: string): string {
	return text.replace(/^['"`]/, "").replace(/['"`]$/, "");
}

function truncateSignature(text: string): string {
	return text.length > MAX_SIGNATURE_CHARS ? `${text.slice(0, MAX_SIGNATURE_CHARS)}…` : text;
}

/** Flatten the outline tree depth-first, preserving document order. */
export function flattenOutline(nodes: readonly RichOutlineNode[]): RichOutlineNode[] {
	const out: RichOutlineNode[] = [];
	const push = (list: readonly RichOutlineNode[]): void => {
		for (const node of list) {
			out.push(node);
			if (node.children) push(node.children);
		}
	};
	push(nodes);
	return out;
}
