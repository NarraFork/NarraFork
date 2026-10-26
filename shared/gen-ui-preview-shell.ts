import {
	UI_ACTION_PROPS,
	UI_FORBIDDEN_PROPS,
	UI_INTRINSIC_TAGS,
	UI_TAG_PROPS,
} from "@shared/gen-ui-markup";

export interface PreviewTheme {
	colorScheme: "light" | "dark";
	tokenCss: string;
}

export interface PreviewShellSource {
	/** The runtime the frame loads first: the built-in React+Mantine bundle or a project kit. */
	runtimeJs: string;
	runtimeCss: string;
	/** Compiled `App.tsx` bundle (`app` mode only). */
	js?: string;
	css?: string;
}

export interface PreviewShellOptions {
	/**
	 * `app` mounts a compiled App.tsx. `markup` mounts nothing of its own and renders the
	 * element trees the host posts, so UI can appear while its markup is still streaming.
	 */
	mode?: "app" | "markup";
	/** `runtimeJs` is a project component kit (`globalThis.__nfKit`), not the built-in runtime. */
	kit?: boolean;
	/** Offline inspection, including project kits; host actions are disabled. */
	inspection?: boolean;
}

/** Advisory frame events, never proof that host capture succeeded. */
export type PreviewShellEvent =
	| { type: "narrafork:ui-ready" }
	| { type: "narrafork:preview-painted" }
	| {
			type: "narrafork:preview-diagnostic";
			kind: "error" | "csp";
			severity: "warning" | "error";
			message: string;
	  };

function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

// The built-in runtime needs nothing from the network. A project kit is the user's own
// component library, which loads its own images, fonts and data; scripts stay inline-only
// in both, so the frame can never pull code the host did not put there.
const BUILTIN_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'";
const KIT_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https: http:; connect-src *; img-src * data: blob:; font-src * data:; media-src * data: blob:; frame-src 'none'; child-src 'none'; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * The host fetches the runtime without credentials. The opaque frame has no host DOM
 * access or token; its only channel to the host is `postMessage`, carrying theme updates
 * in and (in markup mode) element trees in and three declared actions out. JS/CSS are JSON
 * data, never interpolated into raw script/style HTML.
 */
export function createPreviewShell(
	source: PreviewShellSource,
	theme: PreviewTheme,
	failureMessage: string,
	options: PreviewShellOptions = {},
): string {
	const kit = options.kit === true;
	const mode = options.mode ?? "app";
	const config = scriptJson({
		runtimeJs: source.runtimeJs,
		runtimeCss: source.runtimeCss,
		js: source.js ?? "",
		css: source.css ?? "",
		theme,
		failureMessage,
		kit,
		inspection: options.inspection === true,
		mode,
		intrinsic: UI_INTRINSIC_TAGS,
		actionProps: UI_ACTION_PROPS,
		tagProps: UI_TAG_PROPS,
		forbiddenProps: UI_FORBIDDEN_PROPS,
	});
	const base = kit
		? ":root{color-scheme:light}body{background:#fff;color:#1a1a1a;font-family:system-ui,sans-serif}"
		: "body{background:var(--mantine-color-body);color:var(--mantine-color-text);font-family:var(--mantine-font-family,system-ui)}";
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${kit && !options.inspection ? KIT_CSP : BUILTIN_CSP}">
<meta name="referrer" content="no-referrer">
<style>html,body,#root{min-height:100%;margin:0}${base}#root{padding:${mode === "markup" ? 12 : 16}px;box-sizing:border-box}#failure{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px}</style>
</head><body><div id="root"></div><pre id="failure" role="alert" hidden></pre><script>
(() => {
  const config = ${config};
  // Only a teardown hint. Browsers allow self-navigation even with connect-src 'none'.
  window.addEventListener("pagehide", () => parent.postMessage({type:"narrafork:preview-left"}, "*"), {once:true});
  window.addEventListener("message", event => {
    if (event.source === parent && event.data?.type === "narrafork:preview-check")
      parent.postMessage({type:"narrafork:preview-present", id:event.data.id}, "*");
  });
  // An opaque origin has no storage, and reading the property throws. Component
  // libraries read it at import time, so give them an in-memory stand-in.
  for (const name of ["localStorage", "sessionStorage"]) {
    try { void window[name].length; } catch {
      const data = new Map();
      try {
        Object.defineProperty(window, name, {configurable: true, value: {
          getItem: key => data.has(String(key)) ? data.get(String(key)) : null,
          setItem: (key, value) => { data.set(String(key), String(value)); },
          removeItem: key => { data.delete(String(key)); },
          clear: () => data.clear(),
          key: index => [...data.keys()][index] ?? null,
          get length() { return data.size; },
        }});
      } catch {}
    }
  }
  const failure = document.getElementById("failure");
  let diagnostics = 0;
  let diagnosticBytes = 0;
  let failed = false;
  const encoder = new TextEncoder();
  const diagnose = (kind, error, severity = "error") => {
    if (severity === "error") failed = true;
    // Reserve one message and 2KiB so warnings cannot hide the first runtime error.
    const maxCount = severity === "warning" ? 19 : 20;
    const maxBytes = severity === "warning" ? 14336 : 16384;
    if (diagnostics >= maxCount || diagnosticBytes >= maxBytes) return;
    let message = "Unknown preview error";
    try { message = String(error?.message ?? error ?? message).slice(0, 2000); } catch {}
    const budget = Math.min(2048, maxBytes - diagnosticBytes);
    while (encoder.encode(message).length > budget) message = message.slice(0, -1);
    diagnostics++;
    diagnosticBytes += encoder.encode(message).length;
    parent.postMessage({type: "narrafork:preview-diagnostic", kind, severity, message}, "*");
  };
  const fail = (error) => {
    diagnose("error", error);
    failure.hidden = false;
    failure.textContent = config.failureMessage + (error && error.message ? "\\n" + String(error.message).slice(0, 2000) : "");
  };
  window.addEventListener("securitypolicyviolation", event => {
    diagnose("csp", "Blocked " + event.effectiveDirective + ": " + String(event.blockedURI).slice(0, 1000), "warning");
  });
  // A React commit plus two animation frames, not root.render() returning. The host
  // still owns timeout, diagnostics and actual screenshot verification.
  const painted = () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!failed) parent.postMessage({type: "narrafork:preview-painted"}, "*");
    }));
  };
  window.addEventListener("error", event => fail(event.error || new Error(event.message)));
  window.addEventListener("unhandledrejection", event => fail(event.reason));
  const style = (text) => {
    const element = document.createElement("style");
    element.textContent = text;
    document.head.appendChild(element);
    return element;
  };
  const script = (text) => {
    const element = document.createElement("script");
    element.textContent = text;
    document.head.appendChild(element);
    element.remove();
  };
  try {
    style(config.runtimeCss);
    style(config.css);
    // Host tokens restyle the built-in Mantine runtime; a project kit brings its own look.
    const tokens = style(config.kit ? "" : config.theme.tokenCss);
    if (!config.kit) document.documentElement.dataset.mantineColorScheme = config.theme.colorScheme;
    script(config.runtimeJs);
    // The app's way to reach the conversation. Filled in once the actions exist below;
    // the host asks the reader to confirm everything an app sends.
    const bridge = {};
    if (config.mode === "app") globalThis.genUI = Object.freeze({
      sendPrompt: (text) => bridge.sendPrompt?.(text),
      submit: (values, message) => bridge.submit?.(values, message),
      openLink: (url) => bridge.openLink?.(url),
    });
    if (config.mode === "app") script(config.js);
    // Drop the bootstrap's duplicate source strings once the browser has parsed them.
    config.runtimeJs = config.runtimeCss = config.js = config.css = "";
    const kit = config.kit ? globalThis.__nfKit : null;
    const builtin = config.kit ? null : globalThis.__nfPluginRuntime;
    if (!kit && !builtin) throw new Error("UI runtime is unavailable");
    const React = (kit || builtin).React;
    const ReactDOMClient = (kit || builtin).ReactDOMClient;
    const components = kit ? kit.components : builtin.MantineCore;
    const h = React.createElement;
    // One per independent subtree. A crash is contained to it, and it retries when the
    // host posts a newer tree: mid-stream a component may throw only because its
    // children have not arrived yet.
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: null }; }
      static getDerivedStateFromError(error) { return { failed: error || new Error("render failed") }; }
      componentDidCatch(error) { if (!this.props.inline) fail(error); else diagnose("error", error); }
      componentDidUpdate(previous) {
        if (this.state.failed && previous.children !== this.props.children) this.setState({ failed: null });
      }
      render() {
        if (!this.state.failed) return this.props.children;
        if (!this.props.inline) return null;
        return h("div", {role: "alert", style: {font: "12px/1.4 ui-monospace,monospace", color: "#c92a2a", padding: "4px 0", overflowWrap: "anywhere"}},
          String(this.state.failed.message || this.state.failed).slice(0, 300));
      }
    }
    let updateTheme;
    function Setup(props) {
      if (kit) return kit.Setup ? h(kit.Setup, null, props.children) : props.children;
      const [scheme, setScheme] = React.useState(config.theme.colorScheme);
      updateTheme = setScheme;
      return h(builtin.MantineCore.MantineProvider, {
        theme: builtin.theme,
        cssVariablesResolver: builtin.MantineCore.v8CssVariablesResolver,
        forceColorScheme: scheme,
        colorSchemeManager: { get: () => scheme, set: () => {}, subscribe: () => {}, unsubscribe: () => {}, clear: () => {} }
      }, props.children);
    }
    // A host action is the reader's act, not the UI's. Posting one only right after a real
    // input event keeps markup that merely gets drawn from speaking for them; that holds in
    // the built-in runtime. A project kit's code shares this frame and can post directly,
    // so the host confirms its sendPrompt with the reader before it becomes a chat message.
    let lastGesture = -Infinity;
    for (const type of ["pointerdown", "keydown", "click"])
      document.addEventListener(type, event => { if (event.isTrusted) lastGesture = performance.now(); }, true);
    const act = (action, value, form) => {
      if (config.inspection || performance.now() - lastGesture > 1000) return;
      parent.postMessage({type: "narrafork:ui-action", action, value: String(value).slice(0, 2000), ...(form ? {fields: form.fields, message: form.message.slice(0, 2000)} : {})}, "*");
    };
    // Named state: what a bind="x" control holds, read by $x and by the actions. It lives
    // for the frame, so a newer tree posted while the UI streams keeps what was typed.
    const stateName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
    const state = new Map();
    const touched = new Set();
    let rerender = () => {};
    const shown = (value) => value == null ? "" : Array.isArray(value) ? value.map(shown).join(", ")
      : typeof value === "object" ? JSON.stringify(value) : String(value);
    // Only plain data leaves the frame: what controls hold is strings, numbers, booleans,
    // arrays of those, or null.
    const plain = (value) => value == null ? null : Array.isArray(value) ? value.slice(0, 200).map((item) => Array.isArray(item) ? shown(item).slice(0, 2000) : plain(item))
      : typeof value === "string" ? value.slice(0, 2000) : typeof value === "number" || typeof value === "boolean" ? value : shown(value).slice(0, 2000);
    const fill = (text) => text.replace(/\\{([A-Za-z_][A-Za-z0-9_]{0,63})\\}/g, (match, name) => state.has(name) ? shown(state.get(name)) : match);
    const perform = (action, value) => {
      if (action === "sendPrompt") return act(action, fill(value));
      if (action === "openLink") return act(action, value);
      const fields = {};
      for (const [name, current] of state) fields[name] = plain(current);
      submitFields(value, fields);
    };
    const submitFields = (value, fields) => {
      // The host sends at most 2000 characters, so each field is cut on its own rather
      // than the last ones disappearing behind a long first answer.
      const names = Object.keys(fields);
      const room = Math.max(40, Math.floor((1900 - value.length) / Math.max(1, names.length)));
      const lines = names.map((name) => {
        const text = shown(fields[name]);
        return name + ": " + (text.length > room ? text.slice(0, room - 1) + "…" : text);
      });
      act("submit", [value.trim(), ...lines].filter(Boolean).join("\\n"), {fields, message: value.trim()});
    };
    bridge.sendPrompt = (text) => act("sendPrompt", String(text ?? ""));
    bridge.openLink = (url) => act("openLink", String(url ?? ""));
    bridge.submit = (values, message) => {
      const fields = {};
      if (values && typeof values === "object" && !Array.isArray(values))
        for (const name of Object.keys(values).slice(0, 200)) if (stateName.test(name)) fields[name] = plain(values[name]);
      submitFields(typeof message === "string" ? message : "", fields);
    };
    // What the reader has set goes to the host, which hands it to another frame of the same
    // card (the expanded view, or the card drawn again after scrolling away).
    const share = () => {
      const values = {};
      for (const name of touched) if (state.has(name)) values[name] = plain(state.get(name));
      parent.postMessage({type: "narrafork:ui-state", values}, "*");
    };
    const adopt = (values) => {
      if (!values || typeof values !== "object" || Array.isArray(values)) return;
      for (const name of Object.keys(values).slice(0, 200)) {
        if (!stateName.test(name)) continue;
        state.set(name, plain(values[name]));
        touched.add(name);
      }
      rerender();
    };
    // A change reaches a bound control as an event (inputs, checkboxes) or as the value
    // itself (Select, Slider, SegmentedControl, Tabs…).
    const changed = (input, checkable) => {
      const target = input && typeof input === "object" && !Array.isArray(input) && (input.currentTarget || input.target);
      if (target && typeof target === "object" && "value" in target) return checkable ? !!target.checked : target.value;
      return input;
    };
    const intrinsic = new Set(config.intrinsic);
    const actionProps = new Set(config.actionProps);
    const tagProps = new Set(config.tagProps);
    const forbiddenProps = new Set(config.forbiddenProps);
    const placeholder = (key, label) =>
      h("span", {key, style: {font: "12px ui-monospace,monospace", border: "1px dashed currentColor", borderRadius: 4, padding: "0 4px", opacity: 0.6}}, label);
    // Trees are data from the host's parser. Names are looked up, never evaluated; the
    // only functions that exist are the two host actions created here; and every rule
    // the parser applies is applied again, because this is where a mistake would run.
    const resolve = (name) => {
      if (name === "") return React.Fragment;
      if (/^[a-z]/.test(name)) return intrinsic.has(name) ? name : null;
      let current = components;
      for (const part of name.split(".")) current = current == null ? undefined : current[part];
      return typeof current === "function" || (current && typeof current === "object" && current.$$typeof) ? current : null;
    };
    // How a bound control holds its value: "check" is a boolean, "radio" holds the value
    // of whichever radio sharing the name is picked, "multi" is a list, "text" a string,
    // and anything else starts at null until it moves.
    const bindKind = (name, props) => {
      if (props.type === "radio" || /(^|\\.)Radio$/.test(name)) return "radio";
      if ("defaultChecked" in props || props.type === "checkbox" || /(^|\\.)(Checkbox|Switch|Chip)$/.test(name)) return "check";
      if (/(^|\\.)(TagsInput|MultiSelect|PillsInput)$|^Checkbox\\.Group$/.test(name) || (name === "Chip.Group" && props.multiple)) return "multi";
      if (/^(input|textarea|TextInput|PasswordInput|Textarea|JsonInput|NumberInput|ColorInput|Autocomplete)$/.test(name)) return "text";
      return "value";
    };
    const seedBind = (bind, kind, props) => {
      if (kind === "radio") {
        if (props.defaultChecked === true && !touched.has(bind) && state.get(bind) == null) state.set(bind, props.value ?? null);
        else if (!state.has(bind)) state.set(bind, null);
        return;
      }
      if (state.has(bind)) return;
      if (kind === "check") state.set(bind, props.defaultChecked === true);
      else if (props.defaultValue !== undefined) state.set(bind, props.defaultValue);
      else state.set(bind, kind === "multi" ? [] : kind === "text" ? "" : null);
    };
    // A $x may come before the control that binds x, so every bound control's starting
    // value is in place before a tree is drawn.
    const seedTree = (value) => {
      if (Array.isArray(value)) { for (const item of value) seedTree(item); return; }
      if (!value || typeof value !== "object" || "$ref" in value || "$action" in value) return;
      if (value.$node === "el") {
        const given = value.props && typeof value.props === "object" && !Array.isArray(value.props) ? value.props : {};
        if (typeof given.bind === "string" && stateName.test(given.bind) && typeof value.name === "string") {
          const props = {};
          for (const name of ["type", "value", "defaultValue", "defaultChecked", "multiple"]) {
            const item = name in given ? toValue(given[name], name) : undefined;
            if (item !== undefined) props[name] = item;
          }
          seedBind(given.bind, bindKind(value.name, props), props);
        }
        for (const key of Object.keys(given)) seedTree(given[key]);
        seedTree(value.children);
        return;
      }
      if (value.$node) return;
      for (const key of Object.keys(value)) seedTree(value[key]);
    };
    // undefined means "leave this prop out".
    const toValue = (value, name) => {
      if (forbiddenProps.has(name)) return undefined;
      if (tagProps.has(name)) return typeof value === "string" && intrinsic.has(value) ? value : undefined;
      if (Array.isArray(value)) return value.map(item => toValue(item, "")).filter(item => item !== undefined);
      if (value && typeof value === "object") {
        if (value.$node === "el") return renderNode(value);
        if (value.$node === "text") return typeof value.text === "string" ? value.text : undefined;
        if ("$ref" in value) return typeof value.$ref === "string" && state.has(value.$ref) && !actionProps.has(name) ? state.get(value.$ref) : undefined;
        if ("$action" in value) {
          if (!actionProps.has(name) || !["sendPrompt", "openLink", "submit"].includes(value.$action) || typeof value.value !== "string") return undefined;
          return () => perform(value.$action, value.value);
        }
        const out = {};
        for (const key of Object.keys(value)) {
          if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
          const item = toValue(value[key], key);
          if (item !== undefined) out[key] = item;
        }
        return out;
      }
      return typeof value === "function" ? undefined : value;
    };
    function renderNode(node, key) {
      if (!node || typeof node !== "object") return null;
      if (node.$node === "text") return typeof node.text === "string" ? node.text : null;
      if (node.$node === "ref") return typeof node.name === "string" ? shown(state.get(node.name)) : null;
      if (node.$node !== "el" || typeof node.name !== "string") return null;
      const type = resolve(node.name);
      if (type === null) return placeholder(key, "<" + node.name.slice(0, 80) + ">");
      const props = {};
      const given = node.props && typeof node.props === "object" && !Array.isArray(node.props) ? node.props : {};
      const bind = typeof given.bind === "string" && stateName.test(given.bind) ? given.bind : null;
      for (const name of Object.keys(given)) {
        if (name === "ref" || name === "key" || name === "__proto__" || name === "bind") continue;
        const value = toValue(given[name], name);
        if (value !== undefined) props[name] = value;
      }
      if (bind) {
        // The frame owns a bound control's value, so it is controlled from here on.
        const kind = bindKind(node.name, props);
        seedBind(bind, kind, props);
        delete props.defaultValue;
        delete props.defaultChecked;
        const current = state.get(bind);
        if (kind === "radio") props.checked = current != null && current === props.value;
        else if (kind === "check") props.checked = current === true;
        // With no default, a Slider or Select is left to pick its own start until it moves:
        // null is not a value every control accepts.
        else if (current !== null || touched.has(bind)) props.value = current;
        const update = (input) => {
          const next = kind === "radio" ? props.value : changed(input, kind === "check");
          if (kind === "radio" && changed(input, true) === false) return;
          touched.add(bind);
          state.set(bind, next);
          rerender();
          share();
        };
        props.onChange = update;
        // Radix-style kit controls (shadcn Select, Tabs, Checkbox, Switch) report changes
        // through these instead; Mantine and plain HTML never see them.
        if (kit && typeof type !== "string") {
          if (kind === "check") props.onCheckedChange = update;
          else props.onValueChange = update;
        }
      }
      if (key !== undefined) props.key = key;
      const children = (Array.isArray(node.children) ? node.children : []).map((child, index) => renderNode(child, index));
      return children.length ? h(type, props, ...children) : h(type, props);
    }
    // Building the element happens inside the boundary, so a tree this frame cannot
    // turn into elements costs that tree and not the root every later tree needs.
    function NodeView(props) { return renderNode(props.node); }
    let setTree;
    function AppCommitted() {
      React.useEffect(() => {
        parent.postMessage({type: "narrafork:ui-ready"}, "*");
        painted();
      }, []);
      return null;
    }
    function Markup() {
      const [tree, set] = React.useState({nodes: [], revision: 0});
      const [, setVersion] = React.useState(0);
      setTree = (nodes) => set(previous => ({nodes, revision: previous.revision + 1}));
      rerender = () => setVersion((version) => version + 1);
      React.useEffect(() => {
        parent.postMessage({type: "narrafork:ui-ready"}, "*");
      }, []);
      React.useEffect(() => { if (tree.revision > 0) painted(); }, [tree.revision]);
      return tree.nodes.map((node, index) => h(Boundary, {key: index, inline: true}, h(NodeView, {node})));
    }
    const root = ReactDOMClient.createRoot(document.getElementById("root"));
    if (config.mode === "app") {
      const App = globalThis.__nfGenUiApp;
      if (!App) throw new Error("UI runtime or default App export is unavailable");
      root.render(h(Boundary, null, h(Setup, null, h(App), h(AppCommitted))));
    } else {
      // The outer boundary keeps the root alive if the kit's own wrapper throws.
      root.render(h(Boundary, null, h(Setup, null, h(Markup))));
      // A plain link would navigate this frame away from the UI; hand it to the host.
      document.addEventListener("click", event => {
        const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
        if (!link) return;
        event.preventDefault();
        if (event.isTrusted) lastGesture = performance.now();
        act("openLink", link.href);
      }, true);
    }
    window.addEventListener("message", event => {
      if (event.source !== parent) return;
      const data = event.data;
      if (data?.type === "narrafork:ui-tree" && Array.isArray(data.nodes)) { seedTree(data.nodes); setTree?.(data.nodes); return; }
      if (data?.type === "narrafork:ui-state") { adopt(data.values); return; }
      if (data?.type !== "narrafork:preview-theme" || config.kit) return;
      const theme = data.theme;
      if (!theme || !["light", "dark"].includes(theme.colorScheme) || typeof theme.tokenCss !== "string" || theme.tokenCss.length > 65536) return;
      config.theme = theme;
      tokens.textContent = theme.tokenCss;
      document.documentElement.dataset.mantineColorScheme = theme.colorScheme;
      updateTheme?.(theme.colorScheme);
    });
  } catch (error) { fail(error); }
})();
</script></body></html>`;
}
