const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const WORKTREE_DIR = '.catalyst-worktrees';
const BRANCH_NAME_RE = /^[a-zA-Z0-9._\/-]+$/;

function git(args, cwd) {
  return execFileAsync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}

/**
 * Create a git worktree for an isolated session.
 * @param {string} repoPath - The main repo directory
 * @param {string} [branchName] - Branch name; auto-generated if omitted
 * @returns {Promise<{ worktreePath: string, branch: string }>}
 */
async function createWorktree(repoPath, branchName) {
  const worktreeBase = path.join(repoPath, WORKTREE_DIR);
  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  }

  // Add .catalyst-worktrees to .gitignore if not already present
  const gitignorePath = path.join(repoPath, '.gitignore');
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (!existing.includes(WORKTREE_DIR)) {
      const newline = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(gitignorePath, `${newline}${WORKTREE_DIR}/\n`);
    }
  } catch {
    // Non-critical — skip if .gitignore can't be updated
  }

  if (!branchName) {
    const short = crypto.randomUUID().slice(0, 8);
    branchName = `catalyst-${short}`;
  }

  if (!BRANCH_NAME_RE.test(branchName) || branchName.includes('..')) {
    throw new Error('Invalid branch name. Only letters, numbers, dots, underscores, slashes, and hyphens are allowed.');
  }

  const worktreePath = path.join(worktreeBase, branchName);
  // Slashes in branch names nest directories — make sure they can't escape the worktree base
  const resolved = path.resolve(worktreePath);
  if (!resolved.startsWith(path.resolve(worktreeBase) + path.sep)) {
    throw new Error('Invalid branch name.');
  }

  try {
    await git(['worktree', 'add', '-b', branchName, worktreePath], repoPath);
  } catch (err) {
    // Branch may already exist; try without -b
    try {
      await git(['worktree', 'add', worktreePath, branchName], repoPath);
    } catch (err2) {
      throw new Error(`Failed to create worktree: ${err2.message}`);
    }
  }

  return { worktreePath, branch: branchName };
}

/**
 * Remove a git worktree.
 * @param {string} repoPath - The main repo directory
 * @param {string} worktreePath - The worktree path to remove
 */
async function removeWorktree(repoPath, worktreePath) {
  try {
    await git(['worktree', 'remove', worktreePath, '--force'], repoPath);
  } catch {
    // If git worktree remove fails, try manual cleanup
    try {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
      await git(['worktree', 'prune'], repoPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * List all git worktrees for a repo.
 * @param {string} repoPath - The main repo directory
 * @returns {Promise<Array<{ path: string, head: string, branch: string }>>}
 */
async function listWorktrees(repoPath) {
  try {
    const { stdout: output } = await git(['worktree', 'list', '--porcelain'], repoPath);

    const worktrees = [];
    let current = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
      } else if (line.trim() === '' && current.path) {
        worktrees.push(current);
        current = {};
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees;
  } catch {
    return [];
  }
}

module.exports = { createWorktree, removeWorktree, listWorktrees };
