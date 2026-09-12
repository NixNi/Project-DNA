import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { git_pr_status } from "../src/git_pr_status.js"

describe('git_pr_status live tool', () => {
  it('exports a tool named git_pr_status', () => {
    assert.equal(git_pr_status.name, 'git_pr_status')
  })

  it('exposes args schema and execute function', () => {
    assert.ok(git_pr_status.args, 'args schema present')
    assert.equal(typeof git_pr_status.execute, 'function')
  })

  it('has repoPath, all, watch, includeClosed args', () => {
    const schema = git_pr_status.args as any
    for (const key of ['repoPath', 'all', 'watch', 'includeClosed']) {
      assert.ok(schema[key], `arg '${key}' present`)
    }
  })
})