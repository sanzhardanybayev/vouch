import * as vscode from 'vscode'
import { callSiteMd, rangeHoverMd, isValidSha, type HoverEntry } from '../core/hovermd'
import { commitUrl } from '../core/giturl'
import { overlaps } from '../core/attest'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { remoteUrl } from './gitinfo'

export function registerHovers(
  context: vscode.ExtensionContext, ctx: VouchContext, pipeline: StatusPipeline,
): void {
  const remoteCache = new Map<string, string | null>()
  const defCache = new Map<string, vscode.Location | null>()

  async function remoteFor(rootDir: string): Promise<string | null> {
    if (!remoteCache.has(rootDir)) remoteCache.set(rootDir, await remoteUrl(rootDir))
    return remoteCache.get(rootDir)!
  }

  const provider: vscode.HoverProvider = {
    async provideHover(doc, pos, token) {
      if (!ctx.roots.some(r => r.store.attestedFiles().length > 0)) return undefined
      const line = pos.line + 1

      // (a) range hover — records covering this line in THIS document
      const status = await pipeline.statusFor(doc)
      const covering = status.entries.filter(e =>
        e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line]))
      if (covering.length > 0) {
        const root = ctx.rootFor(doc.uri)!
        const remote = await remoteFor(root.rootDir)
        const entries: HoverEntry[] = covering.map(e => ({
          authorName: e.record.author.name,
          status: e.res.status,
          createdAt: e.record.createdAt,
          comment: e.record.comment,
          commit: e.record.commit,
          commitLink: e.record.commit && isValidSha(e.record.commit) && remote
            ? commitUrl(remote, e.record.commit) : null,
          recordId: e.record.id,
          supersedesCount: e.record.supersedes?.length,
        }))
        const md = new vscode.MarkdownString(rangeHoverMd(entries, new Date().toISOString()))
        // Only allowlist the exact command links rangeHoverMd emits — never
        // grant blanket isTrusted, since authorName/comment are attacker-
        // controlled text from other users' .vouch/ records.
        md.isTrusted = { enabledCommands: ['vouch.openTimeline', 'vouch.showDiff', 'vouch.reReview'] }
        return new vscode.Hover(md)
      }

      // (b) call-site hover — definition target's status (open docs only; spec §7)
      const key = `${doc.uri}:${pos.line}:${pos.character}:${doc.version}`
      let target = defCache.get(key)
      if (target === undefined) {
        const lookup = vscode.commands.executeCommand<
          (vscode.Location | vscode.LocationLink)[] | undefined
        >('vscode.executeDefinitionProvider', doc.uri, pos)
        // If the timeout wins the race, `lookup` keeps running in the
        // background; guard it so a late rejection can't surface as an
        // unhandled promise rejection. (vscode's Thenable only has `.then`,
        // not `.catch`.)
        lookup.then(undefined, () => undefined)
        const timeout = new Promise<null>(r => setTimeout(() => r(null), 400))
        const res = await Promise.race([lookup, timeout])
        if (token.isCancellationRequested) return undefined
        const first = res?.[0]
        target = !first ? null
          : first instanceof vscode.Location ? first
          : new vscode.Location(first.targetUri, first.targetRange)
        defCache.set(key, target)
        if (defCache.size > 500) defCache.clear()
      }
      if (!target || target.uri.toString() === doc.uri.toString()) return undefined
      const targetDoc = vscode.workspace.textDocuments.find(
        d => d.uri.toString() === target!.uri.toString())
      if (!targetDoc) return undefined
      const tStatus = await pipeline.statusFor(targetDoc)
      const tLine: [number, number] =
        [target.range.start.line + 1, target.range.end.line + 1]
      const hits = tStatus.entries.filter(e =>
        e.record.kind === 'file' || overlaps(e.res.effectiveRange, tLine))
      if (hits.length === 0) return undefined
      const md = new vscode.MarkdownString(callSiteMd(hits.map(e => ({
        authorName: e.record.author.name, status: e.res.status, createdAt: e.record.createdAt,
      })), new Date().toISOString()))
      return new vscode.Hover(md)
      // NOTE: never call executeHoverProvider here — infinite recursion.
    },
  }
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, provider))
}
