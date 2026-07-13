import { describe, it, expect } from 'vitest'
import { textFileCoverage } from '../../src/core/linecount'

describe('textFileCoverage', () => {
  it('text buffer -> {0, N}', () => {
    expect(textFileCoverage(Buffer.from('a\nb\nc\n', 'utf8'))).toEqual({ reviewedLines: 0, totalLines: 3 })
  })

  it('NUL byte within the first 8KB -> binary -> null', () => {
    const buf = Buffer.concat([Buffer.from('hello '), Buffer.from([0]), Buffer.from(' world')])
    expect(textFileCoverage(buf)).toBeNull()
  })

  it('NUL byte beyond the first 8KB is not inspected -> still counted as text', () => {
    const prefix = Buffer.from('a\n'.repeat(4096), 'utf8') // > 8192 bytes, no NUL
    const buf = Buffer.concat([prefix, Buffer.from([0])])
    expect(textFileCoverage(buf)).not.toBeNull()
  })

  it('empty buffer -> null', () => {
    expect(textFileCoverage(Buffer.alloc(0))).toBeNull()
  })

  it('CRLF text counts per convention (trailing newline adds no line)', () => {
    expect(textFileCoverage(Buffer.from('a\r\nb\r\nc\r\n', 'utf8'))).toEqual({ reviewedLines: 0, totalLines: 3 })
    expect(textFileCoverage(Buffer.from('a\r\nb\r\nc', 'utf8'))).toEqual({ reviewedLines: 0, totalLines: 3 })
  })
})
