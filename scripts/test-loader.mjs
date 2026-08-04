// Registers the `@/…` alias resolve hook for the Node test runner.
// Used via `node --import ./scripts/test-loader.mjs --test …`.
import { register } from "node:module";

register("./test-alias-hook.mjs", import.meta.url);
