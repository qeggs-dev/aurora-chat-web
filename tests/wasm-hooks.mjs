// Node ESM loader hooks for the test runner: the memory store imports sql.js's wasm
// asset URL (`import wasmUrl from 'sql.js/.../sql-wasm-browser.wasm'`), which rspack
// emits as an asset but Node cannot import. Map every `.wasm` specifier to an empty
// module so the pure argument-validation paths of memory/store.ts can be tested;
// no test in this suite actually initializes sql.js.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.wasm')) {
    return { url: 'data:text/javascript,export default "";', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
