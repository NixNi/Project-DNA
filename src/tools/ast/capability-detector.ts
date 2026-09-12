/**
 * Capability Detector
 * Identifies developer capabilities (shell, network, filesystem, sockets)
 * and routes them to OpenCode permission gating or strict sandbox violations.
 */

import ts from "typescript"
import type { ToolPermission, ASTDiagnostic } from "../../../specs/contracts/live-tools.js"
import {
  unwrapExpression,
  extractStaticString,
  getAccessedMemberName,
  getTargetOfMemberAccess,
  isGlobalObject,
  isFsObject,
  normalizeModuleName,
} from "./expression-utils.js"

export const FS_WRITE_METHODS = new Set([
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

export class CapabilityDetector {
  public detectedCapabilities = new Set<ToolPermission>()
  public fsImports = new Set<string>()

  constructor(
    private isStrict: boolean,
    private violations: string[],
    private diagnostics: ASTDiagnostic[]
  ) {}

  public registerCapability(perm: ToolPermission, moduleName: string): void {
    this.detectedCapabilities.add(perm)
    if (this.isStrict) {
      const msg = `Module or API '${moduleName}' requires '${perm}' permission, which is not permitted in strict sandbox mode.`
      this.violations.push(msg)
      this.diagnostics.push({
        rule: `permission-${perm}`,
        severity: "error",
        message: msg,
        permission: perm,
      })
    } else {
      this.diagnostics.push({
        rule: `capability-${perm}`,
        severity: "info",
        message: `Detected capability '${perm}' via '${moduleName}'. Routed to OpenCode permission gating.`,
        permission: perm,
      })
    }
  }

  public checkModuleSpecifier(specifier: string): void {
    const norm = normalizeModuleName(specifier)

    if (norm === "child_process") {
      this.registerCapability("shell_execution", specifier)
    } else if (norm === "net" || norm === "dgram" || norm === "tls") {
      this.registerCapability("raw_socket_access", specifier)
    } else if (
      norm === "http" ||
      norm === "https" ||
      norm === "undici" ||
      norm === "axios"
    ) {
      this.registerCapability("network_access", specifier)
    }
  }

  public checkImportDeclaration(node: ts.ImportDeclaration): void {
    if (
      ts.isStringLiteral(node.moduleSpecifier) ||
      ts.isNoSubstitutionTemplateLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text
      const norm = normalizeModuleName(spec)

      this.checkModuleSpecifier(spec)

      // Track fs imports to monitor mutating calls
      if (norm === "fs" || norm === "fs/promises") {
        if (node.importClause) {
          if (node.importClause.name) {
            this.fsImports.add(node.importClause.name.text)
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              this.fsImports.add(node.importClause.namedBindings.name.text)
            } else if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const el of node.importClause.namedBindings.elements) {
                const imported = el.propertyName?.text || el.name.text
                if (FS_WRITE_METHODS.has(imported)) {
                  this.registerCapability("filesystem_write", `fs.${imported}`)
                }
                this.fsImports.add(el.name.text)
              }
            }
          }
        }
      }
    }
  }

  public checkVariableDeclaration(node: ts.VariableDeclaration): void {
    if (!node.initializer) return
    const init = unwrapExpression(node.initializer)
    if (ts.isCallExpression(init)) {
      const expr = unwrapExpression(init.expression)
      // If it's a require call
      if (
        (ts.isIdentifier(expr) && expr.text === "require") ||
        (ts.isPropertyAccessExpression(expr) && expr.name.text === "require")
      ) {
        if (init.arguments.length > 0) {
          const spec = extractStaticString(init.arguments[0])
          if (spec) {
            const norm = normalizeModuleName(spec)
            if (norm === "fs" || norm === "fs/promises") {
              if (ts.isIdentifier(node.name)) {
                this.fsImports.add(node.name.text)
              } else if (ts.isObjectBindingPattern(node.name)) {
                for (const el of node.name.elements) {
                  const imported =
                    (el.propertyName && ts.isIdentifier(el.propertyName)
                      ? el.propertyName.text
                      : null) ||
                    (ts.isIdentifier(el.name) ? el.name.text : null)
                  if (imported) {
                    if (FS_WRITE_METHODS.has(imported)) {
                      this.registerCapability("filesystem_write", `fs.${imported}`)
                    }
                    if (ts.isIdentifier(el.name)) {
                      this.fsImports.add(el.name.text)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  public checkCallExpression(expr: ts.Expression): void {
    // Network capability detection: fetch(...)
    if (ts.isIdentifier(expr) && expr.text === "fetch") {
      this.registerCapability("network_access", "fetch")
    } else if (
      ts.isPropertyAccessExpression(expr) ||
      ts.isElementAccessExpression(expr)
    ) {
      const target = getTargetOfMemberAccess(expr)
      const member = getAccessedMemberName(expr)
      if (target && isGlobalObject(target) && member === "fetch") {
        this.registerCapability("network_access", "globalThis.fetch")
      }
    }

    // Shell capability detection: Bun.$
    if (
      ts.isPropertyAccessExpression(expr) ||
      ts.isElementAccessExpression(expr)
    ) {
      const target = getTargetOfMemberAccess(expr)
      const member = getAccessedMemberName(expr)
      if (
        target &&
        ts.isIdentifier(target) &&
        target.text === "Bun" &&
        member === "$"
      ) {
        this.registerCapability("shell_execution", "Bun.$")
      }
    }

    // Filesystem write capability detection: fs.writeFile, fs.promises.writeFile, require('fs').writeFileSync, etc.
    if (
      ts.isPropertyAccessExpression(expr) ||
      ts.isElementAccessExpression(expr)
    ) {
      const methodName = getAccessedMemberName(expr)
      if (methodName && FS_WRITE_METHODS.has(methodName)) {
        const target = getTargetOfMemberAccess(expr)
        if (target && isFsObject(target, this.fsImports)) {
          this.registerCapability("filesystem_write", `fs.${methodName}`)
        }
      }
    } else if (
      ts.isIdentifier(expr) &&
      FS_WRITE_METHODS.has(expr.text) &&
      this.fsImports.has(expr.text)
    ) {
      this.registerCapability("filesystem_write", `fs.${expr.text}`)
    }
  }

  public checkTaggedTemplate(node: ts.TaggedTemplateExpression): void {
    const tag = unwrapExpression(node.tag)
    if (
      ts.isPropertyAccessExpression(tag) ||
      ts.isElementAccessExpression(tag)
    ) {
      const target = getTargetOfMemberAccess(tag)
      const member = getAccessedMemberName(tag)
      if (
        target &&
        ts.isIdentifier(target) &&
        target.text === "Bun" &&
        member === "$"
      ) {
        this.registerCapability("shell_execution", "Bun.$")
      }
    }
  }
}
