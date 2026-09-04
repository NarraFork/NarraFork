/**
 * JSX runtime backed by the host's React.
 *
 * `@jsxImportSource ./shim` makes the compiler emit `import { jsx } from "./shim/jsx-runtime"`,
 * which lands here instead of at the real `react/jsx-runtime`. Without this indirection the
 * automatic JSX transform would pull React into the plugin bundle — the components would then
 * be created by a different React than the one that renders them, and hooks would fail.
 *
 * `jsxDEV` is aliased to `jsx` because the panel is only ever built for production; the dev
 * transform is never emitted, but exporting the name keeps a stray dev build from failing to
 * resolve.
 */

export { Fragment, jsx, jsx as jsxDEV, jsxs } from "../host-runtime";
