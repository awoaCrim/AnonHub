const HOSTNAME_READ = new Set([
  "-f",
  "-i",
  "-I",
  "-s",
  "-d",
  "-A",
  "--fqdn",
  "--long",
  "--short",
  "--domain",
  "--ip-address",
  "--all-ip-addresses",
  "--all-fqdns",
]);
const IP_WRITES = new Set([
  "add",
  "del",
  "delete",
  "set",
  "flush",
  "change",
  "replace",
  "append",
  "prepend",
  "save",
  "restore",
  "exec",
  "netns",
  "-b",
  "-batch",
  "--batch",
  "-force",
]);
const DOCKER_READ = new Set(["ps", "logs", "inspect", "images", "version", "info", "top", "port", "stats"]);
const DOCKER_OBJECT_READ = new Set(["ls", "list", "inspect", "logs", "ps", "top", "port"]);
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "describe", "blame"]);

const PROGRAMS: Record<string, ArgumentRule> = {
  ...Object.fromEntries(
    [
      "ls",
      "cat",
      "head",
      "tail",
      "stat",
      "wc",
      "du",
      "df",
      "pwd",
      "whoami",
      "id",
      "uname",
      "uptime",
      "free",
      "ps",
      "pgrep",
      "which",
      "type",
      "echo",
      "printf",
      "grep",
      "egrep",
      "fgrep",
      "sha256sum",
      "sha1sum",
      "sha512sum",
      "md5sum",
      "shasum",
      "cksum",
      "b2sum",
      "readlink",
      "realpath",
      "basename",
      "dirname",
      "printenv",
      "test",
      "[",
      "true",
      "false",
      "cut",
      "tr",
      "jq",
      "nl",
      "od",
      "strings",
      "cd",
      "netstat",
      "lsblk",
      "lscpu",
      "nproc",
      "getent",
      "dig",
      "nslookup",
      "host",
      "lsof",
      "column",
    ].map((name) => [name, anyArguments]),
  ),
  file: without("-C", "--compile"),
  rg: without("--pre"),
  sort: without("-o", "--output"),
  tree: without("-o"),
  ss: without("-K", "--kill"),
  // `uniq in out` writes `out`.
  uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length <= 1,
  env: (args) => args.length === 0,
  command: (args) => args[0] === "-v" || args[0] === "-V",
  hostname: (args) => args.every((arg) => HOSTNAME_READ.has(arg)),
  // `date -s` and a bare date argument set the clock; `+FORMAT` and `-d DATE` only print.
  date: (args) => {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (["-d", "--date", "-r", "--reference"].includes(arg)) index++;
      else if (!arg.startsWith("+") && !/^-[uRI]|^--(utc|universal|rfc|iso)/.test(arg) && !/^--(date|reference)=/.test(arg)) return false;
    }
    return true;
  },
  find: without("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"),
  systemctl: subcommand(["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "list-sockets", "show", "cat"]),
  journalctl: without(
    "--vacuum-size",
    "--vacuum-time",
    "--vacuum-files",
    "--rotate",
    "--flush",
    "--sync",
    "--relinquish-var",
    "--smart-relinquish-var",
    "--setup-keys",
    "--update-catalog",
  ),
  docker: ([first, second, ...rest]) => {
    if (first === undefined) return false;
    if (DOCKER_READ.has(first)) return true;
    if (["container", "image", "network", "volume"].includes(first)) return second !== undefined && DOCKER_OBJECT_READ.has(second);
    if (first !== "compose") return false;
    const words = [second, ...rest].filter((word): word is string => word !== undefined);
    for (let index = 0; index < words.length; index++) {
      if (["-f", "--file", "-p", "--project-name"].includes(words[index]!)) index++;
      else return ["ps", "logs", "ls", "config", "images", "top", "port"].includes(words[index]!);
    }
    return false;
  },
  git: (args) => {
    let index = 0;
    while (args[index] === "-C" || args[index] === "--no-pager") index += args[index] === "-C" ? 2 : 1;
    return GIT_READ.has(args[index] ?? "") && !args.some((arg) => arg.startsWith("--output"));
  },
  ip: (args) => !args.some((arg) => IP_WRITES.has(arg)),
};

/** `/`, the home directory and the system directories, with or without a trailing `/` or `/*`. */
const BROAD_PATH = /^(?:\/|~|\$HOME|\$\{HOME\}|\/(?:etc|usr|var|boot|bin|sbin|lib|lib64|opt|root|home|srv|dev|proc|sys))\/?\*?$/;
/** A program name where a command starts, also after `sudo` or an opening quote (`ssh host 'reboot'`). */
const AT = String.raw`(?:^|[\s;&|('"\`])(?:sudo\s+)?`;
const END = String.raw`(?=$|[\s;&|'")\`])`;
const DANGERS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`${AT}(?:mkfs(?:\\.\\w+)?|mkswap|wipefs|sfdisk|sgdisk)${END}`), "会改写磁盘分区或文件系统"],
  [new RegExp(`${AT}(?:fdisk|parted)\\s+(?!-l${END}|--list${END})`), "会改写磁盘分区或文件系统"],
  [/\bdd\s[^;&|\n]*\bof=\/dev\//, "会直接写磁盘设备"],
  [new RegExp(`${AT}(?:shutdown|reboot|poweroff|halt)${END}`), "会关机或重启机器"],
  [new RegExp(`${AT}init\\s+[06]${END}`), "会关机或重启机器"],
  [/\bsystemctl\s+(?:-\S+\s+)*(?:reboot|poweroff|halt|kexec)\b/, "会关机或重启机器"],
  [/(?:^|[^>])>\s*["']?[^\s;&|'"]*authorized_keys\b/, "会覆盖 SSH 登录密钥"],
  [/\b(?:rm|mv|shred)\s[^;&|\n]*authorized_keys\b/, "会删除或移走 SSH 登录密钥"],
  [/\biptables\b[^;&|\n]*\s(?:-F|--flush|-P\s+INPUT\s+DROP)(?=$|\s)/, "可能把远程连接挡在防火墙外"],
  [/\bnft\s+flush\s+ruleset\b/, "可能把远程连接挡在防火墙外"],
  [/\bufw\s+(?:--force\s+)?(?:enable|reset|default\s+deny)\b/, "可能把远程连接挡在防火墙外"],
  [/\bcrontab\s+(?:-u\s+\S+\s+)?-r\b/, "会删除全部定时任务"],
  [new RegExp(`${AT}(?:userdel|deluser)${END}`), "会删除系统账号"],
];

type ArgumentRule = (args: readonly string[]) => boolean;

/**
 * Whether a shell command only reads: every simple command in it is a known read-only program used in a read-only way,
 * and it has no file output redirection, command substitution, subshell, heredoc or background job. Anything not
 * recognised is not read-only. This is no security boundary (before an unknown result any command may run); it lets a
 * task look at the state after one, and keeps a look that ran past its deadline from counting as an unknown write
 * (雨云 komari-agent tasks, 2026-11-20: one `sftp ls` past its deadline left a task unable to look at anything).
 */
export function readOnlyCommand(command: string): boolean {
  const commands = simpleCommands(command);
  return (
    !!commands?.length &&
    commands.every(([program, ...args]) => {
      if (program === undefined || /^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return false;
      const rule = PROGRAMS[program.slice(program.lastIndexOf("/") + 1)];
      return rule !== undefined && rule(args);
    })
  );
}

/**
 * Why a command is too hard to undo for a background task to run on its own, if it is: shutting down, wiping disks,
 * deleting system directories, replacing the SSH login keys, emptying the firewall. The main conversation decides
 * those (harness item 4, 「危险命令执行前审批」, done at the user's 「全做」 on 2026-11-20). Matched in the raw text, so it also
 * catches them inside `ssh host '…'` or `bash -c '…'`; a read-only command is never dangerous.
 */
export function dangerousCommand(command: unknown): string | undefined {
  if (typeof command !== "string" || readOnlyCommand(command)) return undefined;
  for (const match of command.matchAll(/(?:^|[\s;&|('"`])(rm|chmod|chown)\s+([^;&|\n'"`]*)/g)) {
    const words = match[2]!.trim().split(/\s+/);
    const recursive = words.some((word) => /^-[A-Za-z]*[rR]/.test(word) || word === "--recursive");
    if (match[1] === "rm" && words.includes("--no-preserve-root")) return "会删除整个系统";
    if (recursive && words.some((word) => BROAD_PATH.test(word)))
      return match[1] === "rm" ? "会递归删除系统目录或整个主目录" : "会递归改动系统目录或整个主目录的权限";
  }
  return DANGERS.find(([pattern]) => pattern.test(command))?.[1];
}

function anyArguments(): boolean {
  return true;
}

/** None of these options, also as `--option=value` or, for a one-letter option, inside a group like `-uo`. */
function without(...options: string[]): ArgumentRule {
  return (args) =>
    !args.some((arg) =>
      options.some(
        (option) =>
          arg === option || arg.startsWith(`${option}=`) || (/^-[A-Za-z]$/.test(option) && /^-[A-Za-z]+/.test(arg) && arg.slice(1).includes(option[1]!)),
      ),
    );
}

/** The first word that is not an option names a subcommand from `allowed`. */
function subcommand(allowed: readonly string[]): ArgumentRule {
  return (args) => allowed.includes(args.find((arg) => !arg.startsWith("-")) ?? "");
}

/**
 * The simple commands of a command line, split at `;`, `&&`, `||`, `|` and newlines, with quotes removed; undefined for
 * anything this cannot read for sure: command or process substitution, subshells, heredocs, background jobs, output
 * redirection other than to /dev/null or another descriptor, unterminated quotes.
 */
function simpleCommands(line: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    const next = line[index + 1];
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) return undefined;
      word += line.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      for (; end < line.length && line[end] !== '"'; end++) {
        if (line[end] === "`" || (line[end] === "$" && line[end + 1] === "(")) return undefined;
        if (line[end] === "\\") end++;
        word += line[end] ?? "";
      }
      if (end >= line.length) return undefined;
      inWord = true;
      index = end;
    } else if (char === "\\") {
      if (next === undefined) return undefined;
      if (next !== "\n") word += next;
      inWord = next !== "\n" || inWord;
      index++;
    } else if (char === "`" || char === "(" || char === ")" || (char === "$" && next === "(")) return undefined;
    else if (char === " " || char === "\t") endWord();
    else if (char === "\n" || char === ";") endCommand();
    else if (char === "|") {
      endCommand();
      if (next === "|") index++;
    } else if (char === "&" && next === "&") {
      endCommand();
      index++;
    } else if (char === ">" || char === "<" || (char === "&" && next === ">")) {
      // A descriptor number right before the operator belongs to it (`2>/dev/null`).
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      const output = char !== "<";
      if (char === "<" && (next === "<" || next === ">")) return undefined;
      index += char === "&" ? 1 : 0;
      while (line[index + 1] === ">" || line[index + 1] === "|") index++;
      if (output && line[index + 1] === "&") {
        const descriptor = /^&(\d+|-)/.exec(line.slice(index + 1));
        if (!descriptor) return undefined;
        index += descriptor[0].length;
        continue;
      }
      while (line[index + 1] === " " || line[index + 1] === "\t") index++;
      const target = /^[^\s;|&<>()`$'"\\]+/.exec(line.slice(index + 1))?.[0];
      if (!target || (output && target !== "/dev/null")) return undefined;
      index += target.length;
    } else if (char === "&") return undefined;
    else if (char === "#" && !inWord) {
      const end = line.indexOf("\n", index);
      if (end < 0) break;
      index = end - 1;
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}
