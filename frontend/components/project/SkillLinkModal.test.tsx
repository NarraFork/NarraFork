import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	act,
	type ChangeEvent,
	type ComponentProps,
	type CSSProperties,
	type ReactNode,
	useCallback,
	useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { api } from "../../lib/api";

const mantine = { ...(await import("@mantine/core")) };
const mantineHooks = { ...(await import("@mantine/hooks")) };
const translation = { ...(await import("react-i18next")) };
const skillHooks = { ...(await import("../../hooks/useSkills")) };
const platformHooks = { ...(await import("../../hooks/usePlatform")) };
const authHooks = { ...(await import("../../hooks/useAuth")) };
const box = ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => (
	<div style={style}>{children}</div>
);
let inputValue = "";
const input = ({
	label,
	value,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
	disabled?: boolean;
}) => (
	<div data-input={label} data-value={value} data-disabled={disabled}>
		<button
			type="button"
			disabled={disabled}
			onClick={() =>
				onChange({ currentTarget: { value: inputValue } } as ChangeEvent<HTMLInputElement>)
			}
		>
			{label}
		</button>
	</div>
);
const checkbox = ({
	label,
	checked,
	disabled,
	onChange,
}: {
	label?: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) => (
	<button
		type="button"
		data-checkbox={label}
		data-checked={checked}
		disabled={disabled}
		onClick={() =>
			onChange({ currentTarget: { checked: !checked } } as ChangeEvent<HTMLInputElement>)
		}
	>
		{label}
	</button>
);
mock.module("@mantine/core", () => ({
	...mantine,
	Group: box,
	Stack: box,
	Text: box,
	Badge: box,
	Paper: box,
	ActionIcon: ({
		children,
		disabled,
		title,
		onClick,
		"aria-label": ariaLabel,
	}: {
		children?: ReactNode;
		disabled?: boolean;
		title?: string;
		onClick?: () => void;
		"aria-label"?: string;
	}) => (
		<button
			type="button"
			disabled={disabled}
			title={title}
			onClick={onClick}
			aria-label={ariaLabel}
		>
			{children}
		</button>
	),
	SegmentedControl: ({
		value,
		data,
		onChange,
		disabled,
	}: {
		value: string;
		data: Array<{ value: string; label: string }>;
		onChange: (value: string) => void;
		disabled?: boolean;
	}) => (
		<div role="radiogroup">
			{data.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={value === option.value}
					disabled={disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	),
	Container: box,
	Title: box,
	TextInput: input,
	Textarea: input,
	Checkbox: checkbox,
	Switch: checkbox,
	Tabs: Object.assign(box, {
		List: () => null,
		Tab: box,
		Panel: ({ value, children }: { value: string; children?: ReactNode }) =>
			value === "global-skills" ? <div>{children}</div> : null,
	}),
	Alert: ({
		children,
		role,
		style,
	}: {
		children?: ReactNode;
		role?: string;
		style?: CSSProperties;
	}) => (
		<div role={role} style={style}>
			{children}
		</div>
	),
	Button: ({
		children,
		disabled,
		title,
		loading,
		type = "button",
		onClick,
	}: {
		children?: ReactNode;
		disabled?: boolean;
		title?: string;
		loading?: boolean;
		type?: "button" | "submit";
		onClick?: () => void;
	}) => (
		<button type={type} disabled={disabled} title={title} data-loading={loading} onClick={onClick}>
			{children}
		</button>
	),
	Modal: ({
		opened,
		children,
		title,
		onClose,
		closeOnClickOutside,
		closeOnEscape,
		withCloseButton,
	}: {
		opened: boolean;
		children?: ReactNode;
		title?: string;
		onClose: () => void;
		closeOnClickOutside?: boolean;
		closeOnEscape?: boolean;
		withCloseButton?: boolean;
	}) =>
		opened ? (
			<div
				data-modal={title}
				data-close-outside={closeOnClickOutside}
				data-close-escape={closeOnEscape}
				data-close-button={withCloseButton}
			>
				{/* Always invoke onClose to test the handler's own pending guard. */}
				<button type="button" onClick={onClose}>
					modal-close
				</button>
				{children}
			</div>
		) : null,
}));
mock.module("@mantine/hooks", () => ({
	...mantineHooks,
	useDisclosure: () => {
		const [opened, setOpened] = useState(false);
		const open = useCallback(() => setOpened(true), []);
		const close = useCallback(() => setOpened(false), []);
		return [opened, { open, close }];
	},
}));
mock.module("react-i18next", () => ({
	...translation,
	useTranslation: () => ({ t: (key: string) => key }),
}));
let canManage = true;
let currentRole: "admin" | "user" = "admin";
mock.module("../../hooks/usePlatform", () => ({
	...platformHooks,
	useContentCapability: () => ({
		projectSkills: { supported: canManage, reason: canManage ? undefined : "unsupported" },
	}),
}));
mock.module("../../hooks/useAuth", () => ({
	...authHooks,
	useCurrentUser: () => ({ data: { role: currentRole } }),
}));

type LinkInput = { name?: string; url: string; signal: AbortSignal };
type Skill = Awaited<ReturnType<typeof api.updateGlobalSkillFromUrl>>;
type LinkRequest = {
	projectId?: string;
	kind: "create" | "update";
	input: LinkInput;
	resolve: (result: Skill) => void;
	reject: (error: unknown) => void;
};
const requests: LinkRequest[] = [];
function linkMutation(kind: LinkRequest["kind"], projectId?: string) {
	return {
		mutateAsync: (input: LinkInput) =>
			new Promise<Skill>((resolve, reject) =>
				requests.push({ kind, projectId, input, resolve, reject }),
			),
	};
}
const mutation = { mutate: mock(() => {}), isPending: false };
let projectSkills: Awaited<ReturnType<typeof api.listSkills>> = [];
let globalSkills: Awaited<ReturnType<typeof api.listGlobalSkills>> = [];
mock.module("../../hooks/useSkills", () => ({
	...skillHooks,
	useSkills: () => ({ data: projectSkills, isLoading: false }),
	useGlobalSkills: () => ({ data: globalSkills, isLoading: false }),
	useCreateProjectSkill: () => mutation,
	useUpdateProjectSkill: () => mutation,
	useDeleteProjectSkill: () => mutation,
	useProjectSkillsRefresh: () => mutation,
	useCreateGlobalSkill: () => mutation,
	useUpdateGlobalSkill: () => mutation,
	useDeleteGlobalSkill: () => mutation,
	useGlobalSkillsRefresh: () => mutation,
	useToggleGlobalSkill: () => mutation,
	useImportProjectSkill: (projectId: string) => linkMutation("create", projectId),
	useImportGlobalSkill: () => linkMutation("create"),
	useUpdateProjectSkillFromUrl: (projectId: string) => linkMutation("update", projectId),
	useUpdateGlobalSkillFromUrl: () => linkMutation("update"),
}));

const { SkillLinkModal } = await import("./SkillLinkModal");
const { ProjectSkillsManager } = await import("./ProjectSkillsManager");
const { Route } = await import("../../routes/routines/index");
const RoutinesPage = Route.options.component as () => ReactNode;
const url = "https://gitee.com/owner/repo/raw/main/SKILL.md";
const skill = {
	name: "example",
	description: "Example skill",
	location: "/project/.narrafork/skills/example",
	files: ["SKILL.md", "scripts/run.ts"],
	disabled: true,
	canUpdateFromUrl: true,
};
const result: Skill = { ...skill, content: "# Example" };
let root: Root;
let container: HTMLDivElement;
const close = mock(() => {});
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	inputValue = "";
	requests.length = 0;
	projectSkills = [];
	globalSkills = [];
	canManage = true;
	currentRole = "admin";
	close.mockClear();
	mutation.mutate.mockClear();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});
afterAll(() => {
	mock.module("@mantine/core", () => mantine);
	mock.module("@mantine/hooks", () => mantineHooks);
	mock.module("react-i18next", () => translation);
	mock.module("../../hooks/useSkills", () => skillHooks);
	mock.module("../../hooks/usePlatform", () => platformHooks);
	mock.module("../../hooks/useAuth", () => authHooks);
	mock.restore();
});
function buttons(text: string) {
	return Array.from(container.querySelectorAll("button")).filter(
		(candidate) => candidate.textContent === text || candidate.getAttribute("aria-label") === text,
	);
}
function button(text: string, index = 0) {
	const node = buttons(text)[index];
	expect(node).toBeDefined();
	return node as HTMLButtonElement;
}
async function click(text: string, index = 0) {
	await act(async () =>
		button(text, index).dispatchEvent(new window.Event("click", { bubbles: true })),
	);
}
async function enter(value: string) {
	inputValue = value;
	await click("skillLinkUrl");
}
function value() {
	return container.querySelector('[data-input="skillLinkUrl"]')?.getAttribute("data-value");
}
async function renderModal(props: Partial<ComponentProps<typeof SkillLinkModal>> = {}) {
	await act(async () => root.render(<SkillLinkModal opened onClose={close} {...props} />));
}
async function submit(count = 1) {
	const form = container.querySelector("form");
	expect(form).not.toBeNull();
	await act(async () => {
		for (let index = 0; index < count; index++) {
			form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
		}
	});
}
async function ready(update = true) {
	await enter(url);
	if (update) await click("skillLinkConfirmOverwrite");
}

describe("skill link dialog", () => {
	test("creation explains supported links and trust and rejects a blank URL without requiring overwrite", async () => {
		await renderModal();
		for (const text of ["skillLinkFormat", "skillLinkCreateContents", "skillLinkTrust"]) {
			expect(container.textContent).toContain(text);
		}
		expect(container.querySelector("[data-checkbox]")).toBeNull();
		expect(button("createSkillFromLink").disabled).toBe(true);
		await submit();
		await enter("  \t\n ");
		await submit();
		expect(button("createSkillFromLink").disabled).toBe(true);
		expect(requests).toHaveLength(0);
	});

	test.each([
		url,
		"https://gitlab.com/owner/repo/-/raw/main/SKILL.md",
		"http://example.com/SKILL.md",
		"https://github.com/owner/repo/tree/main/skill",
	])("creates from %s in the selected scope without adding metadata", async (link) => {
		await renderModal({ projectId: "project-a" });
		await enter(` ${link} `);
		await submit();
		expect(requests).toHaveLength(1);
		expect(requests[0].kind).toBe("create");
		expect(requests[0].projectId).toBe("project-a");
		expect(requests[0].input).toEqual({ url: link, signal: requests[0].input.signal });
	});

	test("update always asks for a fresh URL and explains definition versus directory replacement", async () => {
		await renderModal({ skill });
		for (const text of [
			"example",
			"skillLinkFormat",
			"skillLinkUpdateContents",
			"skillLinkOverwriteWarning",
		]) {
			expect(container.textContent).toContain(text);
		}
		expect(value()).toBe("");
		expect(button("updateSkillFromLink").disabled).toBe(true);
		await submit();
		await click("skillLinkConfirmOverwrite");
		await enter(" ");
		await submit();
		expect(requests).toHaveLength(0);
		await enter(url);
		expect(button("updateSkillFromLink").disabled).toBe(false);
		await click("skillLinkConfirmOverwrite");
		await submit();
		expect(requests).toHaveLength(0);
	});

	test.each([
		"create",
		"update",
	])("%s trims the URL, submits once and blocks editing and all close paths while pending", async (kind) => {
		await renderModal({ skill: kind === "update" ? skill : undefined });
		await enter(`  ${url}  `);
		if (kind === "update") await click("skillLinkConfirmOverwrite");
		await submit(2);
		expect(requests).toHaveLength(1);
		expect(requests[0].kind).toBe(kind);
		expect(requests[0].projectId).toBeUndefined();
		expect(requests[0].input).toEqual({
			...(kind === "update" ? { name: skill.name } : {}),
			url,
			signal: requests[0].input.signal,
		});
		expect(requests[0].input.signal.aborted).toBe(false);
		expect(button("skillLinkPending").disabled).toBe(true);
		expect(button("cancel").disabled).toBe(true);
		if (kind === "update") expect(button("skillLinkConfirmOverwrite").disabled).toBe(true);
		expect(
			container.querySelector('[data-input="skillLinkUrl"]')?.getAttribute("data-disabled"),
		).toBe("true");
		for (const attribute of ["data-close-outside", "data-close-escape", "data-close-button"]) {
			expect(container.querySelector("[data-modal]")?.getAttribute(attribute)).toBe("false");
		}
		expect(container.textContent).toContain("skillLinkInterruptedHint");
		await click("cancel");
		await click("modal-close");
		await submit();
		expect(requests).toHaveLength(1);
		expect(close).not.toHaveBeenCalled();
	});

	test.each([
		"create",
		"update",
	])("failed %s preserves URL and error and permits an explicit retry", async (kind) => {
		await renderModal({ skill: kind === "update" ? skill : undefined, projectId: "project-a" });
		await enter(` ${url} `);
		if (kind === "update") await click("skillLinkConfirmOverwrite");
		await submit();
		await act(async () => requests[0].reject(new Error("Skill URL not found")));
		expect(value()).toBe(` ${url} `);
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Skill URL not found");
		if (kind === "update")
			expect(button("skillLinkConfirmOverwrite").getAttribute("data-checked")).toBe("true");
		expect(button(kind === "update" ? "updateSkillFromLink" : "createSkillFromLink").disabled).toBe(
			false,
		);
		expect(close).not.toHaveBeenCalled();
		await submit();
		expect(requests).toHaveLength(2);
	});

	test("uses a localized fallback, clears errors when editing and wraps long explanatory/error text", async () => {
		await renderModal({ skill });
		const formatText = Array.from(container.querySelectorAll("div")).find(
			(node) => node.textContent === "skillLinkFormat",
		);
		expect(formatText?.style.overflowWrap).toBe("anywhere");
		await ready();
		await submit();
		await act(async () => requests[0].reject({ unexpected: true }));
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("skillLinkError");
		expect((container.querySelector('[role="alert"]') as HTMLElement).style.overflowWrap).toBe(
			"anywhere",
		);
		await enter(url);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	test.each([
		"create",
		"update",
	])("successful %s closes and does not retain URL or confirmation on reopening", async (kind) => {
		const props = { skill: kind === "update" ? skill : undefined };
		await renderModal(props);
		await ready(kind === "update");
		await submit();
		await act(async () => requests[0].resolve(result));
		expect(close).toHaveBeenCalledTimes(1);
		await renderModal({ ...props, opened: false });
		await renderModal(props);
		expect(value()).toBe("");
		expect(button(kind === "update" ? "updateSkillFromLink" : "createSkillFromLink").disabled).toBe(
			true,
		);
	});

	test.each([
		"project",
		"skill",
		"mode",
	])("changing %s aborts and ignores old success while the new form is pending", async (change) => {
		await renderModal({ projectId: "project-a", skill });
		await ready();
		await submit();
		const oldRequest = requests[0];
		await renderModal({
			projectId: change === "project" ? "project-b" : "project-a",
			skill:
				change === "mode"
					? undefined
					: change === "skill"
						? { ...skill, name: "next-skill" }
						: skill,
		});
		expect(oldRequest.input.signal.aborted).toBe(true);
		expect(value()).toBe("");
		await ready(change !== "mode");
		await submit();
		await act(async () => oldRequest.resolve(result));
		expect(close).not.toHaveBeenCalled();
		expect(button("skillLinkPending").disabled).toBe(true);
		await act(async () => requests[1].resolve(result));
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("a scope change discards the old error and ignores late failure", async () => {
		await renderModal({ projectId: "project-a" });
		await ready(false);
		await submit();
		await renderModal();
		expect(requests[0].input.signal.aborted).toBe(true);
		await act(async () => requests[0].reject(new Error("Late project error")));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(value()).toBe("");
		expect(close).not.toHaveBeenCalled();
	});

	test.each([
		"closed",
		"disabled",
		"unsupported",
		"unmounted",
	])("%s cancels waiting and ignores late results", async (change) => {
		await renderModal({ skill });
		await ready();
		await submit();
		if (change === "unmounted") await act(async () => root.render(null));
		else
			await renderModal({
				skill: { ...skill, canUpdateFromUrl: change !== "unsupported" },
				opened: change !== "closed",
				enabled: change !== "disabled",
			});
		expect(requests[0].input.signal.aborted).toBe(true);
		expect(container.querySelector("form")).toBeNull();
		await act(async () => requests[0].resolve(result));
		expect(close).not.toHaveBeenCalled();
	});

	test("unsupported skill, disabled management or missing project scope cannot start a request", async () => {
		await renderModal({ skill: { name: "external" } });
		expect(container.querySelector("form")).toBeNull();
		await renderModal({ enabled: false });
		expect(container.querySelector("form")).toBeNull();
		await renderModal({ projectId: "" });
		expect(container.querySelector("form")).toBeNull();
		expect(requests).toHaveLength(0);
	});
});

describe("skill add-method dialog", () => {
	test("starts with manual entry and switches to link creation within the same dialog", async () => {
		await renderModal({ manualForm: <div>existing-manual-fields</div> });
		expect(container.querySelector('[data-modal="addSkill"]')).not.toBeNull();
		expect(container.textContent).toContain("existing-manual-fields");
		expect(container.querySelector("form")).toBeNull();
		await click("skillAddLink");
		expect(container.textContent).not.toContain("existing-manual-fields");
		await enter(url);
		await click("skillAddManual");
		expect(container.textContent).toContain("existing-manual-fields");
		await click("skillAddLink");
		expect(value()).toBe(url);
		await submit();
		expect(requests[0].kind).toBe("create");
		expect(button("skillAddManual").disabled).toBe(true);
		await click("modal-close");
		expect(close).not.toHaveBeenCalled();
	});

	test("manual submission disables method switching and all modal close paths", async () => {
		await renderModal({ manualForm: <div>manual-form</div>, manualPending: true });
		expect(button("skillAddLink").disabled).toBe(true);
		expect(button("skillAddManual").disabled).toBe(true);
		await click("modal-close");
		expect(close).not.toHaveBeenCalled();
		expect(container.querySelector("[data-modal]")?.getAttribute("data-close-escape")).toBe(
			"false",
		);
	});

	test("updating a card never shows the add-method switch", async () => {
		await renderModal({ skill, manualForm: <div>manual-form</div> });
		expect(container.querySelector('[role="radiogroup"]')).toBeNull();
		expect(container.textContent).not.toContain("manual-form");
		expect(container.querySelector("form")).not.toBeNull();
	});
});

describe("skill card entries", () => {
	test("project has one add button, top method switch, and a per-card update icon", async () => {
		projectSkills = [skill, { ...skill, name: "external", canUpdateFromUrl: false }];
		await act(async () => root.render(<ProjectSkillsManager projectId="project-a" />));
		expect(button("addSkill").disabled).toBe(false);
		expect(buttons("createSkillFromLink")).toHaveLength(0);
		expect(button("updateSkillFromLink").disabled).toBe(false);
		expect(button("updateSkillFromLink").textContent).toBe("");
		expect(button("updateSkillFromLink", 1).disabled).toBe(true);
		expect(button("updateSkillFromLink", 1).title).toBe("skillLinkUpdateUnsupported");
		await click("addSkill");
		expect(container.querySelector('[data-modal="addSkill"]')).not.toBeNull();
		expect(container.querySelector('[data-input="skillName"]')).not.toBeNull();
		await click("skillAddLink");
		await ready(false);
		await submit();
		expect(requests[0].kind).toBe("create");
		await act(async () => requests[0].resolve(result));
		await click("updateSkillFromLink");
		await ready();
		await submit();
		expect(requests[1].kind).toBe("update");
		expect(requests[1].projectId).toBe("project-a");
		expect(requests[1].input.name).toBe(skill.name);
	});

	test.each([
		"create",
		"update",
	])("project changes cancel old %s and do not reopen a dialog", async (kind) => {
		projectSkills = [skill];
		await act(async () => root.render(<ProjectSkillsManager projectId="project-a" />));
		const entry = kind === "update" ? "updateSkillFromLink" : "addSkill";
		await click(entry);
		if (kind === "create") await click("skillAddLink");
		await ready(kind === "update");
		await submit();
		await act(async () => root.render(<ProjectSkillsManager projectId="project-b" />));
		expect(requests[0].input.signal.aborted).toBe(true);
		expect(container.querySelector("form")).toBeNull();
		await click(entry);
		if (kind === "create") await click("skillAddLink");
		expect(value()).toBe("");
		await act(async () => requests[0].resolve(result));
		expect(container.querySelector("form")).not.toBeNull();
	});

	test("project inherits disabled management and cancels when its outer modal closes", async () => {
		projectSkills = [skill];
		await act(async () => root.render(<ProjectSkillsManager projectId="project-a" />));
		await click("updateSkillFromLink");
		await ready();
		await submit();
		await act(async () =>
			root.render(
				<ProjectSkillsManager projectId="project-a" enabled={false} disabledReason="unsupported" />,
			),
		);
		expect(requests[0].input.signal.aborted).toBe(true);
		expect(container.querySelector("form")).toBeNull();
		for (const entry of ["addSkill", "updateSkillFromLink"]) {
			expect(button(entry).disabled).toBe(true);
			expect(button(entry).title).toBe("unsupported");
		}
		await act(async () => root.render(<ProjectSkillsManager projectId="project-a" />));
		expect(container.querySelector("form")).toBeNull();
	});

	test("global has one add button and uses compact card icons with the same form", async () => {
		globalSkills = [skill, { ...skill, name: "external", canUpdateFromUrl: false }];
		await act(async () => root.render(<RoutinesPage />));
		expect(button("addSkill").disabled).toBe(false);
		expect(buttons("createSkillFromLink")).toHaveLength(0);
		expect(button("updateSkillFromLink").textContent).toBe("");
		expect(button("updateSkillFromLink", 1).disabled).toBe(true);
		await click("addSkill");
		await click("skillAddLink");
		await ready(false);
		await submit();
		expect(requests[0].kind).toBe("create");
		await act(async () => requests[0].resolve(result));
		await click("updateSkillFromLink");
		await ready();
		await submit();
		expect(requests[1].projectId).toBeUndefined();
		expect(requests[1].kind).toBe("update");
		canManage = false;
		await act(async () => root.render(<RoutinesPage />));
		expect(requests[1].input.signal.aborted).toBe(true);
		expect(button("updateSkillFromLink").disabled).toBe(true);
		expect(button("updateSkillFromLink").title).toBe("unsupported");
		expect(container.querySelector("form")).toBeNull();
	});

	test("a non-admin keeps manual creation and cannot update a global skill from a link", async () => {
		currentRole = "user";
		globalSkills = [skill, { ...skill, name: "external", canUpdateFromUrl: false }];
		await act(async () => root.render(<RoutinesPage />));
		expect(button("addSkill").disabled).toBe(false);
		expect(button("updateSkillFromLink").disabled).toBe(true);
		expect(button("updateSkillFromLink").title).toBe("skillLinkAdminOnly");
		expect(button("updateSkillFromLink", 1).disabled).toBe(true);
		expect(button("updateSkillFromLink", 1).title).toBe("skillLinkAdminOnly");
		await click("addSkill");
		expect(container.querySelector('[data-modal="createSkill"]')).not.toBeNull();
		expect(container.querySelector('[data-modal="addSkill"]')).toBeNull();
		expect(container.querySelector('[role="radiogroup"]')).toBeNull();
		expect(requests).toHaveLength(0);
	});
});
