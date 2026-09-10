/**
 * OpenCode LLM Reuse Bridge
 * Allows background synthesis (Tool Maker, Skill Distiller, Zettelkasten Link Gen)
 * to run via OpenCode's authenticated client session without requiring external API keys.
 */

import type { IOpenCodeLLMBridge } from "../../specs/contracts/opencode-plugin.js"

export interface PromptOptions {
  systemPrompt: string
  userPrompt: string
  useSmallModel?: boolean
  timeoutMs?: number
}

export interface IOpenCodeClientLike {
  config: {
    get: (options?: any) => Promise<{ data?: { model?: any; small_model?: any } } | any>
  }
  session: {
    create: (options: { body: { title?: string } }) => Promise<{ data?: { id?: string } } | any>
    prompt: (options: {
      path: { id: string }
      body: {
        model?: any
        system?: string
        parts: Array<{ type: "text"; text: string }>
      }
    }) => Promise<{ data?: { parts?: Array<{ type: string; text?: string }> } } | any>
    abort?: (options: { path: { id: string } }) => Promise<unknown>
    delete: (options: { path: { id: string } }) => Promise<unknown>
  }
}

export class OpenCodeLLMBridge implements IOpenCodeLLMBridge {
  constructor(
    private client: IOpenCodeClientLike,
    private defaultTimeoutMs: number = 120000
  ) {}

  /**
   * Prompts the user's configured model via a headless, non-intrusive sub-session
   */
  public async prompt(options: PromptOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs

    // 1. Fetch current OpenCode model configuration
    let configData: { model?: any; small_model?: any } | undefined
    try {
      const configRes = await this.client.config.get()
      configData = configRes?.data
    } catch {
      // If config retrieval fails, proceed with default server model
      configData = undefined
    }

    const targetModel =
      options.useSmallModel && configData?.small_model
        ? configData.small_model
        : configData?.model

    // 2. Create headless background sub-session
    const sessionRes = await this.client.session.create({
      body: {
        title: "dna:background-synthesis",
      },
    })

    const sessionId = sessionRes?.data?.id
    if (!sessionId) {
      throw new Error("Failed to create OpenCode background session for LLM synthesis")
    }

    let timeoutTimer: NodeJS.Timeout | undefined
    let timedOut = false

    try {
      // 3. Dispatch prompt with timeout
      const promptPromise = this.client.session.prompt({
        path: { id: sessionId },
        body: {
          model: targetModel,
          system: options.systemPrompt,
          parts: [{ type: "text", text: options.userPrompt }],
        },
      })

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true
          reject(new Error(`LLM synthesis timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      const result = await Promise.race([promptPromise, timeoutPromise])

      // 4. Extract generated text
      const parts: any[] = result?.data?.parts ?? []
      const textPart = parts.find((p: any) => p.type === "text")
      return textPart?.text ?? ""
    } catch (err) {
      if (timedOut && this.client.session.abort) {
        // Abort the running prompt stream inside OpenCode to prevent dangling writes to SQLite
        try {
          await this.client.session.abort({ path: { id: sessionId } })
        } catch {
          // Suppress abort error
        }
      }
      throw err
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      // 5. Clean up background sub-session so user history stays completely clean
      try {
        if (timedOut) {
          // Allow OpenCode server a small grace window (500ms) to finish aborting before cascading delete
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        await this.client.session.delete({ path: { id: sessionId } })
      } catch {
        // Suppress cleanup error to avoid masking synthesis result
      }
    }
  }

  /**
   * Prompts the model expecting a structured JSON response
   */
  public async promptJson<T = unknown>(options: PromptOptions): Promise<T> {
    const enhancedSystem = `${options.systemPrompt}\n\nIMPORTANT: You must output ONLY valid, raw JSON. Do not include markdown code blocks, backticks, or any extraneous explanation.`
    const rawText = await this.prompt({
      ...options,
      systemPrompt: enhancedSystem,
    })

    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()

    try {
      return JSON.parse(cleaned) as T
    } catch (err) {
      throw new Error(
        `Failed to parse JSON from LLM synthesis output: ${String(err)}\nRaw Output:\n${rawText}`
      )
    }
  }

  /**
   * Synthesize method matching IOpenCodeLLMBridge contract
   */
  public async synthesize(options: PromptOptions): Promise<string> {
    return this.prompt(options)
  }
}
