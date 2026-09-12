/**
 * AST Expression Utilities
 * Evaluates and unwraps TypeScript AST expressions for LiveTools security analysis.
 */

import ts from "typescript"

/**
 * Strips 'node:' prefix from module specifiers.
 */
export function normalizeModuleName(raw: string): string {
  return raw.replace(/^node:/, "")
}

/**
 * Unwraps parentheses, type assertions, non-null assertions, and satisfies expressions.
 */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
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
export function extractStaticString(
  expr: ts.Expression | ts.PropertyName | undefined
): string | null {
  if (!expr) return null
  const unwrapped = unwrapExpression(expr as ts.Expression)
  if (
    ts.isStringLiteral(unwrapped) ||
    ts.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return unwrapped.text
  }
  if (ts.isTemplateExpression(unwrapped)) {
    let result = unwrapped.head.text
    for (const span of unwrapped.templateSpans) {
      const spanText = extractStaticString(span.expression)
      if (spanText === null) return null
      result += spanText + span.literal.text
    }
    return result
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = extractStaticString(unwrapped.left)
    const right = extractStaticString(unwrapped.right)
    if (left !== null && right !== null) {
      return left + right
    }
  }
  return null
}

/**
 * Checks whether an expression or property name statically equals an expected string.
 */
export function isLiteralStringValue(
  node: ts.Expression | ts.PropertyName | undefined,
  expected: string
): boolean {
  return extractStaticString(node) === expected
}

/**
 * Extracts property or element member name from a member access expression.
 */
export function getAccessedMemberName(expr: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expr)
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    return extractStaticString(unwrapped.argumentExpression)
  }
  return null
}

/**
 * Retrieves the target expression of a property or element access expression.
 */
export function getTargetOfMemberAccess(expr: ts.Expression): ts.Expression | null {
  const unwrapped = unwrapExpression(expr)
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return unwrapExpression(unwrapped.expression)
  }
  return null
}

/**
 * Checks whether an expression references a global namespace object (this, globalThis, global, window).
 */
export function isGlobalObject(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
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

/**
 * Checks whether an expression resolves to the Node.js process object.
 */
export function isProcessObject(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "process") {
    return true
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const target = getTargetOfMemberAccess(unwrapped)
    const member = getAccessedMemberName(unwrapped)
    if (target && isGlobalObject(target) && member === "process") {
      return true
    }
  }
  return false
}

/**
 * Determines if an expression is a CommonJS require call:
 * bare require, globalThis.require, module.require, process.mainModule.require.
 */
export function isRequireExpression(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr)
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "require") {
    return true
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const member = getAccessedMemberName(unwrapped)
    if (member === "require") {
      const target = getTargetOfMemberAccess(unwrapped)
      if (target) {
        if (isGlobalObject(target)) return true
        if (ts.isIdentifier(target) && target.text === "module") return true
        const innerMember = getAccessedMemberName(target)
        const innerTarget = getTargetOfMemberAccess(target)
        if (innerMember === "mainModule" && innerTarget && isProcessObject(innerTarget)) {
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
export function isFsObject(
  expr: ts.Expression,
  fsImports: Set<string>
): boolean {
  const unwrapped = unwrapExpression(expr)

  if (ts.isIdentifier(unwrapped)) {
    return fsImports.has(unwrapped.text) || unwrapped.text === "fs"
  }

  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const member = getAccessedMemberName(unwrapped)
    if (member === "promises") {
      const target = getTargetOfMemberAccess(unwrapped)
      if (target && isFsObject(target, fsImports)) {
        return true
      }
    }
  }

  if (ts.isCallExpression(unwrapped) && isRequireExpression(unwrapped.expression)) {
    if (unwrapped.arguments.length > 0) {
      const spec = extractStaticString(unwrapped.arguments[0])
      if (spec) {
        const norm = normalizeModuleName(spec)
        return norm === "fs" || norm === "fs/promises"
      }
    }
  }

  return false
}

/**
 * Checks if a syntax kind represents an assignment operator (=, +=, -=, etc.).
 */
export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  )
}
