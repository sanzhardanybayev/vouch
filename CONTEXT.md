# Vouch

Human review coverage for code: engineers vouch for spans of code they have read, and the marks travel through git as versioned, per-author records.

## Language

**Review**:
A record of one person vouching for one span of code (a selection, function, class, or whole file), anchored to the exact text it covered and the location that held it (enclosing symbol plus neighboring-line context).
_Avoid_: attestation, vouch (as a noun), mark

**Supersede**:
Replace one of your own earlier reviews with a newer one whose scope fully encloses it. Partial overlap never supersedes - those reviews coexist as peers. The old review stops being current but stays in history.
_Avoid_: consolidate, override, dismiss, move, envelope

**Chain**:
The full lineage of a review: every record linked by supersede edges, from the first review of a span to its current one.
_Avoid_: history, thread

**Current**:
The newest review in a chain that has not been revoked. Only current reviews are rendered, given a status, or counted toward coverage; a current review can be reviewed, dismissed, or ambiguous. Only current reviews can be superseded.
_Avoid_: active, live

**Dismissed**:
A render-time status meaning the code changed after it was reviewed - or moved out of its reviewed location - so the review no longer vouches for what is on screen. Never user-initiated.
_Avoid_: stale, cancelled, invalidated

**Ambiguous**:
A render-time status meaning the reviewed text now matches more than one location (or its recorded location cannot be verified), so no single span can be proven to be the one reviewed. Machine-detected, never a guess; cleared by Resolve.
_Avoid_: unresolved, conflicted, uncertain

**Resolve**:
Pin an ambiguous review to one of its candidate locations by writing a replacement record there. Only the review's author can resolve; anyone else re-reviews the code themselves.
_Avoid_: fix, disambiguate, pick

**Revoke**:
Explicitly withdraw a review (and its whole chain) by writing a tombstone. User-initiated, unlike Dismissed.
_Avoid_: delete, unvouch (command name only)

**Tombstone**:
The append-only record that revokes a chain. Nothing is ever deleted or rewritten.
