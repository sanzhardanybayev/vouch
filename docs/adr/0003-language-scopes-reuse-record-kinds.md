# Language-specific scopes reuse the existing record kinds

The Rust commands (struct, enum, trait, impl, mod, macro) only decide WHICH
symbol a review covers; the record they write keeps the existing kinds -
`function` for macros, `class` for every other item - with the item's symbol
path. We considered new kinds (`impl`, `mod`, ...) and rejected them: a kind an
older client doesn't know resolves to not-reviewed there (it is a future
version's record), so a teammate who hasn't upgraded would see a reviewed impl
block as unreviewed, and every new language would grow the format again. The
item scope is derived from the declaration head at render time and lives in a
separate `SymbolNode.item` tag that never feeds `kindClass`, so selection
anchors and symbol resolution stay identical across clients and versions.
