import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pr_status } from "../src/pr_status.js"

describe('pr_status live tool', () => {
  it('exports a tool named pr_status', () => {
    assert.equal(pr_status.name, 'pr_status')
  })

  it('exposes args schema and execute function', () => {
    assert.ok(pr_status.args, 'args schema present')
    assert.equal(typeof pr_status.execute, 'function')
  })

  it('has repoPath, all, watch, includeClosed args', () => {
    const schema = pr_status.args as any
    for (const key of ['repoPath', 'all', 'watch', 'includeClosed']) {
      assert.ok(schema[key], `arg '${key}' present`)
    }
  })
})