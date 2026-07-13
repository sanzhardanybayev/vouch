// Pure decision used by CoverageTree.refresh() (src/vscode/sidebar.ts) to
// decide which tracked files need a coverage recompute.
//
// A file cached as reviewed=true can go stale without its own text or mtime
// changing at all: dismissing/revoking a file's *last* active review flips
// it attested -> unattested by only touching `.vouch/reviews/*.jsonl`, never
// the source file. Neither an mtime guard nor an "already has a cache entry"
// check can see that on their own, so this predicate treats "cached as
// reviewed" as its own trigger, independent of attested/uncounted:
//   - attested            -> always recompute (the record set may have
//                             changed even when the file's text didn't).
//   - no cache entry yet   -> first count.
//   - cached as reviewed   -> re-evaluate. If still attested this is
//                             subsumed by the first branch and it recomputes
//                             (staying reviewed); if no longer attested it
//                             must be requeued here so it can flip to
//                             unreviewed {0, N} instead of serving a stale
//                             reviewed:true entry forever.
// Already-counted, not-reviewed, not-attested files are the only ones left
// alone — the count doesn't depend on the record set, so there's nothing to
// invalidate for them.
export function shouldRequeue(attested: boolean, cached: { reviewed: boolean } | undefined): boolean {
  return attested || !cached || cached.reviewed
}
