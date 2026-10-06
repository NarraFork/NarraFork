/**
 * Per-language declaration tables.
 *
 * Outline extraction walks the tree and consults these tables rather than running
 * a per-language S-expression query. Two reasons: nesting depth and the
 * parent/child relationship (a method belongs to its class) come out of the walk
 * for free, whereas a flat query returns captures that then have to be re-nested
 * by comparing byte ranges; and adding a language becomes one table entry instead
 * of one query file whose capture names must stay in sync with the normalizer.
 *
 * Node type names differ per grammar even for the same concept
 * (`function_declaration` in TS/Go, `function_definition` in Python,
 * `function_item` in Rust), which is exactly why the mapping is data.
 */
import type { StructKind } from "./provider";

/** How to read a declaration node of a given grammar type. */
export interface DeclarationRule {
	/** Normalized kind reported to callers. */
	kind: StructKind;
	/**
	 * Field name holding the declaration's name. Defaults to `"name"`. When the
	 * name is not a field (Rust `impl`, Java multi-declarator fields), a custom
	 * `nameFrom` handles it.
	 */
	nameField?: string;
	/** Fields concatenated into the signature fragment, in order. */
	signatureFields?: string[];
	/**
	 * Treat this node as a pass-through wrapper: it contributes nothing to the
	 * outline itself, but its children are still visited at the SAME depth, and
	 * they inherit the wrapper's export/decorator context. `export_statement`,
	 * Python's `decorated_definition` and Go's grouped `type (...)` all work this way.
	 */
	transparent?: boolean;
	/** Marks everything inside as exported (TS `export`, Go/Java handled separately). */
	marksExported?: boolean;
	/**
	 * Extend the reported start line backwards over attached decorators/annotations
	 * so `extract` on a decorated method includes its decorators.
	 */
	includeLeadingSiblings?: string[];
	/**
	 * Where to look when there is no `name` field.
	 *
	 * - `"positional"`: first identifier-ish child. Kotlin and Swift need this — their
	 *   node types are named exactly as expected but expose no `name` field at all, so a
	 *   field-only read yields ZERO declarations with no error to explain why.
	 * - `"declarator"`: descend through a nested declarator before looking. C/C++ wrap
	 *   the function name in `function_declarator`, itself possibly behind a pointer
	 *   declarator.
	 */
	nameFallback?: "positional" | "declarator";
}

export interface LanguageSpec {
	id: string;
	/** Grammar node type → how to read it. */
	declarations: Record<string, DeclarationRule>;
	/** Node types whose children should be traversed but which are not declarations. */
	containerTypes: string[];
	/** Import statement node types. */
	importTypes: string[];
	/**
	 * Decides whether a declaration is publicly visible. Falls back to
	 * `export`-wrapper context when omitted.
	 */
	exportRule?: "wrapper" | "uppercase-initial" | "visibility-modifier" | "java-modifiers";
	/**
	 * Node types for statement-level bare calls, e.g. `useEffect(() => {...}, [])`.
	 *
	 * These are expressions, not declarations, so a declaration-only outline omits them
	 * entirely — and for whole categories of file that IS the structure. A React
	 * component's effects mark its side-effect boundaries; a test file is a tree of
	 * `describe`/`it`; a route module is a list of `app.route(...)`. Such files
	 * previously produced a near-empty outline.
	 */
	statementCallKinds?: { statementType: string; callType: string };
	/** Node types that hold a comment; used to attach doc comments to declarations. */
	commentTypes: string[];
}

/**
 * TS and JS share the declaration vocabulary; TSX adds nothing structural. The
 * TypeScript-only entries (`interface_declaration`, `type_alias_declaration`,
 * `enum_declaration`, `abstract_class_declaration`) are harmless in a JS tree
 * because those node types simply never appear.
 */
const ECMASCRIPT_DECLARATIONS: Record<string, DeclarationRule> = {
	export_statement: { kind: "unknown", transparent: true, marksExported: true },
	ambient_declaration: { kind: "unknown", transparent: true },
	class_declaration: { kind: "class", signatureFields: ["type_parameters"] },
	abstract_class_declaration: { kind: "class", signatureFields: ["type_parameters"] },
	interface_declaration: { kind: "interface", signatureFields: ["type_parameters"] },
	type_alias_declaration: { kind: "type", signatureFields: ["type_parameters"] },
	enum_declaration: { kind: "enum" },
	function_declaration: {
		kind: "function",
		signatureFields: ["type_parameters", "parameters", "return_type"],
	},
	generator_function_declaration: {
		kind: "function",
		signatureFields: ["parameters", "return_type"],
	},
	function_signature: {
		kind: "function",
		signatureFields: ["type_parameters", "parameters", "return_type"],
	},
	method_definition: {
		kind: "method",
		signatureFields: ["type_parameters", "parameters", "return_type"],
		includeLeadingSiblings: ["decorator", "comment"],
	},
	method_signature: { kind: "method", signatureFields: ["parameters", "return_type"] },
	abstract_method_signature: { kind: "method", signatureFields: ["parameters", "return_type"] },
	public_field_definition: { kind: "property", signatureFields: ["type"] },
	property_signature: { kind: "property", signatureFields: ["type"] },
	internal_module: { kind: "namespace" },
	module: { kind: "namespace" },
	// `{ key: value }` inside an object literal. Included because whole modules are
	// written this way — a Hono handler map, a Pinia store, any `export default { … }`
	// — and without it those files' members are invisible while the local variables
	// inside their method bodies leak into the outline as if they were top level.
	// The name lives in `key`, not `name`, and the reported kind comes from the value.
	pair: { kind: "property", nameField: "key" },
	// `const x = () => {}` is a function in every way that matters to a reader, so
	// variable_declarator is included and the initializer decides the reported kind.
	variable_declarator: { kind: "variable", signatureFields: ["type"] },
};

const ECMASCRIPT_STATEMENT_CALLS = {
	statementType: "expression_statement",
	callType: "call_expression",
} as const;

const ECMASCRIPT_CONTAINERS = [
	"program",
	"class_body",
	"statement_block",
	"lexical_declaration",
	"variable_declaration",
	"interface_body",
	"object_type",
	"enum_body",
	"declaration_list",
	// Object literals hold members worth outlining (see the `pair` rule). Descending
	// into them is also what stops the leak: without this the walk fell through the
	// object into method BODIES and reported their local variables at the wrong level.
	"object",
];

export const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
	typescript: {
		id: "typescript",
		declarations: ECMASCRIPT_DECLARATIONS,
		containerTypes: ECMASCRIPT_CONTAINERS,
		importTypes: ["import_statement", "import_require_clause"],
		exportRule: "wrapper",
		commentTypes: ["comment"],
		statementCallKinds: ECMASCRIPT_STATEMENT_CALLS,
	},
	tsx: {
		id: "tsx",
		declarations: ECMASCRIPT_DECLARATIONS,
		containerTypes: ECMASCRIPT_CONTAINERS,
		importTypes: ["import_statement", "import_require_clause"],
		exportRule: "wrapper",
		commentTypes: ["comment"],
		statementCallKinds: ECMASCRIPT_STATEMENT_CALLS,
	},
	javascript: {
		id: "javascript",
		declarations: ECMASCRIPT_DECLARATIONS,
		containerTypes: ECMASCRIPT_CONTAINERS,
		importTypes: ["import_statement", "import_require_clause"],
		exportRule: "wrapper",
		commentTypes: ["comment"],
		statementCallKinds: ECMASCRIPT_STATEMENT_CALLS,
	},
	python: {
		id: "python",
		declarations: {
			decorated_definition: {
				kind: "unknown",
				transparent: true,
			},
			class_definition: { kind: "class", signatureFields: ["superclasses"] },
			function_definition: {
				kind: "function",
				signatureFields: ["parameters", "return_type"],
			},
		},
		containerTypes: ["module", "block"],
		importTypes: ["import_statement", "import_from_statement", "future_import_statement"],
		// Python has no export syntax; the leading-underscore convention is the only
		// signal available, and it is a real one that readers rely on.
		exportRule: "uppercase-initial",
		statementCallKinds: { statementType: "expression_statement", callType: "call" },
		commentTypes: ["comment"],
	},
	go: {
		id: "go",
		declarations: {
			type_declaration: { kind: "unknown", transparent: true },
			const_declaration: { kind: "unknown", transparent: true },
			var_declaration: { kind: "unknown", transparent: true },
			type_spec: { kind: "type", signatureFields: ["type_parameters"] },
			type_alias: { kind: "type" },
			const_spec: { kind: "constant" },
			var_spec: { kind: "variable", signatureFields: ["type"] },
			function_declaration: {
				kind: "function",
				signatureFields: ["type_parameters", "parameters", "result"],
			},
			method_declaration: {
				kind: "method",
				signatureFields: ["receiver", "parameters", "result"],
			},
		},
		containerTypes: ["source_file"],
		importTypes: ["import_declaration"],
		exportRule: "uppercase-initial",
		commentTypes: ["comment"],
	},
	rust: {
		id: "rust",
		declarations: {
			mod_item: { kind: "module" },
			struct_item: { kind: "struct", signatureFields: ["type_parameters"] },
			enum_item: { kind: "enum", signatureFields: ["type_parameters"] },
			union_item: { kind: "struct" },
			trait_item: { kind: "trait", signatureFields: ["type_parameters"] },
			impl_item: { kind: "impl" },
			function_item: {
				kind: "function",
				signatureFields: ["type_parameters", "parameters", "return_type"],
			},
			function_signature_item: { kind: "function", signatureFields: ["parameters"] },
			type_item: { kind: "type" },
			const_item: { kind: "constant", signatureFields: ["type"] },
			static_item: { kind: "variable", signatureFields: ["type"] },
			macro_definition: { kind: "unknown" },
		},
		containerTypes: ["source_file", "declaration_list"],
		importTypes: ["use_declaration"],
		exportRule: "visibility-modifier",
		commentTypes: ["line_comment", "block_comment"],
	},
	c: {
		id: "c",
		declarations: {
			// The name lives inside `function_declarator` (possibly behind a pointer
			// declarator), not in a `name` field — hence the declarator fallback.
			function_definition: {
				kind: "function",
				nameFallback: "declarator",
				signatureFields: ["type"],
			},
			declaration: { kind: "unknown", transparent: true },
			type_definition: { kind: "type", nameField: "declarator" },
			struct_specifier: { kind: "struct" },
			union_specifier: { kind: "struct" },
			enum_specifier: { kind: "enum" },
			field_declaration: { kind: "field", nameField: "declarator", signatureFields: ["type"] },
			preproc_function_def: { kind: "function" },
			preproc_def: { kind: "constant" },
		},
		containerTypes: ["translation_unit", "field_declaration_list", "enumerator_list"],
		importTypes: ["preproc_include"],
		// C has no visibility keyword; `static` means the opposite of exported, which the
		// modifier list already records, so nothing is claimed here.
		commentTypes: ["comment"],
	},
	cpp: {
		id: "cpp",
		declarations: {
			function_definition: {
				kind: "function",
				nameFallback: "declarator",
				signatureFields: ["type"],
			},
			declaration: { kind: "unknown", transparent: true },
			type_definition: { kind: "type", nameField: "declarator" },
			class_specifier: { kind: "class" },
			struct_specifier: { kind: "struct" },
			union_specifier: { kind: "struct" },
			enum_specifier: { kind: "enum" },
			namespace_definition: { kind: "namespace" },
			template_declaration: { kind: "unknown", transparent: true },
			field_declaration: { kind: "field", nameField: "declarator", signatureFields: ["type"] },
			function_declarator: { kind: "function", nameFallback: "positional" },
		},
		containerTypes: [
			"translation_unit",
			"field_declaration_list",
			"declaration_list",
			"enumerator_list",
		],
		importTypes: ["preproc_include"],
		commentTypes: ["comment"],
	},
	c_sharp: {
		id: "c_sharp",
		declarations: {
			namespace_declaration: { kind: "namespace" },
			file_scoped_namespace_declaration: { kind: "namespace" },
			class_declaration: { kind: "class", signatureFields: ["type_parameters"] },
			struct_declaration: { kind: "struct" },
			interface_declaration: { kind: "interface", signatureFields: ["type_parameters"] },
			record_declaration: { kind: "struct", signatureFields: ["parameters"] },
			enum_declaration: { kind: "enum" },
			delegate_declaration: { kind: "type", signatureFields: ["parameters"] },
			method_declaration: {
				kind: "method",
				signatureFields: ["type_parameters", "parameters", "type"],
			},
			constructor_declaration: { kind: "constructor", signatureFields: ["parameters"] },
			property_declaration: { kind: "property", signatureFields: ["type"] },
			field_declaration: { kind: "unknown", transparent: true },
			event_declaration: { kind: "property" },
			variable_declarator: { kind: "field" },
		},
		containerTypes: ["compilation_unit", "declaration_list", "enum_member_declaration_list"],
		importTypes: ["using_directive"],
		exportRule: "java-modifiers",
		commentTypes: ["comment"],
	},
	php: {
		id: "php",
		declarations: {
			namespace_definition: { kind: "namespace" },
			class_declaration: { kind: "class" },
			interface_declaration: { kind: "interface" },
			trait_declaration: { kind: "trait" },
			enum_declaration: { kind: "enum" },
			function_definition: { kind: "function", signatureFields: ["parameters", "return_type"] },
			method_declaration: { kind: "method", signatureFields: ["parameters", "return_type"] },
			property_declaration: { kind: "property" },
			const_declaration: { kind: "constant" },
		},
		containerTypes: ["program", "declaration_list", "compound_statement", "enum_declaration_list"],
		importTypes: ["namespace_use_declaration"],
		exportRule: "java-modifiers",
		commentTypes: ["comment"],
	},
	ruby: {
		id: "ruby",
		declarations: {
			// Ruby's nodes carry no `_declaration` suffix at all — they are plainly
			// `class`, `module`, `method`.
			module: { kind: "module" },
			class: { kind: "class", signatureFields: ["superclass"] },
			singleton_class: { kind: "class" },
			method: { kind: "method", signatureFields: ["parameters"] },
			singleton_method: { kind: "method", signatureFields: ["parameters"] },
		},
		containerTypes: ["program", "body_statement", "begin_block"],
		importTypes: [],
		// Ruby's `private`/`public` are runtime calls rather than declaration modifiers,
		// so visibility cannot be read syntactically; the capitalisation convention for
		// constants/classes is the only reliable signal.
		exportRule: "uppercase-initial",
		commentTypes: ["comment"],
	},
	kotlin: {
		id: "kotlin",
		declarations: {
			// No `name` field anywhere in this grammar: every entry needs the positional
			// fallback, and without it the whole language reported zero declarations.
			class_declaration: { kind: "class", nameFallback: "positional" },
			object_declaration: { kind: "class", nameFallback: "positional" },
			function_declaration: {
				kind: "function",
				nameFallback: "positional",
				signatureFields: ["function_value_parameters"],
			},
			property_declaration: { kind: "property", nameFallback: "positional" },
			type_alias: { kind: "type", nameFallback: "positional" },
			enum_entry: { kind: "constant", nameFallback: "positional" },
			secondary_constructor: { kind: "constructor" },
			companion_object: { kind: "class" },
		},
		containerTypes: ["source_file", "class_body", "enum_class_body"],
		importTypes: ["import_header"],
		exportRule: "java-modifiers",
		commentTypes: ["line_comment", "multiline_comment", "comment"],
	},
	swift: {
		id: "swift",
		declarations: {
			class_declaration: { kind: "class", nameFallback: "positional" },
			protocol_declaration: { kind: "trait", nameFallback: "positional" },
			function_declaration: {
				kind: "function",
				nameFallback: "positional",
				signatureFields: ["parameters"],
			},
			protocol_function_declaration: { kind: "method", nameFallback: "positional" },
			property_declaration: { kind: "property", nameFallback: "positional" },
			typealias_declaration: { kind: "type", nameFallback: "positional" },
			init_declaration: { kind: "constructor" },
			deinit_declaration: { kind: "method" },
			associatedtype_declaration: { kind: "type", nameFallback: "positional" },
		},
		// Swift's grammar models struct/enum/actor through `class_declaration` too, so
		// the single entry above covers them; the body node names differ per form.
		containerTypes: ["source_file", "class_body", "protocol_body", "enum_class_body", "statements"],
		importTypes: ["import_declaration"],
		exportRule: "java-modifiers",
		commentTypes: ["comment", "multiline_comment"],
	},
	java: {
		id: "java",
		declarations: {
			class_declaration: { kind: "class", signatureFields: ["type_parameters", "superclass"] },
			interface_declaration: { kind: "interface", signatureFields: ["type_parameters"] },
			enum_declaration: { kind: "enum" },
			record_declaration: { kind: "struct", signatureFields: ["parameters"] },
			annotation_type_declaration: { kind: "interface" },
			method_declaration: {
				kind: "method",
				signatureFields: ["type_parameters", "parameters"],
				includeLeadingSiblings: ["annotation", "marker_annotation"],
			},
			constructor_declaration: { kind: "constructor", signatureFields: ["parameters"] },
			field_declaration: { kind: "unknown", transparent: true },
			variable_declarator: { kind: "field" },
		},
		containerTypes: [
			"program",
			"class_body",
			"interface_body",
			"enum_body",
			"enum_body_declarations",
			"annotation_type_body",
		],
		importTypes: ["import_declaration"],
		exportRule: "java-modifiers",
		commentTypes: ["line_comment", "block_comment", "comment"],
	},
};

/** Language spec for an id, or null when the language has no table. */
export function getLanguageSpec(languageId: string): LanguageSpec | null {
	return LANGUAGE_SPECS[languageId] ?? null;
}
