# Supersede on enclosure only, never on partial overlap

A new review supersedes an earlier review by the same author only when the new
scope fully encloses the old one (equal ranges count; a file review encloses
everything in the file; same symbol is the same unit). Originally any overlap
superseded, but a review is a unit of confidence: partial coverage of a block is
a separate act of review, not a replacement of it, so partially overlapping
reviews coexist as peers. This also works in reverse - re-reviewing an inner
function inside a larger (possibly dismissed) review coexists with it rather
than collapsing the larger review's chain down to a function-sized scope.
Confidence grows bottom-up: pieces accumulate as peers until one review of the
whole block consolidates them all.
