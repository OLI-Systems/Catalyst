// Catalyst Guard: holds a destructive shell command until the person confirms it.
//
// Catalyst runs several agents side by side, often with permissions relaxed so
// they can work unattended. That is exactly when one stray `git reset --hard`
// or `rm -rf` costs the most. This mod sits on the shell tools (Bash and, on
// Windows, PowerShell) and, for the handful of commands that throw work away,
// asks first through Claude Code's own question dialog. The dialog is the
// engine's, so it works in every permission mode, bypass included, and the
// hook's time budget does not run while it is open.
//
// Headless runs (`claude -p`, the SDK) have nobody to ask; there the command is
// left to the session's own permission rules rather than refused outright.

import type { EngineInterface, Register } from 'claude-code'

type Risk = { kind: string; label: string; why: string }

const RUN = 'Run it'
const RUN_ALL = 'Allow for this session'
const STOP = "Don't run it"

// Kinds the person has allowed for the rest of the session. A module variable
// on purpose: a reload (or a new session) asks again.
const allowed = new Set<string>()

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await review($, String(e.command ?? ''))
    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => failClosed(String(e.command ?? ''), () => next(e)))
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const deny = await review($, commandOf(e))
    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => failClosed(commandOf(e), () => next(e)))
}

function commandOf(e: unknown): string {
  return String((e as { command?: unknown }).command ?? '')
}

// A guard that broke must not wave the command it was guarding through: the
// engine would otherwise skip the failed hook and run the call.
function failClosed<T>(command: string, run: () => T): T | { deny: string } {
  const risk = classify(command)
  return risk === null
    ? run()
    : { deny: `Catalyst Guard could not confirm this command with the user, so it was not run (${risk.label}: ${risk.why}) Ask the user to run it themselves if it is needed.` }
}

// null to let the command run, or the reason the model reads when it does not.
async function review($: EngineInterface, command: string): Promise<string | null> {
  const risk = classify(command)
  if (risk === null || allowed.has(risk.kind)) {
    return null
  }
  if ((await $.session.surfaces()).length === 0) {
    return null
  }

  const facts = await measure($, risk)
  const shown = command.length > 160 ? `${command.slice(0, 157)}...` : command
  const question = `Claude wants to run a destructive command: ${shown} — ${risk.why}${facts ? ` ${facts}` : ''} Run it?`

  let answer: string
  try {
    answer = await $.ui.ask(question, { header: 'Guard', options: [RUN, RUN_ALL, STOP] })
  } catch {
    return `Catalyst Guard held this command and did not run it: the question was dismissed. ${risk.label}: ${risk.why} Do not retry it unless the user asks you to.`
  }

  if (answer === RUN) {
    return null
  }
  if (answer === RUN_ALL) {
    allowed.add(risk.kind)
    $.ui.toast(`Guard: ${risk.label} allowed for this session`)
    return null
  }
  if (answer === STOP) {
    return `Catalyst Guard: the user chose not to run this command (${risk.label}). Do not retry it unless the user asks you to; find another way or ask them.`
  }
  // Free text typed under "Other": the person's own instruction.
  return `Catalyst Guard: the user did not run this command and said: "${answer}"`
}

// ---- What counts as destructive ---------------------------------------------

// Split on shell separators; quoting is not honoured, which errs on the side of
// asking (a separator inside quotes only ever adds a segment to inspect).
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map(s => s.trim().replace(/^[({]+\s*/, ''))
    .filter(Boolean)
}

function words(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  // Leading env assignments and wrappers do not change what runs.
  while (out.length > 0) {
    const w = out[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || ['sudo', 'command', 'exec', 'env', 'nohup', 'time', '&', '.'].includes(w)) {
      out.shift()
    } else {
      break
    }
  }
  return out
}

const POSIX_RM = new Set(['rm'])
// PowerShell's Remove-Item and its aliases, plus cmd's own.
const PS_REMOVE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'])

export function classify(command: string): Risk | null {
  for (const segment of segments(command)) {
    const risk = classifySegment(segment)
    if (risk !== null) {
      return risk
    }
  }
  return null
}

function classifySegment(segment: string): Risk | null {
  const w = words(segment)
  const first = (w[0] ?? '').replace(/^\\/, '').replace(/\.exe$/i, '')
  const cmd = first.toLowerCase().split(/[\\/]/).pop() ?? ''
  const args = w.slice(1)
  const lower = args.map(a => a.toLowerCase())

  if (POSIX_RM.has(cmd) || PS_REMOVE.has(cmd)) {
    const isPosixRecursive = args.some(a => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a))
    const isPosixForce = args.some(a => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))
    const isPsRecursive = lower.some(a => /^-rec(u(r(s(e)?)?)?)?$/.test(a))
    const isPsForce = lower.some(a => a === '-force' || a === '-fo' || a === '-forc')
    const isCmdRecursive = lower.some(a => a === '/s')
    if (isPosixRecursive || isPosixForce || isPsRecursive || isPsForce || isCmdRecursive) {
      const targets = args.filter(a => !a.startsWith('-') && !/^\/[a-zA-Z]$/.test(a))
      return { kind: 'delete', label: `${first} ${targets.join(' ')}`.trim(), why: 'it deletes files recursively or forcibly, and they do not go to the recycle bin.' }
    }
  }

  if (cmd === 'find' && lower.includes('-delete')) {
    return { kind: 'delete', label: 'find -delete', why: 'it deletes every file it matches.' }
  }

  if (cmd === 'git') {
    let i = 0
    while (i < args.length && args[i]!.startsWith('-')) {
      i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
    }
    const sub = args[i] ?? ''
    const rest = args.slice(i + 1)
    if (sub === 'reset' && rest.includes('--hard')) {
      return { kind: 'git-reset', label: 'git reset --hard', why: 'it discards every uncommitted change.' }
    }
    if (sub === 'clean' && rest.some(a => a === '--force' || /^-[a-zA-Z]*f/.test(a)) && !rest.some(a => a === '--dry-run' || /^-[a-zA-Z]*n/.test(a))) {
      return { kind: 'git-clean', label: 'git clean', why: 'it deletes untracked files, which git cannot bring back.' }
    }
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('--mirror') || /^\+/.test(a))) {
      return { kind: 'git-push-force', label: 'git push --force', why: 'it rewrites the remote branch and can drop other people\'s commits.' }
    }
    if (sub === 'push' && rest.some(a => a === '--delete' || a === '-d' || /^:[^:]/.test(a))) {
      return { kind: 'git-push-delete', label: 'git push --delete', why: 'it deletes a branch or tag on the remote.' }
    }
    if ((sub === 'checkout' || sub === 'restore') && (rest.includes('.') || rest.includes(':/')) && !(sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree'))) {
      return { kind: 'git-discard', label: `git ${sub} .`, why: 'it discards every unstaged change in the working tree.' }
    }
    if (sub === 'branch' && rest.some(a => a === '-D' || (a === '--delete' && rest.includes('--force')))) {
      return { kind: 'git-branch-delete', label: 'git branch -D', why: 'it deletes a branch even if its commits were never merged.' }
    }
    if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) {
      return { kind: 'git-stash-drop', label: `git stash ${rest[0]}`, why: 'it throws stashed work away.' }
    }
  }

  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(segment)) {
    return { kind: 'sql-drop', label: 'DROP / TRUNCATE', why: 'it destroys database data.' }
  }
  if (cmd === 'format-volume' || cmd === 'clear-disk' || cmd === 'mkfs' || cmd.startsWith('mkfs.') || (cmd === 'dd' && lower.some(a => a.startsWith('of=/dev/')))) {
    return { kind: 'disk', label: cmd, why: 'it overwrites a disk or volume.' }
  }
  return null
}

// ---- Facts for the question --------------------------------------------------

// A short, measured sentence on what would be lost, or '' when there is nothing
// cheap and reliable to say. Never throws: the question still gets asked.
async function measure($: EngineInterface, risk: Risk): Promise<string> {
  try {
    const cwd = await $.session.cwd()
    if (risk.kind === 'git-reset' || risk.kind === 'git-discard' || risk.kind === 'git-clean') {
      const run = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 8000 })
      if (run.exitCode !== 0) {
        return ''
      }
      const rows = run.stdout.split('\n').filter(l => l.length > 3)
      const untracked = rows.filter(l => l.startsWith('??')).length
      const changed = rows.length - untracked
      if (risk.kind === 'git-clean') {
        return untracked === 0 ? 'There are no untracked files right now.' : `${untracked} untracked ${untracked === 1 ? 'path' : 'paths'} would go.`
      }
      return changed === 0 ? 'There are no uncommitted changes right now.' : `${changed} ${changed === 1 ? 'file has' : 'files have'} uncommitted changes.`
    }
  } catch {
    // fall through
  }
  return ''
}
