/**
 * Pi adapter: `~/.pi/agent/sessions/--<munged-cwd>--/<timestamp>_<id>.jsonl`.
 * `PI_CODING_AGENT_SESSION_DIR` relocates the session store and
 * `PI_CODING_AGENT_DIR` the whole agent directory, as in pi itself.
 *
 * OMP keeps the same layout and format, so {@link piLineageAdapter} builds
 * both adapters; the format is parsed by the pure pi.parse.ts. Only files
 * directly inside a project directory are conversations: OMP keeps a
 * session's sub-agent logs in a directory beside the file (`<session>/<task>.jsonl`),
 * one level deeper, and those belong to their parent session. The browse scan
 * runs the same parser over the file's head, plus a tail window for a title
 * set later in the session.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/pi
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { normalizeTitle } from '../parse/title.js'
import type { ForeignSessionSummary, LoadSkip, MigrationAdapter, MigrationDiscovery, MigrationSession, ScanOptions, WalkSpec } from '../types.js'
import { latestOwnTitle, parsePiSession } from './pi.parse.js'
import { countEntries } from './scan.js'
import { MAX_ARTIFACT_BYTES, fingerprintOf, loadText, readTail, runScan, walkFiles, withHead, type ScanCandidate } from './scan-fs.js'

const WALK: WalkSpec = { maxDepth: 1, match: name => name.endsWith('.jsonl') }

/** Tail window searched for a title set after the head. */
const TITLE_TAIL_BYTES = 64 * 1024

/** The session's stable source id: the id after the timestamp in its file name. */
function sourceIdOf(path: string): string {
  // basename(): join() is `\`-separated on Windows, where split('/') returned
  // the whole path and the fallback id stopped being stable across moves.
  const file = basename(path)
  return /^[\dT:.Z-]*_([0-9a-zA-Z-]+)\.jsonl$/u.exec(file)?.[1] ?? file
}

/**
 * A migration adapter for a store in pi's session format.
 * @param id - Adapter id (the `dsh-tui migrate <agent>` argument).
 * @param label - Display name.
 * @param roots - Session store roots, resolved when scanned.
 */
export function piLineageAdapter(id: string, label: string, roots: () => readonly string[]): MigrationAdapter {
  const summarize = async ({ ref, fp }: ScanCandidate): Promise<ForeignSessionSummary | null> => {
    const sourceId = sourceIdOf(ref)
    const found = await withHead(ref, fp.size, (raw, whole) => {
      const session = parsePiSession({ raw, sourceId })
      return session === undefined ? undefined : { session, whole }
    })
    if (found === undefined) return null
    const { session, whole } = found
    const later = whole ? undefined : latestOwnTitle(await readTail(ref, TITLE_TAIL_BYTES, fp.size))
    return {
      agentId: id,
      sessionKey: session.sourceId,
      ref,
      title: later === undefined ? session.title ?? '' : normalizeTitle(later),
      cwd: session.cwd,
      lastMessageAt: fp.mtimeMs,
      createdAt: session.startedAt || fp.mtimeMs,
    }
  }

  return {
    id,
    label,
    roots,
    discover(): MigrationDiscovery {
      const scanned = roots()
      const sessions: MigrationSession[] = []
      const walk = (dir: string, depth: number): void => {
        if (depth > WALK.maxDepth) return
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(path, depth + 1)
            continue
          }
          if (!entry.isFile() || !WALK.match(entry.name)) continue
          let raw
          try {
            if (statSync(path).size > MAX_ARTIFACT_BYTES) continue
            raw = readFileSync(path, 'utf8')
          } catch {
            continue
          }
          const session = parsePiSession({ raw, sourceId: sourceIdOf(path) })
          if (session !== undefined) sessions.push(session)
        }
      }
      for (const root of scanned) walk(root, 0)
      return { roots: scanned, sessions }
    },
    count(): number {
      return countEntries(roots(), { maxDepth: WALK.maxDepth, fileMatch: WALK.match })
    },
    walk: WALK,
    async scan(options?: ScanOptions) {
      const files = walkFiles(roots(), { ...WALK, signal: options?.signal })
      return runScan(files, file => file.path, fingerprintOf, options, summarize)
    },
    async load(ref: string): Promise<MigrationSession | LoadSkip> {
      const raw = await loadText(ref)
      if (typeof raw !== 'string') return raw
      return parsePiSession({ raw, sourceId: sourceIdOf(ref) }) ?? { skip: 'not-a-session' }
    },
  }
}

export const piAdapter = piLineageAdapter('pi', 'Pi', () => {
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (sessionDir !== undefined && sessionDir !== '') return [sessionDir]
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
  return [join(agentDir !== undefined && agentDir !== '' ? agentDir : join(homedir(), '.pi', 'agent'), 'sessions')]
})
