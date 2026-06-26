// Academic deep-research pipeline. Migrated from the standalone
// academic-deep-research project so the same 6-stage pipeline (plan → search
// → relevance → OA-resolve → fulltext → synthesize → verify → render) is
// callable as glm__academic / deepseek__academic / kimi__academic via the MCP
// server. Stages 2 (search) and 3-5 (OA + fulltext) are pure HTTP. Stages 1
// (plan), 2.5 (relevance), 6 (synthesize), 7 (verify) accept any LlmClient;
// per-stage models default to per-provider choices set in tool-catalog and
// can be overridden via opts.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseLlmJson } from "./llm-json.js";
import type { LlmClient } from "./providers/types.js";

const RELEVANCE_TOP_K = Number(process.env.ACADEMIC_RELEVANCE_TOP_K ?? "15");
const PER_QUERY_LIMIT = 15;
const TOTAL_PAPER_LIMIT = Number(process.env.ACADEMIC_TOTAL_PAPER_LIMIT ?? "80");
const MAILTO = process.env.OPENALEX_MAILTO ?? "research@example.com";
const PLAN_CACHE_DIR =
  process.env.ACADEMIC_PLAN_CACHE_DIR ?? join(homedir(), ".claude", "agentmcp-academic-cache");

interface Paper {
  paperId: string;
  title: string;
  abstract: string;
  authors: string[];
  year: number;
  venue?: string | undefined;
  citationCount: number;
  url: string;
  source:
    | "s2"
    | "openalex"
    | "arxiv"
    | "core"
    | "europepmc"
    | "crossref"
    | "osti"
    | "ntrs"
    | "doaj";
  pmcid?: string | undefined;
  fulltextUrl?: string | undefined;
  fulltext?: string | undefined;
  fundedBy?: string[] | undefined;
}

// JSON-shaped LLM call. Wraps LlmClient.call with a Zod schema, fence-tolerant
// parser, and a one-shot repair retry. Mirrors the standalone project's
// jsonCall but routes through agentmcp's provider abstraction instead of a
// raw OpenAI SDK pointed at Z.ai. Repair attempt bumps temperature to give
// the model entropy to escape a deterministic-bad output.
async function jsonCall<T extends z.ZodTypeAny>(
  client: LlmClient,
  opts: {
    model: string;
    system: string;
    user: string;
    schema: T;
    schemaName: string;
    schemaHint: string;
    thinking?: boolean;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<z.infer<T>> {
  const sys = `${opts.system}\n\nRespond with a single JSON object. Schema:\n${opts.schemaHint}\n\nOutput only the JSON object — no markdown fences, no preamble. Strings inside JSON must escape any internal double quotes as \\".`;
  const thinking = opts.thinking ?? false;
  const baseTemp = opts.temperature ?? (thinking ? 1.0 : 0);
  const maxTokens = opts.maxTokens ?? 16000;

  let lastError = "";
  let userPrompt = opts.user;

  for (let attempt = 0; attempt < 2; attempt++) {
    const temperature = attempt === 0 ? baseTemp : Math.max(baseTemp, 0.3);
    const result = await client.call({
      systemPrompt: sys,
      userPrompt,
      maxOutputTokens: maxTokens,
      temperature,
      thinking,
      format: "json",
      model: opts.model,
    });
    const content = result.content;
    const finishReason = result.finishReason;
    if (!content || content.trim() === "") {
      throw new Error(
        `Empty content (finish_reason=${finishReason}, completion_tokens=${result.outputTokens}). ` +
          `Likely reasoning_content consumed max_tokens. Bump maxTokens.`,
      );
    }
    const parsed = parseLlmJson(content);
    if ("ok" in parsed) {
      try {
        return opts.schema.parse(parsed.ok);
      } catch (err) {
        lastError = `schema validation failed: ${(err as Error).message}`;
      }
    } else {
      lastError = `${parsed.err.kind}: ${parsed.err.message}`;
    }
    if (finishReason === "length") {
      throw new Error(
        `Output truncated at max_tokens=${maxTokens} (finish_reason=length). Bump maxTokens or trim corpus.`,
      );
    }
    if (attempt === 0) {
      console.error(
        `[jsonCall] parse failed on attempt 1 (${lastError.slice(0, 80)}); retrying with repair instruction`,
      );
      userPrompt = `${opts.user}\n\n---\n\nYour previous response was not valid JSON: ${lastError.slice(0, 300)}\n\nReturn ONLY a corrected JSON object that matches the schema. No prose, no markdown.`;
    }
  }
  throw new Error(`Model returned invalid JSON after retry: ${lastError.slice(0, 200)}`);
}

// ------- Stage 1: Plan -------

const PlanSchema = z.object({
  queries: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe("Diverse, keyword-style search queries that decompose the question."),
});

function planCachePath(question: string, planModel: string): string {
  const hash = createHash("sha256").update(`${planModel}\n${question}`).digest("hex").slice(0, 16);
  return join(PLAN_CACHE_DIR, `${hash}.json`);
}

function readPlanCache(question: string, planModel: string): string[] | undefined {
  if (process.env.SKIP_PLAN_CACHE === "1") return undefined;
  const p = planCachePath(question, planModel);
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as {
      question: string;
      model: string;
      queries: string[];
    };
    if (data.question !== question || data.model !== planModel) return undefined;
    return data.queries;
  } catch {
    return undefined;
  }
}

function writePlanCache(question: string, planModel: string, queries: string[]): void {
  if (process.env.SKIP_PLAN_CACHE === "1") return;
  try {
    mkdirSync(PLAN_CACHE_DIR, { recursive: true });
    writeFileSync(
      planCachePath(question, planModel),
      JSON.stringify(
        { question, model: planModel, queries, cachedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(`[plan-cache] write failed: ${(err as Error).message}`);
  }
}

async function plan(question: string, client: LlmClient, planModel: string): Promise<string[]> {
  const cached = readPlanCache(question, planModel);
  if (cached) {
    console.error(`[plan] cache hit (${cached.length} queries)`);
    return cached;
  }
  const out = await jsonCall(client, {
    model: planModel,
    system:
      "You are a research librarian. Decompose research questions into 3-5 diverse, keyword-style search queries that together cover the question's scope. Queries should be 3-8 words each, not full sentences.",
    user: `Decompose this question:\n\n${question}`,
    schema: PlanSchema,
    schemaName: "ResearchPlan",
    schemaHint: `{ "queries": ["query1", "query2", "query3"] }  // 3-5 items, each 3-8 words`,
    maxTokens: 4096,
  });
  writePlanCache(question, planModel, out.queries);
  return out.queries;
}

// ------- Stage 2: Search (Semantic Scholar + OpenAlex) -------

async function searchS2(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set(
    "fields",
    "paperId,title,abstract,authors.name,year,venue,citationCount,externalIds,url",
  );
  const headers: Record<string, string> = {
    "User-Agent": `academic-deep-research/0.2 (mailto:${MAILTO})`,
  };
  if (process.env.S2_API_KEY) headers["x-api-key"] = process.env.S2_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(
      `[s2] "${query}" -> ${res.status}${process.env.S2_API_KEY ? "" : " (set S2_API_KEY for higher limits)"}`,
    );
    return [];
  }
  const data = (await res.json()) as {
    data?: Array<{
      paperId: string;
      title: string;
      abstract: string | null;
      authors: Array<{ name: string }>;
      year: number | null;
      venue: string | null;
      citationCount: number | null;
      externalIds?: { DOI?: string };
      url: string;
    }>;
  };
  return (data.data ?? [])
    .filter((p) => p.abstract && p.title)
    .map((p) => ({
      paperId: p.externalIds?.DOI ? `doi:${p.externalIds.DOI}` : `s2:${p.paperId}`,
      title: p.title,
      abstract: p.abstract!,
      authors: p.authors.map((a) => a.name),
      year: p.year ?? 0,
      venue: p.venue ?? undefined,
      citationCount: p.citationCount ?? 0,
      url: p.url,
      source: "s2" as const,
    }));
}

async function searchOpenAlex(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set(
    "select",
    "id,doi,title,abstract_inverted_index,authorships,publication_year,primary_location,cited_by_count,open_access",
  );
  url.searchParams.set("mailto", MAILTO);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[openalex] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    results: Array<{
      id: string;
      doi: string | null;
      title: string;
      abstract_inverted_index: Record<string, number[]> | null;
      authorships: Array<{ author: { display_name: string } }>;
      publication_year: number | null;
      primary_location?: { source?: { display_name?: string } | null; pdf_url?: string | null };
      cited_by_count: number;
      open_access?: { is_oa?: boolean; oa_url?: string | null };
    }>;
  };
  return data.results
    .filter((p) => p.abstract_inverted_index && p.title)
    .map((p) => {
      const oaUrl = p.open_access?.is_oa
        ? (p.primary_location?.pdf_url ?? p.open_access.oa_url ?? undefined)
        : undefined;
      return {
        paperId: p.doi
          ? `doi:${p.doi.replace(/^https?:\/\/doi\.org\//, "")}`
          : `openalex:${p.id.split("/").pop()}`,
        title: p.title,
        abstract: reconstructAbstract(p.abstract_inverted_index!),
        authors: p.authorships.map((a) => a.author.display_name),
        year: p.publication_year ?? 0,
        venue: p.primary_location?.source?.display_name,
        citationCount: p.cited_by_count,
        url: p.doi ?? p.id,
        source: "openalex" as const,
        fulltextUrl: oaUrl ?? undefined,
      };
    });
}

async function searchCore(query: string, limit: number): Promise<Paper[]> {
  const apiKey = process.env.CORE_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.core.ac.uk/v3/search/works", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, limit }),
  });
  if (!res.ok) {
    console.error(`[core] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    results?: Array<{
      id: number;
      doi: string | null;
      title: string | null;
      abstract: string | null;
      authors: Array<{ name: string }>;
      yearPublished: number | null;
      publisher: string | null;
      downloadUrl: string | null;
    }>;
  };
  return (data.results ?? [])
    .filter((p) => p.title && p.abstract)
    .map((p) => ({
      paperId: p.doi ? `doi:${p.doi.replace(/^https?:\/\/doi\.org\//, "")}` : `core:${p.id}`,
      title: p.title!,
      abstract: p.abstract!,
      authors: p.authors.map((a) => a.name),
      year: p.yearPublished ?? 0,
      venue: p.publisher ?? undefined,
      citationCount: 0,
      url: p.downloadUrl ?? `https://core.ac.uk/works/${p.id}`,
      source: "core" as const,
    }));
}

async function searchDoaj(query: string, limit: number): Promise<Paper[]> {
  // DOAJ public search API: no key required. Path-encoded query.
  // Docs: https://doaj.org/api/v3/docs#articles
  const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${Math.min(limit, 100)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error(`[doaj] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    results?: Array<{
      id: string;
      bibjson?: {
        title?: string;
        abstract?: string;
        year?: string | number;
        author?: Array<{ name?: string }>;
        journal?: { title?: string; publisher?: string };
        identifier?: Array<{ type?: string; id?: string }>;
        link?: Array<{ type?: string; url?: string; content_type?: string }>;
      };
    }>;
  };
  return (data.results ?? [])
    .filter((r) => r.bibjson?.title && r.bibjson?.abstract)
    .map((r) => {
      const bj = r.bibjson!;
      const doi = bj.identifier?.find((i) => i.type?.toLowerCase() === "doi")?.id;
      const fulltextLink = bj.link?.find((l) => l.type?.toLowerCase() === "fulltext" && l.url);
      const yearNum =
        typeof bj.year === "number"
          ? bj.year
          : typeof bj.year === "string"
            ? parseInt(bj.year, 10) || 0
            : 0;
      const isPdf =
        fulltextLink?.content_type?.toLowerCase() === "pdf" ||
        /\.pdf(?:[?#]|$)/i.test(fulltextLink?.url ?? "");
      return {
        paperId: doi ? `doi:${doi.replace(/^https?:\/\/doi\.org\//i, "")}` : `doaj:${r.id}`,
        title: bj.title!,
        abstract: bj.abstract!,
        authors: (bj.author ?? []).map((a) => a.name ?? "").filter(Boolean),
        year: yearNum,
        venue: bj.journal?.title ?? bj.journal?.publisher ?? undefined,
        citationCount: 0,
        url: fulltextLink?.url ?? `https://doaj.org/article/${r.id}`,
        source: "doaj" as const,
        ...(isPdf && fulltextLink?.url ? { fulltextUrl: fulltextLink.url } : {}),
      };
    });
}

const FEDERAL_FUNDER_DOIS: Record<string, string> = {
  "10.13039/100000002": "NIH",
  "10.13039/100000001": "NSF",
  "10.13039/100000015": "DOE",
  "10.13039/100000104": "NASA",
  "10.13039/100000199": "USDA",
  "10.13039/100000928": "ARPA-E",
  "10.13039/100000038": "USAID",
  "10.13039/100006112": "DARPA",
  "10.13039/100000139": "EPA",
  "10.13039/100000162": "NIST",
};

async function searchOsti(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://www.osti.gov/api/v1/records");
  url.searchParams.set("q", query);
  url.searchParams.set("rows", String(limit));
  url.searchParams.set("format", "json");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error(`[osti] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as Array<{
    osti_id: string;
    doi?: string;
    title?: string;
    description?: string;
    authors?: string[];
    publication_date?: string;
    journal_name?: string;
    sponsor_orgs?: string[];
    links?: Array<{ rel: string; href: string }>;
  }>;
  return data
    .filter((p) => p.title && p.description)
    .map((p) => {
      const fulltextHref = p.links?.find((l) => l.rel === "fulltext")?.href;
      return {
        paperId: p.doi ? `doi:${p.doi.replace(/^https?:\/\/doi\.org\//, "")}` : `osti:${p.osti_id}`,
        title: p.title!,
        abstract: p.description!,
        authors: (p.authors ?? []).map((a) =>
          a
            .replace(/\s*\[[^\]]+\]\s*/g, "")
            .replace(/\s*\(ORCID:[^)]+\)\s*/g, "")
            .trim(),
        ),
        year: parseInt((p.publication_date ?? "").slice(0, 4), 10) || 0,
        venue: p.journal_name ?? "DOE OSTI",
        citationCount: 0,
        url: fulltextHref ?? `https://www.osti.gov/biblio/${p.osti_id}`,
        source: "osti" as const,
        fulltextUrl: fulltextHref,
        fundedBy: deriveFedFunders(p.sponsor_orgs ?? ["DOE"]),
      };
    });
}

async function searchNtrs(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://ntrs.nasa.gov/api/citations/search");
  url.searchParams.set("q", query);
  url.searchParams.set("size", String(limit));
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error(`[ntrs] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    results?: Array<{
      id: number;
      title?: string;
      abstract?: string;
      authorAffiliations?: Array<{ meta?: { author?: { name?: string } } }>;
      publications?: Array<{ publicationDate?: string; publisher?: string }>;
      center?: { name?: string };
      downloads?: Array<{ links?: { fulltext?: string; pdf?: string } }>;
      downloadsAvailable?: boolean;
    }>;
  };
  return (data.results ?? [])
    .filter((p) => p.title && p.abstract)
    .map((p) => {
      const fulltextRel = p.downloads?.[0]?.links?.fulltext;
      const fulltextUrl = fulltextRel ? `https://ntrs.nasa.gov${fulltextRel}` : undefined;
      const venue = p.center?.name ? `NASA ${p.center.name}` : "NASA NTRS";
      return {
        paperId: `ntrs:${p.id}`,
        title: p.title!,
        abstract: p.abstract!,
        authors: (p.authorAffiliations ?? [])
          .map((a) => a.meta?.author?.name ?? "")
          .filter(Boolean),
        year: parseInt((p.publications?.[0]?.publicationDate ?? "").slice(0, 4), 10) || 0,
        venue,
        citationCount: 0,
        url: `https://ntrs.nasa.gov/citations/${p.id}`,
        source: "ntrs" as const,
        fulltextUrl,
        fundedBy: ["NASA"],
      };
    });
}

function deriveFedFunders(sponsors: string[]): string[] {
  const tags = new Set<string>();
  for (const s of sponsors) {
    const u = s.toUpperCase();
    if (u.includes("DOE")) tags.add("DOE");
    if (u.includes("NSF")) tags.add("NSF");
    if (u.includes("NIH")) tags.add("NIH");
    if (u.includes("NASA")) tags.add("NASA");
    if (u.includes("USDA")) tags.add("USDA");
    if (u.includes("DARPA")) tags.add("DARPA");
    if (u.includes("EPA")) tags.add("EPA");
    if (u.includes("ARPA-E")) tags.add("ARPA-E");
  }
  return tags.size > 0 ? [...tags] : ["DOE"];
}

async function searchCrossref(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query);
  url.searchParams.set("rows", String(limit));
  url.searchParams.set(
    "select",
    "DOI,title,abstract,author,issued,container-title,publisher,is-referenced-by-count,URL,funder",
  );
  const res = await fetch(url, {
    headers: {
      "User-Agent": `academic-deep-research/0.4 (mailto:${MAILTO})`,
    },
  });
  if (!res.ok) {
    console.error(`[crossref] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    message?: {
      items?: Array<{
        DOI: string;
        title?: string[];
        abstract?: string;
        author?: Array<{ given?: string; family?: string; name?: string }>;
        issued?: { "date-parts"?: number[][] };
        "container-title"?: string[];
        publisher?: string;
        "is-referenced-by-count"?: number;
        URL?: string;
        funder?: Array<{ DOI?: string; name?: string }>;
      }>;
    };
  };
  return (data.message?.items ?? [])
    .filter((p) => p.title?.[0] && p.abstract)
    .map((p) => ({
      paperId: `doi:${p.DOI}`,
      title: p.title![0]!,
      abstract: stripJatsTags(p.abstract!),
      authors: (p.author ?? []).map((a) => a.name ?? `${a.given ?? ""} ${a.family ?? ""}`.trim()),
      year: p.issued?.["date-parts"]?.[0]?.[0] ?? 0,
      venue: p["container-title"]?.[0] ?? p.publisher,
      citationCount: p["is-referenced-by-count"] ?? 0,
      url: p.URL ?? `https://doi.org/${p.DOI}`,
      source: "crossref" as const,
      fundedBy: tagFederalFunders(p.funder ?? []),
    }));
}

function tagFederalFunders(funders: Array<{ DOI?: string; name?: string }>): string[] {
  const tags = new Set<string>();
  for (const f of funders) {
    if (f.DOI && FEDERAL_FUNDER_DOIS[f.DOI]) tags.add(FEDERAL_FUNDER_DOIS[f.DOI]!);
    else if (f.name) {
      const upper = f.name.toUpperCase();
      for (const agency of ["NIH", "NSF", "DOE", "NASA", "USDA", "DARPA", "EPA"]) {
        if (upper.includes(agency)) tags.add(agency);
      }
    }
  }
  return tags.size > 0 ? [...tags] : [];
}

function stripJatsTags(s: string): string {
  return s
    .replace(/<jats:[^>]+>/g, "")
    .replace(/<\/jats:[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchEuropePMC(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("resultType", "core");
  url.searchParams.set("email", MAILTO);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[europepmc] "${query}" -> ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    resultList?: {
      result: Array<{
        id: string;
        source: string;
        doi?: string;
        pmcid?: string;
        title?: string;
        abstractText?: string;
        authorString?: string;
        pubYear?: string;
        journalTitle?: string;
        citedByCount?: number;
        grantsList?: { grant?: Array<{ agency?: string }> };
      }>;
    };
  };
  return (data.resultList?.result ?? [])
    .filter((p) => p.title && p.abstractText)
    .map((p) => {
      const grantAgencies = (p.grantsList?.grant ?? [])
        .map((g) => (g.agency ?? "").toUpperCase())
        .filter(Boolean);
      const fed = new Set<string>();
      for (const a of grantAgencies) {
        for (const tag of ["NIH", "NSF", "DOE", "NASA", "USDA", "DARPA", "EPA"]) {
          if (a.includes(tag)) fed.add(tag);
        }
      }
      return {
        paperId: p.doi ? `doi:${p.doi}` : `europepmc:${p.source}:${p.id}`,
        title: p.title!,
        abstract: p.abstractText!,
        authors: (p.authorString ?? "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        year: parseInt(p.pubYear ?? "0", 10) || 0,
        venue: p.journalTitle ?? undefined,
        citationCount: p.citedByCount ?? 0,
        url: p.doi
          ? `https://doi.org/${p.doi}`
          : `https://europepmc.org/article/${p.source}/${p.id}`,
        source: "europepmc" as const,
        pmcid: p.pmcid,
        fundedBy: fed.size > 0 ? [...fed] : undefined,
      };
    });
}

async function searchArxiv(query: string, limit: number): Promise<Paper[]> {
  const url = new URL("http://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("max_results", String(limit));
  url.searchParams.set("sortBy", "relevance");
  url.searchParams.set("sortOrder", "descending");
  const res = await fetch(url, {
    headers: { "User-Agent": `academic-deep-research/0.2 (mailto:${MAILTO})` },
  });
  if (!res.ok) {
    console.error(`[arxiv] "${query}" -> ${res.status}`);
    return [];
  }
  const xml = await res.text();
  return parseArxivAtom(xml);
}

function parseArxivAtom(xml: string): Paper[] {
  const entries = xml
    .split(/<entry>/)
    .slice(1)
    .map((s) => s.split(/<\/entry>/)[0] ?? "");
  const papers: Paper[] = [];
  for (const e of entries) {
    const id = textOf(e, "id");
    const title = collapse(textOf(e, "title"));
    const abstract = collapse(textOf(e, "summary"));
    const published = textOf(e, "published");
    const doi = textOf(e, "arxiv:doi") || textOf(e, "doi");
    if (!title || !abstract || !id) continue;
    const authors = [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((m) => m[1]!.trim());
    const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    const year = parseInt(published.slice(0, 4), 10) || 0;
    papers.push({
      paperId: doi ? `doi:${doi}` : `arxiv:${arxivId}`,
      title,
      abstract,
      authors,
      year,
      venue: "arXiv preprint",
      citationCount: 0,
      url: `https://arxiv.org/abs/${arxivId}`,
      source: "arxiv",
      fulltextUrl: `https://arxiv.org/pdf/${arxivId}`,
    });
  }
  return papers;
}

function textOf(xml: string, tag: string): string {
  const re = new RegExp(
    `<${tag.replace(":", "\\:")}[^>]*>([\\s\\S]*?)<\\/${tag.replace(":", "\\:")}>`,
  );
  const m = xml.match(re);
  return m ? decodeXml(m[1]!.trim()) : "";
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function reconstructAbstract(idx: Record<string, number[]>): string {
  const positions: Array<[number, string]> = [];
  for (const [word, posList] of Object.entries(idx)) {
    for (const pos of posList) positions.push([pos, word]);
  }
  positions.sort(([a], [b]) => a - b);
  return positions.map(([, w]) => w).join(" ");
}

function dedupePapers(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>();
  for (const p of papers) {
    const key = p.paperId.startsWith("doi:") ? p.paperId : p.title.toLowerCase().slice(0, 120);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, p);
      continue;
    }
    const winner = p.citationCount > existing.citationCount ? p : existing;
    const loser = winner === p ? existing : p;
    seen.set(key, {
      ...winner,
      pmcid: winner.pmcid ?? loser.pmcid,
      fulltextUrl: winner.fulltextUrl ?? loser.fulltextUrl,
      fundedBy: mergeFunders(winner.fundedBy, loser.fundedBy),
    });
  }
  return [...seen.values()].sort((a, b) => b.citationCount - a.citationCount);
}

function mergeFunders(a?: string[], b?: string[]): string[] | undefined {
  const merged = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return merged.size > 0 ? [...merged] : undefined;
}

// ------- Stage 2.6: Unpaywall OA URL resolution (DOI → OA fulltext URL) -------

async function enrichWithOAUrls(papers: Paper[]): Promise<{
  tried: number;
  resolved: number;
  viaUnpaywall: number;
  viaOpenAlex: number;
  skipped: boolean;
}> {
  const candidates = papers.filter(
    (p) => !p.fulltextUrl && !p.pmcid && p.paperId.startsWith("doi:"),
  );
  const unpaywallEnabled = !!UNPAYWALL_EMAIL && !UNPAYWALL_EMAIL.endsWith("@example.com");
  if (!unpaywallEnabled && candidates.length === 0) {
    return { tried: 0, resolved: 0, viaUnpaywall: 0, viaOpenAlex: 0, skipped: true };
  }
  if (candidates.length === 0) {
    return { tried: 0, resolved: 0, viaUnpaywall: 0, viaOpenAlex: 0, skipped: false };
  }

  let tried = 0;
  let resolved = 0;
  let viaUnpaywall = 0;
  let viaOpenAlex = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const p = candidates[i]!;
      tried++;
      const doi = p.paperId.slice(4);
      let oaUrl: string | undefined;
      if (unpaywallEnabled) {
        try {
          oaUrl = await resolveDoiOaUrlUnpaywall(doi);
        } catch {
          /* swallow — Unpaywall transient errors shouldn't fail the pipeline */
        }
        if (oaUrl) {
          p.fulltextUrl = oaUrl;
          resolved++;
          viaUnpaywall++;
          continue;
        }
      }
      try {
        oaUrl = await resolveDoiOaUrlOpenAlex(doi);
      } catch {
        /* swallow */
      }
      if (oaUrl) {
        p.fulltextUrl = oaUrl;
        resolved++;
        viaOpenAlex++;
      }
    }
  }

  await Promise.all(Array.from({ length: UNPAYWALL_CONCURRENCY }, () => worker()));
  return { tried, resolved, viaUnpaywall, viaOpenAlex, skipped: false };
}

async function resolveDoiOaUrlUnpaywall(doi: string): Promise<string | undefined> {
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL!)}`;
  const ctrl = AbortSignal.timeout(8000);
  const res = await fetch(url, { signal: ctrl });
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    is_oa?: boolean;
    best_oa_location?: { url_for_pdf?: string; url?: string };
  };
  if (!data.is_oa) return undefined;
  return data.best_oa_location?.url_for_pdf ?? data.best_oa_location?.url;
}

async function resolveDoiOaUrlOpenAlex(doi: string): Promise<string | undefined> {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=open_access,primary_location&mailto=${encodeURIComponent(MAILTO)}`;
  const ctrl = AbortSignal.timeout(8000);
  const res = await fetch(url, { signal: ctrl });
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    open_access?: { is_oa?: boolean; oa_url?: string | null };
    primary_location?: { pdf_url?: string | null };
  };
  if (!data.open_access?.is_oa) return undefined;
  return data.primary_location?.pdf_url ?? data.open_access.oa_url ?? undefined;
}

// ------- Stage 2.65: Sci-Hub DOI → PDF resolution (closed-access rescue) -------

const SCIHUB_MIRRORS_DEFAULT = ["https://sci-hub.se", "https://sci-hub.ru", "https://sci-hub.st"];
const SCIHUB_MIRRORS =
  process.env.SCIHUB_MIRRORS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? SCIHUB_MIRRORS_DEFAULT;
const SCIHUB_CONCURRENCY = Number(process.env.SCIHUB_CONCURRENCY ?? "4");
const SCIHUB_TIMEOUT_MS = Number(process.env.SCIHUB_TIMEOUT_MS ?? "10000");
const SCIHUB_UA =
  process.env.SCIHUB_UA ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function enrichWithSciHubUrls(
  papers: Paper[],
): Promise<{ tried: number; resolved: number; perMirror: Record<string, number> }> {
  const candidates = papers.filter(
    (p) => !p.fulltextUrl && !p.pmcid && p.paperId.startsWith("doi:"),
  );
  const perMirror: Record<string, number> = {};
  if (candidates.length === 0) return { tried: 0, resolved: 0, perMirror };

  let tried = 0;
  let resolved = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const p = candidates[i]!;
      tried++;
      const doi = p.paperId.slice(4);
      const hit = await resolveDoiViaSciHub(doi);
      if (hit) {
        p.fulltextUrl = hit.url;
        resolved++;
        perMirror[hit.mirror] = (perMirror[hit.mirror] ?? 0) + 1;
      }
    }
  }
  await Promise.all(Array.from({ length: SCIHUB_CONCURRENCY }, () => worker()));
  return { tried, resolved, perMirror };
}

async function resolveDoiViaSciHub(
  doi: string,
): Promise<{ url: string; mirror: string } | undefined> {
  for (const mirror of SCIHUB_MIRRORS) {
    try {
      const res = await fetch(`${mirror}/${encodeURIComponent(doi)}`, {
        signal: AbortSignal.timeout(SCIHUB_TIMEOUT_MS),
        headers: { "User-Agent": SCIHUB_UA, Accept: "text/html,*/*" },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.includes("html")) continue;
      const html = await res.text();
      const pdfUrl = extractSciHubPdfUrl(html, mirror);
      if (pdfUrl) return { url: pdfUrl, mirror };
    } catch {
      /* swallow — try next mirror */
    }
  }
  return undefined;
}

function extractSciHubPdfUrl(html: string, mirror: string): string | undefined {
  // Modern Sci-Hub renders PDFs via JS (no <embed>/<iframe>), but the storage URL
  // still appears as a `src=` / `href=` attribute on whatever container the page uses.
  // Prefer URLs under /storage/ (Sci-Hub's PDF cache convention), then fall back to
  // any quoted URL ending in .pdf.
  const patterns = [
    /(?:src|href)\s*=\s*["']([^"']*\/storage\/[^"']+\.pdf(?:[?#][^"']*)?)["']/i,
    /(?:src|href)\s*=\s*["']([^"']+\.pdf(?:[?#][^"']*)?)["']/i,
    /["']([^"']*\/storage\/[^"']+\.pdf(?:[?#][^"']*)?)["']/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return resolveSciHubUrl(m[1], mirror);
  }
  return undefined;
}

function resolveSciHubUrl(raw: string, mirror: string): string {
  const cleaned = raw.replace(/#.*$/, "");
  if (cleaned.startsWith("//")) return `https:${cleaned}`;
  if (cleaned.startsWith("/")) return `${mirror}${cleaned}`;
  return cleaned;
}

// ------- Stage 2.66: Anna's Archive DOI → fulltext rescue (Sci-Hub fallback) -------
//
// Anna's Archive sits behind a JS adblock-detect / Cloudflare layer that plain
// `fetch` can't pass. We route through FlareSolverr (POST cmd=request.get) when
// FLARESOLVERR_URL is set; otherwise fall back to direct fetch (which mostly
// fails on real Anna's mirrors but is fine for testing or future relaxation).
//
// Without a member API key, Anna's doesn't expose a direct PDF URL — the scidb
// page links to slow_download / fast_download gateways behind captcha or
// membership. We surface the scidb URL itself when the paper exists, so the
// user gets a working click-through link in citations even though the
// pipeline's PDF auto-fetcher won't be able to extract it.
//
// If ANNAS_ARCHIVE_API_KEY is set (paid member), we additionally try the
// member fast_download.json endpoint to obtain a direct CDN URL that the PDF
// fetcher can consume.

const ANNAS_MIRRORS_DEFAULT = [
  "https://annas-archive.pk",
  "https://annas-archive.gd",
  "https://annas-archive.gl",
];
const ANNAS_MIRRORS =
  process.env.ANNAS_MIRRORS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? ANNAS_MIRRORS_DEFAULT;
const ANNAS_API_KEY = process.env.ANNAS_ARCHIVE_API_KEY ?? null;
const ANNAS_CONCURRENCY = Number(process.env.ANNAS_CONCURRENCY ?? "2");
const ANNAS_TIMEOUT_MS = Number(process.env.ANNAS_TIMEOUT_MS ?? "60000");
const ANNAS_UA =
  process.env.ANNAS_UA ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL ?? null;
const FLARESOLVERR_WAIT_S = Number(process.env.FLARESOLVERR_WAIT_S ?? "3");

async function enrichWithAnnasArchiveUrls(
  papers: Paper[],
): Promise<{ tried: number; resolved: number; viaMember: number; viaScidb: number }> {
  const candidates = papers.filter(
    (p) => !p.fulltextUrl && !p.pmcid && p.paperId.startsWith("doi:"),
  );
  if (candidates.length === 0) {
    return { tried: 0, resolved: 0, viaMember: 0, viaScidb: 0 };
  }

  let tried = 0;
  let resolved = 0;
  let viaMember = 0;
  let viaScidb = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const p = candidates[i]!;
      tried++;
      const doi = p.paperId.slice(4);
      const hit = await resolveDoiViaAnnasArchive(doi);
      if (hit) {
        p.fulltextUrl = hit.url;
        resolved++;
        if (hit.via === "member") viaMember++;
        else viaScidb++;
      }
    }
  }
  await Promise.all(Array.from({ length: ANNAS_CONCURRENCY }, () => worker()));
  return { tried, resolved, viaMember, viaScidb };
}

async function resolveDoiViaAnnasArchive(
  doi: string,
): Promise<{ url: string; via: "member" | "scidb" } | undefined> {
  for (const mirror of ANNAS_MIRRORS) {
    const scidbUrl = `${mirror}/scidb/${encodeURIComponent(doi)}`;
    const html = await fetchAnnasHtml(scidbUrl);
    if (!html) continue;
    // "No results" guard — page renders an empty state for unknown DOIs.
    if (/no\s+results|not\s+available|sorry/i.test(html.slice(0, 4000)) && !/\/md5\//.test(html)) {
      return undefined;
    }
    const md5 = extractAnnasMd5(html);
    if (!md5) continue;

    // Member-key path: get a direct CDN URL the PDF fetcher can consume.
    if (ANNAS_API_KEY) {
      try {
        const apiUrl = `${mirror}/dyn/api/fast_download.json?md5=${md5}&key=${encodeURIComponent(ANNAS_API_KEY)}`;
        const apiBody = await fetchAnnasHtml(apiUrl);
        if (apiBody) {
          const data = JSON.parse(apiBody) as { download_url?: string };
          if (data.download_url) return { url: data.download_url, via: "member" };
        }
      } catch {
        /* fall through to scidb URL */
      }
    }
    return { url: scidbUrl, via: "scidb" };
  }
  return undefined;
}

async function fetchAnnasHtml(url: string): Promise<string | undefined> {
  if (FLARESOLVERR_URL) {
    try {
      const res = await fetch(`${FLARESOLVERR_URL.replace(/\/$/, "")}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url,
          maxTimeout: ANNAS_TIMEOUT_MS,
          waitInSeconds: FLARESOLVERR_WAIT_S,
        }),
        signal: AbortSignal.timeout(ANNAS_TIMEOUT_MS + 15000),
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as {
        status?: string;
        solution?: { status?: number; response?: string };
      };
      if (data.status !== "ok") return undefined;
      const sol = data.solution;
      if (!sol?.response || (sol.status ?? 0) >= 400) return undefined;
      return sol.response;
    } catch {
      return undefined;
    }
  }
  // Direct fetch fallback — usually defeated by Anna's anti-bot, kept for testing.
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(ANNAS_TIMEOUT_MS),
      headers: { "User-Agent": ANNAS_UA, Accept: "text/html,*/*" },
      redirect: "follow",
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

function extractAnnasMd5(html: string): string | undefined {
  // md5 hashes appear in /md5/<hash> links and on slow_download / fast_download URLs.
  const m = /\/(?:md5|slow_download|fast_download)\/([a-f0-9]{32})/i.exec(html);
  return m?.[1];
}

// ------- Stage 2.7: Fulltext enrichment (PMC OA biomedical) -------

const FULLTEXT_CHAR_CAP = Number(process.env.FULLTEXT_CHAR_CAP ?? "4000");
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL ?? process.env.OPENALEX_MAILTO ?? null;
const UNPAYWALL_CONCURRENCY = Number(process.env.UNPAYWALL_CONCURRENCY ?? "8");

async function enrichWithFulltext(
  papers: Paper[],
): Promise<{ added: number; tried: number; viaPmc: number; viaPdf: number }> {
  let tried = 0;
  let added = 0;
  let viaPmc = 0;
  let viaPdf = 0;

  await Promise.all(
    papers.map(async (p) => {
      let pmcid = p.pmcid;
      if (!pmcid && p.paperId.startsWith("doi:")) {
        pmcid = await resolveDoiToPmcid(p.paperId.slice(4));
        if (pmcid) p.pmcid = pmcid;
      }
      if (pmcid) {
        tried++;
        try {
          const ft = await fetchPmcFulltext(pmcid);
          if (ft) {
            p.fulltext = ft;
            added++;
            viaPmc++;
            return;
          }
        } catch (err) {
          console.error(`[fulltext] PMC ${pmcid} failed: ${(err as Error).message}`);
        }
      }
      if (p.fulltextUrl) {
        tried++;
        try {
          const ft = await fetchPdfFulltext(p.fulltextUrl);
          if (ft) {
            p.fulltext = ft;
            added++;
            viaPdf++;
          }
        } catch (err) {
          console.error(`[fulltext] PDF ${p.fulltextUrl} failed: ${(err as Error).message}`);
        }
      }
    }),
  );

  return { added, tried, viaPmc, viaPdf };
}

const PDF_MAX_BYTES = 25_000_000;
const PDF_FETCH_TIMEOUT_MS = 30_000;

async function fetchPdfFulltext(url: string): Promise<string | undefined> {
  const ctrl = AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": `academic-deep-research/0.6 (mailto:${MAILTO})` },
    redirect: "follow",
    signal: ctrl,
  });
  if (!res.ok) return undefined;
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.startsWith("text/plain") || url.toLowerCase().endsWith(".txt")) {
    const text = await res.text();
    if (!text) return undefined;
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, FULLTEXT_CHAR_CAP);
  }
  if (
    !ct.includes("pdf") &&
    !url.toLowerCase().endsWith(".pdf") &&
    !/servlets\/purl|biblio\/\d+\/pdf/.test(url)
  ) {
    return undefined;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > PDF_MAX_BYTES) return undefined;

  const tmpPath = join(
    tmpdir(),
    `ads-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
  );
  writeFileSync(tmpPath, Buffer.from(buf));
  try {
    // Node port of Bun.spawn: run pdftotext, capture stdout, ignore stderr.
    const text = await new Promise<string>((resolve) => {
      const proc = spawn("pdftotext", ["-layout", "-q", tmpPath, "-"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      proc.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      proc.on("close", () => resolve(out));
      proc.on("error", () => resolve(""));
    });
    if (!text) return undefined;
    return text
      .replace(/\f/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, FULLTEXT_CHAR_CAP);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function resolveDoiToPmcid(doi: string): Promise<string | undefined> {
  const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(doi)}&format=json&tool=academic-deep-research&email=${encodeURIComponent(MAILTO)}`;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  const data = (await res.json()) as { records?: Array<{ pmcid?: string }> };
  return data.records?.[0]?.pmcid;
}

async function fetchPmcFulltext(pmcid: string): Promise<string | undefined> {
  const id = pmcid.replace(/^PMC/i, "");
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${id}&rettype=xml`;
  const res = await fetch(url, {
    headers: { "User-Agent": `academic-deep-research/0.5 (mailto:${MAILTO})` },
  });
  if (!res.ok) return undefined;
  const xml = await res.text();
  if (xml.includes("<error>") || !xml.includes("<body>")) return undefined;
  return parseJatsBody(xml);
}

function parseJatsBody(xml: string): string {
  const bodyMatch = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!bodyMatch) return "";
  const body = bodyMatch[1]!;
  const sections: string[] = [];
  const secRegex = /<sec[^>]*>([\s\S]*?)<\/sec>/g;
  let m: RegExpExecArray | null;
  while ((m = secRegex.exec(body)) !== null) {
    const secXml = m[1]!;
    const titleMatch = secXml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = titleMatch ? stripXml(titleMatch[1]!) : "";
    const text = stripXml(secXml.replace(/<title[^>]*>[\s\S]*?<\/title>/, ""));
    if (title) sections.push(`## ${title}\n${text}`);
    else sections.push(text);
  }
  const flat = sections.length > 0 ? sections.join("\n\n") : stripXml(body);
  return flat.slice(0, FULLTEXT_CHAR_CAP);
}

function stripXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------- Stage 2.5: Relevance filter -------

const RelevanceSchema = z.object({
  scores: z.array(
    z.object({
      paper_index: z.number().int(),
      relevance: z.number().int().min(0).max(3),
      reason: z.string().optional(),
    }),
  ),
});

interface RelevanceVerdict {
  score: number;
  reason?: string | undefined;
}

async function scoreRelevance(
  question: string,
  papers: Paper[],
  client: LlmClient,
  relevanceModel: string,
): Promise<Map<string, RelevanceVerdict>> {
  if (papers.length === 0) return new Map();

  const candidates = papers
    .map((p, i) => `[${i}] ${p.title}\n    ${p.abstract.slice(0, 400).replace(/\s+/g, " ")}`)
    .join("\n\n");

  const out = await jsonCall(client, {
    model: relevanceModel,
    system: `You are a relevance judge. Given a research question and a list of paper candidates (title + abstract excerpt), score each paper's relevance to the question.

Scoring rubric:
- 3: Directly addresses the question — primary topic match
- 2: Substantially relevant — covers a meaningful subset or related mechanism
- 1: Tangentially related — shares keywords but addresses a different question
- 0: Off-topic — keyword collision only, different field or different question

Score conservatively. Do NOT count keyword matches alone as relevance — judge whether the paper would meaningfully contribute to answering the question.`,
    user: `Research question: ${question}\n\nPaper candidates:\n\n${candidates}`,
    schema: RelevanceSchema,
    schemaName: "RelevanceScores",
    schemaHint: `{ "scores": [{ "paper_index": 0, "relevance": 0-3, "reason": "brief, only if score < 2" }, ...] }  // ONE entry per paper, all indices 0..N-1, in order`,
    maxTokens: 20000,
  });

  const result = new Map<string, RelevanceVerdict>();
  for (const v of out.scores) {
    const p = papers[v.paper_index];
    if (!p) continue;
    result.set(p.paperId, { score: v.relevance, reason: v.reason });
  }

  if (process.env.DEBUG_RELEVANCE === "1") {
    const dist: Record<number, number> = {};
    for (const v of result.values()) dist[v.score] = (dist[v.score] ?? 0) + 1;
    console.error(
      `[relevance] returned ${out.scores.length} scores for ${papers.length} papers; matched ${result.size}; distribution ${JSON.stringify(dist)}`,
    );
  }
  return result;
}

// ------- Stage 3: Synthesize with hard citation grounding -------

const ReportSchema = z.object({
  title: z.string(),
  paragraphs: z
    .array(
      z.object({
        content: z.string().describe("Paragraph text. Every claim must be backed by a citation."),
        citations: z.array(
          z.object({
            paper_id: z.string().describe("paper_id EXACTLY as given in the corpus."),
            claim: z.string().describe("The specific claim being supported."),
            supporting_span: z.string().describe("Verbatim quote from that paper's abstract."),
            confidence: z.enum(["well-supported", "contested", "preliminary"]),
          }),
        ),
      }),
    )
    .min(1),
  open_questions: z.array(z.string()).describe("Questions the corpus cannot answer."),
});

type Report = z.infer<typeof ReportSchema>;

async function synthesize(
  question: string,
  papers: Paper[],
  client: LlmClient,
  synthesizeModel: string,
  relevance?: Map<string, RelevanceVerdict>,
): Promise<Report> {
  const corpus = papers
    .map((p, i) => {
      const relScore = relevance?.get(p.paperId)?.score;
      const relTag = relScore !== undefined ? `\nrelevance_to_question: ${relScore}/3` : "";
      const fundedTag =
        p.fundedBy && p.fundedBy.length > 0 ? `\nfunded_by: ${p.fundedBy.join(", ")}` : "";
      const ftSection = p.fulltext ? `\nfulltext_excerpt:\n${p.fulltext}` : "";
      return `## Paper ${i + 1}
paper_id: ${p.paperId}
title: ${p.title}
authors: ${p.authors.slice(0, 5).join(", ")}${p.authors.length > 5 ? " et al." : ""}
year: ${p.year}
venue: ${p.venue ?? "n/a"}
citations: ${p.citationCount}${relTag}${fundedTag}
abstract: ${p.abstract}${ftSection}`;
    })
    .join("\n\n");

  return await jsonCall(client, {
    model: synthesizeModel,
    system: `You are a research synthesizer. You receive a research question and a corpus of paper abstracts. Write a literature review that:

1. ONLY cites papers in the corpus. Use paper_id strings VERBATIM from the corpus.
2. Every claim must carry a 'supporting_span' that is a verbatim quote from the cited abstract OR fulltext_excerpt (if available — fulltext lets you cite specific methods/results).
3. Tag each claim's confidence: well-supported (multiple papers agree), contested (papers disagree), or preliminary (single paper / weak evidence).
4. Write 3-6 paragraphs that progress logically (overview → mechanisms → debates → frontier).
5. Flag gaps as open_questions when the corpus cannot answer something.
6. STRONGLY PREFER papers with relevance_to_question >= 2. Only cite papers with relevance 0-1 if they offer a unique, directly-relevant point AND no high-relevance paper covers it. If most retrieved papers have low relevance, write a SHORTER review (even 1-2 paragraphs is acceptable) and put a clear note in open_questions explaining that the corpus was insufficient. Do NOT pad with off-topic citations.

NEVER invent paper_ids. NEVER cite papers not in the corpus. NEVER fabricate supporting_span text.`,
    user: `Research question: ${question}\n\nCorpus (${papers.length} papers):\n\n${corpus}`,
    schema: ReportSchema,
    schemaName: "LiteratureReview",
    schemaHint: `{
  "title": "string",
  "paragraphs": [
    {
      "content": "Paragraph text. Every claim cites at least one paper.",
      "citations": [
        {
          "paper_id": "doi:10.xxxx/yyy or s2:xxx — VERBATIM from corpus",
          "claim": "The specific claim being supported.",
          "supporting_span": "Verbatim quote from the abstract.",
          "confidence": "well-supported" // or "contested" or "preliminary"
        }
      ]
    }
    // 3-6 paragraphs total, each with >=1 citation
  ],
  "open_questions": ["question 1", "question 2"]
}`,
    thinking: false,
    maxTokens: 48000,
  });
}

// ------- Stage 4: Verifier (independent-context support check) -------

const VerifySchema = z.object({
  scores: z.array(
    z.object({
      claim_index: z.number().int(),
      support_score: z.number().int().min(0).max(3),
      issue: z.string().optional(),
    }),
  ),
});

type VerificationKey = `${number}:${number}`;
interface VerifierVerdict {
  score: number;
  issue?: string | undefined;
}

async function verify(
  report: Report,
  papers: Paper[],
  client: LlmClient,
  verifyModel: string,
): Promise<Map<VerificationKey, VerifierVerdict>> {
  const idToPaper = new Map(papers.map((p) => [p.paperId, p]));
  const byPaper = new Map<string, Array<{ key: VerificationKey; claim: string; span: string }>>();

  report.paragraphs.forEach((para, pi) => {
    para.citations.forEach((c, ci) => {
      const key = `${pi}:${ci}` as VerificationKey;
      const list = byPaper.get(c.paper_id) ?? [];
      list.push({ key, claim: c.claim, span: c.supporting_span });
      byPaper.set(c.paper_id, list);
    });
  });

  const results = new Map<VerificationKey, VerifierVerdict>();
  const concurrency = Math.max(1, Number(process.env.VERIFY_CONCURRENCY ?? "3"));
  const entries = [...byPaper.entries()];
  let cursor = 0;
  let rateLimitHits = 0;

  async function verifyOnePaper(
    paperId: string,
    claims: Array<{ key: VerificationKey; claim: string; span: string }>,
  ): Promise<void> {
    const paper = idToPaper.get(paperId);
    if (!paper) {
      for (const c of claims) results.set(c.key, { score: 0, issue: "paper not in corpus" });
      return;
    }

    const claimsList = claims
      .map((c, i) => `Claim ${i}: "${c.claim}"\nSupporting span: "${c.span}"`)
      .join("\n\n");
    const sourceText = paper.fulltext
      ? `Full abstract:\n${paper.abstract}\n\nFulltext excerpt:\n${paper.fulltext}`
      : `Full abstract:\n${paper.abstract}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await jsonCall(client, {
          model: verifyModel,
          system: `You are an independent citation verifier. For each (claim, supporting_span) pair, rate how well the span — read in the context of the FULL source text — actually supports the claim. The source text may be just an abstract, or an abstract plus a fulltext excerpt.

Scoring rubric:
- 3: Span directly states or implies the claim
- 2: Span supports the claim partially, with caveats, or as one piece of evidence among several
- 1: Span is topically related but doesn't really back the claim
- 0: Span contradicts the claim, is unrelated, or is fabricated (not in the source)

Score conservatively. If the source doesn't contain the supporting_span verbatim or near-verbatim, score 0.`,
          user: `Paper title: ${paper.title}\n\n${sourceText}\n\n---\n\n${claimsList}`,
          schema: VerifySchema,
          schemaName: "Verifications",
          schemaHint: `{ "scores": [{ "claim_index": 0, "support_score": 0-3, "issue": "brief reason, only if score < 2" }, ...] }  // one entry per claim, in order`,
          maxTokens: 6000,
        });
        for (const v of out.scores) {
          const c = claims[v.claim_index];
          if (!c) continue;
          results.set(c.key, { score: v.support_score, issue: v.issue });
        }
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
          rateLimitHits++;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        console.error(`[verify] paper=${paperId} failed: ${msg}`);
        for (const c of claims) results.set(c.key, { score: -1, issue: "verifier call failed" });
        return;
      }
    }
    console.error(`[verify] paper=${paperId} exhausted retries (rate-limited)`);
    for (const c of claims)
      results.set(c.key, { score: -1, issue: "rate-limited; retries exhausted" });
  }

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= entries.length) return;
      const [paperId, claims] = entries[i]!;
      await verifyOnePaper(paperId, claims);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (rateLimitHits > 0) {
    console.error(
      `[verify] hit Z.ai rate limit ${rateLimitHits} times across run (retried with backoff)`,
    );
  }
  return results;
}

// ------- Render -------

function renderMarkdown(
  report: Report,
  papers: Paper[],
  models: { plan: string; synthesize: string; verify: string },
  verdicts?: Map<VerificationKey, VerifierVerdict>,
): string {
  const idToPaper = new Map(papers.map((p) => [p.paperId, p]));
  const cited = new Set<string>();

  let md = `# ${report.title}\n\n`;

  report.paragraphs.forEach((para, pi) => {
    const inline = para.citations
      .map((c, ci) => {
        const ref = shortRef(idToPaper.get(c.paper_id), c.paper_id);
        const verdict = verdicts?.get(`${pi}:${ci}` as VerificationKey);
        const tag = verdict !== undefined ? ` ${scoreEmoji(verdict.score)}${verdict.score}` : "";
        return `[${ref}${tag}]`;
      })
      .join(" ");
    md += `${para.content} ${inline}\n\n`;
    for (const c of para.citations) cited.add(c.paper_id);
  });

  md += `## Open questions\n\n`;
  for (const q of report.open_questions) md += `- ${q}\n`;

  md += `\n## Bibliography\n\n`;
  let i = 1;
  for (const id of cited) {
    const p = idToPaper.get(id);
    if (!p) {
      md += `${i++}. \`${id}\` — **WARNING: not in retrieved corpus (potential hallucination)**\n`;
      continue;
    }
    md += `${i++}. ${p.authors[0] ?? "Unknown"}${p.authors.length > 1 ? " et al." : ""} (${p.year}). *${p.title}*. ${p.venue ?? ""}. ${p.url}\n`;
  }

  let totalCites = 0;
  let hallucinated = 0;
  let spansVerified = 0;
  let verifierSum = 0;
  let verifierCounted = 0;
  let verifierLow = 0;
  const conf: Record<string, number> = {
    "well-supported": 0,
    contested: 0,
    preliminary: 0,
  };
  const lowFlags: string[] = [];
  report.paragraphs.forEach((para, pi) => {
    para.citations.forEach((c, ci) => {
      totalCites++;
      const p = idToPaper.get(c.paper_id);
      if (!p) hallucinated++;
      else {
        const haystack = (p.abstract + " " + (p.fulltext ?? "")).toLowerCase();
        if (haystack.includes(c.supporting_span.toLowerCase().slice(0, 50))) {
          spansVerified++;
        }
      }
      conf[c.confidence] = (conf[c.confidence] ?? 0) + 1;
      const v = verdicts?.get(`${pi}:${ci}` as VerificationKey);
      if (v && v.score >= 0) {
        verifierSum += v.score;
        verifierCounted++;
        if (v.score < 2) {
          verifierLow++;
          lowFlags.push(
            `  - [P${pi + 1}.C${ci + 1}] ${shortRef(p, c.paper_id)} score ${v.score}${v.issue ? ` — ${v.issue}` : ""}`,
          );
        }
      }
    });
  });
  md += `\n## Citation hygiene\n\n`;
  md += `- Total citations: ${totalCites}\n`;
  md += `- Unique papers cited: ${cited.size} / ${papers.length} retrieved\n`;
  md += `- Hallucinated paper_ids: **${hallucinated}**\n`;
  md += `- Supporting spans verified in source: ${spansVerified} / ${totalCites - hallucinated}\n`;
  md += `- Confidence: well-supported ${conf["well-supported"]}, contested ${conf["contested"]}, preliminary ${conf["preliminary"]}\n`;
  if (verifierCounted > 0) {
    md += `- Verifier mean score: ${(verifierSum / verifierCounted).toFixed(2)} / 3 (${verifierCounted} citations scored)\n`;
    md += `- Citations scoring < 2: **${verifierLow}**\n`;
    if (lowFlags.length > 0) {
      md += `- Flagged:\n${lowFlags.join("\n")}\n`;
    }
  }
  md += `- Models: plan=${models.plan}, synthesize=${models.synthesize}${verifierCounted > 0 ? `, verify=${models.verify}` : ""}\n`;
  return md;
}

function scoreEmoji(score: number): string {
  if (score >= 3) return "✓";
  if (score >= 2) return "~";
  if (score >= 0) return "⚠";
  return "?";
}

function shortRef(p: Paper | undefined, fallback: string): string {
  if (!p) return fallback;
  const first = p.authors[0]?.split(" ").pop() ?? "Anon";
  return `${first}${p.authors.length > 1 ? "+" : ""} ${p.year}`;
}

// ------- Stats -------

export interface RunStats {
  question: string;
  queries: string[];
  retrieval: {
    s2: number;
    openalex: number;
    arxiv: number;
    core: number;
    europepmc: number;
    crossref: number;
    osti: number;
    ntrs: number;
    doaj: number;
    unique: number;
  };
  federallyFundedCited?: number | undefined;
  fulltext?:
    | { tried: number; added: number; viaPmc: number; viaPdf: number; citedWithFulltext: number }
    | undefined;
  unpaywall?:
    | { tried: number; resolved: number; viaUnpaywall: number; viaOpenAlex: number }
    | undefined;
  scihub?: { tried: number; resolved: number; perMirror: Record<string, number> } | undefined;
  annas?: { tried: number; resolved: number; viaMember: number; viaScidb: number } | undefined;
  relevance?: { mean: number; kept: number; dropped: number } | undefined;
  citationsTotal: number;
  uniquePapersCited: number;
  hallucinatedPaperIds: number;
  spansVerifiedLiteral: number;
  confidence: { wellSupported: number; contested: number; preliminary: number };
  verifier?: { mean: number; counted: number; lowSupport: number } | undefined;
  runtimeMs: number;
  models: { plan: string; synthesize: string; verify: string; relevance: string };
}

function computeStats(
  question: string,
  queries: string[],
  retrieval: RunStats["retrieval"],
  report: Report,
  papers: Paper[],
  verdicts: Map<VerificationKey, VerifierVerdict> | undefined,
  runtimeMs: number,
  relevance: Map<string, RelevanceVerdict> | undefined,
  droppedByRelevance: number,
  fulltextStats: { added: number; tried: number; viaPmc: number; viaPdf: number } | undefined,
  oaResolverStats:
    | {
        tried: number;
        resolved: number;
        viaUnpaywall: number;
        viaOpenAlex: number;
        skipped: boolean;
      }
    | undefined,
  scihubStats: { tried: number; resolved: number; perMirror: Record<string, number> } | undefined,
  annasStats: { tried: number; resolved: number; viaMember: number; viaScidb: number } | undefined,
  models: { plan: string; relevance: string; synthesize: string; verify: string },
): RunStats {
  const idToPaper = new Map(papers.map((p) => [p.paperId, p]));
  const cited = new Set<string>();
  let totalCites = 0;
  let hallucinated = 0;
  let spansVerified = 0;
  let verifierSum = 0;
  let verifierCounted = 0;
  let verifierLow = 0;
  const conf = { wellSupported: 0, contested: 0, preliminary: 0 };

  report.paragraphs.forEach((para, pi) => {
    para.citations.forEach((c, ci) => {
      cited.add(c.paper_id);
      totalCites++;
      const p = idToPaper.get(c.paper_id);
      if (!p) hallucinated++;
      else {
        const haystack = (p.abstract + " " + (p.fulltext ?? "")).toLowerCase();
        if (haystack.includes(c.supporting_span.toLowerCase().slice(0, 50))) {
          spansVerified++;
        }
      }
      if (c.confidence === "well-supported") conf.wellSupported++;
      else if (c.confidence === "contested") conf.contested++;
      else conf.preliminary++;
      const v = verdicts?.get(`${pi}:${ci}` as VerificationKey);
      if (v && v.score >= 0) {
        verifierSum += v.score;
        verifierCounted++;
        if (v.score < 2) verifierLow++;
      }
    });
  });

  let relMean: number | undefined;
  let keptMeanRel: number | undefined;
  if (relevance && relevance.size > 0) {
    const allScores = [...relevance.values()].map((v) => v.score);
    relMean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    const keptScores = papers
      .map((p) => relevance!.get(p.paperId)?.score)
      .filter((s): s is number => s !== undefined);
    if (keptScores.length > 0) {
      keptMeanRel = keptScores.reduce((a, b) => a + b, 0) / keptScores.length;
    }
  }

  let federallyFundedCited = 0;
  let citedWithFulltext = 0;
  for (const id of cited) {
    const p = papers.find((q) => q.paperId === id);
    if (!p) continue;
    if (p.fundedBy && p.fundedBy.length > 0) federallyFundedCited++;
    if (p.fulltext) citedWithFulltext++;
  }

  return {
    question,
    queries,
    retrieval,
    relevance:
      relevance !== undefined
        ? {
            mean: keptMeanRel ?? relMean ?? 0,
            kept: papers.length,
            dropped: droppedByRelevance,
          }
        : undefined,
    citationsTotal: totalCites,
    uniquePapersCited: cited.size,
    hallucinatedPaperIds: hallucinated,
    spansVerifiedLiteral: spansVerified,
    confidence: conf,
    verifier:
      verifierCounted > 0
        ? {
            mean: verifierSum / verifierCounted,
            counted: verifierCounted,
            lowSupport: verifierLow,
          }
        : undefined,
    federallyFundedCited,
    fulltext: fulltextStats
      ? {
          tried: fulltextStats.tried,
          added: fulltextStats.added,
          viaPmc: fulltextStats.viaPmc,
          viaPdf: fulltextStats.viaPdf,
          citedWithFulltext,
        }
      : undefined,
    unpaywall:
      oaResolverStats && !oaResolverStats.skipped
        ? {
            tried: oaResolverStats.tried,
            resolved: oaResolverStats.resolved,
            viaUnpaywall: oaResolverStats.viaUnpaywall,
            viaOpenAlex: oaResolverStats.viaOpenAlex,
          }
        : undefined,
    scihub:
      scihubStats && scihubStats.tried > 0
        ? {
            tried: scihubStats.tried,
            resolved: scihubStats.resolved,
            perMirror: scihubStats.perMirror,
          }
        : undefined,
    annas:
      annasStats && annasStats.tried > 0
        ? {
            tried: annasStats.tried,
            resolved: annasStats.resolved,
            viaMember: annasStats.viaMember,
            viaScidb: annasStats.viaScidb,
          }
        : undefined,
    runtimeMs,
    models,
  };
}

// ------- Public API -------

export interface RunResult {
  markdown: string;
  stats: RunStats;
}

export interface AcademicLoopOpts {
  question: string;
  client: LlmClient;
  planModel: string;
  relevanceModel: string;
  synthesizeModel: string;
  verifyModel: string;
}

export async function runAcademicLoop(opts: AcademicLoopOpts): Promise<RunResult> {
  const { question, client, planModel, relevanceModel, synthesizeModel, verifyModel } = opts;
  const start = Date.now();
  console.error(`[plan] decomposing question (${planModel})`);
  const queries = await plan(question, client, planModel);
  console.error(`[plan] queries: ${queries.map((q) => `"${q}"`).join(", ")}`);

  console.error(
    `[search] ${queries.length} queries × up to 5 sources (sequential within provider)`,
  );
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function runSequential<T>(fn: (q: string) => Promise<T[]>, gapMs: number): Promise<T[]> {
    const out: T[] = [];
    for (const q of queries) {
      out.push(...(await fn(q)));
      await sleep(gapMs);
    }
    return out;
  }

  const [
    s2Hits,
    openAlexHits,
    arxivHits,
    coreHits,
    europepmcHits,
    crossrefHits,
    ostiHits,
    ntrsHits,
    doajHits,
  ] = await Promise.all([
    runSequential((q) => searchS2(q, PER_QUERY_LIMIT), 1100),
    runSequential((q) => searchOpenAlex(q, PER_QUERY_LIMIT), 200),
    runSequential((q) => searchArxiv(q, PER_QUERY_LIMIT), 3100),
    runSequential((q) => searchCore(q, PER_QUERY_LIMIT), 200),
    runSequential((q) => searchEuropePMC(q, PER_QUERY_LIMIT), 200),
    runSequential((q) => searchCrossref(q, PER_QUERY_LIMIT), 200),
    runSequential((q) => searchOsti(q, PER_QUERY_LIMIT), 200),
    runSequential((q) => searchNtrs(q, PER_QUERY_LIMIT), 200),
    runSequential((q) => searchDoaj(q, PER_QUERY_LIMIT), 200),
  ]);
  const papers = dedupePapers([
    ...s2Hits,
    ...openAlexHits,
    ...arxivHits,
    ...coreHits,
    ...europepmcHits,
    ...crossrefHits,
    ...ostiHits,
    ...ntrsHits,
    ...doajHits,
  ]).slice(0, TOTAL_PAPER_LIMIT);
  console.error(
    `[search] s2=${s2Hits.length}, openalex=${openAlexHits.length}, arxiv=${arxivHits.length}, core=${coreHits.length}, europepmc=${europepmcHits.length}, crossref=${crossrefHits.length}, osti=${ostiHits.length}, ntrs=${ntrsHits.length}, doaj=${doajHits.length}, unique=${papers.length}`,
  );
  if (papers.length < 5) {
    throw new Error(`Only retrieved ${papers.length} papers; corpus too small.`);
  }

  const skipRelevance = process.env.SKIP_RELEVANCE === "1";
  let relevance: Map<string, RelevanceVerdict> | undefined;
  let filteredPapers = papers;
  if (!skipRelevance) {
    console.error(
      `[relevance] scoring ${papers.length} candidates against question (${relevanceModel})`,
    );
    relevance = await scoreRelevance(question, papers, client, relevanceModel);
    const ranked = [...papers].sort((a, b) => {
      const sa = relevance!.get(a.paperId)?.score ?? 0;
      const sb = relevance!.get(b.paperId)?.score ?? 0;
      if (sa !== sb) return sb - sa;
      return b.citationCount - a.citationCount;
    });
    filteredPapers = ranked.slice(0, RELEVANCE_TOP_K);
    const minKept =
      filteredPapers.length > 0
        ? (relevance.get(filteredPapers[filteredPapers.length - 1]!.paperId)?.score ?? 0)
        : 0;
    const maxDropped = ranked[RELEVANCE_TOP_K]
      ? (relevance.get(ranked[RELEVANCE_TOP_K]!.paperId)?.score ?? 0)
      : 0;
    console.error(
      `[relevance] kept top ${filteredPapers.length}/${papers.length} (min kept score ${minKept}, max dropped score ${maxDropped})`,
    );
  } else {
    console.error(`[relevance] skipped (SKIP_RELEVANCE=1)`);
  }

  const skipFulltext = process.env.SKIP_FULLTEXT === "1";
  let fulltextStats: { added: number; tried: number; viaPmc: number; viaPdf: number } | undefined;
  let oaResolverStats:
    | {
        tried: number;
        resolved: number;
        viaUnpaywall: number;
        viaOpenAlex: number;
        skipped: boolean;
      }
    | undefined;
  let scihubStats:
    | { tried: number; resolved: number; perMirror: Record<string, number> }
    | undefined;
  let annasStats:
    | { tried: number; resolved: number; viaMember: number; viaScidb: number }
    | undefined;
  if (!skipFulltext) {
    oaResolverStats = await enrichWithOAUrls(filteredPapers);
    if (oaResolverStats.skipped) {
      console.error(
        `[oa-resolver] skipped (set UNPAYWALL_EMAIL or OPENALEX_MAILTO to a real address)`,
      );
    } else if (oaResolverStats.tried > 0) {
      console.error(
        `[oa-resolver] resolved ${oaResolverStats.resolved}/${oaResolverStats.tried} (unpaywall=${oaResolverStats.viaUnpaywall}, openalex=${oaResolverStats.viaOpenAlex})`,
      );
    }

    const skipScihub = process.env.SKIP_SCIHUB === "1";
    if (!skipScihub) {
      scihubStats = await enrichWithSciHubUrls(filteredPapers);
      if (scihubStats.tried > 0) {
        console.error(
          `[scihub] resolved ${scihubStats.resolved}/${scihubStats.tried} (mirrors=${JSON.stringify(scihubStats.perMirror)})`,
        );
      }
    } else {
      console.error(`[scihub] skipped (SKIP_SCIHUB=1)`);
    }

    const skipAnnas = process.env.SKIP_ANNAS === "1";
    if (!skipAnnas) {
      annasStats = await enrichWithAnnasArchiveUrls(filteredPapers);
      if (annasStats.tried > 0) {
        console.error(
          `[annas] resolved ${annasStats.resolved}/${annasStats.tried} (member=${annasStats.viaMember}, scidb=${annasStats.viaScidb})`,
        );
      }
    } else {
      console.error(`[annas] skipped (SKIP_ANNAS=1)`);
    }

    const withPmcid = filteredPapers.filter((p) => p.pmcid).length;
    const withFulltextUrl = filteredPapers.filter((p) => p.fulltextUrl).length;
    const sourceMix: Record<string, number> = {};
    for (const p of filteredPapers) sourceMix[p.source] = (sourceMix[p.source] ?? 0) + 1;
    console.error(
      `[fulltext] enriching ${filteredPapers.length} papers (sources=${JSON.stringify(sourceMix)}, pmcid=${withPmcid}, fulltextUrl=${withFulltextUrl})`,
    );
    fulltextStats = await enrichWithFulltext(filteredPapers);
    console.error(
      `[fulltext] added ${fulltextStats.added}/${fulltextStats.tried} attempted (pmc=${fulltextStats.viaPmc}, pdf=${fulltextStats.viaPdf})`,
    );
  } else {
    console.error(`[fulltext] skipped (SKIP_FULLTEXT=1)`);
  }

  console.error(
    `[synthesize] writing review on ${filteredPapers.length} papers (${synthesizeModel})`,
  );
  const report = await synthesize(question, filteredPapers, client, synthesizeModel, relevance);

  const skipVerify = process.env.SKIP_VERIFY === "1";
  let verdicts: Map<VerificationKey, VerifierVerdict> | undefined;
  if (!skipVerify) {
    const totalCites = report.paragraphs.reduce((acc, p) => acc + p.citations.length, 0);
    console.error(`[verify] checking ${totalCites} citations against sources (${verifyModel})`);
    verdicts = await verify(report, filteredPapers, client, verifyModel);
  } else {
    console.error(`[verify] skipped (SKIP_VERIFY=1)`);
  }

  const markdown = renderMarkdown(
    report,
    filteredPapers,
    { plan: planModel, synthesize: synthesizeModel, verify: verifyModel },
    verdicts,
  );
  const stats = computeStats(
    question,
    queries,
    {
      s2: s2Hits.length,
      openalex: openAlexHits.length,
      arxiv: arxivHits.length,
      core: coreHits.length,
      europepmc: europepmcHits.length,
      crossref: crossrefHits.length,
      osti: ostiHits.length,
      ntrs: ntrsHits.length,
      doaj: doajHits.length,
      unique: papers.length,
    },
    report,
    filteredPapers,
    verdicts,
    Date.now() - start,
    relevance,
    papers.length - filteredPapers.length,
    fulltextStats,
    oaResolverStats,
    scihubStats,
    annasStats,
    {
      plan: planModel,
      relevance: relevanceModel,
      synthesize: synthesizeModel,
      verify: verifyModel,
    },
  );
  return { markdown, stats };
}
