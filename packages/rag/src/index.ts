import { CORPUS_DOCUMENTS } from "./corpus.js";

export interface CorpusSection {
  id: string;
  title: string;
  source: string;
  content: string;
}

export interface Corpus {
  disease: string;
  sections: CorpusSection[];
}

export interface SearchOptions {
  topK?: number;
}

const CORPUS_MAP: Record<string, Corpus> = {};
for (const [disease, documents] of Object.entries(CORPUS_DOCUMENTS)) {
  CORPUS_MAP[disease] = loadFromDocuments(disease, documents);
}

export function loadDiseaseCorpus(disease: string): Corpus {
  return CORPUS_MAP[disease.toLowerCase()] ?? { disease, sections: [] };
}

export function searchCorpus(corpus: Corpus, query: string, options: SearchOptions = {}): CorpusSection[] {
  const topK = options.topK ?? 3;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return corpus.sections.slice(0, topK);

  const scored = corpus.sections.map((section) => {
    const text = `${section.title}\n${section.content}`.toLowerCase();
    const terms = tokenize(text);
    const termCounts = new Map<string, number>();
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const count = termCounts.get(term) ?? 0;
      if (count > 0) {
        const idf = Math.log(1 + corpus.sections.length / (1 + [...termCounts.values()].filter((c) => c > 0).length));
        score += count * idf;
      }
    }

    const titleTerms = tokenize(section.title);
    for (const term of queryTerms) {
      if (titleTerms.includes(term)) score += 2;
    }

    return { section, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.section);
}

function loadFromDocuments(disease: string, documents: { source: string; content: string }[]): Corpus {
  const sections: CorpusSection[] = [];
  for (const doc of documents) {
    const fileSections = splitMarkdown(doc.content, doc.source);
    sections.push(...fileSections);
  }
  return { disease, sections };
}

function splitMarkdown(markdown: string, source: string): CorpusSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: CorpusSection[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];
  let sectionIndex = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({
          id: `${source.replace(/\.md$/, "")}-${sectionIndex}`,
          title: currentTitle,
          source,
          content: currentLines.join("\n").trim(),
        });
        sectionIndex++;
      }
      currentTitle = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentTitle) {
    sections.push({
      id: `${source.replace(/\.md$/, "")}-${sectionIndex}`,
      title: currentTitle,
      source,
      content: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
