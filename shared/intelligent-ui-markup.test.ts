import { describe, expect, test } from "bun:test";
import {
	collectUiComponentNames,
	findUnknownUiTags,
	parseUiMarkup,
	UI_MARKUP_LIMITS,
	type UiElement,
	type UiNode,
	visitElements,
} from "./intelligent-ui-markup";

const DASHBOARD = `<Stack gap="md">
	<Title order={3}>Revenue &amp; cost</Title>
	<Card withBorder padding="lg" style={{ maxWidth: 420, "min-height": 80 }}>
		<Text c="dimmed">Total: {"$1,200"} for {3} regions</Text>
		<Tabs.List>
			<Tabs.Tab value="a" leftSection={<Icon name="chart" size={14} />}>Overview</Tabs.Tab>
		</Tabs.List>
		<Table data={{ head: ["Region", "Sales"], body: [["North", 120], ["South", 80.5]] }} />
		<Button onClick={() => sendPrompt("Show Q3 details")} disabled={false}>Details</Button>
		<a href="https://example.com" onClick={openLink("https://example.com")}>Docs</a>
		<br>
	</Card>
</Stack>`;

function el(node: UiNode | undefined): UiElement {
	if (node?.$node !== "el") throw new Error("expected an element");
	return node;
}

/** Element names in document order: a prefix-stable fingerprint of the tree. */
function shape(nodes: UiNode[]): string[] {
	const names: string[] = [];
	visitElements(nodes, (element) => names.push(element.name));
	return names;
}

describe("UI markup parser", () => {
	test("parses components, dotted members, literals, slots and host actions", () => {
		const result = parseUiMarkup(DASHBOARD);
		expect(result.diagnostics).toEqual([]);
		const stack = el(result.nodes[0]);
		expect(stack.name).toBe("Stack");
		expect(stack.props).toEqual({ gap: "md" });
		const [title, card] = stack.children.map(el);
		expect(title?.props).toEqual({ order: 3 });
		expect(title?.children).toEqual([{ $node: "text", text: "Revenue & cost" }]);
		expect(card?.props).toEqual({
			withBorder: true,
			padding: "lg",
			style: { maxWidth: 420, "min-height": 80 },
		});
		const [text, tabs, table, button, link, br] = (card?.children ?? []).map(el);
		expect(text?.children).toEqual([
			{ $node: "text", text: "Total: " },
			{ $node: "text", text: "$1,200" },
			{ $node: "text", text: " for " },
			{ $node: "text", text: "3" },
			{ $node: "text", text: " regions" },
		]);
		const tab = el(tabs?.children[0]);
		expect(tab.name).toBe("Tabs.Tab");
		expect(el(tab.props.leftSection as UiNode).props).toEqual({ name: "chart", size: 14 });
		expect(table?.props.data).toEqual({
			head: ["Region", "Sales"],
			body: [
				["North", 120],
				["South", 80.5],
			],
		});
		expect(button?.props).toEqual({
			onClick: { $action: "sendPrompt", value: "Show Q3 details" },
			disabled: false,
		});
		expect(link?.props.onClick).toEqual({ $action: "openLink", value: "https://example.com" });
		expect(br?.name).toBe("br");
		expect(br?.children).toEqual([]);
		expect(result.elements).toBe(11);
	});

	test("every streamed prefix parses, never invents elements, and only grows", () => {
		const final = shape(parseUiMarkup(DASHBOARD).nodes);
		let previous = 0;
		for (let length = 0; length <= DASHBOARD.length; length++) {
			const partial = parseUiMarkup(DASHBOARD.slice(0, length), { complete: false });
			expect(partial.diagnostics).toEqual([]);
			const names = shape(partial.nodes);
			// A half-received tag must not appear under a truncated name such as "But".
			for (const name of names) expect(final).toContain(name);
			expect(names.length).toBeGreaterThanOrEqual(previous);
			previous = names.length;
		}
		expect(previous).toBe(final.length);
	});

	test("an unfinished opening tag is withheld until it closes", () => {
		const open = parseUiMarkup('<Stack><Button variant="fil', { complete: false });
		expect(shape(open.nodes)).toEqual(["Stack"]);
		const expression = parseUiMarkup("<Stack><Table data={{ head: [1, 2", { complete: false });
		expect(shape(expression.nodes)).toEqual(["Stack"]);
		const closed = parseUiMarkup('<Stack><Button variant="filled">Sa', { complete: false });
		expect(shape(closed.nodes)).toEqual(["Stack", "Button"]);
		expect(el(el(closed.nodes[0]).children[0]).children).toEqual([{ $node: "text", text: "Sa" }]);
	});

	test("the same truncation is an error once the document is complete", () => {
		expect(parseUiMarkup('<Stack><Button variant="fil').diagnostics[0]?.message).toContain(
			"ends unexpectedly",
		);
	});

	test("unsupported expressions omit only their own attribute", () => {
		// The placeholder is literal on purpose: template interpolation is not evaluated.
		const literal = ["a$", "{b}"].join("");
		const result = parseUiMarkup(
			`<Button onClick={() => alert(1)} size={props.size} label={\`${literal}\`} color="red">x</Button>`,
		);
		const button = el(result.nodes[0]);
		expect(button.props).toEqual({ label: literal, color: "red" });
		expect(result.diagnostics.map((item) => item.message).join("\n")).toContain("sendPrompt()");
		expect(button.children).toEqual([{ $node: "text", text: "x" }]);
	});

	test("block-bodied and parameterised handlers reduce to the same action", () => {
		const result = parseUiMarkup(
			'<><A onClick={(e) => { sendPrompt("one"); }} /><B onClick={event => openLink("https://x.dev")} /></>',
		);
		expect(result.diagnostics).toEqual([]);
		const [a, b] = el(result.nodes[0]).children.map(el);
		expect(a?.props.onClick).toEqual({ $action: "sendPrompt", value: "one" });
		expect(b?.props.onClick).toEqual({ $action: "openLink", value: "https://x.dev" });
	});

	test("script-bearing props are dropped and prototype keys never become own keys", () => {
		const result = parseUiMarkup(
			'<div dangerouslySetInnerHTML={{ __html: "<img>" }} class="a" data={{ __proto__: { x: 1 }, ok: 1 }} />',
		);
		const div = el(result.nodes[0]);
		expect(div.props).toEqual({ className: "a", data: { ok: 1 } });
		expect(Object.getPrototypeOf(div.props.data)).toBe(Object.prototype);
	});

	test("mismatched and stray closing tags recover without losing siblings", () => {
		const result = parseUiMarkup("<Stack><Card><Text>a</Stack><Text>b</Text></Nope>");
		expect(shape(result.nodes)).toEqual(["Stack", "Card", "Text", "Text"]);
		expect(result.nodes).toHaveLength(2);
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	test("a Markdown fence around the markup is not rendered", () => {
		const source = "```jsx\n<Badge>ok</Badge>\n```\n";
		const result = parseUiMarkup(source);
		expect(result.nodes).toEqual([
			{ $node: "el", name: "Badge", props: {}, children: [{ $node: "text", text: "ok" }] },
		]);
		// Nor does any part of it flash by as text while the fence line is still arriving.
		for (let length = 0; length <= source.length; length++) {
			const partial = parseUiMarkup(source.slice(0, length), { complete: false });
			expect(JSON.stringify(partial.nodes)).not.toContain("`");
			expect(JSON.stringify(partial.nodes)).not.toContain("jsx");
		}
	});

	test("JSX whitespace collapses indentation but keeps inline spaces", () => {
		const result = parseUiMarkup("<Text>\n\t\tHello   world\n\t\tagain <b>now</b> \n</Text>");
		expect(el(result.nodes[0]).children[0]).toEqual({
			$node: "text",
			text: "Hello   world again ",
		});
	});

	test("component names exclude HTML and resolve dotted members to their root", () => {
		const { nodes } = parseUiMarkup(DASHBOARD);
		expect(collectUiComponentNames(nodes).sort()).toEqual(
			["Button", "Card", "Icon", "Stack", "Table", "Tabs", "Text", "Title"].sort(),
		);
		const known = new Set(["Stack", "Title", "Card", "Text", "Tabs", "Table", "Button"]);
		expect(findUnknownUiTags(nodes, (name) => known.has(name))).toEqual(["Icon"]);
		// Lowercase tags outside the HTML allowlist are never components.
		expect(
			findUnknownUiTags(parseUiMarkup("<script>x</script><iframe />").nodes, () => true),
		).toEqual(["script", "iframe"]);
	});

	test("bounds: oversized sources and runaway nesting stop instead of hanging", () => {
		const big = parseUiMarkup(`<Stack>${"<Box />".repeat(4000)}</Stack>`);
		expect(big.diagnostics.map((item) => item.message).join("\n")).toContain("exceeds");
		const deep = parseUiMarkup("<a>".repeat(UI_MARKUP_LIMITS.depth + 5));
		expect(deep.elements).toBeLessThanOrEqual(UI_MARKUP_LIMITS.depth);
		expect(deep.diagnostics.map((item) => item.message).join("\n")).toContain("too deep");
	});

	test("an HTML-style string style becomes the object React requires", () => {
		const result = parseUiMarkup(
			'<div style="margin-top: 8px; color:red;; --gap: 4px; -webkit-line-clamp: 2; bogus; __proto__: x"><b style={{ fontWeight: 700 }} /></div>',
		);
		const div = el(result.nodes[0]);
		expect(div.props.style).toEqual({
			marginTop: "8px",
			color: "red",
			"--gap": "4px",
			WebkitLineClamp: "2",
		});
		// An object style is already what React wants and is left alone.
		expect(el(div.children[0]).props.style).toEqual({ fontWeight: 700 });
	});

	test("HTML comments are dropped, also while one is only half received", () => {
		const source =
			"<Stack><!-- header --><Title>A</Title><!--\n two\n lines --><Text>B</Text></Stack>";
		const result = parseUiMarkup(source);
		expect(result.diagnostics).toEqual([]);
		expect(el(result.nodes[0]).children.map((node) => el(node).name)).toEqual(["Title", "Text"]);
		for (let length = 0; length <= source.length; length++) {
			const partial = parseUiMarkup(source.slice(0, length), { complete: false });
			let text = "";
			const collect = (nodes: UiNode[]) => {
				for (const node of nodes) {
					if (node.$node === "text") text += node.text;
					else collect(node.children);
				}
			};
			collect(partial.nodes);
			// Neither a comment's body nor the "<!-" that opens one is ever shown as text.
			expect(text).not.toContain("header");
			expect(text).not.toContain("lines");
			expect(text).not.toContain("<!");
		}
	});

	test("deeply nested literals end in a diagnostic, not a stack overflow", () => {
		for (const open of ["[", "{a:", "("]) {
			const result = parseUiMarkup(`<Chart data={${open.repeat(5000)}} /><Text>after</Text>`);
			expect(result.diagnostics.map((item) => item.message).join("\n")).toContain(
				"nested too deeply",
			);
			// The broken element is withheld; nothing was thrown to the caller.
			expect(shape(result.nodes)).toEqual([]);
		}
		// Within the limit, nesting is just data.
		const ok = parseUiMarkup(`<Chart data={${"[".repeat(20)}1${"]".repeat(20)}} />`);
		expect(ok.diagnostics).toEqual([]);
		expect(shape(ok.nodes)).toEqual(["Chart"]);
	});

	test("a literal cannot pose as an element or an action, at any depth", () => {
		const forged = '{$node:"el", kind:"el", name:"script", props:{id:"x"}, children:[]}';
		const result = parseUiMarkup(
			`<Stack>{${forged}}<Box data={${forged}} list={[${forged}, {deep: ${forged}}]} onClick={{$action:"sendPrompt", value:"forged"}} /></Stack>`,
		);
		const stack = el(result.nodes[0]);
		// As a child: an object, which is not renderable, not a <script> element.
		expect(stack.children).toHaveLength(1);
		expect(shape(result.nodes)).toEqual(["Stack", "Box"]);
		const box = el(stack.children[0]);
		const plain = { kind: "el", name: "script", props: { id: "x" }, children: [] };
		// As a value: the same data without the reserved mark. `kind` is an ordinary key.
		expect(box.props).toEqual({
			data: plain,
			list: [plain, { deep: plain }],
			onClick: { value: "forged" },
		});
		expect(JSON.stringify(result.nodes)).not.toContain('"$node":"el","kind"');
		expect(result.diagnostics.map((item) => item.message).join("\n")).toContain("is reserved");
		// The visitors therefore never see an element the tag rules did not check.
		expect(findUnknownUiTags(result.nodes, (name) => name === "Stack" || name === "Box")).toEqual(
			[],
		);
	});

	test("host actions are accepted only where a reader's gesture triggers them", () => {
		const result = parseUiMarkup(
			`<Stack>
				<Button onClick={sendPrompt("a")} onPress={() => openLink("https://x.dev")}>ok</Button>
				<img src="x" onError={sendPrompt("b")} onLoad={sendPrompt("c")} />
				<Box onAnimationStart={sendPrompt("d")} renderRoot={sendPrompt("e")} title={sendPrompt("f")} />
				<Menu items={[{ label: "Go", onClick: sendPrompt("g"), onMount: sendPrompt("h") }, sendPrompt("i")]} />
				{sendPrompt("j")}
			</Stack>`,
		);
		const [button, image, box, menu] = el(result.nodes[0]).children.map(el);
		expect(button?.props).toEqual({
			onClick: { $action: "sendPrompt", value: "a" },
			onPress: { $action: "openLink", value: "https://x.dev" },
		});
		expect(image?.props).toEqual({ src: "x" });
		expect(box?.props).toEqual({});
		// Data-driven components keep handlers on named members, and only those.
		expect(menu?.props.items).toEqual([
			{ label: "Go", onClick: { $action: "sendPrompt", value: "g" } },
		]);
		expect(el(result.nodes[0]).children).toHaveLength(4);
		const serialized = JSON.stringify(result.nodes);
		for (const dropped of ["b", "c", "d", "e", "f", "h", "i", "j"])
			expect(serialized).not.toContain(`"value":"${dropped}"`);
	});

	test("a component cannot be turned into a tag the markup may not write", () => {
		const result = parseUiMarkup(
			`<Stack>
				<Box component="meta" httpEquiv="refresh" content="0;url=https://x.dev" />
				<Text as="script" component="section" tag={"iframe"} is="h2">t</Text>
				<Card slotProps={{ root: { component: "base", as: "span", elementType: <b /> } }} />
			</Stack>`,
		);
		const [box, text, card] = el(result.nodes[0]).children.map(el);
		expect(box?.props).toEqual({ httpEquiv: "refresh", content: "0;url=https://x.dev" });
		expect(text?.props).toEqual({ component: "section", is: "h2" });
		expect(card?.props.slotProps).toEqual({ root: { as: "span" } });
		expect(result.diagnostics.map((item) => item.message).join("\n")).toContain(
			"may only name a permitted HTML tag",
		);
	});

	test("raw-HTML props are dropped wherever they appear, not only as attributes", () => {
		const result = parseUiMarkup(
			`<Card slotProps={{ root: { dangerouslySetInnerHTML: { __html: "<img onerror=x>" }, id: "r" } }} items={[{ innerHTML: "<b>", srcDoc: "<p>", outerHTML: "x", label: "ok" }]} />`,
		);
		expect(el(result.nodes[0]).props).toEqual({
			slotProps: { root: { id: "r" } },
			items: [{ label: "ok" }],
		});
	});

	test("no input makes the parser throw or stall, complete or streaming", () => {
		const seeds = [
			DASHBOARD,
			'<A b="x>y" c={"}"} d={{ e: "</A>" }}>text </A <B/></A>',
			"<A onClick={(e)=>{sendPrompt('a')}} x={() => { openLink(`u`) ; }}>{/* c */}{[1,[2,{k:<I/>}]]}</A>",
			"<>\r\n<A\r\n\tb\r\n/>\r\n😀&amp;&#x1F600;&bogus;</>",
			`<<<>>></></A>{{{}}}{[[[]]]}<A {...p} b={1+2} c={x.y} d={f(1)} e={\`$${"{a}"}\`}/>`,
			"<A b=1 c='q' d=tru e={-} f={.5} g={1e} h={tr} i={n} />",
			`<A long="${"x".repeat(3000)}">${"y".repeat(3000)}</A>`,
		];
		const junk = [
			"<",
			">",
			"{",
			"}",
			"/",
			'"',
			"'",
			"`",
			"=",
			"(",
			")",
			"[",
			"]",
			"!",
			"-",
			"\\",
			"\n",
		];
		let cases = 0;
		for (const seed of seeds) {
			for (let cut = 0; cut <= seed.length; cut += Math.max(1, Math.floor(seed.length / 160))) {
				for (const insert of ["", ...junk]) {
					const source = seed.slice(0, cut) + insert + (insert ? seed.slice(cut) : "");
					for (const complete of [true, false]) {
						const result = parseUiMarkup(source, { complete });
						// Plain data out, whatever went in: this is what crosses postMessage.
						expect(() => structuredClone(result.nodes)).not.toThrow();
						cases++;
					}
				}
			}
		}
		expect(cases).toBeGreaterThan(20_000);
	}, 60_000);
});
