import { rollup, pct, type FileCoverage } from './coverage'

export interface TreeFile {
  path: string
  coverage: FileCoverage | null | 'pending'
  reviewed: boolean
}
export interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  files: TreeFile[]
  coverage: FileCoverage | null | 'pending'
}

export function buildTree(files: TreeFile[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [], coverage: null }
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = f.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]!
      let child = node.folders.find((x) => x.name === name)
      if (!child) {
        child = {
          name,
          path: segments.slice(0, i + 1).join('/'),
          folders: [],
          files: [],
          coverage: null,
        }
        node.folders.push(child)
      }
      node = child
    }
    node.files.push(f)
  }
  computeCoverage(root)
  return root
}

function computeCoverage(folder: TreeFolder): FileCoverage | null | 'pending' {
  const parts: (FileCoverage | null)[] = []
  let pending = false
  for (const sub of folder.folders) {
    const c = computeCoverage(sub)
    if (c === 'pending') pending = true
    else parts.push(c)
  }
  for (const f of folder.files) {
    if (f.coverage === 'pending') pending = true
    else parts.push(f.coverage)
  }
  folder.coverage = pending ? 'pending' : rollup(parts)
  return folder.coverage
}

export interface HeaderStats {
  workspacePct: number | null
  pending: boolean
  records: number
  reviewedFiles: number
  totalFiles: number
  perAuthor: { name: string; current: number }[]
}

export function headerStats(
  files: TreeFile[],
  totalFiles: number,
  counts: { records: number; perAuthor: Map<string, { name: string; current: number }> },
): HeaderStats {
  const pending = files.some((f) => f.coverage === 'pending')
  const covs = files
    .map((f) => f.coverage)
    .filter((c): c is FileCoverage => c !== null && c !== 'pending')
  const total = rollup(covs)
  return {
    workspacePct: total ? pct(total) : null,
    pending,
    records: counts.records,
    reviewedFiles: files.filter((f) => f.reviewed).length,
    totalFiles,
    perAuthor: [...counts.perAuthor.values()],
  }
}
