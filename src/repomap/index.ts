import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import ts from "typescript";
import type { WireSymbol } from "../lsp/protocol.js";

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "variable" | "constant" | "interface" | "type" | "method" | "property" | "enum" | "struct" | "module" | "string" | "number" | "boolean";
  file: string;
  line: number;
  exported: boolean;
  /** Compact signature when the source had one — `(a: string): void`, `: number`, `extends Base`. */
  sig?: string;
}

export interface FileTags {
  mtime: number;
  symbols: SymbolDef[];
  /** Workspace-relative paths this file imports (TS/JS only). */
  edges: string[];
}

export interface RepoMapResult {
  symbols: SymbolDef[];
  fileSymbolCount: Map<string, number>;
}

const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage", "__pycache__"]);
const MAX_FILES = 800;

/** Non-TS/JS extensions the map covers when a language server owns them (docs/todo.md D8). */
export const LSP_EXTENSIONS = [".py", ".go", ".rs", ".rb", ".java", ".dart", ".kt", ".lua", ".php", ".c", ".h", ".cpp", ".hpp", ".ex", ".exs", ".swift", ".zig", ".cs"];

/** Async source of document symbols for files the TS parser cannot read. */
export interface DocumentSymbolSource {
  (path: string): Promise<WireSymbol[]>;
}

export interface RepoMapOptions {
  /** Extra file extensions to cover through `documentSymbols` (LSP-served languages). */
  extraExtensions?: string[];
  /** `textDocument/documentSymbol` for one file; only called for `extraExtensions` files. */
  documentSymbols?: DocumentSymbolSource;
}

function isSupported(filePath: string): boolean {
  return SUPPORTED_EXTS.some((ext) => filePath.endsWith(ext));
}

function extractSymbols(filePath: string, source: string): SymbolDef[] {
  const symbols: SymbolDef[] = [];
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node): void {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());

    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText(sf);
      if (name) {
        symbols.push({
          name,
          kind: "function",
          file: filePath,
          line: line + 1,
          exported: hasExportModifier(node),
          ...(signatureOf(node, sf) !== undefined ? { sig: signatureOf(node, sf)! } : {}),
        });
      }
    } else if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText(sf);
      if (name) {
        // The heritage clause IS the class's interface: `extends Base`.
        const extended = node.heritageClauses?.[0]?.getText(sf);
        symbols.push({
          name,
          kind: "class",
          file: filePath,
          line: line + 1,
          exported: hasExportModifier(node),
          ...(extended ? { sig: extended } : {}),
        });
      }
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const name = node.name?.getText(sf);
      if (name && node.parent && ts.isClassDeclaration(node.parent)) {
        symbols.push({
          name: `${(node.parent as ts.ClassDeclaration).name?.getText(sf) ?? "?"}.${name}`,
          kind: "method",
          file: filePath,
          line: line + 1,
          exported: false,
          ...(signatureOf(node, sf) !== undefined ? { sig: signatureOf(node, sf)! } : {}),
        });
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent)
    ) {
      const name = node.name.getText(sf);
      const parent = node.parent.parent;
      const isModuleLevel = parent && ts.isSourceFile(parent);
      if (isModuleLevel && name) {
        let exported = false;
        if (parent && ts.isVariableStatement(parent)) {
          exported = hasExportModifier(parent);
        }
        const declType = node.type?.getText(sf);
        symbols.push({
          name,
          kind: declType ? "constant" : "variable",
          file: filePath,
          line: line + 1,
          exported,
          ...(declType ? { sig: `: ${declType}` } : {}),
        });
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name?.getText(sf);
      if (name) {
        symbols.push({
          name,
          kind: "interface",
          file: filePath,
          line: line + 1,
          exported: hasExportModifier(node),
        });
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText(sf);
      symbols.push({
        name,
        kind: "type",
        file: filePath,
        line: line + 1,
        exported: hasExportModifier(node),
        sig: `= ${node.type.getText(sf)}`,
      });
    } else if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText(sf);
      symbols.push({
        name,
        kind: "enum",
        file: filePath,
        line: line + 1,
        exported: hasExportModifier(node),
      });
    } else if (ts.isPropertyDeclaration(node) && node.parent && ts.isClassDeclaration(node.parent)) {
      const name = node.name.getText(sf);
      if (name) {
        symbols.push({
          name: `${(node.parent as ts.ClassDeclaration).name?.getText(sf) ?? "?"}.${name}`,
          kind: "property",
          file: filePath,
          line: line + 1,
          exported: false,
          ...(node.type ? { sig: `: ${node.type.getText(sf)}` } : {}),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return symbols;
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return ts.getModifiers(node)?.some(
    (mod) => mod.kind === ts.SyntaxKind.ExportKeyword || mod.kind === ts.SyntaxKind.DefaultKeyword,
  ) ?? false;
}

/** Map an LSP SymbolKind name (from symbolsFromWire — lowercase) to the map's vocabulary. Case-insensitive on the input. */
export function lspKindToMapKind(kind: string): SymbolDef["kind"] {
  switch (kind.toLowerCase()) {
    case "function": return "function";
    case "class": return "class";
    case "method": case "constructor": return "method";
    case "property": case "field": case "enumMember": case "key": return "property";
    case "constant": return "constant";
    case "interface": return "interface";
    case "enum": return "enum";
    case "struct": return "struct";
    case "module": case "namespace": case "package": case "file": return "module";
    case "typeParameter": return "type";
    default: return "variable";
  }
}

/** `(a: string, b?: number): void` — annotated types only; nothing is guessed. */
function signatureOf(node: ts.SignatureDeclaration, sf: ts.SourceFile): string | undefined {
  const params = node.parameters.map((p) => {
    const name = p.name.getText(sf);
    const optional = p.questionToken ? "?" : "";
    const type = p.type ? `: ${p.type.getText(sf)}` : "";
    return `${name}${optional}${type}`;
  });
  const ret = node.type ? `: ${node.type.getText(sf)}` : "";
  if (params.length === 0 && !node.type) return undefined;
  return `(${params.join(", ")})${ret}`;
}

/** Workspace-relative targets of internal (./ and ../) import specifiers. */function collectEdges(filePath: string, source: string, workspaceDir: string): string[] {
  const edges = new Set<string>();
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false);
  const visit = (node: ts.Node): void => {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = (node.moduleSpecifier as ts.StringLiteral).text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === "require" &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = (node.arguments[0] as ts.StringLiteral).text;
    }
    if (specifier && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      const base = resolve(workspaceDir, filePath, "..", specifier);
      // TS/JS imports elide extensions ("./utils.js" may mean utils.ts), so
      // candidates cover both spellings plus the index-file convention.
      const stripped = base.replace(/\.(m|c)?[jt]sx?$/, "");
      const candidates = [
        base,
        ...SUPPORTED_EXTS.map((ext) => `${stripped}${ext}`),
        join(stripped, "index.ts"),
        join(stripped, "index.js"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          edges.add(relative(workspaceDir, candidate).split("\\").join("/"));
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...edges].sort();
}

async function scanFiles(
  dir: string,
  files: string[],
  max: number,
  extraExtensions: string[] = [],
): Promise<void> {
  if (files.length >= max) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= max) return;
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDE_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanFiles(full, files, max, extraExtensions);
    } else if (entry.isFile() && (isSupported(entry.name) || extraExtensions.some((ext) => entry.name.endsWith(ext)))) {
      files.push(full);
    }
  }
}

export class RepoMap {
  private cache: Map<string, FileTags> = new Map();
  private workspaceDir: string;
  private readonly extraExts: string[];
  private readonly documentSymbols: DocumentSymbolSource | undefined;

  constructor(workspaceDir?: string, options?: RepoMapOptions) {
    this.workspaceDir = resolve(workspaceDir ?? process.cwd());
    this.extraExts = (options?.extraExtensions ?? []).filter(
      (ext) => ext.startsWith(".") && !SUPPORTED_EXTS.includes(ext),
    );
    this.documentSymbols = options?.documentSymbols;
  }

  async build(): Promise<RepoMapResult> {
    const files: string[] = [];
    await scanFiles(this.workspaceDir, files, MAX_FILES, this.extraExts);

    const symbols: SymbolDef[] = [];
    const fileSymbolCount = new Map<string, number>();

    for (const filePath of files) {
      const relPath = relative(this.workspaceDir, filePath);

      let mtime = 0;
      try {
        const s = await stat(filePath);
        mtime = s.mtimeMs;
      } catch {
        continue;
      }

      const cached = this.cache.get(relPath);
      if (cached && cached.mtime === mtime) {
        for (const sym of cached.symbols) {
          symbols.push(sym);
        }
        fileSymbolCount.set(relPath, cached.symbols.length);
        continue;
      }

      // LSP-served languages (docs/todo.md D8): no TS parse, symbols come from
      // `documentSymbols`. An absent/failing source just skips the file — a
      // broken server must not cost the whole map.
      if (!isSupported(filePath)) {
        const fromLsp = await this.symbolsViaLsp(filePath, relPath, mtime);
        if (!fromLsp) continue;
        // Cached like parsed files: formatRankedFiles renders from the cache.
        this.cache.set(relPath, { mtime, symbols: fromLsp.symbols, edges: [] });
        symbols.push(...fromLsp.symbols);
        fileSymbolCount.set(relPath, fromLsp.symbols.length);
        continue;
      }

      let source: string;
      try {
        source = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const extracted = extractSymbols(relPath, source);
      this.cache.set(relPath, { mtime, symbols: extracted, edges: collectEdges(relPath, source, this.workspaceDir) });

      for (const sym of extracted) {
        symbols.push(sym);
      }
      fileSymbolCount.set(relPath, extracted.length);
    }

    return { symbols, fileSymbolCount };
  }

  private async symbolsViaLsp(
    filePath: string,
    relPath: string,
    mtime: number,
  ): Promise<{ symbols: SymbolDef[] } | undefined> {
    if (!this.documentSymbols) return undefined;
    try {
      const raw: WireSymbol[] = await this.documentSymbols(filePath);
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      return {
        symbols: raw.map((ws) => ({
          name: ws.name,
          kind: lspKindToMapKind(ws.kind),
          file: relPath,
          line: ws.line,
          exported: true,
        })),
      };
    } catch {
      return undefined;
    }
  }

  getCachedSymbols(): SymbolDef[] {
    const result: SymbolDef[] = [];
    for (const [, tags] of this.cache) {
      for (const sym of tags.symbols) {
        result.push(sym);
      }
    }
    return result;
  }

  async getMap(conversation: string, tokenBudget: number): Promise<string> {
    const result = await this.build();
    if (result.symbols.length === 0) return "(empty repository)";

    const identifiers = extractIdentifiers(conversation);
    const fileMentions = extractFileMentions(conversation, result.symbols);

    const fileScores = scoreFiles(result.symbols, result.fileSymbolCount, identifiers, fileMentions);
    const ranked = [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([file]) => file);

    const formatted = formatRankedFiles(ranked, this.cache, tokenBudget);
    return formatted || "(empty repository)";
  }
}

function extractIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();
  const words = text.match(/\b[a-zA-Z_]\w*\b/g);
  if (!words) return ids;

  for (const w of words) {
    if (w.length < 3 || w.length > 40) continue;
    if (/^(the|and|for|not|are|but|you|that|this|with|have|from|your|will|what|when|then|can|all|each|they|their|them|been|were|about|which|also|into|more|some|only|other|than|would|could|should|there|being)$/i.test(w)) continue;
    ids.add(w);
  }
  return ids;
}

function extractFileMentions(text: string, symbols: SymbolDef[]): Set<string> {
  const mentions = new Set<string>();
  const symbolFiles = new Map<string, boolean>();
  for (const s of symbols) {
    symbolFiles.set(s.file, true);
  }

  const patterns = [
    /([\w.\-/\\]+\.(?:ts|tsx|js|jsx|mts|mjs))/g,
    /`([\w.\-/\\]+)`/g,
    /([\w.\-/\\]+\/\w+\.\w+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[1];
      for (const f of symbolFiles.keys()) {
        if (f.endsWith(candidate) || candidate.endsWith(f) || f.includes(candidate)) {
          mentions.add(f);
        }
      }
    }
  }
  return mentions;
}

function scoreFiles(
  symbols: SymbolDef[],
  fileSymbolCount: Map<string, number>,
  identifiers: Set<string>,
  fileMentions: Set<string>,
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const sym of symbols) {
    let base = 0;

    for (const id of identifiers) {
      if (sym.name.toLowerCase().includes(id.toLowerCase())) {
        base += 10;
      }
    }

    if (fileMentions.has(sym.file)) {
      base += 50;
    }

    if (!sym.exported) {
      base *= 0.1;
    }

    const existing = scores.get(sym.file) ?? 0;
    scores.set(sym.file, existing + base);
  }

  return scores;
}

/** The largest repo map injected into the prompt, in bytes (REPOMAP_BYTE_BUDGET). */
const MAX_SYMBOL_LIST_CHARS = 400;

/**
 * Interface-level detail (docs/todo.md D8) joined into one line per file.
 * Long symbol lists are truncated with a count, not dropped: one generated
 * file with 375 helpers must not eat the whole 4KB budget and starve every
 * other file out of the map (measured on this repo: an 8,948-char line left
 * a 1-line map).
 */
/** One symbol rendered for the map line, signature riding the name. */
function render(s: SymbolDef): string {
  if (!s.sig) return `${s.kind} ${s.name}`;
  // `(name: string): void` joins without a space; `: type` already carries
  // its own separator; `extends Base` / `= …` need one.
  const sep = s.sig.startsWith("(") || s.sig.startsWith(":") ? "" : " ";
  return `${s.kind} ${s.name}${sep}${s.sig}`;
}

function renderList(symbols: SymbolDef[]): string {
  let out = "";
  let shown = 0;
  for (const sym of symbols) {
    const item = `${shown > 0 ? ", " : ""}${render(sym)}`;
    if (out.length + item.length > MAX_SYMBOL_LIST_CHARS && shown > 0) break;
    out += item;
    shown++;
  }
  if (shown < symbols.length) {
    const note = ` … (+${symbols.length - shown} more)`;
    if (out.length + note.length <= MAX_SYMBOL_LIST_CHARS + note.length) out += note;
  }
  return out;
}

function formatRankedFiles(
  ranked: string[],
  cache: Map<string, FileTags>,
  tokenBudget: number,
): string | null {
  if (ranked.length === 0) return null;

  const buffer: { file: string; text: string }[] = [];
  for (const file of ranked) {
    const tags = cache.get(file);
    if (!tags) continue;

    const publicSyms = tags.symbols.filter((s) => s.exported);
    const privateSyms = tags.symbols.filter((s) => !s.exported);

    const parts: string[] = [];
    if (publicSyms.length > 0) {
      parts.push(renderList(publicSyms));
    }
    if (privateSyms.length > 0 && publicSyms.length === 0) {
      parts.push(renderList(privateSyms.slice(0, 3)));
    }

    if (parts.length > 0) {
      let text = `${file}: ${parts.join("; ")}`;
      if (tags.edges.length > 0) text += ` · imports ${tags.edges.join(", ")}`;
      buffer.push({ file, text });
    }
  }

  if (buffer.length === 0) return null;

  let lo = 0;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = buffer.slice(0, mid);
    const chars = slice.reduce((sum, e) => sum + e.text.length + 1, 0);
    const tokens = Math.ceil(chars / 4);
    if (tokens <= tokenBudget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo === 0) return null;
  return buffer.slice(0, lo).map((e) => e.text).join("\n");
}

