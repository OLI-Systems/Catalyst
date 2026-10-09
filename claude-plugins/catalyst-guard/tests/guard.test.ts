import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/register'

describe('classify', () => {
  const risky: Array<[string, string]> = [
    ['rm -rf build', 'delete'],
    ['cd sub && rm -r dist', 'delete'],
    ['sudo rm -f /tmp/x', 'delete'],
    ['Remove-Item -Recurse -Force .\out', 'delete'],
    ['ri .\out -rec', 'delete'],
    ['rd /s /q out', 'delete'],
    ['find . -name "*.log" -delete', 'delete'],
    ['git reset --hard HEAD~1', 'git-reset'],
    ['git -C ../other reset --hard', 'git-reset'],
    ['git clean -fdx', 'git-clean'],
    ['git push --force origin main', 'git-push-force'],
    ['git push origin +main', 'git-push-force'],
    ['git push --force-with-lease', 'git-push-force'],
    ['git push origin --delete feature', 'git-push-delete'],
    ['git checkout -- .', 'git-discard'],
    ['git restore .', 'git-discard'],
    ['git branch -D topic', 'git-branch-delete'],
    ['git stash clear', 'git-stash-drop'],
    ['psql -c "DROP TABLE users"', 'sql-drop'],
  ]
  for (const [command, kind] of risky) {
    test(`holds: ${command}`, async () => {
      expect(classify(command)?.kind).toBe(kind)
    })
  }

  const safe = [
    'ls -la',
    'rm notes.txt',
    'git status',
    'git push origin main',
    'git clean -n',
    'git clean -fdn',
    'git restore --staged .',
    'git checkout main',
    'git branch -d merged',
    'npm run build',
    'Remove-Item .\one-file.txt',
    'echo "rm -rf is dangerous"',
  ]
  for (const command of safe) {
    test(`lets through: ${command}`, async () => {
      expect(classify(command)).toBeNull()
    })
  }
})

describe('guard', () => {
  test('a safe command runs without a question', async ($, on) => {
    let asked = 0
    on('session.surfaces', () => ({ value: ['terminal'] as const }))
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked += 1
      return { result: {} as never }
    })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } as never }))
    const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(ran.deny).toBeUndefined()
    expect(asked).toBe(0)
  })

  for (const [answer, runs] of [["Don't run it", false], ['Run it', true]] as const) {
    test(`a destructive command waits for the answer: ${answer}`, async ($, on) => {
      let ran = 0
      on('session.surfaces', () => ({ value: ['terminal'] as const }))
      on('session.cwd', () => ({ value: '/repo' }))
      on('process.run', () => ({ value: { exitCode: 0, stdout: ' M a.ts\n M b.ts\n?? c.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
      on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
        const q = (e as unknown as { questions: Array<{ question: string }> }).questions[0]!.question
        expect(q).toContain('git reset --hard')
        expect(q).toContain('2 files have uncommitted changes')
        return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q]: answer } } as never }
      })
      on('tool.call', { tool: 'Bash' }, () => {
        ran += 1
        return { result: { stdout: '', stderr: '', interrupted: false } as never }
      })
      const result = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as never)
      expect(ran).toBe(runs ? 1 : 0)
      expect(result.deny === undefined && result.isError !== true).toBe(runs)
    })
  }

  test('headless sessions are left to their own permission rules', async ($, on) => {
    let ran = 0
    on('session.surfaces', () => ({ value: [] }))
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: '', stderr: '', interrupted: false } as never }
    })
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
    expect(ran).toBe(1)
  })

  test('a destructive command is refused when the guard itself fails', async ($, on) => {
    let ran = 0
    on('session.surfaces', () => {
      throw new Error('boom')
    })
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: '', stderr: '', interrupted: false } as never }
    })
    const result = await $.tool.call({ tool: 'Bash', command: 'git push --force' } as never)
    expect(ran).toBe(0)
    expect(result.deny).toContain('could not confirm')
  })
})
