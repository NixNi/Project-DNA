import { access, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tool } from '@opencode-ai/plugin/tool'
import { z } from 'zod'

const API = 'https://api.github.com'

type HttpResult = { status: number; data: any; rateRemaining: string | null }

async function fetchJson(url: string, token: string | null): Promise<HttpResult> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'project-dna-live-tool',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { headers })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return {
    status: res.status,
    data,
    rateRemaining: res.headers.get('x-ratelimit-remaining'),
  }
}

async function findGitRoot(start: string): Promise<string | null> {
  let dir = start
  for (;;) {
    try {
      await access(join(dir, '.git'))
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
}

async function readGitConfig(repoRoot: string): Promise<string> {
  let gitDir = join(repoRoot, '.git')
  try {
    const content = await readFile(gitDir, 'utf8')
    const m = content.match(/^gitdir:\s*(.+)$/m)
    if (m) {
      const target = m[1].trim()
      gitDir = target.startsWith('/') ? target : join(repoRoot, target)
    }
  } catch {
    // .git is a directory (standard layout); gitDir is already correct
  }
  try {
    return await readFile(join(gitDir, 'config'), 'utf8')
  } catch {
    return ''
  }
}

function parseRemoteUrl(config: string): string | null {
  const lines = config.split(/\r?\n/)
  let inOrigin = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\[/.test(line)) {
      inOrigin = /\[remote\s+("origin"|'origin'|origin)\]/.test(line)
    } else if (inOrigin && /^url\s*=/.test(line)) {
      const m = line.match(/^url\s*=\s*(.+)$/)
      if (m) return m[1].trim()
    }
  }
  return null
}

function remoteToSlug(remote: string): string | null {
  const idx = remote.indexOf('github.com')
  if (idx === -1) return null
  const rest = remote.slice(idx + 'github.com'.length)
  const m = rest.match(/^[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

type PullRef = { number: number; title: string; state?: string; draft?: boolean; login?: string; base?: string; head?: string; headSha?: string; headRepo?: string; url?: string }

export const git_pr_status = tool({
  name: 'git_pr_status',
  description:
    'Reports pull request status for a local git repository over the GitHub REST API. Locates the repo root by walking up from repoPath, reads remote origin from .git/config, derives the owner/repo slug, and lists open PRs with author, base/head refs, draft state, and headline. Optional watch mode also reports CI check-run status per PR. Honors the GITHUB_TOKEN environment variable for private repos and higher rate limits.',
  args: {
    repoPath: z.string().optional().describe('Path inside the git repository. Defaults to the current working directory.'),
    all: z.boolean().default(false).describe('List all open PRs. When GITHUB_TOKEN is set, defaults to only your PRs; set true to list everyone\u2019s.'),
    watch: z.boolean().default(false).describe('Include CI check-run status for each open pull request.'),
    includeClosed: z.boolean().default(false).describe('Also include recently merged/closed pull requests.'),
  },
  execute: async (args: any) => {
    const start = args.repoPath ?? process.cwd()
    const repoRoot = await findGitRoot(start)
    if (!repoRoot) {
      return { output: `ERROR: '${start}' is not inside a git repository.`, ok: false }
    }

    const config = await readGitConfig(repoRoot)
    const remote = parseRemoteUrl(config)
    if (!remote) {
      return { output: 'ERROR: no remote "origin" found in .git/config. Add one with: git remote add origin <url>', ok: false }
    }

    const slug = remoteToSlug(remote)
    if (!slug) {
      return { output: `ERROR: could not derive a github.com owner/repo slug from remote URL: ${remote}`, ok: false }
    }

    const token = process.env.GITHUB_TOKEN ?? null

    const state = args.includeClosed ? 'all' : 'open'
    const pullsRes = await fetchJson(`${API}/repos/${slug}/pulls?state=${state}&sort=created&direction=desc&per_page=25`, token)
    if (pullsRes.status === 404) {
      return { output: `ERROR: repository '${slug}' not found or is private (no GITHUB_TOKEN set).`, ok: false }
    }
    if (!pullsRes.data || !Array.isArray(pullsRes.data)) {
      const rate = pullsRes.rateRemaining ? ` (rate-limit remaining: ${pullsRes.rateRemaining})` : ''
      return { output: `ERROR: GitHub API returned HTTP ${pullsRes.status}${rate}\n\nBody: ${JSON.stringify(pullsRes.data ?? '')?.slice(0, 300)}`, ok: false }
    }

    let pulls = (pullsRes.data as any[]).map((p): PullRef => ({
      number: p.number,
      title: p.title ?? '(no title)',
      state: p.state,
      draft: Boolean(p.draft),
      login: p.user?.login,
      base: p.base?.ref,
      head: p.head?.ref,
      headSha: p.head?.sha,
      headRepo: p.head?.repo?.full_name ?? slug,
      url: p.html_url,
    }))

    if (!args.all && token) {
      const userRes = await fetchJson(`${API}/user`, token)
      const me = userRes.data?.login
      if (me) pulls = pulls.filter((p) => p.login === me)
    }

    if (!args.watch) {
      const lines = pulls.map((p) => {
        const draft = p.draft ? ' [draft]' : ''
        const stateTag = args.includeClosed && p.state !== 'open' ? ` [${p.state}]` : ''
        return `#${p.number} ${p.title} (${p.login ?? 'unknown'}) ${p.base ?? '?'} <-- ${p.head ?? '?'}${draft}${stateTag}`
      })
      return {
        output: lines.length ? lines.join('\n') : 'No pull requests found.',
        ok: true,
        repo: slug,
        count: pulls.length,
        authed: Boolean(token),
      }
    }

    const rows: string[] = []
    for (const p of pulls) {
      const checkRes = await fetchJson(`${API}/repos/${p.headRepo}/commits/${p.headSha}/check-runs`, token)
      let summary = 'checks: unknown'
      if (checkRes.data && Array.isArray(checkRes.data.check_runs)) {
        const runs = checkRes.data.check_runs as Array<{ name?: string; status?: string; conclusion?: string }>
        const success = runs.filter((r) => r.conclusion === 'success').length
        const failure = runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out').length
        const pending = runs.length - success - failure
        summary = `checks: success=${success} failure=${failure} pending=${pending}`
      }
      rows.push(`#${p.number} ${p.title} (${p.login ?? 'unknown'}) ${p.base ?? '?'} <-- ${p.head ?? '?'}${p.draft ? ' [draft]' : ''}\n  ${summary}`)
    }

    return {
      output: rows.length ? rows.join('\n') : 'No pull requests found.',
      ok: true,
      repo: slug,
      count: pulls.length,
      authed: Boolean(token),
      rateRemaining: pullsRes.rateRemaining,
    }
  },
})