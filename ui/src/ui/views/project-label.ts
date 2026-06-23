// Shared encode/parse + legacy-icon resolution for workboard project labels.
//
// Projects are emergent from card labels of the form
//   project:<name>:<icon>:<dir?>
// The name and dir are user-supplied and may contain ":" (e.g. "Sprint: Q3" or a
// Windows path), so each segment is URL-encoded on write and decoded on read —
// otherwise a colon in the name corrupts the name/icon/dir split. Old unencoded
// labels without special chars round-trip unchanged through decodeURIComponent.
//
// This is the single source of truth shared by the workboard and the office; both
// import from this leaf module (no view imports) to avoid the icon-map drift that
// happens when the logic is copy-pasted.
import { icons } from "../icons.ts";

// Existing project labels may still store an emoji; map them to SVG icon names so
// old projects keep an icon.
const LEGACY_EMOJI_TO_ICON: Record<string, keyof typeof icons> = {
  "📁": "folder",
  "📂": "folderOpen",
  "🗂️": "folders",
  "📦": "package",
  "🚀": "rocket",
  "⚙️": "settings",
  "🛠️": "wrench",
  "🔧": "wrench",
  "💻": "monitor",
  "🖥️": "monitor",
  "🧩": "puzzle",
  "🧠": "brain",
  "🔬": "microscope",
  "🧪": "flask",
  "📊": "barChart",
  "📈": "trendingUp",
  "📚": "book",
  "📝": "penLine",
  "🎯": "target",
  "🔭": "telescope",
  "🛰️": "satellite",
  "🌐": "globe",
  "🔌": "plug",
  "🗄️": "database",
  "🏷️": "tag",
  "⭐": "star",
  "🔥": "flame",
  "💡": "lightbulb",
  "🤖": "bot",
  "🦅": "bird",
  // No flag icon exists; pirate/flag projects fall back to a bookmark.
  "🏴‍☠️": "bookmark",
  "🌱": "spark",
};

/** Resolve a stored project-icon value (new icon-name or legacy emoji) to an icon name. */
export function projectIconName(value: string): keyof typeof icons {
  const trimmed = value.trim();
  if (trimmed in icons) {
    return trimmed as keyof typeof icons;
  }
  return LEGACY_EMOJI_TO_ICON[trimmed] ?? "folder";
}

/** Stable project id (slug) from a display name. */
export function projectIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Build a `project:name:icon:dir` card label, encoding user segments. */
export function encodeProjectLabel(name: string, icon: string, dir?: string): string {
  const base = `project:${encodeURIComponent(name.trim())}:${projectIconName(icon)}`;
  const trimmedDir = dir?.trim();
  return trimmedDir ? `${base}:${encodeURIComponent(trimmedDir)}` : base;
}

export type ParsedProjectLabel = { name: string; icon: string; dir?: string };

/** Parse a `project:...` card label into name/icon/dir, or null if not a project label. */
export function parseProjectLabel(label: string): ParsedProjectLabel | null {
  const match = /^project:(.+)$/i.exec(label);
  if (!match) {
    return null;
  }
  const segments = match[1].split(":");
  const name = decodeSegment(segments[0] ?? "").trim();
  if (!name) {
    return null;
  }
  const icon = segments[1] ? decodeSegment(segments[1]).trim() : "folder";
  // Join any trailing segments so a legacy unencoded dir containing ":" survives.
  const dir = segments.length > 2 ? decodeSegment(segments.slice(2).join(":")).trim() : "";
  return { name, icon, dir: dir || undefined };
}
