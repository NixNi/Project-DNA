import { describe, it } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolLifecycleStatus, ToolPackageMetadata } from "../specs/contracts/live-tools.js"
import type { SkillLifecycleStatus, SkillPackageMetadata } from "../specs/contracts/live-skills.js"

interface SchemaValidationError {
  path: string
  message: string
}

interface ValidationResult {
  valid: boolean
  errors: SchemaValidationError[]
}

/**
 * Genuine JSON Schema Draft 2020-12 validator tailored for tool & skill package schemas
 */
function validateAgainstSchema(schema: any, data: any, currentPath = "$"): ValidationResult {
  const errors: SchemaValidationError[] = []

  if (schema === undefined || schema === null) {
    return { valid: true, errors: [] }
  }

  // Type check
  if (schema.type) {
    const expectedType = schema.type
    if (expectedType === "object") {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        errors.push({ path: currentPath, message: `Expected object, got ${Array.isArray(data) ? "array" : typeof data}` })
        return { valid: false, errors }
      }
    } else if (expectedType === "array") {
      if (!Array.isArray(data)) {
        errors.push({ path: currentPath, message: `Expected array, got ${typeof data}` })
        return { valid: false, errors }
      }
    } else if (expectedType === "string") {
      if (typeof data !== "string") {
        errors.push({ path: currentPath, message: `Expected string, got ${typeof data}` })
        return { valid: false, errors }
      }
    } else if (expectedType === "integer") {
      if (typeof data !== "number" || !Number.isInteger(data)) {
        errors.push({ path: currentPath, message: `Expected integer, got ${typeof data} (${data})` })
        return { valid: false, errors }
      }
    } else if (expectedType === "number") {
      if (typeof data !== "number" || Number.isNaN(data)) {
        errors.push({ path: currentPath, message: `Expected number, got ${typeof data}` })
        return { valid: false, errors }
      }
    } else if (expectedType === "boolean") {
      if (typeof data !== "boolean") {
        errors.push({ path: currentPath, message: `Expected boolean, got ${typeof data}` })
        return { valid: false, errors }
      }
    }
  }

  // Enum check
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push({
        path: currentPath,
        message: `Value ${JSON.stringify(data)} not in enum: [${schema.enum.join(", ")}]`,
      })
    }
  }

  // Pattern check for strings
  if (typeof schema.pattern === "string" && typeof data === "string") {
    const regex = new RegExp(schema.pattern)
    if (!regex.test(data)) {
      errors.push({
        path: currentPath,
        message: `Value "${data}" does not match pattern "${schema.pattern}"`,
      })
    }
  }

  // Minimum & Maximum for numbers/integers
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push({
        path: currentPath,
        message: `Value ${data} is less than minimum ${schema.minimum}`,
      })
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push({
        path: currentPath,
        message: `Value ${data} is greater than maximum ${schema.maximum}`,
      })
    }
  }

  // Format check (date-time)
  if (schema.format === "date-time" && typeof data === "string") {
    const timestamp = Date.parse(data)
    if (Number.isNaN(timestamp)) {
      errors.push({
        path: currentPath,
        message: `String "${data}" is not a valid ISO date-time`,
      })
    }
  }

  // Object checks: required, properties, additionalProperties
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in data) || data[reqKey] === undefined) {
          errors.push({
            path: `${currentPath}.${reqKey}`,
            message: `Missing required property "${reqKey}"`,
          })
        }
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      const allowedKeys = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(data)) {
        if (!allowedKeys.has(key)) {
          errors.push({
            path: `${currentPath}.${key}`,
            message: `Additional property "${key}" is not permitted`,
          })
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries<any>(schema.properties)) {
        if (key in data && data[key] !== undefined) {
          const propRes = validateAgainstSchema(propSchema, data[key], `${currentPath}.${key}`)
          errors.push(...propRes.errors)
        }
      }
    }
  }

  // Array checks: minItems, items
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push({
        path: currentPath,
        message: `Array has length ${data.length}, minimum required is ${schema.minItems}`,
      })
    }

    if (schema.items) {
      data.forEach((item, index) => {
        const itemRes = validateAgainstSchema(schema.items, item, `${currentPath}[${index}]`)
        errors.push(...itemRes.errors)
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

describe("R5 Schema & Contract Synchronization", () => {
  const toolSchemaPath = path.resolve("./specs/schemas/tool-package.schema.json")
  const skillSchemaPath = path.resolve("./specs/schemas/skill-package.schema.json")

  const expectedToolStatuses: ToolLifecycleStatus[] = [
    "PROPOSED",
    "GENERATING",
    "VALIDATING_AST",
    "TESTING",
    "ACTIVE",
    "DEGRADED",
    "ARCHIVED",
  ]

  const expectedSkillStatuses: SkillLifecycleStatus[] = [
    "HARVESTED",
    "DISTILLING",
    "STAGED",
    "VERIFYING",
    "ACTIVE",
    "DEGRADED",
    "ARCHIVED",
  ]

  it("should load tool-package.schema.json and contain exactly the 7 contract lifecycle statuses", async () => {
    const raw = await fs.readFile(toolSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    assert.ok(schema.properties?.status?.enum, "status.enum must be defined in tool schema")
    const schemaStatuses: string[] = schema.properties.status.enum

    assert.strictEqual(schemaStatuses.length, 7, "tool-package schema must declare exactly 7 statuses")
    assert.deepStrictEqual(
      schemaStatuses,
      expectedToolStatuses,
      "tool-package schema status enum must match ToolLifecycleStatus contract"
    )
  })

  it("should validate valid tool package metadata payloads for all 7 lifecycle statuses", async () => {
    const raw = await fs.readFile(toolSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    for (const status of expectedToolStatuses) {
      const payload: ToolPackageMetadata = {
        id: `tool-${status.toLowerCase()}-001`,
        name: `test_tool_${status.toLowerCase()}`,
        version: "1.0.0",
        description: `Tool in ${status} status for testing`,
        entrypoint: `src/tools/test_tool_${status.toLowerCase()}.ts`,
        testFile: `tests/test_tool_${status.toLowerCase()}.test.ts`,
        status,
        parameters: { type: "object", properties: { input: { type: "string" } } },
        telemetry: {
          totalInvocations: 10,
          successCount: 9,
          failureCount: 1,
          avgDurationMs: 42.5,
          healthScore: 0.9,
          lastExecutedAt: "2026-09-11T20:00:00.000Z",
        },
        createdAt: "2026-09-11T19:00:00.000Z",
        updatedAt: "2026-09-11T20:00:00.000Z",
      }

      const result = validateAgainstSchema(schema, payload)
      assert.strictEqual(
        result.valid,
        true,
        `Tool payload with status "${status}" must pass validation. Errors: ${JSON.stringify(result.errors)}`
      )
    }
  })

  it("should reject tool payloads with invalid status values", async () => {
    const raw = await fs.readFile(toolSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    const invalidStatuses = ["INVALID_STATUS", "PENDING", "UNKNOWN", "VERIFYING", "STAGED"]
    for (const invalidStatus of invalidStatuses) {
      const payload = {
        id: "tool-invalid-status-001",
        name: "test_tool_invalid",
        version: "1.0.0",
        description: "Tool with invalid status",
        entrypoint: "src/tools/invalid.ts",
        status: invalidStatus,
        parameters: {},
        telemetry: {
          totalInvocations: 0,
          successCount: 0,
          failureCount: 0,
          healthScore: 1.0,
        },
        createdAt: "2026-09-11T19:00:00.000Z",
        updatedAt: "2026-09-11T20:00:00.000Z",
      }

      const result = validateAgainstSchema(schema, payload)
      assert.strictEqual(result.valid, false, `Tool payload with invalid status "${invalidStatus}" should be rejected`)
      assert.ok(
        result.errors.some((e) => e.path.includes("status")),
        `Expected error at status path, got: ${JSON.stringify(result.errors)}`
      )
    }
  })

  it("should reject tool payloads with structural or schema violations", async () => {
    const raw = await fs.readFile(toolSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    // Violation 1: invalid tool name pattern (uppercase not allowed by ^[a-z0-9_-]+$)
    const invalidName = {
      id: "tool-001",
      name: "INVALID_NAME!",
      version: "1.0.0",
      description: "Invalid name tool",
      entrypoint: "src/tools/tool.ts",
      status: "ACTIVE",
      telemetry: { totalInvocations: 0, successCount: 0, failureCount: 0, healthScore: 1.0 },
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
    }
    const resName = validateAgainstSchema(schema, invalidName)
    assert.strictEqual(resName.valid, false)
    assert.ok(resName.errors.some((e) => e.path.includes("name")))

    // Violation 2: invalid healthScore (> 1.0)
    const invalidHealth = {
      id: "tool-002",
      name: "tool_health",
      version: "1.0.0",
      description: "Invalid health score",
      entrypoint: "src/tools/tool.ts",
      status: "ACTIVE",
      telemetry: { totalInvocations: 0, successCount: 0, failureCount: 0, healthScore: 1.5 },
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
    }
    const resHealth = validateAgainstSchema(schema, invalidHealth)
    assert.strictEqual(resHealth.valid, false)
    assert.ok(resHealth.errors.some((e) => e.path.includes("healthScore")))

    // Violation 3: additionalProperties false
    const extraProperty = {
      id: "tool-003",
      name: "tool_extra",
      version: "1.0.0",
      description: "Tool with extra property",
      entrypoint: "src/tools/tool.ts",
      status: "ACTIVE",
      telemetry: { totalInvocations: 0, successCount: 0, failureCount: 0, healthScore: 1.0 },
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
      unauthorizedKey: "illegal",
    }
    const resExtra = validateAgainstSchema(schema, extraProperty)
    assert.strictEqual(resExtra.valid, false)
    assert.ok(resExtra.errors.some((e) => e.path.includes("unauthorizedKey")))
  })

  it("should load skill-package.schema.json and contain exactly the 7 contract lifecycle statuses", async () => {
    const raw = await fs.readFile(skillSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    assert.ok(schema.properties?.lifecycleStatus?.enum, "lifecycleStatus.enum must be defined in skill schema")
    const schemaStatuses: string[] = schema.properties.lifecycleStatus.enum

    assert.strictEqual(schemaStatuses.length, 7, "skill-package schema must declare exactly 7 statuses")
    assert.deepStrictEqual(
      schemaStatuses,
      expectedSkillStatuses,
      "skill-package schema lifecycleStatus enum must match SkillLifecycleStatus contract"
    )
  })

  it("should validate valid skill package metadata payloads for all 7 lifecycle statuses", async () => {
    const raw = await fs.readFile(skillSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    for (const status of expectedSkillStatuses) {
      const payload: SkillPackageMetadata = {
        id: `skill-${status.toLowerCase()}-001`,
        name: `test-skill-${status.toLowerCase()}`,
        version: "1.0.0",
        description: `Skill in ${status} status for testing`,
        triggers: ["test trigger", "intent phrase"],
        tags: ["testing", "lifecycle"],
        author: "dna-synthesizer",
        confidenceScore: 0.95,
        lifecycleStatus: status,
        scripts: ["scripts/helper.sh"],
        references: ["references/guide.md"],
        telemetry: {
          executionCount: 5,
          successCount: 5,
          failureCount: 0,
          lastAppliedAt: "2026-09-11T20:00:00.000Z",
        },
        createdAt: "2026-09-11T19:00:00.000Z",
        updatedAt: "2026-09-11T20:00:00.000Z",
      }

      const result = validateAgainstSchema(schema, payload)
      assert.strictEqual(
        result.valid,
        true,
        `Skill payload with lifecycleStatus "${status}" must pass validation. Errors: ${JSON.stringify(result.errors)}`
      )
    }
  })

  it("should reject skill payloads with invalid lifecycleStatus values", async () => {
    const raw = await fs.readFile(skillSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    const invalidStatuses = ["INVALID_STATUS", "DRAFT", "PROPOSED", "VALIDATING_AST", "UNKNOWN"]
    for (const invalidStatus of invalidStatuses) {
      const payload = {
        id: "skill-invalid-001",
        name: "test-skill-invalid",
        version: "1.0.0",
        description: "Skill with invalid status",
        triggers: ["trigger"],
        tags: ["tag"],
        confidenceScore: 0.8,
        lifecycleStatus: invalidStatus,
        createdAt: "2026-09-11T19:00:00.000Z",
        updatedAt: "2026-09-11T20:00:00.000Z",
      }

      const result = validateAgainstSchema(schema, payload)
      assert.strictEqual(
        result.valid,
        false,
        `Skill payload with invalid lifecycleStatus "${invalidStatus}" should be rejected`
      )
      assert.ok(
        result.errors.some((e) => e.path.includes("lifecycleStatus")),
        `Expected error at lifecycleStatus path, got: ${JSON.stringify(result.errors)}`
      )
    }
  })

  it("should reject skill payloads with structural or schema violations", async () => {
    const raw = await fs.readFile(skillSchemaPath, "utf-8")
    const schema = JSON.parse(raw)

    // Violation 1: triggers array is empty (violates minItems: 1)
    const emptyTriggers = {
      id: "skill-001",
      name: "test-skill",
      version: "1.0.0",
      description: "Skill with empty triggers",
      triggers: [],
      tags: ["tag"],
      confidenceScore: 0.8,
      lifecycleStatus: "ACTIVE",
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
    }
    const resTriggers = validateAgainstSchema(schema, emptyTriggers)
    assert.strictEqual(resTriggers.valid, false)
    assert.ok(resTriggers.errors.some((e) => e.path.includes("triggers")))

    // Violation 2: invalid name with underscores (violates pattern ^[a-z0-9-]+$)
    const invalidName = {
      id: "skill-002",
      name: "invalid_skill_name",
      version: "1.0.0",
      description: "Skill with invalid name pattern",
      triggers: ["trigger"],
      tags: ["tag"],
      confidenceScore: 0.8,
      lifecycleStatus: "ACTIVE",
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
    }
    const resName = validateAgainstSchema(schema, invalidName)
    assert.strictEqual(resName.valid, false)
    assert.ok(resName.errors.some((e) => e.path.includes("name")))

    // Violation 3: confidenceScore out of bounds (> 1.0)
    const invalidConfidence = {
      id: "skill-003",
      name: "test-skill",
      version: "1.0.0",
      description: "Skill with confidenceScore > 1.0",
      triggers: ["trigger"],
      tags: ["tag"],
      confidenceScore: 1.5,
      lifecycleStatus: "ACTIVE",
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
    }
    const resConf = validateAgainstSchema(schema, invalidConfidence)
    assert.strictEqual(resConf.valid, false)
    assert.ok(resConf.errors.some((e) => e.path.includes("confidenceScore")))

    // Violation 4: unexpected extra property
    const extraProperty = {
      id: "skill-004",
      name: "test-skill",
      version: "1.0.0",
      description: "Skill with forbidden extra field",
      triggers: ["trigger"],
      tags: ["tag"],
      confidenceScore: 0.8,
      lifecycleStatus: "ACTIVE",
      createdAt: "2026-09-11T19:00:00.000Z",
      updatedAt: "2026-09-11T20:00:00.000Z",
      forbiddenKey: "not_allowed",
    }
    const resExtra = validateAgainstSchema(schema, extraProperty)
    assert.strictEqual(resExtra.valid, false)
    assert.ok(resExtra.errors.some((e) => e.path.includes("forbiddenKey")))
  })
})
