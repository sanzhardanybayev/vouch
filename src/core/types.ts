export interface Author {
  name: string
  email: string
}

export type RecordKind = 'selection' | 'function' | 'class' | 'file'

export interface ReviewRecord {
  id: string
  author: Author
  createdAt: string            // ISO 8601
  commit: string               // '' when not a git repo
  dirty: boolean               // file differed from HEAD at review time
  kind: RecordKind
  symbol?: string              // hierarchical DocumentSymbol names joined with '/'
  range?: [number, number]     // 1-based inclusive; absent for kind='file'
  hash: string                 // sha256:<hex> of range text (or whole file), CRLF-normalized
  headHash?: string            // sha256:<hex> of the range's first line; absent for kind='file'
  comment?: string
  supersedes?: string[]        // same-user record ids this replaces
  movedFrom?: string           // set by re-attach
}

export interface Tombstone {
  id: string
  author: Author
  createdAt: string
  revokes: string              // any record id in the target chain — kills the whole chain
  reason: 'unvouch' | 'moved'
  movedTo?: string             // repo-relative path, reason='moved'
}

export type VouchLine = ReviewRecord | Tombstone
