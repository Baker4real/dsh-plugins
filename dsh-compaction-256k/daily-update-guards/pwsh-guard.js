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

async function checkNativeArguments(command, signal) {
  // The existing parser owns native-argument syntax. CheckOnly parses text and never runs it.
  if (process.platform !== 'win32' || typeof command !== 'string' || !/\bgh(?:\.exe)?\b/iu.test(command) || !/--json\b/iu.test(command)) return;
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
      ? `PowerShell 参数预检拒绝了命令：${diagnostic}`
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
