import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

let loading = true;
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@mantine/core", () => ({
	Alert: box,
	Badge: box,
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
	Card: box,
	Code: box,
	Group: box,
	Modal: ({ children, opened }: { children?: ReactNode; opened: boolean }) =>
		opened ? children : null,
	PasswordInput: box,
	Progress: box,
	SegmentedControl: box,
	SimpleGrid: ({ children, ...props }: { children?: ReactNode }) => (
		<div data-testid="project-list-skeleton" {...props}>
			{children}
		</div>
	),
	Skeleton: () => <div data-skeleton />,
	Stack: box,
	Text: box,
	TextInput: box,
	Title: box,
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
	Link: ({ children }: { children?: ReactNode }) => <a href="#projects">{children}</a>,
}));
mock.module("../../frontend/hooks/useProjects", () => ({
	useProjects: () => ({ data: loading ? undefined : [], isLoading: loading }),
	useHiddenProjectExistence: () => ({ data: { hasHidden: false } }),
	useCreateProject: () => ({ isPending: false, error: null, reset: mock(), mutate: mock() }),
	useCreateProjectStream: () => ({
		isPending: false,
		error: null,
		cloneProgress: "",
		needsAuth: false,
		reset: mock(),
		mutate: mock(),
		retryWithCredentials: mock(),
	}),
}));
mock.module("../../frontend/hooks/usePlatform", () => ({ usePlatform: () => "linux" }));
mock.module("../../frontend/hooks/useSetupWizardGuard", () => ({
	useSetupWizardGuard: () => () => true,
}));

const { Route } = await import("../../frontend/routes/projects/index");
const Page = Route.options.component as ComponentType;
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	loading = true;
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

test("project title and creation entry stay available during the first load", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("title");
	expect(container.textContent).toContain("newProject");
	expect(container.querySelector("[data-skeleton]")).not.toBeNull();

	loading = false;
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("title");
	expect(container.textContent).toContain("newProject");
	expect(container.querySelector("[data-skeleton]")).toBeNull();
	expect(container.textContent).toContain("noProjects");
});
