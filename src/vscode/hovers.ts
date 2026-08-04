import * as vscode from 'vscode'
import { callSiteMd, rangeHoverMd, isValidSha, type HoverEntry } from '../core/hovermd'
import { commitUrl } from '../core/giturl'
import { callTargetSpan, coveringEntries } from '../core/callsite'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { remoteUrl } from './gitinfo'
import { documentSymbols } from './symbols'

// A plain Location's range is typically just the identifier, not the whole
// declaration (LocationLink.targetRange is the full span) — track which shape
// we got so the span can be expanded to the enclosing symbol before matching.
type DefTarget = { uri: vscode.Uri; range: vscode.Range; identifierOnly: boolean } | null

const DEF_TIMEOUT = Symbol('defTimeout')

export function registerHovers(
  context: vscode.ExtensionContext,
  ctx: VouchContext,
  pipeline: StatusPipeline,
): void {
  const remoteCache = new Map<string, string | null>()
  const defCache = new Map<string, DefTarget>()

  async function remoteFor(rootDir: string): Promise<string | null> {
    if (!remoteCache.has(rootDir)) remoteCache.set(rootDir, await remoteUrl(rootDir))
    return remoteCache.get(rootDir)!
  }

  const provider: vscode.HoverProvider = {
    async provideHover(doc, pos, token) {
      if (!ctx.roots.some((r) => r.store.attestedFiles().length > 0)) return undefined
      const line = pos.line + 1

      // (a) range hover — records covering this line in THIS document
      const status = await pipeline.statusFor(doc)
      const covering = coveringEntries(status.entries, [line, line])
      if (covering.length > 0) {
        const root = ctx.rootFor(doc.uri)!
        const remote = await remoteFor(root.rootDir)
        const entries: HoverEntry[] = covering.map((e) => ({
          authorName: e.record.author.name,
          status: e.res.status,
          createdAt: e.record.createdAt,
          comment: e.record.comment,
          commit: e.record.commit,
          commitLink:
            e.record.commit && isValidSha(e.record.commit) && remote
              ? commitUrl(remote, e.record.commit)
              : null,
          recordId: e.record.id,
          supersedesCount: e.record.supersedes?.length,
        }))
        const md = new vscode.MarkdownString(rangeHoverMd(entries, new Date().toISOString()))
        // Only allowlist the exact command links rangeHoverMd emits — never
        // grant blanket isTrusted, since authorName/comment are attacker-
        // controlled text from other users' .vouch/ records.
        md.isTrusted = {
          enabledCommands: [
            'vouch.openTimeline',
            'vouch.showDiff',
            'vouch.reReview',
            'vouch.resolveAmbiguous',
          ],
        }
        return new vscode.Hover(md)
      }

      // (b) call-site hover — definition target's status. Same-file targets
      // are served too: path (a) returned above whenever the hovered line
      // itself is covered, so reaching here means the call line is uncovered
      // and the target's own coverage is the only signal worth showing.
      const key = `${doc.uri}:${pos.line}:${pos.character}:${doc.version}`
      let target = defCache.get(key)
      if (target === undefined) {
        const toTarget = (
          res: (vscode.Location | vscode.LocationLink)[] | undefined,
        ): DefTarget => {
          const first = res?.[0]
          return !first
            ? null
            : first instanceof vscode.Location
              ? { uri: first.uri, range: first.range, identifierOnly: true }
              : { uri: first.targetUri, range: first.targetRange, identifierOnly: false }
        }
        const lookup = vscode.commands.executeCommand<
          (vscode.Location | vscode.LocationLink)[] | undefined
        >('vscode.executeDefinitionProvider', doc.uri, pos)
        // Cache is populated from the lookup itself, never from the timeout:
        // a slow language server must not poison this position with null
        // until the next edit. When the timeout wins the race the lookup
        // keeps running and lands in the cache late, so the next hover at
        // this spot is instant. (The rejection handler also keeps a late
        // failure from surfacing as an unhandled rejection — vscode's
        // Thenable has `.then` only, no `.catch`.)
        lookup.then(
          (res) => {
            defCache.set(key, toTarget(res))
            if (defCache.size > 500) defCache.clear()
          },
          () => undefined,
        )
        const timeout = new Promise<typeof DEF_TIMEOUT>((r) =>
          setTimeout(() => r(DEF_TIMEOUT), 400),
        )
        const res = await Promise.race([lookup, timeout])
        if (token.isCancellationRequested || res === DEF_TIMEOUT) return undefined
        target = toTarget(res)
      }
      if (!target) return undefined
      // Cheap in-memory guard before touching any document: no records for
      // the target file → no hover, no disk read (spec §7 perf budget).
      const targetRoot = ctx.rootFor(target.uri)
      const targetPath = targetRoot ? ctx.sourcePathOf(target.uri) : null
      if (!targetRoot || !targetPath) return undefined
      const state = targetRoot.store.stateFor(targetPath)
      if (!state || state.current.length === 0) return undefined
      const targetUriStr = target.uri.toString()
      let targetDoc =
        targetUriStr === doc.uri.toString()
          ? doc
          : vscode.workspace.textDocuments.find((d) => d.uri.toString() === targetUriStr)
      if (!targetDoc) {
        // One-time read of a file known to carry records; VS Code caches the
        // TextDocument and the pipeline caches its status afterwards.
        try {
          targetDoc = await vscode.workspace.openTextDocument(target.uri)
        } catch {
          return undefined
        }
        if (token.isCancellationRequested) return undefined
      }
      const tStatus = await pipeline.statusFor(targetDoc)
      if (tStatus.entries.length === 0) return undefined
      let tSpan: [number, number] = [target.range.start.line + 1, target.range.end.line + 1]
      if (target.identifierOnly) {
        tSpan = callTargetSpan(tSpan, true, await documentSymbols(targetDoc.uri))
        if (token.isCancellationRequested) return undefined
      }
      const hits = coveringEntries(tStatus.entries, tSpan)
      if (hits.length === 0) return undefined
      const md = new vscode.MarkdownString(
        callSiteMd(
          hits.map((e) => ({
            authorName: e.record.author.name,
            status: e.res.status,
            createdAt: e.record.createdAt,
          })),
          new Date().toISOString(),
        ),
      )
      return new vscode.Hover(md)
      // NOTE: never call executeHoverProvider here — infinite recursion.
    },
  }
  context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file' }, provider))
}
