// Fork-owned diagnostic-tolerant skill loaders. Upstream retired these with #138582
// (consumers now carry loaded frontmatter pairs); the fork's workspace skills loader
// (workspace.ts) still reads directories and single frontmatter files this way.
import fs from "node:fs";
import path from "node:path";
import type { ParsedSkillFrontmatter } from "../types.js";
import { parseSkillFrontmatter } from "./frontmatter.js";
import {
  loadSingleSkillDirectory,
  readSkillFileSync,
  type LoadedLocalSkill,
  type LocalSkillLoadDiagnostic,
} from "./local-loader.js";
import type { Skill } from "./skill-contract.js";

function listCandidateSkillDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => path.join(dir, entry.name))
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Loads skills from a local directory while turning read/parse failures into diagnostics. */
export function loadSkillsFromDirSafe(params: {
  dir: string;
  source: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): {
  skills: Skill[];
  frontmatterByFilePath: ReadonlyMap<string, ParsedSkillFrontmatter>;
} {
  const rootDir = path.resolve(params.dir);
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return { skills: [], frontmatterByFilePath: new Map() };
  }

  const rootSkill = loadSingleSkillDirectory({
    skillDir: rootDir,
    source: params.source,
    rootRealPath,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    onDiagnostic: params.onDiagnostic,
  });
  if (rootSkill) {
    return {
      skills: [rootSkill.skill],
      frontmatterByFilePath: new Map([[rootSkill.skill.filePath, rootSkill.frontmatter]]),
    };
  }

  const loadedSkills = listCandidateSkillDirs(rootDir)
    .map((skillDir) =>
      loadSingleSkillDirectory({
        skillDir,
        source: params.source,
        rootRealPath,
        maxBytes: params.maxBytes,
        rejectHardlinks: params.rejectHardlinks,
        onDiagnostic: params.onDiagnostic,
      }),
    )
    .filter((skill): skill is LoadedLocalSkill => skill !== null);
  const frontmatterByFilePath = new Map<string, ParsedSkillFrontmatter>();
  for (const loaded of loadedSkills) {
    frontmatterByFilePath.set(loaded.skill.filePath, loaded.frontmatter);
  }

  return {
    skills: loadedSkills.map((loaded) => loaded.skill),
    frontmatterByFilePath,
  };
}

export function readSkillFrontmatterSafe(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
}): Record<string, string> | null {
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(path.resolve(params.rootDir));
  } catch {
    return null;
  }
  const raw = readSkillFileSync({
    rootRealPath,
    filePath: path.resolve(params.filePath),
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (raw === null) {
    return null;
  }
  try {
    return parseSkillFrontmatter(raw);
  } catch {
    return null;
  }
}
