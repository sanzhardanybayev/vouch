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
  g(['init', '-q']); g(['config', 'user.name', 'Int Test']); g(['config', 'user.email', 'int@test.dev'])
  g(['add', '-A']); g(['commit', '-q', '-m', 'fixture', '--allow-empty'])
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [ws, '--disable-extensions'],
  })
}
main().catch(err => { console.error(err); process.exit(1) })
