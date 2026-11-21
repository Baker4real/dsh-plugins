import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const PREFLIGHT_FILE = 'D:/Codex/.codex/scripts/Invoke-CheckedPowerShell.ps1';
const CHECKED_POWERSHELL = /(?<![\w-])Invoke-CheckedPowerShell(?:\.ps1)?(?![\w.-])/iu;
const COMMAND_TEXT = /(?<![\w-])-CommandText(?:\s*:\s*|\s+)"/giu;
const VARIABLE_START = /[\p{L}_({?$^]/u;

export class UnsafeCheckedPowerShellError extends Error {
  code = "UNSAFE_CHECKED_POWERSHELL_COMMANDTEXT";

  constructor() {
    super("Refusing Invoke-CheckedPowerShell -CommandText with a double-quoted string containing an unescaped $ variable or subexpression. Use -ScriptPath instead, or use single-quoted -CommandText.");
    this.name = "UnsafeCheckedPowerShellError";
  }
}

function hasInterpolation(command, openingQuote) {
  for (let index = openingQuote + 1; index < command.length; index += 1) {
    const character = command[index];
    if (character === "`") {
      index += 1;
      continue;
    }
    if (character === '"') {
      if (command[index + 1] === '"') {
        index += 1;
        continue;
      }
      return false;
    }
    if (character === "$" && index + 1 < command.length && VARIABLE_START.test(command[index + 1])) return true;
  }
  return false;
}

export function hasUnsafeCheckedPowerShellCommand(command) {
  if (typeof command !== "string" || !CHECKED_POWERSHELL.test(command)) return false;
  COMMAND_TEXT.lastIndex = 0;
  let match;
  while ((match = COMMAND_TEXT.exec(command)) !== null) {
    if (hasInterpolation(command, match.index + match[0].length - 1)) return true;
  }
  return false;
}

const PYTHON_AND_PIPE_FIXES = {
  'single-quoted-backslash-quote': "修法：PowerShell 单引号串不转义 \\\"；改用 @' ... '@ | python - 或写入 .py 文件后执行。",
  'multiline-inline-python': "修法：多行 Python 不要塞进 python -c 引号串；改用 PowerShell here-string（@' ... '@ | python -）或写入 .py 文件。",
  'unguarded-pipe-write': "修法：gh api 失败时管道右侧的 python 仍会写出空文件；改用 gh api -H 'Accept: application/vnd.github.raw' ... > file 或先检查 $LASTEXITCODE 再落盘。",
};

function needsNativePreflight(command) {
  if (typeof command !== 'string') return false;
  if (/\bgh(?:\.exe)?\b/iu.test(command) && /--json\b/iu.test(command)) return true;
  if (/\b(?:python3?|py)(?:\.exe)?\b/iu.test(command) && /(?:^|\s)-c(?:\s|$)/u.test(command)) return true;
  if (/\bgh(?:\.exe)?\s+api\b/iu.test(command) && /\|/u.test(command)) return true;
  return false;
}

function formatDiagnostic(diagnostic) {
  const reason = /\breason=([\w-]+)/u.exec(diagnostic)?.[1];
  const fix = reason && Object.hasOwn(PYTHON_AND_PIPE_FIXES, reason) ? PYTHON_AND_PIPE_FIXES[reason] : undefined;
  return `PowerShell 参数预检拒绝了命令：${diagnostic}${fix ? `\n${fix}` : ''}`;
}

async function checkNativeArguments(command, signal) {
  // The existing parser owns native-argument syntax. CheckOnly parses text and never runs it.
  if (process.platform !== 'win32' || !needsNativePreflight(command)) return;
  signal?.throwIfAborted();
  try {
    await runFile('pwsh', ['-NoProfile', '-NonInteractive', '-File', PREFLIGHT_FILE, '-CommandText', command, '-CheckOnly'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384, signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException('PowerShell 参数预检已取消。', 'AbortError');
    // execFile's message contains its argv, which can include private command arguments. Never expose it.
    const diagnostic = String(error.stderr ?? '').split(/\r?\n/).find(line => /^CheckedPowerShell (?:native-argument-error|syntax-error|parameter-error|input-error|regex-error)\b/.test(line));
    const failure = new Error(diagnostic
      ? formatDiagnostic(diagnostic)
      : 'PowerShell 参数预检不可用，命令尚未执行；请检查受检入口与 PowerShell Core 7。');
    failure.name = 'PowerShellPreflightError';
    failure.code = diagnostic ? 'PWSH_PREFLIGHT_REJECTED' : 'PWSH_PREFLIGHT_UNAVAILABLE';
    throw failure;
  }
}

export function createPwshGuardTool(original) {
  return {
    ...original,
    description: `${original.description} Commands invoking Invoke-CheckedPowerShell(.ps1) with a double-quoted -CommandText containing an unescaped $ variable or subexpression are rejected before execution; use -ScriptPath instead. Direct gh calls with a separate --json argument are checked for native field-list and comment-option mistakes before execution.`,
    async execute(args, exec) {
      if (hasUnsafeCheckedPowerShellCommand(args?.command)) throw new UnsafeCheckedPowerShellError();
      await checkNativeArguments(args?.command, exec.signal);
      return original.execute(args, exec);
    },
  };
}
