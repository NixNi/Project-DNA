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

export interface ASTValidatorOptions {
  strict?: boolean
}

export class ASTValidator {
  private static STRICT_FORBIDDEN_MODULES = new Set([
    "cluster",
    "worker_threads",
    "v8",
    "vm",
  ])

  private static BUILTIN_CONSTRUCTORS = new Set([
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "RegExp",
    "Date",
    "Promise",
    "Map",
    "Set",
    "Symbol",
    "BigInt",
    "Error",
    "Function",
    "AsyncFunction",
    "GeneratorFunction",
  ])

  private static FS_WRITE_METHODS = new Set([
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "mkdir",
    "mkdirSync",
    "rm",
    "rmSync",
    "unlink",
    "unlinkSync",
    "rename",
    "renameSync",
    "copyFile",
    "copyFileSync",
    "rmdir",
    "rmdirSync",
    "truncate",
    "truncateSync",
    "chmod",
    "chmodSync",
    "chown",
    "chownSync",
    "createWriteStream",
  ])

  private static normalizeModuleName(raw: string): string {
    return raw.replace(/^node:/, "")
  }

  /**
   * Unwraps parentheses, type assertions, non-null assertions, and satisfies expressions.
   */
  public static unwrapExpression(expr: ts.Expression): ts.Expression {
    while (true) {
      if (ts.isParenthesizedExpression(expr)) {
        expr = expr.expression
      } else if (ts.isAsExpression(expr)) {
        expr = expr.expression
      } else if (ts.isTypeAssertionExpression(expr)) {
        expr = expr.expression
      } else if (ts.isNonNullExpression(expr)) {
        expr = expr.expression
      } else {
        break
      }
    }
    return expr
  }

  /**
   * Statically evaluates string expressions:
   * - ts.StringLiteral ("...", '...')
   * - ts.NoSubstitutionTemplateLiteral (`...`)
   * - ts.TemplateExpression with statically resolvable spans (`...${...}...`)
   * - ts.BinaryExpression with PlusToken string concatenation ("..." + "...")
   * Returns evaluated string or null if expression cannot be statically resolved.
   */
  public static extractStaticString(
    expr: ts.Expression | ts.PropertyName | undefined
  ): string | null {
    if (!expr) return null
    const unwrapped = this.unwrapExpression(expr as ts.Expression)
    if (
      ts.isStringLiteral(unwrapped) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped)
    ) {
      return unwrapped.text
    }
    if (ts.isTemplateExpression(unwrapped)) {
      let result = unwrapped.head.text
      for (const span of unwrapped.templateSpans) {
        const spanText = this.extractStaticString(span.expression)
        if (spanText === null) return null
        result += spanText + span.literal.text
      }
      return result
    }
    if (
      ts.isBinaryExpression(unwrapped) &&
      unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = this.extractStaticString(unwrapped.left)
      const right = this.extractStaticString(unwrapped.right)
      if (left !== null && right !== null) {
        return left + right
      }
    }
    return null
  }

  public static isLiteralStringValue(
    node: ts.Expression | ts.PropertyName | undefined,
    expected: string
  ): boolean {
    return this.extractStaticString(node) === expected
  }

  /**
   * Extracts property or element member name from a member access expression.
   */
  public static getAccessedMemberName(expr: ts.Expression): string | null {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isPropertyAccessExpression(unwrapped)) {
      return unwrapped.name.text
    }
    if (ts.isElementAccessExpression(unwrapped)) {
      return this.extractStaticString(unwrapped.argumentExpression)
    }
    return null
  }

  /**
   * Retrieves the target expression of a property or element access expression.
   */
  public static getTargetOfMemberAccess(expr: ts.Expression): ts.Expression | null {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return this.unwrapExpression(unwrapped.expression)
    }
    return null
  }

  private static isGlobalObject(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) {
      return true
    }
    return (
      ts.isIdentifier(unwrapped) &&
      (unwrapped.text === "globalThis" ||
        unwrapped.text === "global" ||
        unwrapped.text === "window")
    )
  }

  private static isProcessObject(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isIdentifier(unwrapped) && unwrapped.text === "process") {
      return true
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const target = this.getTargetOfMemberAccess(unwrapped)
      const member = this.getAccessedMemberName(unwrapped)
      if (target && this.isGlobalObject(target) && member === "process") {
        return true
      }
    }
    return false
  }

  private static isEvalExpression(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isIdentifier(unwrapped) && unwrapped.text === "eval") {
      return true
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const member = this.getAccessedMemberName(unwrapped)
      const target = this.getTargetOfMemberAccess(unwrapped)
      if (member === "eval") {
        if (!target || this.isGlobalObject(target) || (ts.isIdentifier(target) && target.text === "eval")) {
          return true
        }
      }
      if (target && ((ts.isIdentifier(target) && target.text === "eval") || this.isEvalExpression(target))) {
        return true
      }
    }
    return false
  }

  private static isEvalInvocation(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (this.isEvalExpression(unwrapped)) return true
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const target = this.getTargetOfMemberAccess(unwrapped)
      if (target && this.isEvalExpression(target)) return true
    }
    if (
      ts.isBinaryExpression(unwrapped) &&
      unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return this.isEvalInvocation(unwrapped.right)
    }
    return false
  }

  private static isConstructorAccess(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return this.getAccessedMemberName(unwrapped) === "constructor"
    }
    return false
  }

  private static isPrototypeAccess(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return this.getAccessedMemberName(unwrapped) === "prototype"
    }
    return false
  }

  private static isProtoAccess(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return this.getAccessedMemberName(unwrapped) === "__proto__"
    }
    return false
  }

  private static isPrototypeOrProtoExpression(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (this.isPrototypeAccess(unwrapped) || this.isProtoAccess(unwrapped)) {
      return true
    }
    if (
      ts.isIdentifier(unwrapped) &&
      (unwrapped.text === "__proto__" || unwrapped.text === "prototype")
    ) {
      return true
    }
    return false
  }

  private static isPrototypeMutationTarget(expr: ts.Expression): boolean {
    let curr: ts.Expression = this.unwrapExpression(expr)
    if (this.isPrototypeOrProtoExpression(curr)) {
      return true
    }
    while (ts.isPropertyAccessExpression(curr) || ts.isElementAccessExpression(curr)) {
      const base = this.getTargetOfMemberAccess(curr)
      if (!base) break
      if (this.isPrototypeOrProtoExpression(base)) {
        return true
      }
      curr = base
    }
    return false
  }

  private static isObjectOrReflectTarget(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (
      ts.isIdentifier(unwrapped) &&
      (unwrapped.text === "Object" || unwrapped.text === "Reflect")
    ) {
      return true
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const target = this.getTargetOfMemberAccess(unwrapped)
      const member = this.getAccessedMemberName(unwrapped)
      if (target && this.isGlobalObject(target) && (member === "Object" || member === "Reflect")) {
        return true
      }
    }
    return false
  }

  private static isFunctionConstructor(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isIdentifier(unwrapped) && (unwrapped.text === "Function" || unwrapped.text === "AsyncFunction")) {
      return true
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const target = this.getTargetOfMemberAccess(unwrapped)
      const member = this.getAccessedMemberName(unwrapped)
      if (target && this.isGlobalObject(target) && (member === "Function" || member === "AsyncFunction")) {
        return true
      }
    }

    // Constructor property traversal: (() => {}).constructor, ''.constructor.constructor, ({}).constructor.constructor
    if (this.isConstructorAccess(unwrapped)) {
      const target = this.getTargetOfMemberAccess(unwrapped)
      if (target) {
        if (
          ts.isArrowFunction(target) ||
          ts.isFunctionExpression(target) ||
          (ts.isIdentifier(target) && (target.text === "Function" || target.text === "AsyncFunction"))
        ) {
          return true
        }
        if (this.isConstructorAccess(target)) {
          return true
        }
        if (ts.isIdentifier(target) && this.BUILTIN_CONSTRUCTORS.has(target.text)) {
          return true
        }
        if (this.isPrototypeAccess(target)) {
          return true
        }
      }
    }

    if (
      ts.isBinaryExpression(unwrapped) &&
      unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return this.isFunctionConstructor(unwrapped.right)
    }

    return false
  }

  /**
   * Determines if an expression is a CommonJS require call:
   * bare require, globalThis.require, module.require, process.mainModule.require.
   */
  public static isRequireExpression(expr: ts.Expression): boolean {
    const unwrapped = this.unwrapExpression(expr)
    if (ts.isIdentifier(unwrapped) && unwrapped.text === "require") {
      return true
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const member = this.getAccessedMemberName(unwrapped)
      if (member === "require") {
        const target = this.getTargetOfMemberAccess(unwrapped)
        if (target) {
          if (this.isGlobalObject(target)) return true
          if (ts.isIdentifier(target) && target.text === "module") return true
          const innerMember = this.getAccessedMemberName(target)
          const innerTarget = this.getTargetOfMemberAccess(target)
          if (innerMember === "mainModule" && innerTarget && this.isProcessObject(innerTarget)) {
            return true
          }
          return true
        }
      }
    }
    return false
  }

  /**
   * Checks if an expression represents an fs namespace, fs.promises, or inline require('fs').
   */
  public static isFsObject(
    expr: ts.Expression,
    fsImports: Set<string>
  ): boolean {
    const unwrapped = this.unwrapExpression(expr)

    if (ts.isIdentifier(unwrapped)) {
      return fsImports.has(unwrapped.text) || unwrapped.text === "fs"
    }

    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const member = this.getAccessedMemberName(unwrapped)
      if (member === "promises") {
        const target = this.getTargetOfMemberAccess(unwrapped)
        if (target && this.isFsObject(target, fsImports)) {
          return true
        }
      }
    }

    if (ts.isCallExpression(unwrapped) && this.isRequireExpression(unwrapped.expression)) {
      if (unwrapped.arguments.length > 0) {
        const spec = this.extractStaticString(unwrapped.arguments[0])
        if (spec) {
          const norm = this.normalizeModuleName(spec)
          return norm === "fs" || norm === "fs/promises"
        }
      }
    }

    return false
  }

  private static isAssignmentOperator(kind: ts.SyntaxKind): boolean {
    return (
      kind >= ts.SyntaxKind.FirstAssignment &&
      kind <= ts.SyntaxKind.LastAssignment
    )
  }

  /**
   * Validates TypeScript/JavaScript tool source code against security policies and detects capabilities.
   */
  public static validate(
    sourceCode: string,
    options?: ASTValidatorOptions
  ): ASTValidationReport {
    const violations: string[] = []
    const detectedCapabilities = new Set<ToolPermission>()
    const diagnostics: ASTDiagnostic[] = []
    const fsImports = new Set<string>()

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

    let hasPluginToolImport = false
    let hasToolCall = false
    let hasZodImport = false

    const addViolation = (rule: string, message: string) => {
      violations.push(message)
      diagnostics.push({
        rule,
        severity: "error",
        message,
      })
    }

    const registerCapability = (
      perm: ToolPermission,
      moduleName: string
    ) => {
      detectedCapabilities.add(perm)
      if (isStrict) {
        const msg = `Module or API '${moduleName}' requires '${perm}' permission, which is not permitted in strict sandbox mode.`
        violations.push(msg)
        diagnostics.push({
          rule: `permission-${perm}`,
          severity: "error",
          message: msg,
          permission: perm,
        })
      } else {
        diagnostics.push({
          rule: `capability-${perm}`,
          severity: "info",
          message: `Detected capability '${perm}' via '${moduleName}'. Routed to OpenCode permission gating.`,
          permission: perm,
        })
      }
    }

    const checkModuleSpecifier = (specifier: string) => {
      const norm = this.normalizeModuleName(specifier)

      if (this.STRICT_FORBIDDEN_MODULES.has(norm)) {
        addViolation(
          "no-forbidden-module",
          `Process clustering or worker threads via '${specifier}' is forbidden.`
        )
        return
      }

      if (norm === "child_process") {
        registerCapability("shell_execution", specifier)
      } else if (norm === "net" || norm === "dgram" || norm === "tls") {
        registerCapability("raw_socket_access", specifier)
      } else if (
        norm === "http" ||
        norm === "https" ||
        norm === "undici" ||
        norm === "axios"
      ) {
        registerCapability("network_access", specifier)
      }
    }

    const visit = (node: ts.Node) => {
      // 0. Direct prototype property assignments: Object.prototype.polluted = true, Target.prototype[key] = value, x['__proto__'] = null
      if (ts.isBinaryExpression(node) && this.isAssignmentOperator(node.operatorToken.kind)) {
        if (this.isPrototypeMutationTarget(node.left)) {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        }
      }

      // Delete operator on prototype properties
      if (ts.isDeleteExpression(node)) {
        if (this.isPrototypeMutationTarget(node.expression)) {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        }
      }

      // Unary ++ and -- mutations on prototype properties
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        if (this.isPrototypeMutationTarget(node.operand)) {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        }
      }

      // 1. Static Import Declarations
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier) || ts.isNoSubstitutionTemplateLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text
          const norm = this.normalizeModuleName(spec)

          if (spec === "@opencode-ai/plugin/tool") {
            hasPluginToolImport = true
          }
          if (spec === "zod") {
            hasZodImport = true
          }

          checkModuleSpecifier(spec)

          // Track fs imports to monitor mutating calls
          if (norm === "fs" || norm === "fs/promises") {
            if (node.importClause) {
              if (node.importClause.name) {
                fsImports.add(node.importClause.name.text)
              }
              if (node.importClause.namedBindings) {
                if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                  fsImports.add(node.importClause.namedBindings.name.text)
                } else if (ts.isNamedImports(node.importClause.namedBindings)) {
                  for (const el of node.importClause.namedBindings.elements) {
                    const imported = el.propertyName?.text || el.name.text
                    if (this.FS_WRITE_METHODS.has(imported)) {
                      registerCapability("filesystem_write", `fs.${imported}`)
                    }
                    fsImports.add(el.name.text)
                  }
                }
              }
            }
          }
        }
      }

      // 1.5 Variable Declarations with require('fs') or destructuring
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = this.unwrapExpression(node.initializer)
        if (ts.isCallExpression(init) && this.isRequireExpression(init.expression)) {
          if (init.arguments.length > 0) {
            const spec = this.extractStaticString(init.arguments[0])
            if (spec) {
              const norm = this.normalizeModuleName(spec)
              if (norm === "fs" || norm === "fs/promises") {
                if (ts.isIdentifier(node.name)) {
                  fsImports.add(node.name.text)
                } else if (ts.isObjectBindingPattern(node.name)) {
                  for (const el of node.name.elements) {
                    const imported =
                      (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : null) ||
                      (ts.isIdentifier(el.name) ? el.name.text : null)
                    if (imported) {
                      if (this.FS_WRITE_METHODS.has(imported)) {
                        registerCapability("filesystem_write", `fs.${imported}`)
                      }
                      if (ts.isIdentifier(el.name)) {
                        fsImports.add(el.name.text)
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // 2. Call Expressions
      if (ts.isCallExpression(node)) {
        const expr = this.unwrapExpression(node.expression)

        // Dynamic import: import(...)
        if (expr.kind === ts.SyntaxKind.ImportKeyword) {
          if (node.arguments.length > 0) {
            const arg = this.unwrapExpression(node.arguments[0])
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              checkModuleSpecifier(arg.text)
            } else {
              addViolation(
                "no-dynamic-import",
                "Dynamic module import with non-literal specifier is forbidden."
              )
            }
          }
        }

        // require(...) calls (direct, globalThis.require, module.require, process.mainModule.require)
        if (this.isRequireExpression(expr)) {
          if (node.arguments.length > 0) {
            const spec = this.extractStaticString(node.arguments[0])
            if (spec !== null) {
              if (spec === "@opencode-ai/plugin/tool") {
                hasPluginToolImport = true
              }
              if (spec === "zod") {
                hasZodImport = true
              }
              checkModuleSpecifier(spec)
            } else {
              addViolation(
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

        // eval(...) checks
        if (this.isEvalInvocation(expr)) {
          addViolation(
            "no-eval",
            "Dynamic code execution via eval() is strictly forbidden."
          )
        }

        // Function(...) constructor without 'new'
        if (this.isFunctionConstructor(expr)) {
          addViolation(
            "no-function-constructor",
            "Dynamic code execution via new Function() is strictly forbidden."
          )
        }

        // process.exit(...) & process.kill(...) & process.binding(...) & process.dlopen(...)
        if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
          const target = this.getTargetOfMemberAccess(expr)
          const member = this.getAccessedMemberName(expr)
          if (target && this.isProcessObject(target)) {
            if (member === "exit") {
              addViolation(
                "no-process-exit",
                "Process termination via process.exit() is forbidden in tool runtime."
              )
            } else if (member === "kill") {
              addViolation(
                "no-process-kill",
                "Process killing via process.kill() is forbidden."
              )
            } else if (member === "binding") {
              addViolation(
                "no-process-binding",
                "Direct access to internal Node.js C++ bindings via process.binding() is strictly forbidden."
              )
            } else if (member === "dlopen") {
              addViolation(
                "no-process-dlopen",
                "Dynamic native addon loading via process.dlopen() is strictly forbidden."
              )
            }
          }
        }

        // Object / Reflect methods: setPrototypeOf, defineProperty, defineProperties, assign, set
        const memberAccessTarget = this.getTargetOfMemberAccess(expr)
        if (
          (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
          memberAccessTarget &&
          this.isObjectOrReflectTarget(memberAccessTarget)
        ) {
          const method = this.getAccessedMemberName(expr)
          if (method === "setPrototypeOf") {
            addViolation(
              "no-prototype-pollution",
              "Prototype modification or pollution attempt detected."
            )
          } else if (
            method === "defineProperty" ||
            method === "defineProperties" ||
            method === "assign" ||
            method === "set"
          ) {
            if (node.arguments.length > 0) {
              const firstArg = this.unwrapExpression(node.arguments[0])
              if (
                this.isPrototypeOrProtoExpression(firstArg) ||
                this.isPrototypeMutationTarget(firstArg)
              ) {
                addViolation(
                  "no-prototype-pollution",
                  "Prototype modification or pollution attempt detected."
                )
              }
            }
            if (
              node.arguments.length > 1 &&
              (method === "defineProperty" || method === "set")
            ) {
              const propArg = this.unwrapExpression(node.arguments[1])
              const propName = this.extractStaticString(propArg)
              if (propName === "__proto__" || propName === "prototype") {
                addViolation(
                  "no-prototype-pollution",
                  "Prototype modification or pollution attempt detected."
                )
              }
            }
          }
        }

        // Network capability detection: fetch(...)
        if (ts.isIdentifier(expr) && expr.text === "fetch") {
          registerCapability("network_access", "fetch")
        } else if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
          const target = this.getTargetOfMemberAccess(expr)
          const member = this.getAccessedMemberName(expr)
          if (target && this.isGlobalObject(target) && member === "fetch") {
            registerCapability("network_access", "globalThis.fetch")
          }
        }

        // Shell capability detection: Bun.$
        if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
          const target = this.getTargetOfMemberAccess(expr)
          const member = this.getAccessedMemberName(expr)
          if (target && ts.isIdentifier(target) && target.text === "Bun" && member === "$") {
            registerCapability("shell_execution", "Bun.$")
          }
        }

        // Filesystem write capability detection: fs.writeFile, fs.promises.writeFile, require('fs').writeFileSync, etc.
        if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
          const methodName = this.getAccessedMemberName(expr)
          if (methodName && this.FS_WRITE_METHODS.has(methodName)) {
            const target = this.getTargetOfMemberAccess(expr)
            if (target && this.isFsObject(target, fsImports)) {
              registerCapability("filesystem_write", `fs.${methodName}`)
            }
          }
        } else if (
          ts.isIdentifier(expr) &&
          this.FS_WRITE_METHODS.has(expr.text) &&
          fsImports.has(expr.text)
        ) {
          registerCapability("filesystem_write", `fs.${expr.text}`)
        }
      }

      // Tagged template expression: eval`...`, (0, eval)`...`, Function`...`, Bun.$`...`
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = this.unwrapExpression(node.tag)

        if (this.isEvalInvocation(tag)) {
          addViolation(
            "no-eval",
            "Dynamic code execution via eval() is strictly forbidden."
          )
        }

        if (this.isFunctionConstructor(tag)) {
          addViolation(
            "no-function-constructor",
            "Dynamic code execution via new Function() is strictly forbidden."
          )
        }

        if (ts.isPropertyAccessExpression(tag) || ts.isElementAccessExpression(tag)) {
          const target = this.getTargetOfMemberAccess(tag)
          const member = this.getAccessedMemberName(tag)
          if (target && ts.isIdentifier(target) && target.text === "Bun" && member === "$") {
            registerCapability("shell_execution", "Bun.$")
          }
        }
      }

      // 3. New Expressions (e.g. new Function(...))
      if (ts.isNewExpression(node)) {
        const expr = this.unwrapExpression(node.expression)
        if (this.isFunctionConstructor(expr)) {
          addViolation(
            "no-function-constructor",
            "Dynamic code execution via new Function() is strictly forbidden."
          )
        }
      }

      // 4. Prototype Access & Mutation
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === "__proto__") {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        }
        if (this.isConstructorAccess(node)) {
          const target = this.getTargetOfMemberAccess(node)
          if (
            target &&
            (ts.isArrowFunction(target) ||
              ts.isFunctionExpression(target) ||
              this.isConstructorAccess(target))
          ) {
            addViolation(
              "no-function-constructor",
              "Dynamic code execution via Function constructor traversal is strictly forbidden."
            )
          }
        }
      }

      if (ts.isElementAccessExpression(node)) {
        const arg = this.unwrapExpression(node.argumentExpression)
        const prop = this.extractStaticString(arg)
        if (prop === "__proto__") {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        }
        if (this.isConstructorAccess(node)) {
          const target = this.getTargetOfMemberAccess(node)
          if (
            target &&
            (ts.isArrowFunction(target) ||
              ts.isFunctionExpression(target) ||
              this.isConstructorAccess(target))
          ) {
            addViolation(
              "no-function-constructor",
              "Dynamic code execution via Function constructor traversal is strictly forbidden."
            )
          }
        }
        const expr = this.unwrapExpression(node.expression)
        if (this.isPrototypeAccess(expr) || (ts.isIdentifier(expr) && expr.text === "prototype")) {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        }
      }

      // Object literal: { __proto__: ... } or { ["__proto__"]: ... } or { [`__proto__`]: ... }
      if (ts.isPropertyAssignment(node)) {
        if (ts.isIdentifier(node.name) && node.name.text === "__proto__") {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        } else if (ts.isStringLiteral(node.name) && node.name.text === "__proto__") {
          addViolation(
            "no-prototype-pollution",
            "Prototype modification or pollution attempt detected."
          )
        } else if (ts.isComputedPropertyName(node.name)) {
          const prop = this.extractStaticString(node.name.expression)
          if (prop === "__proto__") {
            addViolation(
              "no-prototype-pollution",
              "Prototype modification or pollution attempt detected."
            )
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    // Check required imports
    if (!hasPluginToolImport && !hasToolCall) {
      addViolation(
        "missing-tool-import",
        "Tool implementation must import and use tool() from '@opencode-ai/plugin/tool'."
      )
    }

    if (!hasZodImport) {
      addViolation(
        "missing-zod-import",
        "Tool implementation must import and use 'zod' for arguments validation."
      )
    }

    const uniqueViolations = Array.from(new Set(violations))
    const caps = Array.from(detectedCapabilities)

    return {
      valid: uniqueViolations.length === 0,
      violations: uniqueViolations,
      detectedCapabilities: caps,
      requiredPermissions: caps,
      diagnostics,
    }
  }
}
