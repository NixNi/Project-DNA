/**
 * Project DNA — OpenCode TUI Notification Service
 * Dispatches visual toast notifications to the user interface via OpenCode SDK.
 */

export interface ToastOptions {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

export interface IClientWithTui {
  tui?: {
    showToast?: (options: {
      body: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
    }) => Promise<unknown>
  }
}

export class PluginNotifier {
  constructor(private client?: IClientWithTui) {}

  /**
   * Dispatches a toast notification to OpenCode TUI if available,
   * falling back to standard console logging.
   */
  public async notify(options: ToastOptions): Promise<void> {
    const variant = options.variant ?? "info"
    const title = options.title ? `[Project DNA] ${options.title}` : "[Project DNA]"
    const duration = options.duration ?? 4000

    if (this.client?.tui?.showToast) {
      try {
        await this.client.tui.showToast({
          body: {
            title,
            message: options.message,
            variant,
            duration,
          },
        })
        return
      } catch {
        // Fall back to console if TUI call fails
      }
    }

    // Console fallback
    const logPrefix = `[Project DNA Notification: ${variant.toUpperCase()}]`
    if (variant === "error") {
      console.error(`${logPrefix} ${title}: ${options.message}`)
    } else if (variant === "warning") {
      console.warn(`${logPrefix} ${title}: ${options.message}`)
    } else {
      console.log(`${logPrefix} ${title}: ${options.message}`)
    }
  }

  /**
   * Convenience method when a new LiveTool is synthesized or registered
   */
  public async notifyToolCreated(
    toolName: string,
    mode: "synthesized" | "registered"
  ): Promise<void> {
    await this.notify({
      title: mode === "synthesized" ? "LiveTool Synthesized" : "LiveTool Registered",
      message: `Tool '${toolName}' is verified and ready for execution.`,
      variant: "success",
      duration: 5000,
    })
  }

  /**
   * Convenience method when a procedural LiveSkill is harvested and active
   */
  public async notifySkillHarvested(
    skillName: string,
    confidenceScore: number
  ): Promise<void> {
    await this.notify({
      title: "LiveSkill Harvested",
      message: `Skill '${skillName}' distilled and activated (confidence: ${(
        confidenceScore * 100
      ).toFixed(0)}%).`,
      variant: "success",
      duration: 5000,
    })
  }
}
