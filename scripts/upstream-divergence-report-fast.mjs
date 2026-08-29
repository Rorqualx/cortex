import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const base = "main";
const upstream = "upstream/main";

// --- Convergent surface: parse `.gitattributes` merge=ours globs -------------
function parseMergeOursGlobs() {
  const text = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  const globs = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !/\bmerge=ours\b/.test(line)) continue;
    const glob = line.split(/\s+/)[0];
    if (glob) globs.push(glob);
  }
  globs.push("extensions/codex/**");
  return globs;
}

function globToRegExp(glob) {
  let g = glob;
  let prefixDir = false;
  if (g.endsWith("/")) { prefixDir = true; g = g.slice(0, -1); }
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; }
      else { re += "[^/]*"; }
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + (prefixDir ? "(/.*)?$" : "$"));
}

const convergentGlobs = parseMergeOursGlobs();
const convergentRes = convergentGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }));

function matchedConvergent(file) {
  for (const { glob, re } of convergentRes) if (re.test(file)) return glob;
  return null;
}

const ADJACENT_ZONES = [
  "src/agents/", "packages/agent-core/", "src/gateway/", "src/config/",
  "src/cron/", "extensions/memory-core/", "ui/src/ui/chat/",
];
const BORDERLINE_FILE_COUNT = 15;
const CHERRY_TYPES = new Set(["fix", "perf", "security", "revert-fix"]);

// --- Batch fetch all data ---
const range = `${base}..${upstream}`;
const shas = git(["rev-list", "--reverse", range]).split("\n").filter(Boolean);
const mergeShas = new Set(git(["rev-list", "--reverse", "--merges", range]).split("\n").filter(Boolean));

// Batch get all subjects: SHA SUBJECT
const logLines = git(["log", "--reverse", "--format=%H %s", range]).split("\n").filter(Boolean);
const subjectMap = new Map();
for (const line of logLines) {
  const sha = line.slice(0, 40);
  const subject = line.slice(41);
  subjectMap.set(sha, subject);
}

// Batch get all files per commit
// Format: "COMMIT <sha>" followed by file lines, then blank line, then next commit
const nameOnlyLines = git(["log", "--reverse", "--format=COMMIT %H", "--name-only", range]).split("\n");
const filesMap = new Map();
let currentSha = null;
let currentFiles = [];
for (const line of nameOnlyLines) {
  if (line.startsWith("COMMIT ")) {
    if (currentSha) filesMap.set(currentSha, currentFiles);
    currentSha = line.slice(7);
    currentFiles = [];
  } else if (line.trim()) {
    currentFiles.push(line.trim());
  }
}
if (currentSha) filesMap.set(currentSha, currentFiles);

// --- Classify ---
const mix = {};
const cherryCandidates = [];
const deferred = [];
const forkExclusiveTouched = new Set();
const hotspotsTouched = new Set();

for (const sha of shas) {
  const subject = subjectMap.get(sha) || "";
  const typeMatch = subject.match(/^([a-z]+)/);
  const type = typeMatch ? typeMatch[1] : "other";
  mix[type] = (mix[type] || 0) + 1;

  const isSecurity = /\bsecurity\b|\bCVE-|\bvuln/i.test(subject);
  const files = filesMap.get(sha) || [];

  const hits = [];
  for (const f of files) {
    const g = matchedConvergent(f);
    if (g) {
      hits.push({ file: f, glob: g });
      if (g.startsWith("extensions/") || g.startsWith("src/skill-forge") || g.includes("memory-l3")) {
        forkExclusiveTouched.add(g);
      } else {
        hotspotsTouched.add(g);
      }
    }
  }

  if (mergeShas.has(sha)) {
    deferred.push({ sha: sha.slice(0, 12), subject, reason: "merge commit" });
    continue;
  }
  if (files.length === 0) {
    deferred.push({ sha: sha.slice(0, 12), subject, reason: "empty / no files" });
    continue;
  }
  if (hits.length > 0) {
    const codex = hits.find((h) => h.glob.startsWith("extensions/codex"));
    deferred.push({
      sha: sha.slice(0, 12), subject,
      reason: codex ? "touches codex (hard gate)" : `touches protected surface: ${[...new Set(hits.map((h) => h.glob))].slice(0, 3).join(", ")}`,
    });
    continue;
  }
  if (!CHERRY_TYPES.has(type) && !isSecurity) {
    deferred.push({ sha: sha.slice(0, 12), subject, reason: `type=${type} (not fix/perf/security)` });
    continue;
  }

  const adjacent = files.some((f) => ADJACENT_ZONES.some((z) => f.startsWith(z)));
  const borderline = adjacent || files.length > BORDERLINE_FILE_COUNT;
  cherryCandidates.push({
    sha: sha.slice(0, 12), subject,
    type: isSecurity ? "security" : type,
    fileCount: files.length,
    files: files.slice(0, 40),
    borderline,
    borderlineReason: borderline ? (adjacent ? "touches fork-adjacent zone" : `large diff (${files.length} files)`) : undefined,
  });
}

const report = {
  base, upstream, n: shas.length, merges: mergeShas.size, mix,
  forkExclusiveTouched: [...forkExclusiveTouched].sort(),
  hotspotsTouched: [...hotspotsTouched].sort(),
  cherryCandidates, deferred,
  counts: {
    cherry: cherryCandidates.length,
    cherryBorderline: cherryCandidates.filter((c) => c.borderline).length,
    deferred: deferred.length,
  },
};

console.log(JSON.stringify(report, null, 2));
