/**
 * Map of file extensions (lowercase) to emoji strings.
 * Covers languages, web, config, build, docs, and more.
 */
export const FILE_TYPE_ICONS: Record<string, string> = {
  // Languages
  ts: "💻",
  tsx: "💻",
  js: "💻",
  jsx: "💻",
  mjs: "💻",
  cjs: "💻",
  py: "🐍",
  pyw: "🐍",
  pyi: "🐍",
  rs: "🦀",
  go: "🦫",
  rb: "💎",
  java: "☕",
  jar: "☕",
  kt: "🦫",
  kts: "🦫",
  swift: "🦁",
  c: "⚙️",
  h: "⚙️",
  cpp: "⚙️",
  cc: "⚙️",
  cxx: "⚙️",
  hpp: "⚙️",
  cs: "🟢",
  php: "🐘",
  scala: "🔴",
  r: "📊",
  rmd: "📊",
  lua: "🔵",
  zig: "🟨",
  nim: "🟡",
  ex: "🛠️",
  exs: "🛠️",
  erl: "🛠️",
  hrl: "🛠️",
  hs: "🥛",
  ml: "🐴",
  mli: "🐴",
  dart: "🎯",
  vue: "🟩",
  svelte: "🟠",
  sh: "💻",
  bash: "💻",
  zsh: "💻",
  fish: "💻",
  ps1: "💻",
  bat: "💻",
  cmd: "💻",
  sql: "🗄️",
  graphql: "🦖",
  gql: "🦖",
  proto: "🌐",
  wasm: "🧠",

  // Web / Markup
  html: "🟢",
  htm: "🟢",
  css: "🟣",
  scss: "🟣",
  sass: "🟣",
  less: "🟣",
  md: "📝",
  mdx: "📝",
  rst: "📝",
  adoc: "📝",
  txt: "📄",
  xml: "📂",
  svg: "🎨",

  // Config / Data
  json: "📊",
  jsonc: "📊",
  json5: "📊",
  yaml: "📋",
  yml: "📋",
  toml: "📋",
  ini: "📋",
  cfg: "📋",
  conf: "📋",
  env: "🔐",
  lock: "🔒",

  // Build
  cmake: "🏗️",
  makefile: "🏗️",
  gradle: "🏗️",
  dockerfile: "🐳",
  dockerignore: "🐳",
  gitignore: "🔀",
  gitattributes: "🔀",
  gitmodules: "🔀",
  editorconfig: "⚙️",

  // Docs
  pdf: "📑",
  doc: "📄",
  docx: "📄",
  xls: "📊",
  xlsx: "📊",
  csv: "📊",
  tsv: "📊",
  ppt: "💬",
  pptx: "💬",

  // Images
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  webp: "🖼️",
  ico: "🖼️",
  bmp: "🖼️",
  tiff: "🖼️",
  avif: "🖼️",

  // Fonts
  ttf: "🔤",
  otf: "🔤",
  woff: "🔤",
  woff2: "🔤",

  // Audio
  mp3: "🎵",
  wav: "🎵",
  ogg: "🎵",
  flac: "🎵",
  aac: "🎵",

  // Video
  mp4: "🎬",
  mkv: "🎬",
  avi: "🎬",
  mov: "🎬",
  webm: "🎬",

  // Archives
  zip: "📦",
  tar: "📦",
  gz: "📦",
  bz2: "📦",
  xz: "📦",
  "7z": "📦",
  rar: "📦",
  zst: "📦",

  // Binary
  bin: "📥",
  exe: "📥",
  dll: "📥",
  so: "📥",
  dylib: "📥",
  o: "📥",
  obj: "📥",

  // Database
  db: "🗄️",
  sqlite: "🗄️",

  // Certificates
  pem: "🔐",
  key: "🔐",
  crt: "🔐",
  pub: "🔐",

  // Logs
  log: "📋",
};

/**
 * Map of exact filenames (lowercase) to emoji strings.
 * Used before extension-based lookup.
 */
export const FILE_NAME_ICONS: Record<string, string> = {
  makefile: "🏗️",
  dockerfile: "🐳",
  ".dockerignore": "🐳",
  ".gitignore": "🔀",
  ".gitattributes": "🔀",
  ".gitmodules": "🔀",
  ".editorconfig": "⚙️",
  readme: "📝",
  license: "📄",
  licence: "📄",
  procfile: "📋",
  vagrantfile: "🏗️",
  gemfile: "💎",
  rakefile: "💎",
  jenkinsfile: "🛠️",
  contributing: "📝",
  changelog: "📝",
  codeowners: "👥",
};

/**
 * Returns an emoji icon for a given filename.
 * Checks exact filename first (case-insensitive), then extension,
 * falls back to 📄.
 */
export function fileIcon(name: string): string {
  const lower = name.toLowerCase();

  // 1. Exact filename match
  if (FILE_NAME_ICONS[lower]) {
    return FILE_NAME_ICONS[lower];
  }

  // 2. Extension match
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex !== -1) {
    const ext = lower.slice(dotIndex + 1);
    if (FILE_TYPE_ICONS[ext]) {
      return FILE_TYPE_ICONS[ext];
    }
  }

  // 3. Fallback
  return "📄";
}
