/**
 * OpenCode LLM Reuse Bridge
 * Allows background synthesis (Tool Maker, Skill Distiller, Zettelkasten Link Gen)
 * to run via OpenCode's authenticated client session without requiring external API keys.
 */

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
    delete: (options: { path: { id: string } }) => Promise<unknown>
  }
}

export class OpenCodeLLMBridge {
  constructor(private client: IOpenCodeClientLike) {}

  /**
   * Prompts the user's configured model via a headless, non-intrusive sub-session
   */
  public async prompt(options: PromptOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 30000

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

    const sessionId = sessionRes.data.id

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
        setTimeout(
          () => reject(new Error(`LLM synthesis timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })

      const result = await Promise.race([promptPromise, timeoutPromise])

      // 4. Extract generated text
      const parts: any[] = result?.data?.parts ?? []
      const textPart = parts.find((p: any) => p.type === "text")
      return textPart?.text ?? ""
    } finally {
      // 5. Clean up background sub-session so user history stays completely clean
      try {
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
}
