import { tool } from '@opencode-ai/plugin/tool'
import { z } from 'zod'

export const fibonacci = tool({
  name: 'fibonacci',
  description:
    'Computes the nth Fibonacci number (F(0)=0, F(1)=1) using an iterative BigInt algorithm to avoid integer overflow. Optionally returns the full sequence up to n.',
  args: {
    n: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .describe('Zero-based index of the Fibonacci number to compute (0..1000).'),
    fullSequence: z
      .boolean()
      .optional()
      .describe('When true, also returns the entire sequence from F(0) through F(n).')
  },
  execute: async (args) => {
    const n = args.n
    const full = args.fullSequence ?? false

    if (n === 0) {
      return {
        output: JSON.stringify(
          full ? { n, value: '0', sequence: ['0'] } : { n, value: '0' }
        )
      }
    }

    let a = 0n
    let b = 1n
    const seq = full ? ['0', '1'] : []

    for (let i = 2; i <= n; i++) {
      const next = a + b
      a = b
      b = next
      if (full) seq.push(next.toString())
    }

    const value = b.toString()
    return {
      output: JSON.stringify(full ? { n, value, sequence: seq } : { n, value })
    }
  }
})