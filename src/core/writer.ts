import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { shardPath } from './paths'
import type { VouchLine } from './types'

export async function appendLine(
  rootDir: string, sourcePath: string, slug: string, line: VouchLine,
): Promise<void> {
  const abs = join(rootDir, shardPath(sourcePath, slug))
  await mkdir(dirname(abs), { recursive: true })
  await appendFile(abs, JSON.stringify(line) + '\n', 'utf8')
}

const ATTR_LINE = '.vouch/reviews/** merge=union'

export async function initVouch(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, '.vouch/reviews'), { recursive: true })
  const cfgPath = join(rootDir, '.vouch/config.json')
  try {
    await readFile(cfgPath, 'utf8')
  } catch {
    await writeFile(cfgPath, JSON.stringify({ schemaVersion: 1 }, null, 2) + '\n', 'utf8')
  }
  const attrPath = join(rootDir, '.gitattributes')
  let attrs = ''
  try { attrs = await readFile(attrPath, 'utf8') } catch { /* absent */ }
  // Split on \r?\n and trim: a CRLF .gitattributes must not accrete a
  // duplicate line on every init.
  if (!attrs.split(/\r?\n/).some(l => l.trim() === ATTR_LINE)) {
    const sep = attrs === '' || attrs.endsWith('\n') ? '' : '\n'
    await writeFile(attrPath, attrs + sep + ATTR_LINE + '\n', 'utf8')
  }
}
