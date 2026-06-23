#!/usr/bin/env tsx
/**
 * RAG Corpus reindex script.
 *
 * Reads Markdown files from packages/rag/documents/<disease>/ and regenerates
 * packages/rag/src/corpus.ts. Run after editing strategy documents.
 *
 * Usage:
 *   pnpm corpus:reindex
 */
import fs from "node:fs/promises";
import path from "node:path";

const DOCUMENTS_DIR = path.resolve(process.cwd(), "documents");
const OUTPUT_FILE = path.resolve(process.cwd(), "src", "corpus.ts");

async function main() {
  const diseases = await fs.readdir(DOCUMENTS_DIR);
  const imports: string[] = [];
  const entries: string[] = [];

  for (const disease of diseases) {
    const diseaseDir = path.join(DOCUMENTS_DIR, disease);
    const stat = await fs.stat(diseaseDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const files = await fs.readdir(diseaseDir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

    const docs: { source: string; content: string }[] = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(diseaseDir, file), "utf-8");
      docs.push({ source: file, content });
    }

    const varName = `${disease.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CORPUS`;
    imports.push(`const ${varName}: CorpusDocument[] = ${JSON.stringify(docs, null, 2)};`);
    entries.push(`  ${disease}: ${varName},`);
  }

  const output = `export interface CorpusDocument {
  source: string;
  content: string;
}

${imports.join("\n\n")}

export const CORPUS_DOCUMENTS: Record<string, CorpusDocument[]> = {
${entries.join("\n")}
};
`;

  await fs.writeFile(OUTPUT_FILE, output, "utf-8");
  console.log(`Reindexed ${entries.length} disease corpus(es) into ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
