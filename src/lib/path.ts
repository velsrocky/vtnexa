import { invoke } from "@tauri-apps/api/core";
import {
  basename as nativeBasename,
  dirname as nativeDirname,
  isAbsolute as nativeIsAbsolute,
  join as nativeJoin,
  normalize as nativeNormalize,
  resolve as nativeResolve,
} from "@tauri-apps/api/path";
import { isTauri } from "./tauri";

export type PathStyle = "posix" | "windows";

interface ParsedPath {
  style: PathStyle;
  separator: "/" | "\\";
  drive: string | null;
  uncServer: string | null;
  uncShare: string | null;
  rooted: boolean;
  absolute: boolean;
  rawComponents: string[];
}

function isSeparator(char: string | undefined): boolean {
  return char === "/" || char === "\\";
}

function hasDrive(value: string): boolean {
  return /^[A-Za-z]:/.test(value);
}

function hasUncPrefix(value: string): boolean {
  return value.length >= 2 && isSeparator(value[0]) && isSeparator(value[1]);
}

export function detectPathStyle(value: string): PathStyle {
  if (hasDrive(value) || hasUncPrefix(value) || (!value.startsWith("/") && value.includes("\\"))) return "windows";
  return "posix";
}

function parsePath(value: string, style = detectPathStyle(value)): ParsedPath {
  if (style === "windows" && hasDrive(value)) {
    const drive = value.slice(0, 2);
    const rest = value.slice(2);
    const absolute = isSeparator(rest[0]);
    return {
      style,
      separator: "\\",
      drive,
      uncServer: null,
      uncShare: null,
      rooted: absolute,
      absolute,
      rawComponents: rest.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean),
    };
  }
  if (style === "windows" && hasUncPrefix(value)) {
    const parts = value.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean);
    const uncServer = parts[0] ?? null;
    const uncShare = parts[1] ?? null;
    return {
      style,
      separator: "\\",
      drive: null,
      uncServer,
      uncShare,
      rooted: true,
      absolute: uncServer !== null && uncShare !== null,
      rawComponents: parts.slice(2),
    };
  }
  if (style === "windows" && isSeparator(value[0])) {
    return {
      style,
      separator: "\\",
      drive: null,
      uncServer: null,
      uncShare: null,
      rooted: true,
      absolute: false,
      rawComponents: value.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean),
    };
  }
  const absolute = style === "posix" && value.startsWith("/");
  return {
    style,
    separator: "/",
    drive: null,
    uncServer: null,
    uncShare: null,
    rooted: absolute,
    absolute,
    rawComponents: value.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean),
  };
}

function renderPath(parsed: ParsedPath, components: string[]): string {
  const tail = components.join(parsed.separator);
  if (parsed.drive) {
    if (parsed.absolute) return `${parsed.drive}${parsed.separator}${tail}`;
    return tail ? `${parsed.drive}${tail}` : parsed.drive;
  }
  if (parsed.uncServer) {
    const share = parsed.uncShare ? `${parsed.separator}${parsed.uncShare}` : "";
    const root = `${parsed.separator}${parsed.separator}${parsed.uncServer}${share}`;
    return tail ? `${root}${parsed.separator}${tail}` : root;
  }
  if (parsed.rooted) return `${parsed.separator}${tail}`;
  return tail || ".";
}

function normalizeWithStyle(value: string, style: PathStyle): string {
  const parsed = parsePath(value, style);
  const components: string[] = [];
  for (const component of parsed.rawComponents) {
    if (!component || component === ".") continue;
    if (component === "..") {
      const last = components[components.length - 1];
      if (last !== undefined && last !== "..") components.pop();
      else if (!parsed.rooted && !parsed.absolute) components.push(component);
      continue;
    }
    components.push(component);
  }
  return renderPath(parsed, components);
}

export function normalizePath(value: string, style = detectPathStyle(value)): string {
  if (!value) return ".";
  return normalizeWithStyle(value, style);
}

export function joinPath(...parts: string[]): string {
  const present = parts.filter((part) => part.length > 0);
  if (present.length === 0) return ".";
  const style = detectPathStyle(present[0]);
  const separator = style === "windows" ? "\\" : "/";
  let joined = present[0];
  for (const part of present.slice(1)) {
    if (/^[A-Za-z]:$/.test(joined)) joined += part.replace(/^[\\/]+/, "");
    else joined = `${joined.replace(/[\\/]+$/, "")}${separator}${part.replace(/^[\\/]+/, "")}`;
  }
  return normalizeWithStyle(joined, style);
}

export function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).map((segment) => segment.trim()).filter(Boolean);
}

export function isAbsolutePath(value: string): boolean {
  return parsePath(value).absolute;
}

export function basenamePath(value: string): string {
  if (!value) return "";
  const parsed = parsePath(value);
  const components = parsed.rawComponents.filter(Boolean);
  if (parsed.absolute && components.length === 0) return "";
  if (parsed.drive && components.length === 0) return parsed.drive;
  if (parsed.uncServer && components.length === 0) return "";
  return components[components.length - 1] ?? (value.trim() || "");
}

export function dirnamePath(value: string): string {
  if (!value) return "";
  const normalized = normalizePath(value);
  const parsed = parsePath(normalized);
  const components = [...parsed.rawComponents];
  if (!parsed.absolute && !parsed.drive && !parsed.uncServer && !parsed.rooted) {
    if (!value.includes("/") && !value.includes("\\")) return "";
  }
  if (components.length === 0) return "";
  components.pop();
  return renderPath(parsed, components);
}

function rootIdentity(parsed: ParsedPath): string | null {
  if (!parsed.absolute) return null;
  if (parsed.drive) return `drive:${parsed.drive.toLowerCase()}`;
  if (parsed.uncServer && parsed.uncShare) {
    return `unc:${parsed.uncServer.toLowerCase()}\\${parsed.uncShare.toLowerCase()}`;
  }
  if (parsed.style === "posix") return "posix:/";
  return null;
}

function componentsEqual(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function relativeComponents(path: string, root: string): string[] | null {
  if (detectPathStyle(path) !== detectPathStyle(root)) return null;
  const rootParsed = parsePath(normalizePath(root));
  const pathParsed = parsePath(normalizePath(path, rootParsed.style));
  const rootKey = rootIdentity(rootParsed);
  const pathKey = rootIdentity(pathParsed);
  if (rootKey === null || pathKey === null || rootKey !== pathKey) return null;
  if (pathParsed.rawComponents.length < rootParsed.rawComponents.length) return null;
  const caseInsensitive = rootParsed.style === "windows";
  const rootComponents = rootParsed.rawComponents;
  const pathComponents = pathParsed.rawComponents;
  for (let index = 0; index < rootComponents.length; index++) {
    if (!componentsEqual(rootComponents[index], pathComponents[index], caseInsensitive)) return null;
  }
  return pathComponents.slice(rootComponents.length);
}

export function isPathInsideRoot(path: string, root: string): boolean {
  return relativeComponents(path, root) !== null;
}

export function isWithinPath(root: string, path: string): boolean {
  if (!root) return true;
  return isPathInsideRoot(path, root);
}

export function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string | null {
  const relative = relativeComponents(path, oldPrefix);
  if (relative === null) return null;
  return relative.length === 0 ? normalizePath(newPrefix) : joinPath(newPrefix, ...relative);
}

export interface ShellWord {
  value: string;
  quoted: boolean;
  expanded: boolean;
  redirection?: boolean;
}

export interface ShellScan {
  words: ShellWord[];
  complete: boolean;
  unsupported: boolean;
  invocations: ShellWord[][];
}

function isShellWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function isShellOperator(value: string): boolean {
  return value === ";" || value === "|" || value === "&" || value === "<" || value === ">" || value === "(" || value === ")";
}

export function scanShellWords(text: string): ShellScan {
  const words: ShellWord[] = [];
  const invocations: ShellWord[][] = [];
  let currentInvocation: ShellWord[] = [];
  let value = "";
  let started = false;
  let quoted = false;
  let expanded = false;
  let quote: "'" | '"' | null = null;
  let complete = true;
  let unsupported = false;
  let redirectionContinuation = false;
  const push = (redirection = false) => {
    if (!started) return;
    const word = redirection
      ? { value, quoted, expanded, redirection: true }
      : { value, quoted, expanded };
    words.push(word);
    currentInvocation.push(word);
    value = "";
    started = false;
    quoted = false;
    expanded = false;
  };
  const finishInvocation = () => {
    push();
    invocations.push(currentInvocation);
    currentInvocation = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (char === "$" || char === "~")) expanded = true;
      if (quote === '"' && char === "`") {
        expanded = true;
        unsupported = true;
      }
      value += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      started = true;
      continue;
    }
    if (isShellWhitespace(char)) {
      push(redirectionContinuation && /^\d+$/.test(value));
      redirectionContinuation = false;
      if (char === "\n" || char === "\r") {
        finishInvocation();
      }
      continue;
    }
    if (char === "\\") {
      started = true;
      if (index + 1 >= text.length) {
        value += char;
        unsupported = true;
        continue;
      }
      const next = text[index + 1];
      if (next === "\\") {
        value += "\\\\";
        index += 1;
      } else if (next === "'" || next === '"' || next === "$" || next === "`" || isShellWhitespace(next)) {
        value += next;
        if (next === "$" || next === "`") expanded = true;
        index += 1;
      } else {
        value += char;
      }
      continue;
    }
    if (char === "$") {
      expanded = true;
      value += char;
      started = true;
      continue;
    }
    if (char === "`") {
      expanded = true;
      unsupported = true;
      value += char;
      started = true;
      continue;
    }
    if (char === "{" || char === "}") {
      expanded = true;
      value += char;
      started = true;
      continue;
    }
    if (isShellOperator(char)) {
      const redirectDescriptor = char === "&" && (text[index - 1] === ">" || text[index - 1] === "<" || text[index + 1] === ">");
      if (redirectDescriptor) {
        push();
        redirectionContinuation = true;
      } else if (char === "<" || char === ">") {
        push(/^\d+$/.test(value));
        redirectionContinuation = true;
      } else {
        finishInvocation();
        redirectionContinuation = false;
      }
      if (char === "<" && text[index + 1] === "<") {
        unsupported = true;
        index += 1;
      }
      if (char === "(" || char === ")") unsupported = true;
      continue;
    }
    value += char;
    started = true;
  }
  if (quote) complete = false;
  if (redirectionContinuation && /^\d+$/.test(value)) {
    value = "";
    started = false;
    quoted = false;
    expanded = false;
  }
  finishInvocation();
  return { words, complete, unsupported, invocations };
}

function cleanPathCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[<([{"'`]+/, "")
    .replace(/[.,:;!?)\]}>"'`]+$/, "")
    .trim();
}

function pathCandidateKey(value: string): string {
  return detectPathStyle(value) === "windows" ? value.toLowerCase() : value;
}

function addAbsoluteCandidate(candidates: string[], seen: Set<string>, raw: string): void {
  const value = cleanPathCandidate(raw);
  if (!value || !isAbsolutePath(value)) return;
  const key = pathCandidateKey(value);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(value);
}

function isUriSchemeChar(char: string | undefined): boolean {
  return typeof char === "string" && /[A-Za-z0-9+.-]/.test(char);
}

const KNOWN_URI_SCHEMES = new Set([
  "data",
  "file",
  "ftp",
  "ftps",
  "git",
  "http",
  "https",
  "mailto",
  "ssh",
  "telnet",
  "ws",
  "wss",
]);

function uriTargetsInValue(value: string): string[] {
  const targets: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!/[A-Za-z]/.test(value[index])) continue;
    if (index > 0 && isUriSchemeChar(value[index - 1])) continue;
    let end = index + 1;
    while (end < value.length && isUriSchemeChar(value[end])) end += 1;
    if (value[end] !== ":") continue;
    const scheme = value.slice(index, end);
    if (scheme.length === 1) {
      index = end;
      continue;
    }
    if (value[end + 1] !== "/" && !KNOWN_URI_SCHEMES.has(scheme.toLowerCase())) {
      index = end;
      continue;
    }
    let stop = end + 1;
    while (stop < value.length && !/[\s;&|()<>"'`]/.test(value[stop])) stop += 1;
    const target = value.slice(index, stop).replace(/[.,;:!?)\]}>]+$/, "");
    if (target.length >= scheme.length + 1) targets.push(target);
    index = Math.max(index, stop - 1);
  }
  return targets;
}

export function extractUriTargets(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of scanShellWords(text).words) {
    for (const target of [...uriTargetsInValue(word.value), ...uriTargetsInValue(word.value.slice(word.value.indexOf("=") + 1))]) {
      const key = target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

export function hasExplicitUriScheme(text: string): boolean {
  return extractUriTargets(text).length > 0;
}

const NETWORK_CLIENT_TARGET_OPTIONS = new Map<string, Set<string>>([
  ["curl", new Set(["--url", "--proxy", "--preproxy", "--connect-to", "--resolve", "--interface", "--dns-servers"])],
  ["wget", new Set(["--proxy", "--bind-address"])],
  ["ssh", new Set(["-J", "--jump-host"])],
  ["scp", new Set(["-J", "--jump-host"])],
  ["sftp", new Set(["-J", "--jump-host"])],
  ["nc", new Set(["-s", "--source", "-b", "--bind", "--local-address"])],
  ["netcat", new Set(["-s", "--source", "-b", "--bind", "--local-address"])],
  ["ncat", new Set(["--source", "--bind"])],
  ["openssl", new Set(["-connect", "-proxy", "-servername", "-verify_hostname"])],
]);

const NETWORK_CLIENT_VALUE_OPTIONS = new Map<string, Set<string>>([
  ["curl", new Set(["-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-o", "--output", "-T", "--upload-file", "-F", "--form", "-X", "--request", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-u", "--user", "--cert", "--key", "--config", "--range", "--limit-rate", "--max-filesize", "--connect-timeout", "--max-time", "--retry", "--retry-delay", "--speed-time", "--speed-limit", "--proto", "--tlsv1.2"])],
  ["wget", new Set(["-O", "--output-document", "-i", "--input-file", "--post-data", "--post-file", "--body-data", "--body-file", "--header", "--user", "--password", "--timeout", "--tries", "--waitretry", "--bind-address", "--directory-prefix", "--limit-rate"])],
  ["ssh", new Set(["-i", "--identity", "-F", "--config", "-J", "--jump-host", "-L", "--local-forward", "-R", "--remote-forward", "-D", "--dynamic-forward", "-E", "--log", "-b", "--bind-address", "-c", "--cipher", "-m", "--mac", "-o", "--option", "-p", "--port", "-l", "--login-name"])],
  ["scp", new Set(["-i", "--identity", "-F", "--config", "-J", "--jump-host", "-c", "--cipher", "-l", "--login-name", "-o", "--option", "-P", "--port", "-S", "--program"])],
  ["sftp", new Set(["-i", "--identity", "-F", "--config", "-J", "--jump-host", "-c", "--cipher", "-l", "--login-name", "-o", "--option", "-P", "--port", "-b", "--batchfile", "-D", "--debug"])],
  ["nc", new Set(["-w", "--timeout", "-q", "--quit-after", "-s", "--source", "-b", "--bind", "-p", "--source-port"])],
  ["netcat", new Set(["-w", "--timeout", "-q", "--quit-after", "-s", "--source", "-b", "--bind", "-p", "--source-port"])],
  ["ncat", new Set(["--source", "--bind", "--source-port", "--timeout", "--quit-after"])],
  ["telnet", new Set(["-l", "--user", "-t", "--timeout"])],
  ["openssl", new Set(["-connect", "-proxy", "-servername", "-verify_hostname", "-cipher", "-ciphersuites", "-cafile", "-capath", "-cert", "-key", "-pass", "-name", "-subj", "-connect_timeout", "-timeout", "-server", "-crl", "-rand_serial"])],
]);

const NETWORK_CLIENT_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "netcat",
  "ncat",
  "netcat-openbsd",
  "netcat-traditional",
  "nc.openbsd",
  "nc.traditional",
  "netcat6",
  "nc6",
  "ncat6",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
]);

const URI_SCHEMES = new Set([
  "data",
  "file",
  "ftp",
  "ftps",
  "http",
  "https",
  "mailto",
  "ssh",
  "telnet",
  "ws",
  "wss",
]);

function networkCommandBase(value: string): string {
  const base = value.replace(/^.*[\\/]/, "").toLowerCase();
  return base.replace(/\.(?:exe|cmd|bat)$/, "");
}

function isNetworkClientInvocation(command: string, args: readonly ShellWord[]): boolean {
  const base = networkCommandBase(command);
  if (NETWORK_CLIENT_COMMANDS.has(base)) return true;
  if (base === "openssl") return args.some((arg) => arg.value.trim().toLowerCase() === "s_client");
  if (base === "busybox" || base === "toybox") {
    return args.some((arg) => NETWORK_CLIENT_COMMANDS.has(networkCommandBase(arg.value)));
  }
  return false;
}

function requiresNativeNetworkApproval(command: string, args: readonly ShellWord[]): boolean {
  return isNetworkClientInvocation(command, args);
}

function envSplitStringValues(invocation: readonly ShellWord[]): string[] {
  let index = 0;
  while (index < invocation.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(invocation[index].value.trim())) index += 1;
  if (index >= invocation.length || networkCommandBase(invocation[index].value) !== "env") return [];
  const values: string[] = [];
  const args = invocation.slice(index + 1);
  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const value = args[argumentIndex].value.trim();
    if (value === "-S" || value === "--split-string") {
      const next = args[argumentIndex + 1]?.value;
      if (next !== undefined) values.push(next);
      argumentIndex += 1;
      continue;
    }
    if (value.startsWith("-S") && value.length > 2) {
      values.push(value.slice(2));
      continue;
    }
    if (value.startsWith("--split-string=")) {
      values.push(value.slice("--split-string=".length));
      continue;
    }
    if (!value.startsWith("-")) break;
  }
  return values;
}

function nestedNetworkCodeValues(command: string, args: readonly ShellWord[]): string[] {
  if (!["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "python", "python3", "node", "nodejs", "perl", "ruby", "php"].includes(command)) return [];
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value.trim();
    if ((command === "cmd" || command === "cmd.exe") && (value === "/c" || value === "/C")) {
      values.push(args.slice(index + 1).map((arg) => arg.value).join(" "));
      break;
    }
    if (value === "-c" || value === "-e" || value === "--eval" || value === "--command" || value === "-Command" || value === "-lc" || value === "-ec") {
      const next = args[index + 1]?.value;
      if (next !== undefined) values.push(next);
      continue;
    }
    if (value.startsWith("--eval=") || value.startsWith("--command=")) {
      values.push(value.slice(value.indexOf("=") + 1));
      continue;
    }
    if (value.startsWith("-c") && value.length > 2) {
      values.push(value.slice(2));
    }
  }
  return values;
}

function shellSubstitutionValues(value: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);
      if (end < 0) break;
      values.push(value.slice(index + 1, end));
      index = end;
      continue;
    }
    if (value[index] === "$" && value[index + 1] === "(") {
      let depth = 1;
      let end = index + 2;
      for (; end < value.length && depth > 0; end += 1) {
        if (value[end] === "(") depth += 1;
        if (value[end] === ")") depth -= 1;
      }
      if (depth === 0) {
        values.push(value.slice(index + 2, end - 1));
        index = end - 1;
      }
    }
  }
  return values;
}

function hasNetworkClientInvocation(text: string, depth = 0): boolean {
  if (depth > 4) return false;
  for (const value of shellSubstitutionValues(text)) {
    if (hasNetworkClientInvocation(value, depth + 1)) return true;
  }
  for (const invocation of scanShellWords(text).invocations) {
    const commandIndex = networkCommandIndex(invocation);
    if (commandIndex < invocation.length && requiresNativeNetworkApproval(invocation[commandIndex].value, invocation.slice(commandIndex + 1))) return true;
    for (const value of envSplitStringValues(invocation)) {
      if (hasNetworkClientInvocation(value, depth + 1)) return true;
    }
    if (commandIndex >= invocation.length) continue;
    const command = networkCommandBase(invocation[commandIndex].value);
    for (const value of nestedNetworkCodeValues(command, invocation.slice(commandIndex + 1))) {
      if (hasNetworkClientInvocation(value, depth + 1)) return true;
    }
  }
  return false;
}

function isNetworkValueOption(command: string, token: string): boolean {
  const name = token.split("=", 1)[0].toLowerCase();
  return NETWORK_CLIENT_VALUE_OPTIONS.get(command)?.has(name) ?? false;
}

function networkCommandIndex(words: readonly ShellWord[]): number {
  let index = 0;
  while (index < words.length) {
    const value = words[index].value.trim();
    const base = networkCommandBase(value);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    if (base === "env") {
      index += 1;
      while (index < words.length) {
        const option = words[index].value.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          index += 1;
          continue;
        }
        if (!option.startsWith("-")) break;
        const name = option.split("=", 1)[0].toLowerCase();
        index += 1;
        if (!option.includes("=") && ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(name) && index < words.length && !words[index].value.startsWith("-")) index += 1;
      }
      continue;
    }
    if (base === "sudo" || base === "doas") {
      index += 1;
      while (index < words.length && words[index].value.startsWith("-")) {
        const option = words[index].value.split("=", 1)[0].toLowerCase();
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt"].includes(option) && index < words.length && !words[index].value.startsWith("-")) index += 1;
      }
      continue;
    }
    if (["command", "builtin", "exec"].includes(base)) {
      index += 1;
      while (index < words.length && words[index].value.startsWith("-")) index += 1;
      continue;
    }
    break;
  }
  return index;
}

function parseIpv4Component(value: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(value)) {
    const parsed = Number.parseInt(value.slice(2), 16);
    return parsed >= 0 && parsed <= 255 ? parsed : null;
  }
  if (/^0[0-9]+$/.test(value)) {
    const parsed = Number.parseInt(value, /^[0-7]+$/.test(value) ? 8 : 10);
    return parsed >= 0 && parsed <= 255 ? parsed : null;
  }
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 0 && parsed <= 255 ? parsed : null;
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length >= 2 && parts.length <= 4) {
    const octets = parts.map(parseIpv4Component);
    if (octets.some((part) => part === null)) return null;
    const numbers = octets as number[];
    let result = 0;
    for (const part of numbers) result = result * 256 + part;
    return result >>> 0;
  }
  if (!parts[0] || parts.length !== 1) return null;
  const raw = parts[0];
  let parsed: number;
  if (/^0x[0-9a-f]+$/i.test(raw)) parsed = Number.parseInt(raw.slice(2), 16);
  else if (/^0[0-9]+$/.test(raw)) parsed = Number.parseInt(raw, /^[0-7]+$/.test(raw) ? 8 : 10);
  else if (/^\d+$/.test(raw)) parsed = Number(raw);
  else return null;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed >>> 0 : null;
}

function isIpv6(value: string): boolean {
  const zone = value.indexOf("%");
  if (zone >= 0) {
    if (!/^[0-9a-z_.~-]+$/i.test(value.slice(zone + 1))) return false;
    value = value.slice(0, zone);
  }
  if (!/^[0-9a-f:.]+$/i.test(value) || value.includes(":::")) return false;
  const compressed = value.split("::").length - 1;
  if (compressed > 1) return false;
  let left = value;
  let right = "";
  if (compressed === 1) [left, right] = value.split("::");
  const expand = (part: string): number[] | null => {
    if (!part) return [];
    const values = part.split(":");
    if (values.some((item) => !item)) return null;
    if (values.some((item) => item.includes("."))) {
      const last = values.pop();
      if (last === undefined || parseIpv4(last) === null) return null;
      const ipv4 = parseIpv4(last) as number;
      values.push(((ipv4 >>> 16) & 255).toString(16), (ipv4 & 255).toString(16));
    }
    return values.map((item) => (/^[0-9a-f]{1,4}$/i.test(item) ? Number.parseInt(item, 16) : Number.NaN));
  };
  const leftValues = expand(left);
  const rightValues = expand(right);
  if (!leftValues || !rightValues || leftValues.some(Number.isNaN) || rightValues.some(Number.isNaN)) return false;
  return compressed === 1 ? leftValues.length + rightValues.length <= 7 : leftValues.length === 8;
}

function isNetworkHostname(value: string): boolean {
  const host = value.replace(/\.+$/, "").toLowerCase();
  if (!host || host.length > 253) return false;
  if (parseIpv4(host) !== null) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain" || host === "ip6-localhost" || host === "ip6-loopback") return true;
  return host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i.test(label));
}

function parseSchemelessNetworkTarget(value: string): string | null {
  const original = value.trim();
  let raw = original;
  const networkPath = raw.startsWith("//") && !raw.startsWith("\\\\");
  if (networkPath) raw = raw.slice(2);
  if (!raw || raw.startsWith("-") || raw.startsWith("@") || raw.startsWith("/") || raw.startsWith("\\") || raw.startsWith(".") || raw.startsWith("~")) return null;
  if (/^[A-Za-z]:/.test(raw) || raw.includes("://") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return null;
  const at = raw.lastIndexOf("@");
  if (at >= 0) raw = raw.slice(at + 1);
  const stop = raw.search(/[/?#]/);
  const endpoint = stop >= 0 ? raw.slice(0, stop) : raw;
  if (!endpoint) return null;
  if (endpoint.startsWith("[")) {
    const end = endpoint.indexOf("]");
    if (end < 0 || !isIpv6(endpoint.slice(1, end))) return null;
    return original;
  }
  if (endpoint.includes("::") || (endpoint.match(/:/g)?.length ?? 0) > 1) return isIpv6(endpoint) ? original : null;
  const colon = endpoint.indexOf(":");
  const host = colon >= 0 ? endpoint.slice(0, colon) : endpoint;
  if (colon >= 0 && URI_SCHEMES.has(host.toLowerCase())) return null;
  return isNetworkHostname(host) ? original : null;
}

function splitTargetFragments(value: string): string[] {
  const fragments: string[] = [];
  let current = "";
  let brackets = 0;
  for (const character of value) {
    if (character === "[") brackets += 1;
    if (character === "]") brackets = Math.max(0, brackets - 1);
    if (brackets === 0 && (character === ":" || character === ",")) {
      if (current) fragments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) fragments.push(current);
  return fragments;
}

export function extractSchemelessNetworkTargets(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const invocation of scanShellWords(text).invocations) {
    const commandIndex = networkCommandIndex(invocation);
    if (commandIndex >= invocation.length || !isNetworkClientInvocation(invocation[commandIndex].value, invocation.slice(commandIndex + 1))) continue;
    const command = networkCommandBase(invocation[commandIndex].value);
    let positionalTargets = 0;
    let previousValueOption = false;
    for (const [argumentIndex, word] of invocation.slice(commandIndex + 1).entries()) {
      if (word.redirection) continue;
      const value = word.value.trim();
      if ((command === "openssl" && value.toLowerCase() === "s_client")
        || (["busybox", "toybox"].includes(command)
          && argumentIndex === 0
          && ["nc", "netcat", "ncat", "wget", "curl", "ssh", "scp", "sftp", "ftp", "telnet"].includes(networkCommandBase(value)))) continue;
      const equals = value.indexOf("=");
      const optionName = equals > 2 ? value.slice(0, equals).toLowerCase() : "";
      const targetOption = value.startsWith("-") && NETWORK_CLIENT_TARGET_OPTIONS.get(command)?.has(optionName) === true;
      if (previousValueOption && /^\d{1,5}$/.test(value)) {
        previousValueOption = false;
        continue;
      }
      if (["nc", "netcat", "ncat", "telnet"].includes(command) && positionalTargets > 0 && /^\d{1,5}$/.test(value)) continue;
      const attached = targetOption && equals > 2 ? value.slice(equals + 1) : null;
      const candidates = attached && ["--connect-to", "--resolve"].includes(optionName)
        ? splitTargetFragments(attached).filter((fragment) => !/^\d{1,5}$/.test(fragment))
        : [attached ?? value];
      let found = false;
      for (const candidate of candidates) {
        const target = parseSchemelessNetworkTarget(candidate);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        out.push(target);
        found = true;
      }
      if (found && attached === null && !value.startsWith("-")) positionalTargets += 1;
      previousValueOption = !targetOption && value.startsWith("-") && isNetworkValueOption(command, value);
    }
  }
  return out;
}

export function hasSchemelessNetworkTarget(text: string): boolean {
  return hasNetworkClientInvocation(text);
}

export function hasPathGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

export function hasGitPathspecMagic(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith(":")) return true;
  const afterDrive = /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed.slice(2) : trimmed;
  return hasPathGlob(trimmed) || afterDrive.includes(":");
}

export function extractAbsolutePaths(text: string, includeUriTargets = false): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of scanShellWords(text).words) {
    addAbsoluteCandidate(out, seen, word.value);
    const equals = word.value.indexOf("=");
    if (equals >= 0) addAbsoluteCandidate(out, seen, word.value.slice(equals + 1));
    const option = word.value.match(/^-[A-Za-z](?=[A-Za-z]:[\\/]|[\\/])/);
    if (option) addAbsoluteCandidate(out, seen, word.value.slice(option[0].length));
  }
  if (includeUriTargets) {
    for (const target of extractUriTargets(text)) {
      const key = target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

export function extractAbsolutePathsWithUris(text: string): string[] {
  return extractAbsolutePaths(text, true);
}

export async function basenamePathNative(value: string): Promise<string> {
  if (!isTauri()) return basenamePath(value);
  return nativeBasename(value);
}

export async function dirnamePathNative(value: string): Promise<string> {
  if (!isTauri()) return dirnamePath(value);
  return nativeDirname(value);
}

export async function isAbsolutePathNative(value: string): Promise<boolean> {
  if (!isTauri()) return isAbsolutePath(value);
  return nativeIsAbsolute(value);
}

export async function joinPathNative(...parts: string[]): Promise<string> {
  if (!isTauri()) return joinPath(...parts);
  return nativeJoin(...parts);
}

export async function normalizePathNative(value: string): Promise<string> {
  if (!isTauri()) return normalizePath(value);
  return nativeNormalize(value);
}

export async function resolvePathNative(value: string, base?: string): Promise<string> {
  if (!isTauri()) return base ? joinPath(base, value) : normalizePath(value);
  return base ? nativeResolve(base, value) : nativeResolve(value);
}

export async function isPathInsideRootNative(path: string, root: string): Promise<boolean> {
  if (!root || !isTauri()) return isPathInsideRoot(path, root);
  const [normalizedPath, normalizedRoot] = await Promise.all([
    nativeNormalize(path),
    nativeNormalize(root),
  ]);
  return invoke<boolean>("path_is_within", { path: normalizedPath, root: normalizedRoot });
}
