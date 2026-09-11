#!/usr/bin/env node
// Cases for the discipline agent catalogue under templates/agents/ (issue #124).
// This is a pure-read test (CLAUDE.md invariant 6 exempts catalogue reads: no
// script is spawned here, only the filesystem). The .toml form is parsed with
// a tiny hand-rolled extractor — no TOML library (invariant 1).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

const AGENTS_DIR = join(ROOT, 'templates', 'agents');

// --- AC1: fourteen cards, both forms, same instructions ---

const CARDS = [
  'qa',
  'architecture',
  'backend',
  'frontend',
  'design',
  'product',
  'research',
  'planner',
  'investigator',
  'security-reviewer',
  'data-migrations',
  'devops',
  'release-manager',
  'profiler',
];

const ALLOWED_PLACEHOLDERS = new Set(['test_command', 'stack', 'test_dirs', 'default_branch']);
const REQUIRED_SECTIONS = ['## Checks', '## Never', '## Output'];

/** Splits a `.md` card into its frontmatter block and body; null if the shape is wrong. */
function parseMarkdownCard(text: string): { frontmatter: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  return m ? { frontmatter: m[1], body: m[2] } : null;
}

/** Reads a `key: value` line out of a frontmatter block. */
function frontmatterField(frontmatter: string, key: string): string | null {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** Reads a `key = "value"` single-line string out of a TOML card. */
function tomlString(toml: string, key: string): string | null {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

/** Reads a `key = '''...'''` multi-line string out of a TOML card. */
function tomlMultilineString(toml: string, key: string): string | null {
  const m = toml.match(new RegExp(`${key}\\s*=\\s*'''([\\s\\S]*?)'''`));
  return m ? m[1] : null;
}

/** Collapses whitespace so a markdown body and a TOML string can be compared "modulo whitespace". */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Every `{{name}}` token found in a piece of instruction text. */
function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
}

for (const name of CARDS) {
  const mdPath = join(AGENTS_DIR, name, `${name}.md`);
  const tomlPath = join(AGENTS_DIR, name, `${name}.toml`);

  if (!existsSync(mdPath)) {
    check(`${name}: ${name}.md exists`, false, mdPath);
    continue;
  }
  if (!existsSync(tomlPath)) {
    check(`${name}: ${name}.toml exists`, false, tomlPath);
    continue;
  }

  const mdText = readFileSync(mdPath, 'utf8');
  const tomlText = readFileSync(tomlPath, 'utf8');

  const parsed = parseMarkdownCard(mdText);
  check(`${name}: .md has a frontmatter block and a body`, parsed !== null, mdText.slice(0, 120));
  if (!parsed) continue;
  const { frontmatter, body } = parsed;

  const mdName = frontmatterField(frontmatter, 'name');
  const mdDescription = frontmatterField(frontmatter, 'description');
  const mdModel = frontmatterField(frontmatter, 'model');
  const mdTools = frontmatterField(frontmatter, 'tools');
  check(`${name}: .md frontmatter name matches the card`, mdName === name, String(mdName));
  check(`${name}: .md frontmatter has a description`, !!mdDescription);
  check(`${name}: .md frontmatter has a model`, !!mdModel);
  check(`${name}: .md frontmatter has tools`, !!mdTools);

  const tomlName = tomlString(tomlText, 'name');
  const tomlDescription = tomlString(tomlText, 'description');
  const tomlModel = tomlString(tomlText, 'model');
  const tomlInstructions = tomlMultilineString(tomlText, 'developer_instructions');
  check(`${name}: .toml name matches the card`, tomlName === name, String(tomlName));
  check(`${name}: .toml has a description`, !!tomlDescription);
  check(`${name}: .toml has a model`, !!tomlModel);
  check(`${name}: .toml has developer_instructions`, tomlInstructions !== null);
  if (tomlInstructions === null) continue;

  check(
    `${name}: .md body and .toml developer_instructions carry the same instructions`,
    normalize(body) === normalize(tomlInstructions),
    `md:   ${normalize(body).slice(0, 200)}\ntoml: ${normalize(tomlInstructions).slice(0, 200)}`,
  );

  const requiredSections = name === 'design' ? [...REQUIRED_SECTIONS, '## Accessibility'] : REQUIRED_SECTIONS;
  for (const section of requiredSections) {
    check(`${name}: body has "${section}"`, body.includes(section));
  }

  const allPlaceholders = new Set([...placeholdersIn(body), ...placeholdersIn(tomlInstructions)]);
  for (const p of allPlaceholders) {
    check(`${name}: placeholder {{${p}}} is from the allowed set`, ALLOWED_PLACEHOLDERS.has(p));
  }
}

// --- AC2: templates/agents/index.json maps scope:* labels to existing cards ---

const indexPath = join(AGENTS_DIR, 'index.json');
if (!existsSync(indexPath)) {
  check('index.json exists', false, indexPath);
} else {
  let index: any = null;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (err) {
    check('index.json is valid JSON', false, String(err));
  }
  if (index) {
    const scopes = index.scopes ?? {};
    const scopeKeys = Object.keys(scopes);
    check('index.json has at least one scope:* mapping', scopeKeys.length > 0);
    for (const key of scopeKeys) {
      check(`index.json scopes: key "${key}" looks like scope:*`, /^scope:[a-z0-9-]+$/.test(key));
      const card = scopes[key];
      check(`index.json scopes: "${key}" -> "${card}" is a real card`, CARDS.includes(card), String(card));
    }
    const runsWithReviewer = index.runs_with_reviewer ?? [];
    check('index.json names at least one card that runs next to reviewer', Array.isArray(runsWithReviewer) && runsWithReviewer.length > 0);
    for (const card of runsWithReviewer) {
      check(`index.json runs_with_reviewer: "${card}" is a real card`, CARDS.includes(card), String(card));
    }
  }
}

finish();
