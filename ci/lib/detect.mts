// Detects the project's check and test commands from what the repository
// contains. The negative-control CI job (ci/negative-control.mts) and the
// SubagentStop gate (hooks/stop-gate.mts) both call this file, and the
// implementer agent reads it to find the same commands, so "the tests" means
// the same thing before the stop, in CI, and in the agent's own hands.
//
// Detection is a default, not a contract: AGENTIC_TEST_CMD and
// AGENTIC_CHECK_CMD override each field. Node built-ins only.
//
// Detector order (first match wins, see DETECTORS below): Makefile,
// package.json (node), Python (pyproject.toml/pytest.ini/setup.py/
// requirements.txt), go.mod, Cargo.toml, Gemfile (ruby), mix.exs (elixir),
// build.gradle(.kts) (gradle), pom.xml (maven), and last of all a Python test
// tree with no packaging marker at all. Makefile always wins: a repo that also
// happens to hold, say, a Gemfile still gets `make test` when it has a
// Makefile with a test: target.
//
// The Python test-tree detector is deliberately last, not next to the other
// Python one: it fires only when every marker above it missed, so no
// repository that detects today changes its answer because it happens to ship
// a stray .py test file. Its signal is what git tracks, so a checked-out
// virtualenv or a vendored copy is not a test tree. It names the stack and
// answers no test command at all — see its own header for why nothing in the
// standard library fits these trees. Crash policy: any failure of the
// `git ls-files` probe (git absent, not a repository, non-zero status) yields
// no signal, which is the answer this file already gave — `unknown`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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

const PY_TEST_FILE = /^(test_.+|.+_test)\.py$/;

/** Tracked *.py paths, or [] when root is not a readable git repository. */
function trackedPythonFiles(root: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--', '*.py'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return [];
  return r.stdout.split('\0').filter(Boolean);
}

// Last resort, only after every marker above missed: a repository whose sole
// Python signal is the tests themselves — the layout the four packaging
// markers cannot see (scripts plus `engine/test_engine.py` behind its own
// runner). It names the stack and answers **no command** (`test: null`,
// `check: null`), the same shape `fromPackageJson` already returns for a
// package.json with no test script.
//
// Why no command (#277). Nothing in the standard library collects these trees
// reliably, and there is no marker here to say what is installed:
//   - `python3 -m unittest discover` — CPython 3.11 dropped namespace-package
//     recursion, so it descends into a subdirectory only when that directory
//     holds an `__init__.py`. On the very layout this detector exists for it
//     collects nothing, prints `NO TESTS RAN` and exits 5.
//   - `python3 -m unittest discover -s <dir>` — rescues that one tree, but
//     only when the tests are `unittest.TestCase` subclasses, and it cannot
//     name a start directory when the tests sit in more than one.
//   - `pytest` — would collect both spellings, but the absence of every
//     packaging marker is exactly the evidence that nothing is installed.
// A command that runs and collects nothing is worse than none: `exit 5` makes
// `ci/negative-control.mts` read the baseline as failing its own tests
// (`inconclusive`), which hides the real problem. With no command the adopter
// reads `cannot-run`, whose detail names the escapes — `AGENTIC_TEST_CMD`, a
// `proof/<slug>.json` command, and a `Makefile` with a `test:` target (#257) —
// and naming the stack is still the improvement #256 asked for: `adopt`'s
// inventory and the stop gate both report `python` instead of `unknown`.
// The executed cases at the end of `tests/detect.test.mts` spawn each rejected
// candidate and read its exit code, so this reasoning is run, not described.
function fromPythonTestTree(root: string): Commands | null {
  const files = trackedPythonFiles(root);
  const isTestTree = files.some((path) => {
    const parts = path.split('/');
    return PY_TEST_FILE.test(basename(path)) || parts.slice(0, -1).includes('tests');
  });
  if (!isTestTree) return null;
  return { test: null, check: null, stack: 'python' };
}

function fromGo(root: string): Commands | null {
  if (!has(root, 'go.mod')) return null;
  return { test: 'go test ./...', check: 'go vet ./...', stack: 'go' };
}

function fromCargo(root: string): Commands | null {
  if (!has(root, 'Cargo.toml')) return null;
  return { test: 'cargo test', check: 'cargo check', stack: 'rust' };
}

function fromRuby(root: string): Commands | null {
  if (!has(root, 'Gemfile')) return null;
  const test = has(root, 'spec') ? 'bundle exec rspec' : 'bundle exec rake test';
  const check = has(root, '.rubocop.yml') ? 'bundle exec rubocop' : null;
  return { test, check, stack: 'ruby' };
}

function fromElixir(root: string): Commands | null {
  if (!has(root, 'mix.exs')) return null;
  return { test: 'mix test', check: 'mix format --check-formatted', stack: 'elixir' };
}

function fromGradle(root: string): Commands | null {
  if (!has(root, 'build.gradle') && !has(root, 'build.gradle.kts')) return null;
  const test = has(root, 'gradlew') ? './gradlew test' : 'gradle test';
  // No obvious universal check task across Gradle projects (checkstyle,
  // ktlint, spotless, etc. all need opt-in plugin detection); leave null.
  return { test, check: null, stack: 'gradle' };
}

function fromMaven(root: string): Commands | null {
  if (!has(root, 'pom.xml')) return null;
  // Same reasoning as Gradle: no universal lint/format plugin to assume.
  return { test: 'mvn -q test', check: null, stack: 'maven' };
}

const DETECTORS = [
  fromMakefile,
  fromPackageJson,
  fromPython,
  fromGo,
  fromCargo,
  fromRuby,
  fromElixir,
  fromGradle,
  fromMaven,
  fromPythonTestTree,
];

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
