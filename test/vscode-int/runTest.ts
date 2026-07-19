import { runTests } from '@vscode/test-electron'
import * as path from 'node:path'
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..')
  const extensionTestsPath = path.resolve(__dirname, './suite/index')
  // Copy fixture to a temp dir and make it a git repo (tests mutate it)
  const fixtureSrc = path.resolve(extensionDevelopmentPath, 'test/vscode-int/fixture')
  const ws = mkdtempSync(path.join(tmpdir(), 'vouch-fixture-'))
  cpSync(fixtureSrc, ws, { recursive: true })
  const g = (args: string[]) => execFileSync('git', args, { cwd: ws })
  g(['init', '-q'])
  g(['config', 'user.name', 'Int Test'])
  g(['config', 'user.email', 'int@test.dev'])
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'fixture', '--allow-empty'])
  // Short user-data-dir: VS Code listens on a unix socket inside it, and
  // macOS caps socket paths at 104 bytes - the default .vscode-test/user-data
  // under a deep checkout path exceeds that and the app fails to launch.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'vouch-ud-'))
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [ws, '--disable-extensions', `--user-data-dir=${userDataDir}`],
  })
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
