/**
 * Static AST & Security Policy Validator for LiveTools
 * Enforces sandboxing rules on agent-synthesized tool implementations before execution.
 */

export interface ASTValidationResult {
  valid: boolean
  violations: string[]
}

export class ASTValidator {
  private static FORBIDDEN_PATTERNS: Array<{ regex: RegExp; message: string }> = [
    {
      regex: /\beval\s*\(/,
      message: "Dynamic code execution via eval() is strictly forbidden.",
    },
    {
      regex: /\bnew\s+Function\s*\(/,
      message: "Dynamic code execution via new Function() is strictly forbidden.",
    },
    {
      regex: /\bprocess\.exit\s*\(/,
      message: "Process termination via process.exit() is forbidden in tool runtime.",
    },
    {
      regex: /\bprocess\.kill\s*\(/,
      message: "Process killing via process.kill() is forbidden.",
    },
    {
      regex: /__proto__|prototype\s*\[/,
      message: "Prototype modification or pollution attempt detected.",
    },
    {
      regex: /require\s*\(\s*['"]child_process['"]\s*\)\.execSync/,
      message: "Unchecked synchronous shell execution via execSync is forbidden.",
    },
  ]

  /**
   * Validates TypeScript/JavaScript tool source code against security policies
   */
  public static validate(sourceCode: string): ASTValidationResult {
    const violations: string[] = []

    for (const rule of this.FORBIDDEN_PATTERNS) {
      if (rule.regex.test(sourceCode)) {
        violations.push(rule.message)
      }
    }

    // Check that tool imports tool from @opencode-ai/plugin/tool
    if (!sourceCode.includes("@opencode-ai/plugin/tool") && !sourceCode.includes("tool(")) {
      violations.push(
        "Tool implementation must import and use tool() from '@opencode-ai/plugin/tool'."
      )
    }

    // Check that zod is imported
    if (!sourceCode.includes("zod")) {
      violations.push("Tool implementation must import and use 'zod' for arguments validation.")
    }

    return {
      valid: violations.length === 0,
      violations,
    }
  }
}
