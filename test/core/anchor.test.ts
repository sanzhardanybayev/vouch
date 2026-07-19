import { describe, it, expect } from 'vitest'
import {
  resolveRecord,
  hashRangeOfText,
  ctxHashes,
  buildLineIndex,
  resolveSymbolPathAll,
  enclosingSymbolOfRange,
  HUGE_FILE_LINES,
  CONFIRM_CAP,
  type SymbolNode,
} from '../../src/core/anchor'
import { splitLines } from '../../src/core/text'
import type { ReviewRecord } from '../../src/core/types'

const DOC = ['function a() {', '  return 1', '}', '', 'function b() {', '  return 2', '}'].join(
  '\n',
)

function recFor(
  docText: string,
  range: [number, number],
  extra: Partial<ReviewRecord> = {},
): ReviewRecord {
  const { hash, headHash } = hashRangeOfText(docText, range)
  return {
    id: 'r1',
    author: { name: 'S', email: 's@x.com' },
    createdAt: '2026-01-01T00:00:00Z',
    commit: 'c',
    dirty: false,
    kind: 'selection',
    range,
    hash,
    headHash,
    ...extra,
  }
}

/** Like recFor but also captures ctx hashes, as the new attest flow does. */
function recWithCtx(
  docText: string,
  range: [number, number],
  extra: Partial<ReviewRecord> = {},
): ReviewRecord {
  const { before, after } = ctxHashes(splitLines(docText), range)
  return recFor(docText, range, { ctxBefore: before, ctxAfter: after, ...extra })
}

function sym(
  name: string,
  kindClass: SymbolNode['kindClass'],
  range: [number, number],
  children: SymbolNode[] = [],
): SymbolNode {
  return { name, kindClass, range, children }
}

describe('resolveRecord — content scan (no location signals)', () => {
  it('unchanged text at same place → reviewed', () => {
    const r = recFor(DOC, [1, 3])
    expect(resolveRecord(r, DOC)).toEqual({ status: 'reviewed', effectiveRange: [1, 3] })
  })

  it('rebase-style no-op (only commit sha changed) → reviewed; commit never consulted', () => {
    const r = recFor(DOC, [1, 3], { commit: 'completely-different-sha' })
    expect(resolveRecord(r, DOC).status).toBe('reviewed')
  })

  it('code moved down (insert above) → reviewed at new range', () => {
    const r = recFor(DOC, [1, 3])
    const moved = '// new header\n' + DOC
    expect(resolveRecord(r, moved)).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })

  it('edited text → dismissed at clamped stored range', () => {
    const r = recFor(DOC, [1, 3])
    const edited = DOC.replace('return 1', 'return 42')
    expect(resolveRecord(r, edited)).toEqual({ status: 'dismissed', effectiveRange: [1, 3] })
  })

  it('deleted text in shrunken doc → dismissed, range clamped to doc length', () => {
    const r = recFor(DOC, [5, 7])
    expect(resolveRecord(r, 'x')).toEqual({ status: 'dismissed', effectiveRange: [1, 1] })
  })

  it('corrupt range below 1 → dismissed, clamped to line 1', () => {
    const r = recFor(DOC, [1, 3], { range: [0, 3], hash: 'nope', headHash: undefined })
    expect(resolveRecord(r, DOC)).toEqual({ status: 'dismissed', effectiveRange: [1, 3] })
  })

  it('non-numeric range values → dismissed at line 1, never NaN', () => {
    const r = recFor(DOC, [1, 3], {
      range: ['a', 'b'] as unknown as [number, number],
      hash: 'nope',
      headHash: undefined,
    })
    expect(resolveRecord(r, DOC)).toEqual({ status: 'dismissed', effectiveRange: [1, 1] })
  })

  it('CRLF document matches LF-hashed record', () => {
    const r = recFor(DOC, [1, 3])
    const crlf = DOC.replace(/\n/g, '\r\n')
    expect(resolveRecord(r, crlf).status).toBe('reviewed')
  })

  it('unknown future kind → dismissed, never reviewed', () => {
    const r = recFor(DOC, [1, 3], { kind: 'paragraph' as ReviewRecord['kind'] })
    expect(resolveRecord(r, DOC).status).toBe('dismissed')
  })
})

describe('resolveRecord — duplicate content (issue #2 core)', () => {
  const block = 'if (!ok) return\n'
  // twins at lines 2 and 3 inside one function
  const TWINS = 'function p() {\n' + block + block + '}'

  it('legacy record, multiple matches → ambiguous, never nearest-guess', () => {
    const doc = [
      'function dup() {',
      '  return 9',
      '}',
      '',
      'pad',
      '',
      'function dup2() {',
      '  return 9',
      '}',
    ].join('\n')
    // identical single line '  return 9' exists at lines 2 and 8
    const r = recFor(doc, [8, 8])
    const res = resolveRecord(r, doc)
    expect(res.status).toBe('ambiguous')
    expect(res.candidates).toEqual([
      [8, 8],
      [2, 2],
    ]) // nearest to stored first
    expect(res.effectiveRange).toEqual([8, 8])
  })

  it('adjacent twins, bottom reviewed with ctx, one line inserted above → mark follows the right twin', () => {
    const r = recWithCtx(TWINS, [3, 3])
    const shifted = '// header\n' + TWINS
    expect(resolveRecord(r, shifted)).toEqual({ status: 'reviewed', effectiveRange: [4, 4] })
  })

  it('twins + shift + edited line below (0 ctx survivors) → ambiguous, never stored-range green', () => {
    const r = recWithCtx(TWINS, [3, 3])
    // shift twins down one AND change the closing context under the bottom twin
    const mutated =
      '// header\n' +
      'function p() {\n' +
      block +
      block +
      '}\n// trailer changed'.replace('}', '} // altered')
    const res = resolveRecord(r, mutated)
    expect(res.status).toBe('ambiguous')
    expect(res.candidates).toHaveLength(2)
  })

  it('a 3-run of identical lines: ctx still pins the middle one after a shift → reviewed', () => {
    const doc = 'a\nx\nx\nx\na'
    const r = recWithCtx(doc, [3, 3])
    const shifted = 'pad\n' + doc
    expect(resolveRecord(r, shifted)).toEqual({ status: 'reviewed', effectiveRange: [4, 4] })
  })

  it('deep inside a long identical run, neighborhoods are identical too → ambiguous', () => {
    const doc = 'a\n' + Array.from({ length: 7 }, () => 'x').join('\n') + '\na'
    const r = recWithCtx(doc, [5, 5]) // middle x: two x above, two x below
    const shifted = 'pad\n' + doc
    const res = resolveRecord(r, shifted)
    expect(res.status).toBe('ambiguous')
    expect(res.candidates!.length).toBeGreaterThan(1)
  })

  it('more than CONFIRM_CAP identical matches → ambiguous with capped candidate list', () => {
    const doc = Array.from({ length: CONFIRM_CAP + 10 }, () => 'dup').join('\n')
    const r = recFor(doc, [5, 5])
    const res = resolveRecord(r, doc)
    expect(res.status).toBe('ambiguous')
    expect(res.candidates!.length).toBeLessThanOrEqual(CONFIRM_CAP)
  })
})

describe('resolveRecord — symbol layer', () => {
  // fnA lines 1-4, fnB lines 6-9; identical body line in both
  const DOC2 = [
    'function fnA() {',
    '  guard()',
    '  return',
    '}',
    '',
    'function fnB() {',
    '  guard()',
    '  return',
    '}',
  ].join('\n')
  const SYMS: SymbolNode[] = [sym('fnA', 'function', [1, 4]), sym('fnB', 'function', [6, 9])]

  it('duplicate content across two functions: symbol filter keeps the reviewed context', () => {
    const r = recFor(DOC2, [7, 7], { anchorSymbol: 'fnB' })
    const res = resolveRecord(r, DOC2, SYMS)
    expect(res).toEqual({ status: 'reviewed', effectiveRange: [7, 7] })
  })

  it('identical text moves to another function → dismissed', () => {
    // record anchored in fnA; fnA body edited so the text now ONLY exists in fnB
    const r = recFor(DOC2, [2, 2], { anchorSymbol: 'fnA' })
    const edited = DOC2.replace('function fnA() {\n  guard()', 'function fnA() {\n  guardChanged()')
    const res = resolveRecord(r, edited, SYMS)
    expect(res.status).toBe('dismissed')
  })

  it('moved within its function (shift) → reviewed at new range', () => {
    const r = recFor(DOC2, [2, 2], { anchorSymbol: 'fnA' })
    const shifted = '// top\n' + DOC2
    const shiftedSyms = [sym('fnA', 'function', [2, 5]), sym('fnB', 'function', [7, 10])]
    expect(resolveRecord(r, shifted, shiftedSyms)).toEqual({
      status: 'reviewed',
      effectiveRange: [3, 3],
    })
  })

  it('enclosing symbol renamed → ambiguous (orphaned), never silent reviewed or dismissed', () => {
    const r = recFor(DOC2, [2, 2], { anchorSymbol: 'fnRenamedAway' })
    const res = resolveRecord(r, DOC2, SYMS)
    expect(res.status).toBe('ambiguous')
  })

  it('duplicate symbol names: ctx breaks the tie → reviewed; without ctx → ambiguous', () => {
    const dupSyms = [sym('fn', 'function', [1, 4]), sym('fn', 'function', [6, 9])]
    const withCtx = recWithCtx(DOC2, [2, 2], { anchorSymbol: 'fn' })
    expect(resolveRecord(withCtx, DOC2, dupSyms).status).toBe('reviewed')
    const noCtx = recFor(DOC2, [2, 2], { anchorSymbol: 'fn' })
    expect(resolveRecord(noCtx, DOC2, dupSyms).status).toBe('ambiguous')
  })

  it('top-level sentinel: still top-level → reviewed; moved inside a function → ambiguous', () => {
    const doc = ['const K = 1', '', 'function f() {', '  const J = 2', '}'].join('\n')
    const syms = [sym('f', 'function', [3, 5])]
    const top = recFor(doc, [1, 1], { anchorSymbol: '' })
    expect(resolveRecord(top, doc, syms).status).toBe('reviewed')
    // byte-identical text now only inside f
    const moved = ['', '', 'function f() {', 'const K = 1', '}'].join('\n')
    expect(resolveRecord(top, moved, syms).status).toBe('ambiguous')
  })

  it('function-kind record with symbol path resolves inside its symbol', () => {
    const r = recFor(DOC2, [6, 9], { kind: 'function', symbol: 'fnB' })
    expect(resolveRecord(r, DOC2, SYMS)).toEqual({ status: 'reviewed', effectiveRange: [6, 9] })
  })
})

describe('resolveRecord — conservative rule (symbols unavailable)', () => {
  const DOC2 = ['function fnA() {', '  body()', '}'].join('\n')

  it('anchored record, symbols null, intact at stored range with ctx verified → reviewed', () => {
    const r = recWithCtx(DOC2, [2, 2], { anchorSymbol: 'fnA' })
    expect(resolveRecord(r, DOC2, null).status).toBe('reviewed')
  })

  it('anchored record, symbols null, single candidate but moved → ambiguous (not reviewed)', () => {
    const r = recWithCtx(DOC2, [2, 2], { anchorSymbol: 'fnA' })
    const shifted = '// pad\n' + DOC2
    expect(resolveRecord(r, shifted, null).status).toBe('ambiguous')
  })

  it('anchored legacy-style record (no ctx), symbols null, intact at stored → reviewed', () => {
    const r = recFor(DOC2, [2, 2], { anchorSymbol: 'fnA' })
    expect(resolveRecord(r, DOC2, null).status).toBe('reviewed')
  })

  it('record with no location signal behaves identically with or without symbols', () => {
    const r = recFor(DOC2, [2, 2])
    const shifted = '// pad\n' + DOC2
    expect(resolveRecord(r, shifted, null)).toEqual(
      resolveRecord(r, shifted, [sym('fnA', 'function', [2, 4])]),
    )
  })
})

describe('resolveRecord — bounded paths (no headHash / huge files)', () => {
  it('record without headHash: intact at stored → reviewed; moved → dismissed', () => {
    const r = recFor(DOC, [1, 3], { headHash: undefined })
    expect(resolveRecord(r, DOC).status).toBe('reviewed')
    expect(resolveRecord(r, '// x\n' + DOC).status).toBe('dismissed')
  })

  it('huge file: intact legacy record at stored range → reviewed', () => {
    const filler = Array.from({ length: HUGE_FILE_LINES + 5 }, (_, i) => `line ${i}`)
    const doc = filler.join('\n')
    const r = recFor(doc, [100, 102])
    expect(resolveRecord(r, doc).status).toBe('reviewed')
    expect(resolveRecord(r, 'inserted\n' + doc).status).toBe('dismissed') // no scan over cap
  })

  it('huge file: twin shifted onto the stored range with failing ctx → ambiguous, not reviewed', () => {
    const filler = Array.from({ length: HUGE_FILE_LINES + 5 }, (_, i) => `line ${i}`)
    filler[99] = 'dup' // L100
    filler[100] = 'dup' // L101 ← reviewed
    const doc = filler.join('\n')
    const r = recWithCtx(doc, [101, 101])
    const shifted = 'inserted\n' + doc // dup twins now at 101/102; stored range hits wrong twin
    expect(resolveRecord(r, shifted).status).toBe('ambiguous')
  })

  it('huge file: selection shifted within its symbol → reviewed via within-symbol scan', () => {
    const filler = Array.from({ length: HUGE_FILE_LINES + 5 }, (_, i) => `line ${i}`)
    const doc = filler.join('\n')
    const r = recWithCtx(doc, [5000, 5001], { anchorSymbol: 'big' })
    const shifted = 'inserted\n' + doc
    const syms = [sym('big', 'function', [4000, 6500])]
    expect(resolveRecord(r, shifted, syms)).toEqual({
      status: 'reviewed',
      effectiveRange: [5001, 5002],
    })
  })
})

describe('resolveRecord — kind=file', () => {
  it('whole-file match / mismatch', () => {
    const { hash } = hashRangeOfText(DOC, [1, splitLines(DOC).length])
    const r: ReviewRecord = {
      id: 'f',
      author: { name: 'S', email: 's@x.com' },
      createdAt: '2026-01-01T00:00:00Z',
      commit: 'c',
      dirty: false,
      kind: 'file',
      hash,
    }
    expect(resolveRecord(r, DOC).status).toBe('reviewed')
    expect(resolveRecord(r, DOC + '\nx').status).toBe('dismissed')
  })
})

describe('ctxHashes', () => {
  it('top/bottom of file hash the empty string consistently', () => {
    const lines = splitLines('a\nb\nc')
    const top = ctxHashes(lines, [1, 1])
    const bottom = ctxHashes(lines, [3, 3])
    expect(top.before).toBe(ctxHashes(['x'], [1, 1]).before) // both hash ''
    expect(bottom.after).toBe(top.before)
    expect(top.after).not.toBe(top.before) // 'b\nc' below line 1
  })

  it('uses up to two lines each side', () => {
    const lines = splitLines('a\nb\nT\nc\nd\ne')
    const { before, after } = ctxHashes(lines, [3, 3])
    expect(before).toBe(ctxHashes(splitLines('a\nb\nT'), [3, 3]).before)
    expect(after).toBe(ctxHashes(splitLines('T\nc\nd'), [1, 1]).after)
  })
})

describe('symbol helpers', () => {
  const tree: SymbolNode[] = [
    sym('A', 'class', [1, 20], [sym('m', 'function', [2, 5]), sym('m', 'function', [7, 10])]),
    sym('top', 'function', [22, 30]),
  ]

  it('resolveSymbolPathAll returns every match of a duplicated path', () => {
    expect(resolveSymbolPathAll(tree, 'A/m').map((n) => n.range)).toEqual([
      [2, 5],
      [7, 10],
    ])
    expect(resolveSymbolPathAll(tree, 'top')).toHaveLength(1)
    expect(resolveSymbolPathAll(tree, 'nope')).toHaveLength(0)
  })

  it('enclosingSymbolOfRange finds the deepest enclosing function/class of a whole range', () => {
    expect(enclosingSymbolOfRange(tree, [3, 4], 'any')?.path).toBe('A/m')
    expect(enclosingSymbolOfRange(tree, [12, 15], 'any')?.path).toBe('A')
    expect(enclosingSymbolOfRange(tree, [2, 9], 'any')?.path).toBe('A') // spans both m's
    expect(enclosingSymbolOfRange(tree, [21, 21], 'any')).toBeNull()
  })
})

describe('buildLineIndex', () => {
  it('is shareable across records and equivalent to the internal build', () => {
    const idx = buildLineIndex(DOC)
    const r = recFor(DOC, [1, 3])
    expect(resolveRecord(r, DOC, null, idx)).toEqual(resolveRecord(r, DOC))
  })
})

describe('resolveRecord — duplicate symbol names (hard containment)', () => {
  // two same-named symbols; the reviewed text + neighborhood cut-pasted OUTSIDE both
  const DOC3 = [
    'function fn() {',
    '  a()',
    '}',
    'function fn() {',
    '  b()',
    '}',
    'pad',
    '  SECRET',
    'pad2',
  ].join('\n')
  const DUP_SYMS: SymbolNode[] = [sym('fn', 'function', [1, 3]), sym('fn', 'function', [4, 6])]

  it('a ctx survivor OUTSIDE every occurrence of the symbol never resolves reviewed', () => {
    // capture pretends the text was once inside fn; now it exists only at L8
    const { hash, headHash } = hashRangeOfText(DOC3, [8, 8])
    const { before, after } = ctxHashes(splitLines(DOC3), [8, 8])
    const r: ReviewRecord = {
      id: 'r1',
      author: { name: 'S', email: 's@x.com' },
      createdAt: '2026-01-01T00:00:00Z',
      commit: 'c',
      dirty: false,
      kind: 'selection',
      range: [2, 2],
      hash,
      headHash,
      anchorSymbol: 'fn',
      ctxBefore: before,
      ctxAfter: after,
    }
    const res = resolveRecord(r, DOC3, DUP_SYMS)
    expect(res.status).not.toBe('reviewed')
  })

  it('legacy record (no ctx) intact at stored range, unique in file → reviewed despite duplicate names', () => {
    const doc = ['function add() {', '  impl()', '}', 'function add() {', '  other()', '}'].join(
      '\n',
    )
    const dupSyms = [sym('add', 'function', [1, 3]), sym('add', 'function', [4, 6])]
    const r = recFor(doc, [2, 2], { anchorSymbol: 'add' })
    expect(resolveRecord(r, doc, dupSyms)).toEqual({ status: 'reviewed', effectiveRange: [2, 2] })
  })
})

describe('buildLineIndex — scan-cap boundary', () => {
  it('a newline-terminated file of exactly HUGE_FILE_LINES real lines still gets the full scan', () => {
    // trailing empty segment must not count toward the cap
    const doc = Array.from({ length: HUGE_FILE_LINES }, (_, i) => `line ${i}`).join('\n') + '\n'
    expect(buildLineIndex(doc).lineHashes).not.toBeNull()
  })

  it('an untouched review in a file that stays at the cap after an insert is followed, not dismissed', () => {
    // 99,999 real lines; after inserting one at the top the current text has
    // exactly HUGE_FILE_LINES real lines → still the complete scan path.
    const base = Array.from({ length: HUGE_FILE_LINES - 1 }, (_, i) => `line ${i}`).join('\n')
    const r = recWithCtx(base, [50, 52])
    expect(resolveRecord(r, 'inserted\n' + base)).toEqual({
      status: 'reviewed',
      effectiveRange: [51, 53],
    })
  })
})
