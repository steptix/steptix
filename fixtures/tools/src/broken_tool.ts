// @ts-nocheck — this fixture is intentionally invalid (see below). The
// directive disables type-checking for THIS FILE ONLY; it has no effect on any
// other file and changes nothing at runtime.
//
// Intentionally broken fixture: imports a package that does not exist.
//
// Used by tests to prove that lazy tool loading isolates a broken file — it is
// indexed alongside the healthy tools but only fails when a test actually
// references `broken_tool`. Tests that never invoke it are unaffected. The
// missing import is the whole point: it must throw at runtime.
import 'this-package-does-not-exist';

export default () => 'never reached';
