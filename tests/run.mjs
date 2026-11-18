// Runs the TypeScript preset tests with Node's built-in test runner.
//
// The preset parser (src/services/preset/zip.ts) is TypeScript that imports `./types.js`
// with rspack's extensionAlias; Node cannot load it directly. So compile that small
// module subtree to `.test-build/` with tsc first, then let `node --test` load the
// emitted ESM. No extra test framework dependency is added.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const buildDir = path.join(root, '.test-build')

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
execFileSync(process.execPath, ['--test', path.join(root, 'tests', 'preset-metadata.test.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
