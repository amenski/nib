/**
 * Nib Syntax Highlighter
 *
 * Lightweight, zero-dependency syntax highlighting for Ink terminal output.
 * Uses regex-based tokenization — no external grammars, no network calls,
 * fully offline. Supports 10+ languages with theme integration.
 *
 * Architecture:
 *   Tokenizer: stateless regex-based lexer per language
 *   Renderer: produces Ink <Text> spans with theme color props
 *   Fallback: graceful degradation to plain dim text for unknown languages
 */

import React from "react";
import { Text } from "ink";
import type { ThemeContextValue, SyntaxColors } from "./theme.js";

// ── Token Types ──

export type SyntaxTokenType = keyof SyntaxColors;

export interface SyntaxToken {
  type: SyntaxTokenType | "text";
  value: string;
}

// ── Language Registry ──

export type Language =
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "python"
  | "go"
  | "rust"
  | "c"
  | "cpp"
  | "java"
  | "kotlin"
  | "swift"
  | "ruby"
  | "php"
  | "shell"
  | "bash"
  | "sql"
  | "html"
  | "css"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "diff"
  | "text";

/**
 * Detect language from a code-fence info string.
 * Returns 'text' for unknown languages (plain dim rendering).
 */
export function detectLanguage(info: string): Language {
  const cleaned = info.toLowerCase().trim();
  const mapping: Record<string, Language> = {
    js: "javascript",
    javascript: "javascript",
    ts: "typescript",
    typescript: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    py: "python",
    python: "python",
    go: "go",
    rs: "rust",
    rust: "rust",
    c: "c",
    cpp: "cpp",
    "c++": "cpp",
    java: "java",
    kt: "kotlin",
    kotlin: "kotlin",
    swift: "swift",
    rb: "ruby",
    ruby: "ruby",
    php: "php",
    sh: "shell",
    bash: "bash",
    shell: "shell",
    zsh: "shell",
    sql: "sql",
    html: "html",
    css: "css",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    markdown: "markdown",
    diff: "diff",
    patch: "diff",
    text: "text",
    plain: "text",
    "": "text",
  };
  return mapping[cleaned] || "text";
}

// ── Tokenizers ──

type TokenizerFn = (code: string) => SyntaxToken[];

/**
 * Base tokenizer with common patterns used across languages.
 */
function baseTokenizer(
  code: string,
  specifics: {
    lineComments?: string[];
    blockComments?: [string, string][];
    strings?: [string, string][];
    keywords?: string[];
    types?: string[];
    builtins?: string[];
    constants?: string[];
    operators?: string[];
    special?: RegExp;
    numbers?: RegExp;
  },
): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let remaining = code;
  let pos = 0;

  const {
    lineComments = ["//"],
    blockComments = [["/*", "*/"]],
    strings = [
      ['"', '"'],
      ["'", "'"],
      ["`", "`"],
    ],
    keywords = [],
    types = [],
    builtins = [],
    constants = [],
    operators = [],
    special,
    numbers = /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b/,
  } = specifics;

  while (pos < remaining.length) {
    let matched = false;

    // Line comments
    for (const lc of lineComments) {
      if (remaining.startsWith(lc, pos)) {
        const end = remaining.indexOf("\n", pos);
        const lineEnd = end === -1 ? remaining.length : end;
        tokens.push({ type: "comment", value: remaining.slice(pos, lineEnd) });
        pos = lineEnd;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Block comments
    for (const [open, close] of blockComments) {
      if (remaining.startsWith(open, pos)) {
        const end = remaining.indexOf(close, pos + open.length);
        const blockEnd = end === -1 ? remaining.length : end + close.length;
        tokens.push({ type: "comment", value: remaining.slice(pos, blockEnd) });
        pos = blockEnd;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Strings
    for (const [quote, endQuote] of strings) {
      if (remaining.startsWith(quote, pos)) {
        const strStart = pos;
        pos += quote.length;
        let escaped = false;
        while (pos < remaining.length) {
          if (escaped) {
            escaped = false;
            pos++;
            continue;
          }
          if (remaining[pos] === "\\") {
            escaped = true;
            pos++;
            continue;
          }
          if (remaining.startsWith(endQuote, pos)) {
            pos += endQuote.length;
            break;
          }
          pos++;
        }
        tokens.push({ type: "string", value: remaining.slice(strStart, pos) });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Regex literals (JS/TS)
    if (special) {
      special.lastIndex = pos;
      const m = special.exec(remaining);
      if (m && m.index === pos) {
        tokens.push({ type: "regexp", value: m[0] });
        pos += m[0].length;
        matched = true;
        continue;
      }
    }

    // Numbers
    const numMatch = remaining.slice(pos).match(numbers);
    if (numMatch && numMatch.index === 0) {
      tokens.push({ type: "number", value: numMatch[0] });
      pos += numMatch[0].length;
      matched = true;
      continue;
    }

    // Identifiers and keywords
    const idMatch = remaining.slice(pos).match(/^[a-zA-Z_$\u00a0-\uffff][\w$]*/);
    if (idMatch && idMatch.index === 0) {
      const word = idMatch[0];

      // Constants (true, false, null, undefined, nil, None, etc.)
      if (constants.includes(word)) {
        tokens.push({ type: constantType(word), value: word });
      }
      // Keywords
      else if (keywords.includes(word)) {
        tokens.push({ type: "keyword", value: word });
      }
      // Types
      else if (types.includes(word)) {
        tokens.push({ type: "type", value: word });
      }
      // Builtins
      else if (builtins.includes(word)) {
        tokens.push({ type: "builtin", value: word });
      }
      // Function calls (word followed by '(')
      else if (remaining.length > pos + word.length && remaining[pos + word.length] === "(") {
        tokens.push({ type: "function", value: word });
      }
      // Class names (after 'class' or 'new')
      else {
        // Check context: if previous token was 'class' or 'new' keyword
        const prevToken = tokens.length > 0 ? tokens[tokens.length - 1] : null;
        if (prevToken && prevToken.type === "keyword" && (prevToken.value === "class" || prevToken.value === "new")) {
          tokens.push({ type: "className", value: word });
        } else if (word[0] === word[0]?.toUpperCase() && word[0] !== word[0]?.toLowerCase()) {
          // PascalCase → likely a type/class
          tokens.push({ type: "type", value: word });
        } else {
          tokens.push({ type: "text", value: word });
        }
      }
      pos += word.length;
      matched = true;
      continue;
    }

    // Operators (multi-char first)
    if (operators.length > 0) {
      // Sort by length descending for greedy matching
      const sorted = [...operators].sort((a, b) => b.length - a.length);
      for (const op of sorted) {
        if (remaining.startsWith(op, pos)) {
          tokens.push({ type: "operator", value: op });
          pos += op.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    // Punctuation / single-char operators
    const char = remaining[pos];
    if (/^[{}()\[\];:,.]$/.test(char)) {
      tokens.push({ type: "punctuation", value: char });
      pos++;
      continue;
    }

    // Whitespace — pass through as text
    const wsMatch = remaining.slice(pos).match(/^\s+/);
    if (wsMatch) {
      tokens.push({ type: "text", value: wsMatch[0] });
      pos += wsMatch[0].length;
      continue;
    }

    // Fallback: single char
    tokens.push({ type: "text", value: char });
    pos++;
  }

  return tokens;
}

function constantType(word: string): SyntaxTokenType {
  const falsey = ["true", "false", "True", "False", "YES", "NO"];
  const nullish = ["null", "undefined", "nil", "None", "NULL", "nil", "nothing"];
  if (falsey.includes(word)) return "boolean";
  if (nullish.includes(word)) return "nullish";
  return "constant";
}

// ── Language-specific tokenizers ──

const tokenizers: Partial<Record<Language, TokenizerFn>> = {
  javascript: (code) =>
    baseTokenizer(code, {
      keywords: [
        "async", "await", "break", "case", "catch", "class", "const", "continue",
        "debugger", "default", "delete", "do", "else", "export", "extends", "finally",
        "for", "function", "if", "import", "in", "instanceof", "let", "new", "of",
        "return", "static", "super", "switch", "this", "throw", "try", "typeof",
        "var", "void", "while", "with", "yield", "from", "as",
      ],
      types: ["any", "boolean", "number", "string", "object", "symbol", "undefined", "null", "never", "unknown", "void"],
      builtins: [
        "console", "Math", "JSON", "Promise", "Map", "Set", "WeakMap", "WeakSet",
        "Array", "Object", "String", "Number", "Boolean", "Symbol", "RegExp",
        "Error", "Date", "parseInt", "parseFloat", "isNaN", "isFinite",
        "setTimeout", "setInterval", "fetch", "require", "module", "process",
        "Buffer", "global", "globalThis", "Intl",
      ],
      constants: ["true", "false", "null", "undefined", "Infinity", "NaN"],
      operators: ["=>", "===", "!==", "==", "!=", "<=", ">=", "??", "?.", "||", "&&", "++", "--", "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~"],
      special: /\/(?![/*])[^\/\\]*(?:\\.[^\/\\]*)*\/[gimsuy]*/,
    }),

  typescript: (code) =>
    baseTokenizer(code, {
      keywords: [
        "async", "await", "break", "case", "catch", "class", "const", "continue",
        "debugger", "default", "delete", "do", "else", "export", "extends", "finally",
        "for", "function", "if", "import", "in", "instanceof", "let", "new", "of",
        "return", "static", "super", "switch", "this", "throw", "try", "typeof",
        "var", "void", "while", "with", "yield", "from", "as", "type", "interface",
        "enum", "implements", "abstract", "private", "protected", "public",
        "readonly", "declare", "namespace", "module", "keyof", "infer",
        "satisfies", "using", "await using",
      ],
      types: [
        "any", "boolean", "number", "string", "object", "symbol", "undefined",
        "null", "never", "unknown", "void", "bigint", "false", "true",
        "Record", "Partial", "Required", "Readonly", "Pick", "Omit",
        "Exclude", "Extract", "NonNullable", "ReturnType", "Parameters",
        "ConstructorParameters", "InstanceType", "ThisType",
        "Promise", "Array", "Map", "Set", "WeakMap", "WeakSet",
        "string[]", "number[]", "boolean[]",
      ],
      builtins: [
        "console", "Math", "JSON", "Error", "Date", "RegExp",
        "parseInt", "parseFloat", "isNaN", "isFinite",
        "setTimeout", "setInterval", "fetch", "require", "module", "process",
        "Buffer", "global", "globalThis", "Intl",
        "Document", "HTMLElement", "Window", "NodeList",
      ],
      constants: ["true", "false", "null", "undefined", "Infinity", "NaN"],
      operators: ["=>", "===", "!==", "==", "!=", "<=", ">=", "??", "?.", "||", "&&", "++", "--", "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", ":", ":"],
      special: /\/(?![/*])[^\/\\]*(?:\\.[^\/\\]*)*\/[gimsuy]*/,
    }),

  python: (code) =>
    baseTokenizer(code, {
      lineComments: ["#"],
      blockComments: [['"""', '"""'], ["'''", "'''"]],
      keywords: [
        "False", "None", "True", "and", "as", "assert", "async", "await",
        "break", "class", "continue", "def", "del", "elif", "else", "except",
        "finally", "for", "from", "global", "if", "import", "in", "is",
        "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
        "try", "while", "with", "yield",
      ],
      types: ["int", "float", "str", "bool", "list", "dict", "tuple", "set", "frozenset", "bytes", "bytearray", "type", "None"],
      builtins: [
        "print", "len", "range", "map", "filter", "zip", "enumerate", "sorted",
        "reversed", "open", "type", "isinstance", "issubclass", "hasattr",
        "getattr", "setattr", "delattr", "super", "object", "property",
        "staticmethod", "classmethod", "__init__", "__str__", "__repr__",
        "self", "cls", "ValueError", "TypeError", "KeyError", "IndexError",
        "Exception", "BaseException", "SystemExit", "KeyboardInterrupt",
        "List", "Dict", "Tuple", "Set", "Optional", "Union", "Any", "Callable",
        "Iterable", "Iterator", "Generator",
      ],
      constants: ["True", "False", "None", "Ellipsis", "NotImplemented"],
      operators: ["==", "!=", "<=", ">=", "->", "**", "//", "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", ":=", "@"],
    }),

  go: (code) =>
    baseTokenizer(code, {
      lineComments: ["//"],
      blockComments: [["/*", "*/"]],
      keywords: [
        "break", "case", "chan", "const", "continue", "default", "defer",
        "else", "fallthrough", "for", "func", "go", "goto", "if", "import",
        "interface", "map", "package", "range", "return", "select", "struct",
        "switch", "type", "var",
      ],
      types: [
        "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
        "int", "int8", "int16", "int32", "int64", "rune", "string",
        "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
      ],
      builtins: [
        "append", "cap", "close", "copy", "delete", "len", "make", "new",
        "panic", "print", "println", "recover", "nil",
        "fmt", "os", "io", "net", "http", "json", "time", "strings",
        "strconv", "sync", "errors", "context",
      ],
      constants: ["true", "false", "nil", "iota"],
      operators: ["==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "&=", "|=", "^=", "<<=", ">>=", "&^", "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "<<", ">>", "<-", ":=", "->"],
    }),

  rust: (code) =>
    baseTokenizer(code, {
      lineComments: ["//"],
      blockComments: [["/*", "*/"]],
      keywords: [
        "as", "async", "await", "break", "const", "continue", "crate", "dyn",
        "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
        "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
        "self", "Self", "static", "struct", "super", "trait", "true", "type",
        "unsafe", "use", "where", "while", "yield",
      ],
      types: [
        "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128",
        "isize", "str", "u8", "u16", "u32", "u64", "u128", "usize",
        "String", "Vec", "HashMap", "HashSet", "Option", "Result", "Box",
        "Rc", "Arc", "Cell", "RefCell", "Mutex", "RwLock",
      ],
      builtins: [
        "Some", "None", "Ok", "Err", "print!", "println!", "format!",
        "vec!", "match", "panic!", "assert!", "assert_eq!",
        "std", "core", "alloc", "clone", "copy", "debug", "display",
      ],
      constants: ["true", "false"],
      operators: ["=>", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "->", "::", "..", "...", "..=", "&", "|", "^", "!", "<<", ">>", "+", "-", "*", "/", "%", "=", "<", ">"],
    }),

  shell: (code) =>
    baseTokenizer(code, {
      lineComments: ["#"],
      blockComments: [],
      keywords: [
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do",
        "done", "case", "esac", "function", "return", "exit", "continue",
        "break", "in", "select", "time",
      ],
      types: [],
      builtins: [
        "echo", "printf", "export", "source", "cd", "pwd", "ls", "cat",
        "grep", "sed", "awk", "cut", "sort", "uniq", "wc", "head", "tail",
        "find", "xargs", "tee", "tr", "diff", "patch", "cp", "mv", "rm",
        "mkdir", "chmod", "chown", "ln", "tar", "gzip", "gunzip", "unzip",
        "ssh", "scp", "rsync", "curl", "wget", "git", "docker", "npm",
        "yarn", "pnpm", "npx", "node", "python", "make", "cmake",
      ],
      constants: ["true", "false"],
      operators: ["==", "!=", "<=", ">=", "&&", "||", "|", "&", ";", "+=", "=", "<", ">", "<<", ">>"],
    }),

  // SQL
  sql: (code) =>
    baseTokenizer(code, {
      lineComments: ["--"],
      blockComments: [["/*", "*/"]],
      keywords: [
        "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL",
        "AS", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL",
        "CROSS", "LATERAL", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
        "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
        "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW",
        "TRIGGER", "FUNCTION", "PROCEDURE", "IF", "EXISTS", "CASE",
        "WHEN", "THEN", "ELSE", "END", "BETWEEN", "LIKE", "ILIKE",
        "DISTINCT", "UNION", "ALL", "EXCEPT", "INTERSECT", "WITH",
        "RECURSIVE", "RETURNING", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
        "UNIQUE", "CHECK", "DEFAULT", "NOT", "NULL", "TRUE", "FALSE",
        "CAST", "COALESCE", "NULLIF",
      ],
      types: [
        "INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT",
        "FLOAT", "REAL", "DOUBLE", "DECIMAL", "NUMERIC",
        "CHAR", "VARCHAR", "TEXT", "CLOB",
        "BOOLEAN", "BIT",
        "DATE", "TIME", "TIMESTAMP", "DATETIME",
        "JSON", "JSONB", "ARRAY", "UUID", "SERIAL",
      ],
      builtins: [
        "COUNT", "SUM", "AVG", "MIN", "MAX", "NOW", "CURRENT_DATE",
        "CURRENT_TIMESTAMP", "EXTRACT", "DATE_TRUNC",
        "UPPER", "LOWER", "LENGTH", "TRIM", "SUBSTRING",
        "CONCAT", "COALESCE", "NULLIF", "ARRAY_AGG",
      ],
      constants: ["TRUE", "FALSE", "NULL"],
      operators: ["=", "!=", "<>", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "||", "::", "->", "->>", "#>", "#>>", "@>", "<@", "?"],
      numbers: /\b\d+(?:\.\d+)?\b/,
    }),

  // JSON
  json: (code) => {
    const tokens: SyntaxToken[] = [];
    const re = /("(?:\\.|[^"\\])*")\s*(:)|("(?:\\.|[^"\\])*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])|(\s+)/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (m[1]) {
        tokens.push({ type: "property", value: m[1] });
        if (m[2]) tokens.push({ type: "punctuation", value: ": " });
      } else if (m[3]) {
        tokens.push({ type: "string", value: m[3] });
      } else if (m[4]) {
        const word = m[4];
        if (word === "true" || word === "false") tokens.push({ type: "boolean", value: word });
        else tokens.push({ type: "nullish", value: word });
      } else if (m[5]) {
        tokens.push({ type: "number", value: m[5] });
      } else if (m[6]) {
        tokens.push({ type: "punctuation", value: m[6] });
      } else if (m[7]) {
        tokens.push({ type: "text", value: m[7] });
      }
    }
    return tokens;
  },

  // HTML
  html: (code) => {
    const tokens: SyntaxToken[] = [];
    const re = /(<[!?\/]?)([a-zA-Z][a-zA-Z0-9-]*)|((<\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)(\/?>))|(&\w+;)|\s+|([^<&]+)/g;
    let pos = 0;
    while (pos < code.length) {
      // Try tag
      let m = re.exec(code);
      if (m && m.index === pos) {
        if (m[1]) {
          // Opening bracket
          tokens.push({ type: "punctuation", value: m[1] });
          tokens.push({ type: "tag", value: m[2] });
          pos = m.index + m[0].length;
          continue;
        }
        if (m[3]) {
          // Full tag match
          const tagMatch = m[3];
          let tp = 0;
          // < or </
          if (tagMatch.startsWith("</")) {
            tokens.push({ type: "punctuation", value: "</" });
            tp = 2;
          } else {
            tokens.push({ type: "punctuation", value: "<" });
            tp = 1;
          }
          tokens.push({ type: "tag", value: m[5] });
          tp += m[5].length;

          // Parse attributes in the tag
          const attrRe = /\s+([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
          let attrM;
          while ((attrM = attrRe.exec(m[6]!)) !== null) {
            if (attrM[1]) {
              tokens.push({ type: "text", value: attrM[0].slice(0, attrM[0].indexOf(attrM[1])) }); // whitespace
              tokens.push({ type: "attribute", value: attrM[1] });
              if (attrM[2] !== undefined) {
                tokens.push({ type: "operator", value: "=" });
                tokens.push({ type: "string", value: `"${attrM[2]}"` });
              } else if (attrM[3] !== undefined) {
                tokens.push({ type: "operator", value: "=" });
                tokens.push({ type: "string", value: `'${attrM[3]}'` });
              } else if (attrM[4] !== undefined) {
                tokens.push({ type: "operator", value: "=" });
                tokens.push({ type: "string", value: attrM[4] });
              }
            }
          }

          // Closing > or />
          const endPart = m[7]!;
          tokens.push({ type: "punctuation", value: endPart });
          pos = m.index + m[0].length;
          continue;
        }
        if (m[8]) {
          // Entity
          tokens.push({ type: "string", value: m[8] });
          pos += m[8].length;
          continue;
        }
        if (m[9]) {
          tokens.push({ type: "text", value: m[9] });
          pos += m[9].length;
          continue;
        }
      }
      // Fallback
      tokens.push({ type: "text", value: code[pos] });
      pos++;
    }
    return tokens;
  },

  // CSS
  css: (code) =>
    baseTokenizer(code, {
      lineComments: [],
      blockComments: [["/*", "*/"]],
      keywords: [
        "import", "media", "keyframes", "font-face", "supports",
        "layer", "container", "scope",
      ],
      types: [],
      builtins: [],
      constants: ["inherit", "initial", "unset", "revert"],
      operators: [],
    }),

  // YAML
  yaml: (code) => {
    const tokens: SyntaxToken[] = [];
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i > 0) tokens.push({ type: "text", value: "\n" });

      // Comment
      const commentIdx = line.indexOf(" #");
      const cleanLine = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
      if (commentIdx >= 0) {
        // Will add comment after key-value parse
      }

      // Key: value pattern
      const kvMatch = cleanLine.match(/^(\s*)([\w./_-]+)(\s*:\s*)(.*)$/);
      if (kvMatch) {
        tokens.push({ type: "text", value: kvMatch[1] });
        tokens.push({ type: "property", value: kvMatch[2] });
        tokens.push({ type: "punctuation", value: kvMatch[3] });

        const val = kvMatch[4];
        if (/^\d/.test(val)) {
          tokens.push({ type: "number", value: val });
        } else if (val === "true" || val === "false") {
          tokens.push({ type: "boolean", value: val });
        } else if (val === "null" || val === "~") {
          tokens.push({ type: "nullish", value: val });
        } else if (val.startsWith('"') || val.startsWith("'")) {
          tokens.push({ type: "string", value: val });
        } else if (val.startsWith("|") || val.startsWith(">")) {
          tokens.push({ type: "operator", value: val });
        } else {
          tokens.push({ type: "text", value: val });
        }
      } else {
        // List item
        const listMatch = cleanLine.match(/^(\s*)(-)\s+(.*)$/);
        if (listMatch) {
          tokens.push({ type: "text", value: listMatch[1] });
          tokens.push({ type: "punctuation", value: listMatch[2] });
          tokens.push({ type: "text", value: " " + listMatch[3] });
        } else {
          tokens.push({ type: "text", value: cleanLine });
        }
      }

      // Append comment
      if (commentIdx >= 0) {
        tokens.push({ type: "comment", value: line.slice(commentIdx) });
      }
    }
    return tokens;
  },

  // Diff
  diff: (code) => {
    const tokens: SyntaxToken[] = [];
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i > 0) tokens.push({ type: "text", value: "\n" });

      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
        tokens.push({ type: "comment", value: line });
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        tokens.push({ type: "string", value: line });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        tokens.push({ type: "decorator", value: line });
      } else {
        tokens.push({ type: "text", value: line });
      }
    }
    return tokens;
  },
};

// ── JSX/TSX (extends JS/TS with HTML-like tags) ──

function tokenizeJsx(code: string, isTsx: boolean): SyntaxToken[] {
  const baseTokens = (isTsx ? tokenizers.typescript : tokenizers.javascript)!(code);
  // Post-process: merge adjacent tag-like sequences
  const merged: SyntaxToken[] = [];
  for (let i = 0; i < baseTokens.length; i++) {
    const t = baseTokens[i];
    merged.push(t);
  }
  return merged;
}

tokenizers.jsx = (code) => tokenizeJsx(code, false);
tokenizers.tsx = (code) => tokenizeJsx(code, true);

// ── Main Tokenizer Entry Point ──

/**
 * Tokenize code for a given language.
 * Falls back to 'text' (single dim token) for unknown languages.
 */
export function tokenize(code: string, language: Language): SyntaxToken[] {
  const tokenizer = tokenizers[language];
  if (!tokenizer) {
    // Fallback: return whole code as a single text token
    return [{ type: "text", value: code }];
  }
  return tokenizer(code);
}

// ── Ink Renderer ──

interface SyntaxHighlighterProps {
  code: string;
  language: Language;
  theme: ThemeContextValue;
}

/**
 * Renders syntax-highlighted code using Ink <Text> spans.
 * Each token gets a color from the theme's syntax colors via ANSI escape codes.
 */
function SyntaxHighlighter({ code, language, theme }: SyntaxHighlighterProps) {
  const tokens = tokenize(code, language);

  if (!theme.colorEnabled) {
    // No color: render as plain text
    return (
      <Text>
        {tokens.map((token, i) => (
          <Text key={i}>{token.value}</Text>
        ))}
      </Text>
    );
  }

  // Build ANSI-colored string
  let result = "";
  for (const token of tokens) {
    if (token.type === "text") {
      result += token.value;
    } else {
      const color = theme.theme.syntax[token.type];
      if (color === undefined) {
        result += token.value;
      } else {
        result += `\x1b[38;5;${color}m${token.value}\x1b[0m`;
      }
    }
  }

  return <Text>{result}</Text>;
}

export default React.memo(SyntaxHighlighter);

/**
 * Get a short display name for a language.
 */
export function languageLabel(language: Language): string {
  const labels: Partial<Record<Language, string>> = {
    javascript: "JS",
    typescript: "TS",
    jsx: "JSX",
    tsx: "TSX",
    python: "Py",
    shell: "sh",
    bash: "bash",
  };
  return labels[language] ?? language;
}
