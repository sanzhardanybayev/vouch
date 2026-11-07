import { codeLineNumbers } from './text'

// Pure line-count coverage for an unreviewed file, given its full contents.
// NUL byte in the first 8192 bytes -> binary -> null (excluded from coverage
// entirely, never counted as 0-reviewed). Empty or blank-only (0 code lines)
// -> null too; blank lines never enter the denominator (core/coverage.ts). No fs,
// no vscode: callers own reading the file (see sidebar.ts's countFileCoverage,
// which reads only a prefix first to reject binaries without a full read).
export function textFileCoverage(buf: Buffer): { reviewedLines: 0; totalLines: number } | null {
  if (buf.subarray(0, 8192).includes(0)) return null // NUL byte -> binary
  const totalLines = codeLineNumbers(buf.toString('utf8')).length
  if (totalLines === 0) return null
  return { reviewedLines: 0, totalLines }
}
