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

export function createPwshGuardTool(original) {
  return {
    ...original,
    description: `${original.description} Commands invoking Invoke-CheckedPowerShell(.ps1) with a double-quoted -CommandText containing an unescaped $ variable or subexpression are rejected before execution; use -ScriptPath instead.`,
    async execute(args, exec) {
      if (hasUnsafeCheckedPowerShellCommand(args?.command)) throw new UnsafeCheckedPowerShellError();
      return original.execute(args, exec);
    },
  };
}
