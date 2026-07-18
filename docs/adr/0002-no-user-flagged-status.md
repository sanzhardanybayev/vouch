# No user-flagged "dismissed" status - vouch or revoke, nothing between

Vouch has exactly two verdicts a person can express: vouch for a span, or not.
Dismissed is machine-detected only (the code changed under a review); it can
never be set by hand. A user who no longer trusts their own review revokes it -
the span becomes honestly unreviewed - or re-reviews it. We considered a
visible-but-distrusted state ("flagged", "cancelled", "stale") and rejected it:
it would make coverage numbers ambiguous ("reviewed... sort of"), add a third
status to every render surface and to the coverage math, and duplicate what
revoke plus the chain history already express. If a span shows as reviewed,
someone currently stands behind it - that guarantee is the product.
