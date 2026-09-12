/**
 * Security Policies and Anti-Evasion Rules
 * Enforces sandboxing invariants, prototype safety, dynamic execution blocks,
 * and process control checks.
 */

import ts from "typescript"
import type { ASTDiagnostic } from "../../../specs/contracts/live-tools.js"
import {
  unwrapExpression,
  extractStaticString,
  getAccessedMemberName,
  getTargetOfMemberAccess,
  isGlobalObject,
  isProcessObject,
  normalizeModuleName,
  isAssignmentOperator,
} from "./expression-utils.js"

export const STRICT_FORBIDDEN_MODULES = new Set([
  "cluster",
  "worker_threads",
  "v8",
  "vm",
])

export const BUILTIN_CONSTRUCTORS = new Set([
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

export function isConstructorAccess(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return getAccessedMemberName(unwrapped) === "constructor"
  }
  return false
}

export function isPrototypeAccess(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return getAccessedMemberName(unwrapped) === "prototype"
  }
  return false
}

export function isProtoAccess(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return getAccessedMemberName(unwrapped) === "__proto__"
  }
  return false
}

export function isPrototypeOrProtoExpression(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (isPrototypeAccess(unwrapped) || isProtoAccess(unwrapped)) {
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

export function isPrototypeMutationTarget(expr: ts.Expression): boolean {
  let curr: ts.Expression = unwrapExpression(expr)
  if (isPrototypeOrProtoExpression(curr)) {
    return true
  }
  while (ts.isPropertyAccessExpression(curr) || ts.isElementAccessExpression(curr)) {
    const base = getTargetOfMemberAccess(curr)
    if (!base) break
    if (isPrototypeOrProtoExpression(base)) {
      return true
    }
    curr = base
  }
  return false
}

export function isObjectOrReflectTarget(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (
    ts.isIdentifier(unwrapped) &&
    (unwrapped.text === "Object" || unwrapped.text === "Reflect")
  ) {
    return true
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const target = getTargetOfMemberAccess(unwrapped)
    const member = getAccessedMemberName(unwrapped)
    if (target && isGlobalObject(target) && (member === "Object" || member === "Reflect")) {
      return true
    }
  }
  return false
}

export function isEvalExpression(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "eval") {
    return true
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const member = getAccessedMemberName(unwrapped)
    const target = getTargetOfMemberAccess(unwrapped)
    if (member === "eval") {
      if (!target || isGlobalObject(target) || (ts.isIdentifier(target) && target.text === "eval")) {
        return true
      }
    }
    if (target && ((ts.isIdentifier(target) && target.text === "eval") || isEvalExpression(target))) {
      return true
    }
  }
  return false
}

export function isEvalInvocation(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (isEvalExpression(unwrapped)) return true
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const target = getTargetOfMemberAccess(unwrapped)
    if (target && isEvalExpression(target)) return true
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return isEvalInvocation(unwrapped.right)
  }
  return false
}

export function isFunctionConstructor(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isIdentifier(unwrapped) && (unwrapped.text === "Function" || unwrapped.text === "AsyncFunction")) {
    return true
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const target = getTargetOfMemberAccess(unwrapped)
    const member = getAccessedMemberName(unwrapped)
    if (target && isGlobalObject(target) && (member === "Function" || member === "AsyncFunction")) {
      return true
    }
  }

  // Constructor property traversal: (() => {}).constructor, ''.constructor.constructor, ({}).constructor.constructor
  if (isConstructorAccess(unwrapped)) {
    const target = getTargetOfMemberAccess(unwrapped)
    if (target) {
      if (
        ts.isArrowFunction(target) ||
        ts.isFunctionExpression(target) ||
        (ts.isIdentifier(target) && (target.text === "Function" || target.text === "AsyncFunction"))
      ) {
        return true
      }
      if (isConstructorAccess(target)) {
        return true
      }
      if (ts.isIdentifier(target) && BUILTIN_CONSTRUCTORS.has(target.text)) {
        return true
      }
      if (isPrototypeAccess(target)) {
        return true
      }
    }
  }

  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return isFunctionConstructor(unwrapped.right)
  }

  return false
}

export class SecurityPolicyEnforcer {
  constructor(
    private violations: string[],
    private diagnostics: ASTDiagnostic[]
  ) {}

  public addViolation(rule: string, message: string): void {
    this.violations.push(message)
    this.diagnostics.push({
      rule,
      severity: "error",
      message,
    })
  }

  public checkModuleSpecifier(specifier: string): boolean {
    const norm = normalizeModuleName(specifier)
    if (STRICT_FORBIDDEN_MODULES.has(norm)) {
      this.addViolation(
        "no-forbidden-module",
        `Process clustering or worker threads via '${specifier}' is forbidden.`
      )
      return false
    }
    return true
  }

  public checkBinaryExpression(node: ts.BinaryExpression): void {
    if (isAssignmentOperator(node.operatorToken.kind)) {
      if (isPrototypeMutationTarget(node.left)) {
        this.addViolation(
          "no-prototype-pollution",
          "Prototype modification or pollution attempt detected."
        )
      }
    }
  }

  public checkDeleteExpression(node: ts.DeleteExpression): void {
    if (isPrototypeMutationTarget(node.expression)) {
      this.addViolation(
        "no-prototype-pollution",
        "Prototype modification or pollution attempt detected."
      )
    }
  }

  public checkUnaryExpression(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): void {
    if (
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      if (isPrototypeMutationTarget(node.operand)) {
        this.addViolation(
          "no-prototype-pollution",
          "Prototype modification or pollution attempt detected."
        )
      }
    }
  }

  public checkCallExpression(node: ts.CallExpression): void {
    const expr = unwrapExpression(node.expression)

    // Dynamic import: import(...)
    if (expr.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length > 0) {
        const arg = unwrapExpression(node.arguments[0])
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          this.checkModuleSpecifier(arg.text)
        } else {
          this.addViolation(
            "no-dynamic-import",
            "Dynamic module import with non-literal specifier is forbidden."
          )
        }
      }
    }

    // eval(...) checks
    if (isEvalInvocation(expr)) {
      this.addViolation(
        "no-eval",
        "Dynamic code execution via eval() is strictly forbidden."
      )
    }

    // Function(...) constructor without 'new'
    if (isFunctionConstructor(expr)) {
      this.addViolation(
        "no-function-constructor",
        "Dynamic code execution via new Function() is strictly forbidden."
      )
    }

    // process.exit(...) & process.kill(...) & process.binding(...) & process.dlopen(...)
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const target = getTargetOfMemberAccess(expr)
      const member = getAccessedMemberName(expr)
      if (target && isProcessObject(target)) {
        if (member === "exit") {
          this.addViolation(
            "no-process-exit",
            "Process termination via process.exit() is forbidden in tool runtime."
          )
        } else if (member === "kill") {
          this.addViolation(
            "no-process-kill",
            "Process killing via process.kill() is forbidden."
          )
        } else if (member === "binding") {
          this.addViolation(
            "no-process-binding",
            "Direct access to internal Node.js C++ bindings via process.binding() is strictly forbidden."
          )
        } else if (member === "dlopen") {
          this.addViolation(
            "no-process-dlopen",
            "Dynamic native addon loading via process.dlopen() is strictly forbidden."
          )
        }
      }
    }

    // Object / Reflect methods: setPrototypeOf, defineProperty, defineProperties, assign, set
    const memberAccessTarget = getTargetOfMemberAccess(expr)
    if (
      (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
      memberAccessTarget &&
      isObjectOrReflectTarget(memberAccessTarget)
    ) {
      const method = getAccessedMemberName(expr)
      if (method === "setPrototypeOf") {
        this.addViolation(
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
          const firstArg = unwrapExpression(node.arguments[0])
          if (
            isPrototypeOrProtoExpression(firstArg) ||
            isPrototypeMutationTarget(firstArg)
          ) {
            this.addViolation(
              "no-prototype-pollution",
              "Prototype modification or pollution attempt detected."
            )
          }
        }
        if (
          node.arguments.length > 1 &&
          (method === "defineProperty" || method === "set")
        ) {
          const propArg = unwrapExpression(node.arguments[1])
          const propName = extractStaticString(propArg)
          if (propName === "__proto__" || propName === "prototype") {
            this.addViolation(
              "no-prototype-pollution",
              "Prototype modification or pollution attempt detected."
            )
          }
        }
      }
    }
  }

  public checkTaggedTemplate(node: ts.TaggedTemplateExpression): void {
    const tag = unwrapExpression(node.tag)

    if (isEvalInvocation(tag)) {
      this.addViolation(
        "no-eval",
        "Dynamic code execution via eval() is strictly forbidden."
      )
    }

    if (isFunctionConstructor(tag)) {
      this.addViolation(
        "no-function-constructor",
        "Dynamic code execution via new Function() is strictly forbidden."
      )
    }
  }

  public checkNewExpression(node: ts.NewExpression): void {
    const expr = unwrapExpression(node.expression)
    if (isFunctionConstructor(expr)) {
      this.addViolation(
        "no-function-constructor",
        "Dynamic code execution via new Function() is strictly forbidden."
      )
    }
  }

  public checkPropertyAccess(node: ts.PropertyAccessExpression): void {
    if (node.name.text === "__proto__") {
      this.addViolation(
        "no-prototype-pollution",
        "Prototype modification or pollution attempt detected."
      )
    }
    if (isConstructorAccess(node)) {
      const target = getTargetOfMemberAccess(node)
      if (
        target &&
        (ts.isArrowFunction(target) ||
          ts.isFunctionExpression(target) ||
          isConstructorAccess(target))
      ) {
        this.addViolation(
          "no-function-constructor",
          "Dynamic code execution via Function constructor traversal is strictly forbidden."
        )
      }
    }
  }

  public checkElementAccess(node: ts.ElementAccessExpression): void {
    const arg = unwrapExpression(node.argumentExpression)
    const prop = extractStaticString(arg)
    if (prop === "__proto__") {
      this.addViolation(
        "no-prototype-pollution",
        "Prototype modification or pollution attempt detected."
      )
    }
    if (isConstructorAccess(node)) {
      const target = getTargetOfMemberAccess(node)
      if (
        target &&
        (ts.isArrowFunction(target) ||
          ts.isFunctionExpression(target) ||
          isConstructorAccess(target))
      ) {
        this.addViolation(
          "no-function-constructor",
          "Dynamic code execution via Function constructor traversal is strictly forbidden."
        )
      }
    }
    const expr = unwrapExpression(node.expression)
    if (isPrototypeAccess(expr) || (ts.isIdentifier(expr) && expr.text === "prototype")) {
      this.addViolation(
        "no-prototype-pollution",
        "Prototype modification or pollution attempt detected."
      )
    }
  }

  public checkPropertyAssignment(node: ts.PropertyAssignment): void {
    if (ts.isIdentifier(node.name) && node.name.text === "__proto__") {
      this.addViolation(
        "no-prototype-pollution",
        "Prototype modification or pollution attempt detected."
      )
    } else if (ts.isStringLiteral(node.name) && node.name.text === "__proto__") {
      this.addViolation(
        "no-prototype-pollution",
        "Prototype modification or pollution attempt detected."
      )
    } else if (ts.isComputedPropertyName(node.name)) {
      const prop = extractStaticString(node.name.expression)
      if (prop === "__proto__") {
        this.addViolation(
          "no-prototype-pollution",
          "Prototype modification or pollution attempt detected."
        )
      }
    }
  }
}
