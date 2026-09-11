import { tool } from '@opencode-ai/plugin/tool'
import { z } from 'zod'

export const word_count = tool({
  name: 'word_count',
  description:
    'Counts words, characters, and lines in a given text string, returning structured statistics.',
  args: {
    text: z
      .string()
      .describe('The text to analyze. Empty strings are allowed and return zero counts.')
  },
  execute: async (args) => {
    const text = args.text ?? ''
    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
    const characters = text.length
    const lines = text.length === 0 ? 0 : text.split(/\n/).length
    const charsNoSpaces = text.replace(/\s/g, '').length
    return {
      output: JSON.stringify({
        words,
        characters,
        charactersNoSpaces: charsNoSpaces,
        lines
      })
    }
  }
})