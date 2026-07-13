import { describe, it, expect } from 'vitest'
import { commitUrl } from '../../src/core/giturl'

describe('commitUrl', () => {
  it('github https', () => {
    expect(commitUrl('https://github.com/org/repo.git', 'abc'))
      .toBe('https://github.com/org/repo/commit/abc')
  })
  it('github ssh', () => {
    expect(commitUrl('git@github.com:org/repo.git', 'abc'))
      .toBe('https://github.com/org/repo/commit/abc')
  })
  it('gitlab (self-hosted host containing gitlab)', () => {
    expect(commitUrl('git@gitlab.mycorp.io:team/app.git', 'abc'))
      .toBe('https://gitlab.mycorp.io/team/app/-/commit/abc')
  })
  it('bitbucket', () => {
    expect(commitUrl('https://bitbucket.org/org/repo.git', 'abc'))
      .toBe('https://bitbucket.org/org/repo/commits/abc')
  })
  it('garbage remote → null', () => {
    expect(commitUrl('not a url', 'abc')).toBeNull()
  })
})
