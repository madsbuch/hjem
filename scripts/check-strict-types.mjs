import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function filesIn(directory, extension) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'target', 'gen', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(path, extension));
    else if (entry.isFile() && extension.test(entry.name)) result.push(path);
  }
  return result;
}

const bannedKinds = new Map([
  [SyntaxKind.AnyKeyword, 'Use unknown and validate it instead of any.'],
  [SyntaxKind.AsExpression, 'Replace the type assertion with a type guard or explicit declaration.'],
  [SyntaxKind.TypeAssertionExpression, 'Replace the type assertion with a type guard or explicit declaration.'],
  [SyntaxKind.NonNullExpression, 'Check the nullable value before using it.'],
]);
const config = join(root, 'tsconfig.json');
const api = new API({ cwd: root });
let typescriptFiles = 0;
try {
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const project = snapshot.getProject(config);
  if (!project) throw new Error('Could not load the TypeScript project.');
  for (const path of await filesIn(join(root, 'src'), /\.[cm]?tsx?$/)) {
    if (/\.(test|spec)\.[cm]?tsx?$/.test(path)) continue;
    const source = project.program.getSourceFile(path);
    if (!source) throw new Error(`Production source was not checked: ${relative(root, path)}`);
    typescriptFiles++;
    const report = (node, message) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${relative(root, path)}:${position.line + 1}:${position.character + 1}: ${message}`);
    };
    const visit = (node) => {
      const message = bannedKinds.get(node.kind);
      if (message) report(node, message);
      if (node.exclamationToken && node.kind !== SyntaxKind.NonNullExpression)
        report(node.exclamationToken, 'Initialize the value instead of asserting definite assignment.');
      node.forEachChild(visit);
    };
    visit(source);
  }
} finally {
  api.close();
}

// A small lexer keeps comments, normal/raw strings and character literals out
// of Rust checks. Import aliases (`use ... as ...`) are not numeric casts.
function rustTokens(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const rest = source.slice(cursor);
    if (rest.startsWith('//')) {
      const newline = source.indexOf('\n', cursor);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 1;
      cursor += 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith('/*', cursor)) { depth++; cursor += 2; }
        else if (source.startsWith('*/', cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      continue;
    }
    const rawString = /^(?:br|cr|r)(#*)"/.exec(rest);
    if (rawString) {
      const end = source.indexOf(`"${rawString[1]}`, cursor + rawString[0].length);
      cursor = end < 0 ? source.length : end + rawString[1].length + 1;
      continue;
    }
    const quoted = /^(?:b|c)?"/.exec(rest);
    if (quoted) {
      cursor += quoted[0].length;
      while (cursor < source.length) {
        const character = source[cursor++];
        if (character === '\\') cursor++;
        else if (character === '"') break;
      }
      continue;
    }
    const character = /^(?:b)?'(?:[^'\\\n]|\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|.))'/.exec(rest);
    if (character) { cursor += character[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z_\d]*/.exec(rest);
    if (identifier) {
      tokens.push({ text: identifier[0], position: cursor });
      cursor += identifier[0].length;
      continue;
    }
    if (';<>:'.includes(source[cursor])) tokens.push({ text: source[cursor], position: cursor });
    cursor++;
  }
  return tokens;
}

const rustFiles = await filesIn(join(root, 'src-tauri'), /\.rs$/);
for (const path of rustFiles) {
  const source = await readFile(path, 'utf8');
  let importDeclaration = false;
  const tokens = rustTokens(source);
  for (const [index, token] of tokens.entries()) {
    if (token.text === 'use') importDeclaration = true;
    if (token.text === ';') importDeclaration = false;
    if (token.text !== 'unsafe' && (token.text !== 'as' || importDeclaration)) continue;
    if (token.text === 'as' && /<\s*(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*\s*$/.test(source.slice(0, token.position))) {
      let depth = 1;
      let closing = index + 1;
      for (; closing < tokens.length && depth > 0; closing++) {
        if (tokens[closing].text === '<') depth++;
        if (tokens[closing].text === '>') depth--;
        if (tokens[closing].text === ';') break;
      }
      if (depth === 0 && tokens[closing]?.text === ':' && tokens[closing + 1]?.text === ':') continue;
    }
    const before = source.slice(0, token.position);
    const line = before.split('\n').length;
    const column = token.position - before.lastIndexOf('\n');
    failures.push(`${relative(root, path)}:${line}:${column}: ${token.text === 'unsafe' ? 'Unsafe Rust is forbidden.' : 'Use checked conversions instead of Rust as casts.'}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Strict typing verified in ${typescriptFiles} TypeScript and ${rustFiles.length} Rust source files.`);
}
