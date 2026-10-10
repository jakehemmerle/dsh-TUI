/**
 * OMP adapter: `~/.omp/agent/sessions/<munged-cwd>/<timestamp>_<id>.jsonl`.
 * OMP is a pi fork and keeps pi's session layout and format (plus its own
 * `title` rows and `developer` messages), so it is built and parsed by the
 * pi adapter (see pi.ts).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/omp
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { piLineageAdapter } from './pi.js'

export const ompAdapter = piLineageAdapter('omp', 'OMP', () => [join(homedir(), '.omp', 'agent', 'sessions')])
