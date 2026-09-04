/**
 * Development JSX runtime, aliased onto the production one.
 *
 * `Bun.build` emits `jsxDEV` imports from `./shim/jsx-dev-runtime` unless told otherwise, so
 * this module has to exist even though the panel only ever ships a production build. It maps
 * onto the same host React as `jsx-runtime`, which is the point: both paths must resolve to
 * the host's runtime rather than pulling a second React into the bundle.
 *
 * `jsxDEV` takes extra debug arguments that `jsx` ignores, so forwarding is safe.
 */

export { Fragment, jsx as jsxDEV, jsx, jsxs } from "../host-runtime";
