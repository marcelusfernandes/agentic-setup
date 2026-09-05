// Detects the project's check and test commands from what the repository
// contains. The stop-gate hook and the negative-control CI job both use
// this file, so "the tests" means the same thing in both places.
//
// Detection is a default, not a contract: AGENTIC_TEST_CMD and
// AGENTIC_CHECK_CMD override each field. Node built-ins only.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Commands = { test: string | null; check: string | null; stack: string };
export type Detected = Commands & { source: 'override' | 'detected' | 'none' };

const has = (root: string, file: string) => existsSync(join(root, file));
const read = (root: string, file: string): string => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
};

function fromMakefile(root: string): Commands | null {
  const mk = read(root, 'Makefile');
  if (!/^test\s*:/m.test(mk)) return null;
  const check = /^check\s*:/m.test(mk) ? 'make check' : /^lint\s*:/m.test(mk) ? 'make lint' : null;
  return { test: 'make test', check, stack: 'make' };
}

function nodePackageManager(root: string): string {
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(root, 'yarn.lock')) return 'yarn';
  if (has(root, 'bun.lock') || has(root, 'bun.lockb')) return 'bun';
  return 'npm';
}

function fromPackageJson(root: string): Commands | null {
  if (!has(root, 'package.json')) return null;
  let pkg;
  try {
    pkg = JSON.parse(read(root, 'package.json'));
  } catch {
    return null;
  }
  const scripts = pkg?.scripts ?? {};
  const pm = nodePackageManager(root);
  const exec = pm === 'npm' ? 'npx' : pm === 'bun' ? 'bunx' : `${pm} exec`;
  const placeholder = /no test specified/;
  const test =
    typeof scripts.test === 'string' && !placeholder.test(scripts.test) ? `${pm} test` : null;
  let check: string | null = null;
  if (typeof scripts.check === 'string') check = `${pm} run check`;
  else if (typeof scripts.lint === 'string') check = `${pm} run lint`;
  else if (has(root, 'tsconfig.json')) check = `${exec} tsc --noEmit`;
  return { test, check, stack: 'node' };
}

function fromPython(root: string): Commands | null {
  const markers = ['pyproject.toml', 'pytest.ini', 'setup.py', 'requirements.txt'];
  if (!markers.some((m) => has(root, m))) return null;
  const runner = has(root, 'uv.lock') ? 'uv run ' : has(root, 'poetry.lock') ? 'poetry run ' : '';
  const pyproject = read(root, 'pyproject.toml');
  const hasRuff = /\[tool\.ruff/.test(pyproject) || has(root, 'ruff.toml');
  return { test: `${runner}pytest`, check: hasRuff ? `${runner}ruff check .` : null, stack: 'python' };
}

function fromGo(root: string): Commands | null {
  if (!has(root, 'go.mod')) return null;
  return { test: 'go test ./...', check: 'go vet ./...', stack: 'go' };
}

function fromCargo(root: string): Commands | null {
  if (!has(root, 'Cargo.toml')) return null;
  return { test: 'cargo test', check: 'cargo check', stack: 'rust' };
}

const DETECTORS = [fromMakefile, fromPackageJson, fromPython, fromGo, fromCargo];

export function detectCommands(root: string, env: NodeJS.ProcessEnv = process.env): Detected {
  let detected: Commands | null = null;
  for (const detector of DETECTORS) {
    detected = detector(root);
    if (detected) break;
  }
  const test = env.AGENTIC_TEST_CMD || detected?.test || null;
  const check = env.AGENTIC_CHECK_CMD || detected?.check || null;
  const overridden = Boolean(env.AGENTIC_TEST_CMD || env.AGENTIC_CHECK_CMD);
  return {
    test,
    check,
    stack: detected?.stack ?? 'unknown',
    source: overridden ? 'override' : detected ? 'detected' : 'none',
  };
}
