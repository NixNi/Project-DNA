import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ILiveMemoryStore, MemoryCard } from "../../specs/contracts/live-memory.js"

export interface OpenMemoryPackage {
  version: string
  format: "open-memory-zettelkasten"
  exportedAt: string
  nodes: MemoryCard[]
}

export class OpenMemoryExporter {
  constructor(private memoryStore: ILiveMemoryStore) {}

  public async exportToFile(targetFilePath: string): Promise<void> {
    const jsonString = await this.memoryStore.exportOpenMemory()
    await fs.mkdir(path.dirname(targetFilePath), { recursive: true })
    await fs.writeFile(targetFilePath, jsonString, "utf-8")
  }

  public async importFromFile(sourceFilePath: string): Promise<number> {
    const rawContent = await fs.readFile(sourceFilePath, "utf-8")
    const pkg: OpenMemoryPackage = JSON.parse(rawContent)

    let importedCount = 0
    for (const node of pkg.nodes) {
      await this.memoryStore.createCard(
        {
          title: node.title,
          category: node.category,
          insight: node.insight,
          context: node.context,
          evidence: node.evidence,
          tags: node.tags,
        },
        node.sessionID
      )
      importedCount++
    }

    return importedCount
  }
}
