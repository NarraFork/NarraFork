import type { parse } from "@babel/parser";

/** Serialized into the isolated Worker; parsing untrusted source never runs on the server. */
export function guardSource(source: string, parseSource: typeof parse): string {
	const prefix =
		'function __nfEntry(global,require,fetch,process,Bun,module,exports,__filename,__dirname){"use strict";\n';
	const wrapped = `${prefix}${source}\n}`;
	const file = parseSource(wrapped, { sourceType: "script", plugins: ["typescript"] });
	const entry = file.program.body[0];
	// Checking the complete wrapper and exact body range prevents closing it early,
	// including replacements with another function or an immediately invoked expression.
	if (
		file.program.body.length !== 1 ||
		entry?.type !== "FunctionDeclaration" ||
		entry.id?.name !== "__nfEntry" ||
		entry.start !== 0 ||
		entry.end !== wrapped.length ||
		entry.body.start !== prefix.indexOf("{") ||
		entry.body.end !== wrapped.length
	)
		throw new Error("Source must remain inside the synchronous function body");

	// Iterative traversal avoids recursive walking of attacker-controlled nesting.
	const pending: unknown[] = [entry];
	while (pending.length) {
		const value = pending.pop();
		if (!value || typeof value !== "object") continue;
		if (Array.isArray(value)) {
			for (const child of value) pending.push(child);
			continue;
		}
		const node = value as Record<string, unknown>;
		if (
			node.async === true ||
			node.type === "AwaitExpression" ||
			(typeof node.type === "string" &&
				(node.type.startsWith("Import") || node.type.startsWith("TSImport"))) ||
			(node.type === "Identifier" && node.name === "Promise")
		)
			throw new Error("Synchronous Eval does not support async/await/Promise/import");
		for (const [key, child] of Object.entries(node)) {
			if (key !== "loc" && key !== "comments" && key !== "tokens") pending.push(child);
		}
	}
	return `(${wrapped})`;
}
