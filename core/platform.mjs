// Cross-platform primitives. PlanForge runs on macOS, Linux, and Windows:
// - the BUNDLED agent wrappers are Node scripts, so they need no shell at all;
// - composed shell commands (role slots, custom agent-<name>.sh providers) run
//   through a POSIX shell everywhere: /bin/sh on macOS/Linux, and on Windows
//   the bash that ships with Git for Windows (git is already a requirement).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';

let cachedShell;

// Locate a POSIX shell. Override with PLANFORGE_SHELL. Returns null when none
// exists (Windows without Git for Windows) — callers degrade with a clear hint.
export function findPosixShell() {
  if (cachedShell !== undefined) return cachedShell;
  if (process.env.PLANFORGE_SHELL && existsSync(process.env.PLANFORGE_SHELL)) {
    cachedShell = process.env.PLANFORGE_SHELL;
    return cachedShell;
  }
  if (!IS_WINDOWS) {
    cachedShell = '/bin/sh';
    return cachedShell;
  }
  const candidates = [
    // Git for Windows, standard installs.
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LocalAppData || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) { cachedShell = c; return cachedShell; }
  }
  // bash on PATH (Git Bash, MSYS2, WSL shim all answer --version).
  const probe = spawnSync('bash.exe', ['--version'], { stdio: 'ignore' });
  if (probe.status === 0) { cachedShell = 'bash.exe'; return cachedShell; }
  cachedShell = null;
  return cachedShell;
}

export const POSIX_SHELL_HINT =
  'No POSIX shell found. On Windows, install Git for Windows (https://git-scm.com/download/win) — '
  + 'PlanForge uses its bundled bash for composed commands — or point PLANFORGE_SHELL at a bash.exe.';

// spawn()/spawnSync() options fragment that runs `command` through the POSIX
// shell — a drop-in for { shell: true }, which on Windows would mean cmd.exe
// and break POSIX quoting. Usage: spawn(...shellInvocation(cmd), opts).
export function shellInvocation(command, { login = false } = {}) {
  const shell = findPosixShell();
  if (!shell) throw new Error(POSIX_SHELL_HINT);
  return [shell, [login ? '-lc' : '-c', command]];
}

// Is `p` inside a throwaway temp location? (Worktree/scratch cleanup guard.)
export function isTempPath(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/');
  return norm.startsWith(`${tmp}/`) || norm.includes('/tmp/') || norm.includes('/var/folders/');
}

// Separator-insensitive "does this path contain this segment" check.
export function pathContains(p, segment) {
  return String(p || '').replace(/\\/g, '/').includes(String(segment).replace(/\\/g, '/'));
}
