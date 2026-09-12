/**
 * Static AST & Security Policy Validator for LiveTools
 * Enforces sandboxing rules and detects developer capabilities using the TypeScript Compiler API.
 */

import ts from "typescript"
import type {
  ASTValidationReport,
  ToolPermission,
  ASTDiagnostic,
} from "../../specs/contracts/live-tools.js"
import {
  unwrapExpression,
  extractStaticString,
  isLiteralStringValue,
  getAccessedMemberName,
  getTargetOfMemberAccess,
  isRequireExpression,
  isFsObject,
} from "./ast/expression-utils.js"
import { CapabilityDetector } from "./ast/capability-detector.js"
import { SecurityPolicyEnforcer } from "./ast/security-policies.js"

export interface ASTValidatorOptions {
  strict?: boolean
}

export class ASTValidator {
  // Public static helpers preserved for backward compatibility
  public static unwrapExpression = unwrapExpression
  public static extractStaticString = extractStaticString
  public static isLiteralStringValue = isLiteralStringValue
  public static getAccessedMemberName = getAccessedMemberName
  public static getTargetOfMemberAccess = getTargetOfMemberAccess
  public static isRequireExpression = isRequireExpression
  public static isFsObject = isFsObject

  /**
   * Validates TypeScript/JavaScript tool source code against security policies and detects capabilities.
   */
  public static validate(
    sourceCode: string,
    options?: ASTValidatorOptions
  ): ASTValidationReport {
    const violations: string[] = []
    const diagnostics: ASTDiagnostic[] = []
    const isStrict = options?.strict === true

    const sourceFile = ts.createSourceFile(
      "synthesized-tool.ts",
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    )

    // Check for syntax parsing diagnostics
    const parseDiagnostics = (sourceFile as any).parseDiagnostics
    if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) {
      for (const diag of parseDiagnostics) {
        const msg = ts.flattenDiagnosticMessageText(diag.messageText, " ")
        violations.push(`Syntax error in tool implementation: ${msg}`)
        diagnostics.push({
          rule: "syntax-error",
          severity: "error",
          message: msg,
        })
      }
    }

    const capabilityDetector = new CapabilityDetector(isStrict, violations, diagnostics)
    const securityEnforcer = new SecurityPolicyEnforcer(violations, diagnostics)

    let hasPluginToolImport = false
    let hasToolCall = false
    let hasZodImport = false

    const checkModuleSpecifier = (specifier: string) => {
      const allowed = securityEnforcer.checkModuleSpecifier(specifier)
      if (allowed) {
        capabilityDetector.checkModuleSpecifier(specifier)
      }
    }

    const visit = (node: ts.Node) => {
      // 0. Prototype mutation checks
      if (ts.isBinaryExpression(node)) {
        securityEnforcer.checkBinaryExpression(node)
      }
      if (ts.isDeleteExpression(node)) {
        securityEnforcer.checkDeleteExpression(node)
      }
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        securityEnforcer.checkUnaryExpression(node)
      }

      // 1. Static Import Declarations
      if (ts.isImportDeclaration(node)) {
        if (
          ts.isStringLiteral(node.moduleSpecifier) ||
          ts.isNoSubstitutionTemplateLiteral(node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier.text
          if (spec === "@opencode-ai/plugin/tool") {
            hasPluginToolImport = true
          }
          if (spec === "zod") {
            hasZodImport = true
          }
          checkModuleSpecifier(spec)
          capabilityDetector.checkImportDeclaration(node)
        }
      }

      // 1.5 Variable Declarations with require('fs')
      if (ts.isVariableDeclaration(node)) {
        capabilityDetector.checkVariableDeclaration(node)
      }

      // 2. Call Expressions
      if (ts.isCallExpression(node)) {
        const expr = unwrapExpression(node.expression)

        // require(...) calls (direct, globalThis.require, module.require, process.mainModule.require)
        if (isRequireExpression(expr)) {
          if (node.arguments.length > 0) {
            const spec = extractStaticString(node.arguments[0])
            if (spec !== null) {
              if (spec === "@opencode-ai/plugin/tool") {
                hasPluginToolImport = true
              }
              if (spec === "zod") {
                hasZodImport = true
              }
              checkModuleSpecifier(spec)
            } else {
              securityEnforcer.addViolation(
                "no-dynamic-require",
                "Dynamic module require with non-literal specifier is forbidden."
              )
            }
          }
        }

        // tool(...)
        if (ts.isIdentifier(expr) && expr.text === "tool") {
          hasToolCall = true
        }

        securityEnforcer.checkCallExpression(node)
        capabilityDetector.checkCallExpression(expr)
      }

      // Tagged template expression: eval`...`, (0, eval)`...`, Function`...`, Bun.$`...`
      if (ts.isTaggedTemplateExpression(node)) {
        securityEnforcer.checkTaggedTemplate(node)
        capabilityDetector.checkTaggedTemplate(node)
      }

      // 3. New Expressions (e.g. new Function(...))
      if (ts.isNewExpression(node)) {
        securityEnforcer.checkNewExpression(node)
      }

      // 4. Prototype Access & Mutation
      if (ts.isPropertyAccessExpression(node)) {
        securityEnforcer.checkPropertyAccess(node)
      }

      if (ts.isElementAccessExpression(node)) {
        securityEnforcer.checkElementAccess(node)
      }

      // Object literal: { __proto__: ... } or { ["__proto__"]: ... } or { [`__proto__`]: ... }
      if (ts.isPropertyAssignment(node)) {
        securityEnforcer.checkPropertyAssignment(node)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    // Check required imports
    if (!hasPluginToolImport && !hasToolCall) {
      securityEnforcer.addViolation(
        "missing-tool-import",
        "Tool implementation must import and use tool() from '@opencode-ai/plugin/tool'."
      )
    }

    if (!hasZodImport) {
      securityEnforcer.addViolation(
        "missing-zod-import",
        "Tool implementation must import and use 'zod' for arguments validation."
      )
    }

    const uniqueViolations = Array.from(new Set(violations))
    const caps = Array.from(capabilityDetector.detectedCapabilities)

    return {
      valid: uniqueViolations.length === 0,
      violations: uniqueViolations,
      detectedCapabilities: caps,
      requiredPermissions: caps,
      diagnostics,
    }
  }
}
