import { describe, it, expect } from 'vitest'
import { escapeIcons } from '../../src/core/quickpick'

describe('escapeIcons', () => {
  it('escapes every codicon token so it renders as literal text', () => {
    expect(escapeIcons('$(check) reviewed $(pass)')).toBe('\\$(check) reviewed \\$(pass)')
  })
  it('leaves plain text and lone dollars alone', () => {
    expect(escapeIcons('Ann - function parse')).toBe('Ann - function parse')
    expect(escapeIcons('costs $5 (net)')).toBe('costs $5 (net)')
  })
})
