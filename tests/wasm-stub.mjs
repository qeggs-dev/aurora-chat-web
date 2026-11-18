// Registered with `node --import` by tests/run.mjs before the test files load.
import { register } from 'node:module'

register('./wasm-hooks.mjs', import.meta.url)
