// Runs the TypeScript unit tests with Node's built-in test runner.
//
// The modules under test are TypeScript that import each other with `.js` specifiers
// (rspack's extensionAlias); Node cannot load them directly. So compile the tested
// module subtrees to `.test-build/` with tsc first, then let `node --test` load the
// emitted ESM. No extra test framework dependency is added.
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const buildDir = path.join(root, '.test-build')
const testsDir = path.join(root, 'tests')

rmSync(buildDir, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    path.join(root, 'tsconfig.test.json'),
  ],
  { cwd: root, stdio: 'inherit' }
)

// One explicit file list (instead of relying on `node --test <dir>` discovery) so every
// *.test.mjs in tests/ is picked up deterministically.
const testFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testsDir, name))
// wasm-stub registers a loader hook that maps `.wasm` asset imports (sql.js) to an empty
// module, so memory/store.ts can be imported without rspack's asset pipeline.
execFileSync(
  process.execPath,
  [
    '--import',
    pathToFileURL(path.join(testsDir, 'wasm-stub.mjs')).href,
    '--test',
    ...testFiles,
  ],
  { cwd: root, stdio: 'inherit' }
)
