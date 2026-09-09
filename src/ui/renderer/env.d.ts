/**
 * Ambient module declarations the renderer's own typecheck needs.
 *
 * `index.tsx` imports `./styles/app.css` for its side effect; Vite handles
 * that at build time, but `npx tsc --noEmit -p src/ui/renderer/tsconfig.json`
 * knows nothing about Vite's asset pipeline and reports the import as a
 * missing module. This tsconfig pins `types` to react/react-dom, so
 * `vite/client` is not picked up automatically either — hence the explicit
 * declaration rather than a `/// <reference types="vite/client" />`, which
 * would also drag in every other asset kind the renderer never imports.
 */
declare module '*.css';
