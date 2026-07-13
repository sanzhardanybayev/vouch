import * as path from 'node:path'
import Mocha from 'mocha'
import { glob } from 'glob'

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: true })
  const testsRoot = path.resolve(__dirname)
  const files = await glob('**/*.test.js', { cwd: testsRoot })
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f))
  await new Promise<void>((resolve, reject) => {
    mocha.run(failures => failures ? reject(new Error(`${failures} tests failed`)) : resolve())
  })
}
