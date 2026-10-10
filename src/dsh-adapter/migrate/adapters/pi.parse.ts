/**
 * Pi session parsing (pure): one `<timestamp>_<id>.jsonl` → one
 * {@link MigrationSession}. OMP writes the same format (it is a pi fork), so
 * both adapters share this parser.
 *
 * The first `session` row is the header (`cwd`, start time). Every other row
 * carries `id` / `parentId`: the rows form a tree, and the conversation is
 * the path from the last row back to the root — rows on an abandoned branch
 * are not part of it. Version-1 sessions (and fixtures) carry no ids and are
 * read in file order.
 *
 * `message` rows hold the model-visible history: `user` opens a turn,
 * `assistant` is one model call (text, `thinking`, `toolCall` blocks), and
 * `toolResult` pairs back by `toolCallId`. Harness context the model saw
 * without the human typing it — `custom_message` rows, OMP `developer`
 * messages, `branch_summary` rows — becomes inputs of the next model call. A
 * `compaction` row becomes a checkpoint in front of the next turn.
 *
 * Titles the source owns: OMP's `title` / `title_change` rows and pi's
 * `session_info` name; the latest in file order wins. Without one the first
 * prompt is the fallback.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/pi.parse
 */
import { isInjectedText, unwrapUserText } from '../parse/injection.js'
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { emptyStats } from '../parse/role-turns.js'
import { normalizeTitle } from '../parse/title.js'
import { CallIndex, IMAGE_PLACEHOLDER, closeToolPairs, newStep } from '../parse/tools.js'
import type { ImportBlock, ImportCompaction, ImportTurn, MigrationSession } from '../types.js'

/** What the adapter knows about a session file besides its text. */
export interface PiSessionInput {
  readonly raw: string
  /** The session's stable source id (the id in its file name). */
  readonly sourceId: string
}

/** Text of string content or of text/image block content (images as placeholders). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER)
    else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/** The human part of a user message: injected blocks dropped (and counted). */
function userPrompt(content: unknown): { text: string, dropped: number } {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const parts: string[] = []
  let dropped = 0
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      parts.push(IMAGE_PLACEHOLDER)
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      if (isInjectedText(block.text)) dropped += 1
      else parts.push(block.text)
    }
  }
  return { text: parts.join('\n\n').trim(), dropped }
}

/** The title a row sets, or undefined when the row sets none. */
function ownTitleOf(record: JsonRecord): string | undefined {
  if (record.type === 'title' || record.type === 'title_change') return typeof record.title === 'string' ? record.title.trim() : undefined
  if (record.type === 'session_info') return typeof record.name === 'string' ? record.name.trim() : ''
  return undefined
}

/**
 * The latest title the source set in a slice of a session file — what a
 * listing reads from the tail when the head window did not cover the file.
 * @returns The title, or undefined when the slice sets none.
 */
export function latestOwnTitle(raw: string): string | undefined {
  let title: string | undefined
  for (const record of parseJsonl(raw).records) {
    const own = ownTitleOf(record)
    if (own !== undefined && own !== '') title = own
  }
  return title
}

/** The rows of the active branch, root first. */
function activePath(records: readonly JsonRecord[]): readonly JsonRecord[] {
  const byId = new Map<string, JsonRecord>()
  let leaf: JsonRecord | undefined
  for (const record of records) {
    if (record.type === 'session' || typeof record.id !== 'string') continue
    byId.set(record.id, record)
    leaf = record
  }
  if (leaf === undefined) return records
  const path: JsonRecord[] = []
  // Bounded by the row count: a corrupt parent cycle ends the walk, not the scan.
  for (let row: JsonRecord | undefined = leaf; row !== undefined && path.length < byId.size; row = typeof row.parentId === 'string' ? byId.get(row.parentId) : undefined) {
    path.push(row)
  }
  return path.reverse()
}

/**
 * Parse one pi / OMP session file.
 * @returns The session, or undefined when it records no cwd or no prompt.
 */
export function parsePiSession(input: PiSessionInput): MigrationSession | undefined {
  const { records, badLines } = parseJsonl(input.raw)
  const stats = { ...emptyStats(), badLines }
  let cwd: string | undefined
  let startedAt = 0
  let headerTitle = ''
  let ownTitle = ''
  for (const record of records) {
    if (record.type === 'session') {
      // Only the first header describes this file.
      if (cwd !== undefined) continue
      cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
      startedAt = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || 0 : 0
      if (typeof record.title === 'string') headerTitle = record.title.trim()
      continue
    }
    const own = ownTitleOf(record)
    if (own !== undefined) ownTitle = own
  }

  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  let model: string | undefined
  let firstAt = 0
  const calls = new CallIndex()
  /** Model-visible context waiting for the next model call. */
  let pendingInputs: string[] = []
  /** A compaction summary waiting for the turn that follows the boundary. */
  let pendingCompaction: ImportCompaction | undefined

  const openTurn = (prompt: string): ImportTurn => {
    current = pendingCompaction === undefined ? { prompt, steps: [] } : { prompt, compaction: pendingCompaction, steps: [] }
    pendingCompaction = undefined
    turns.push(current)
    return current
  }
  const addInput = (text: string): void => {
    if (text === '') return
    pendingInputs.push(text)
    stats.meta += 1
  }

  const acceptMessage = (message: JsonRecord): void => {
    switch (message.role) {
      case 'user': {
        const { text, dropped } = userPrompt(message.content)
        stats.filtered += dropped
        if (text !== '') openTurn(text)
        return
      }
      case 'assistant': {
        if (typeof message.model === 'string' && message.model !== '') model = message.model
        const blocks: ImportBlock[] = []
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!isRecord(block)) continue
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            blocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
            blocks.push({ type: 'reasoning', text: block.thinking })
          } else if (block.type === 'toolCall' && typeof block.id === 'string' && block.id !== '') {
            const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown'
            blocks.push({ type: 'tool-call', id: block.id, name, arguments: JSON.stringify(block.arguments ?? {}) })
          }
        }
        const turn = blocks.length > 0 ? current ?? openTurn('') : current
        if (message.stopReason === 'aborted' && turn !== undefined) turn.aborted = true
        if (turn === undefined || blocks.length === 0) return
        const step = newStep(model)
        step.inputs = pendingInputs
        step.blocks = blocks
        pendingInputs = []
        turn.steps.push(step)
        calls.register(step)
        return
      }
      case 'toolResult':
        if (typeof message.toolCallId === 'string') calls.attach(message.toolCallId, contentText(message.content), message.isError === true)
        else calls.orphans += 1
        return
      // OMP writes harness reminders as developer messages; pi's in-memory
      // custom role is the same context.
      case 'developer':
      case 'custom':
        addInput(contentText(message.content))
        return
      // The system prompt and tool loadout: the resumed DSH session renders its own.
      case 'system':
        return
      // bashExecution (a `!command` the user ran) and roles of extensions.
      default:
        stats.filtered += 1
    }
  }

  for (const entry of activePath(records)) {
    if (firstAt === 0 && typeof entry.timestamp === 'string') firstAt = Date.parse(entry.timestamp) || 0
    switch (entry.type) {
      case 'message':
        if (isRecord(entry.message)) acceptMessage(entry.message)
        break
      case 'custom_message':
        addInput(contentText(entry.content))
        break
      case 'branch_summary':
        addInput(typeof entry.summary === 'string' ? entry.summary.trim() : '')
        break
      case 'compaction': {
        const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
        if (summary === '') break
        pendingCompaction = model === undefined ? { summary } : { summary, model }
        current = undefined
      }
    }
  }

  stats.filtered += pendingInputs.length
  if (pendingCompaction !== undefined) turns.push({ prompt: '', compaction: pendingCompaction, steps: [] })
  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0 || turn.compaction !== undefined)
  stats.droppedToolResults = calls.orphans + closeToolPairs(turns)
  if (cwd === undefined || !turns.some(turn => turn.prompt !== '')) return undefined
  const sourceTitle = ownTitle !== '' ? ownTitle : headerTitle
  const firstPrompt = turns.find(turn => turn.prompt !== '')!.prompt
  const title = normalizeTitle(sourceTitle !== '' ? sourceTitle : unwrapUserText(firstPrompt))
  return { sourceId: input.sourceId, cwd, ...(title === '' ? {} : { title }), titleExplicit: sourceTitle !== '', startedAt: startedAt || firstAt, turns, stats }
}
