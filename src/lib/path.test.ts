import { describe, expect, it } from "vitest";
import {
  basenamePath,
  dirnamePath,
  extractAbsolutePaths,
  extractAbsolutePathsWithUris,
  extractSchemelessNetworkTargets,
  extractUriTargets,
  hasExplicitUriScheme,
  hasSchemelessNetworkTarget,
  hasGitPathspecMagic,
  hasPathGlob,
  isAbsolutePath,
  isPathInsideRoot,
  joinPath,
  normalizePath,
  pathSegments,
  replacePathPrefix,
  resolvePathNative,
} from "./path";

describe("POSIX paths", () => {
  it("normalizes absolute and relative dot segments", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/a/./b/../c")).toBe("/a/c");
    expect(normalizePath("/../../a")).toBe("/a");
    expect(normalizePath("a/b/../c")).toBe("a/c");
    expect(normalizePath("../a/./b")).toBe("../a/b");
    expect(normalizePath("")).toBe(".");
  });

  it("supports basename, dirname, and join", () => {
    expect(basenamePath("/a/b/c.txt")).toBe("c.txt");
    expect(basenamePath("/a/b/")).toBe("b");
    expect(basenamePath("/")).toBe("");
    expect(dirnamePath("/a/b/c.txt")).toBe("/a/b");
    expect(dirnamePath("a/b")).toBe("a");
    expect(dirnamePath("a")).toBe("");
    expect(joinPath("/a", "b", "../c")).toBe("/a/c");
  });

  it("checks containment on component and case-sensitive boundaries", () => {
    expect(isPathInsideRoot("/ws/a", "/ws")).toBe(true);
    expect(isPathInsideRoot("/ws", "/ws")).toBe(true);
    expect(isPathInsideRoot("/ws/a/../b", "/ws")).toBe(true);
    expect(isPathInsideRoot("/ws/../etc", "/ws")).toBe(false);
    expect(isPathInsideRoot("/ws2/a", "/ws")).toBe(false);
    expect(isPathInsideRoot("/WS/a", "/ws")).toBe(false);
    expect(isPathInsideRoot("relative/a", "/ws")).toBe(false);
    expect(isAbsolutePath("/tmp/file\\name")).toBe(true);
    expect(isPathInsideRoot("\\\\server\\share\\file", "/")).toBe(false);
  });

  it("retargets only descendants on component boundaries", () => {
    expect(replacePathPrefix("/w/src/a.ts", "/w/src", "/w/lib")).toBe("/w/lib/a.ts");
    expect(replacePathPrefix("/w/src", "/w/src", "/w/lib")).toBe("/w/lib");
    expect(replacePathPrefix("/w/src2/a", "/w/src", "/w/lib")).toBeNull();
  });
});

describe("Windows paths", () => {
  it("normalizes drive paths with either separator and mixed separators", () => {
    expect(normalizePath("C:/Users/Test/./src/../file.txt")).toBe("C:\\Users\\Test\\file.txt");
    expect(normalizePath("c:\\Users\\Test\\src\\..\\file.txt")).toBe("c:\\Users\\Test\\file.txt");
    expect(normalizePath("C:\\Users/Test\\..\\..")).toBe("C:\\");
    expect(normalizePath("C:\\.")).toBe("C:\\");
    expect(normalizePath("C:folder\\..\\file.txt")).toBe("C:file.txt");
  });

  it("recognizes drive roots and drive-relative paths", () => {
    expect(isAbsolutePath("C:/")).toBe(true);
    expect(isAbsolutePath("C:\\")).toBe(true);
    expect(isAbsolutePath("C:folder")).toBe(false);
    expect(basenamePath("C:\\file.txt")).toBe("file.txt");
    expect(basenamePath("C:\\")).toBe("");
    expect(dirnamePath("C:\\file.txt")).toBe("C:\\");
    expect(dirnamePath("C:/folder/file.txt")).toBe("C:\\folder");
  });

  it("normalizes UNC and mixed UNC paths", () => {
    expect(normalizePath("\\\\server\\share\\folder\\..\\file.txt")).toBe("\\\\server\\share\\file.txt");
    expect(normalizePath("//server/share/folder/../file.txt")).toBe("\\\\server\\share\\file.txt");
    expect(normalizePath("\\\\server/share\\folder/../file.txt")).toBe("\\\\server\\share\\file.txt");
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("\\\\server")).toBe(false);
    expect(basenamePath("\\\\server\\share\\")).toBe("");
    expect(dirnamePath("\\\\server\\share\\folder\\file.txt")).toBe("\\\\server\\share\\folder");
  });

  it("joins drive and UNC paths without losing their roots", () => {
    expect(joinPath("C:/repo", "src", "../test.txt")).toBe("C:\\repo\\test.txt");
    expect(joinPath("C:\\repo", "src", "file.ts")).toBe("C:\\repo\\src\\file.ts");
    expect(joinPath("\\\\server/share", "src", "file.ts")).toBe("\\\\server\\share\\src\\file.ts");
  });

  it("uses case-insensitive component containment", () => {
    expect(isPathInsideRoot("c:/Users/Test/src/file.ts", "C:\\USERS\\test")).toBe(true);
    expect(isPathInsideRoot("C:\\Users\\Test", "c:/users/test/")).toBe(true);
    expect(isPathInsideRoot("C:\\Users\\Testing\\file", "C:\\Users\\Test")).toBe(false);
    expect(isPathInsideRoot("D:\\Users\\Test", "C:\\Users\\Test")).toBe(false);
    expect(isPathInsideRoot("\\\\SERVER\\Share\\src", "\\\\server\\SHARE")).toBe(true);
    expect(isPathInsideRoot("\\\\server\\sharing\\file", "\\\\server\\share")).toBe(false);
  });

  it("retargets Windows descendants across slash styles and casing", () => {
    expect(replacePathPrefix("c:/repo/src/a.ts", "C:\\repo\\src", "D:\\renamed")).toBe("D:\\renamed\\a.ts");
    expect(replacePathPrefix("C:\\repo\\src2\\a.ts", "C:/repo/src", "D:\\renamed")).toBeNull();
  });
});

describe("model and portable paths", () => {
  it("resolves relative model paths against a cross-platform base", async () => {
    await expect(resolvePathNative("src/../file.ts", "C:\\repo\\feature")).resolves.toBe(
      "C:\\repo\\feature\\file.ts",
    );
    await expect(resolvePathNative("./src/file.ts", "/repo/feature")).resolves.toBe(
      "/repo/feature/src/file.ts",
    );
  });

  it("extracts Windows, UNC, and POSIX absolute paths", () => {
    expect(extractAbsolutePaths("open C:\\repo\\src\\file.ts and /repo/readme.md")).toEqual([
      "C:\\repo\\src\\file.ts",
      "/repo/readme.md",
    ]);
    expect(extractAbsolutePaths("share \\\\server\\team\\file.txt")).toEqual([
      "\\\\server\\team\\file.txt",
    ]);
    expect(extractAbsolutePaths("ignore https://example.com/docs and UX/10")).toEqual([]);
  });

  it("extracts quoted, globbed, and every absolute path", () => {
    expect(extractAbsolutePaths('cat "/home/alice/.config/app/token" /etc/*')).toEqual([
      "/home/alice/.config/app/token",
      "/etc/*",
    ]);
    expect(extractAbsolutePaths('type "\\\\server\\share\\secret with spaces.txt"')).toEqual([
      "\\\\server\\share\\secret with spaces.txt",
    ]);
    const many = Array.from({ length: 8 }, (_, index) => `/repo/file-${index}.txt`).join(" ");
    expect(extractAbsolutePaths(many)).toHaveLength(8);
  });

  it("detects explicit URI schemes without treating Windows drives as URIs", () => {
    expect(hasExplicitUriScheme("curl http://127.0.0.1:43123/health")).toBe(true);
    expect(hasExplicitUriScheme("curl HTTPS://example.com/data ws://example.com/socket")).toBe(true);
    expect(hasExplicitUriScheme("cat file:///workspace/data.txt")).toBe(true);
    expect(hasExplicitUriScheme("type C:\\workspace\\file.txt")).toBe(false);
    expect(hasExplicitUriScheme("build C:/workspace/file.txt")).toBe(false);
    expect(hasExplicitUriScheme("type C:workspace\\file.txt")).toBe(false);
    expect(extractUriTargets("curl --url=FILE:///tmp/data.txt")).toEqual(["FILE:///tmp/data.txt"]);
    expect(extractAbsolutePathsWithUris("curl http://127.0.0.1:43123/health")).toEqual([
      "http://127.0.0.1:43123/health",
    ]);
  });

  it("requires approval for every network client invocation", () => {
    for (const cmd of [
      "curl --resolve example.com:443:127.0.0.1 --config ./curl.conf",
      "curl -K./curl.conf",
      "curl --config=curl.conf",
      "curl --resolve example.com:443:127.0.0.1 example.com",
      "curl --connect-to example.com:443:127.0.0.1:80 example.com",
      "curl --unix-socket /tmp/sock http://example",
      "wget --config=file",
      "curl --version",
      "wget https://example.com/data",
      "nc example.com 443",
      "ssh deploy@example.com",
      "scp file example.com:/tmp/file",
      "sftp example.com",
      "ftp example.com",
      "telnet example.com 23",
      "env FOO=bar curl --config=curl.conf",
      "sh -c 'curl --config ./curl.conf'",
      "env -S 'curl --unix-socket /tmp/sock http://example'",
      "echo safe; curl --resolve example.com:443:127.0.0.1 example.com",
      "$(curl --config ./curl.conf)",
      "`curl --config ./curl.conf`",
    ]) {
      expect(hasSchemelessNetworkTarget(cmd), cmd).toBe(true);
    }
    for (const cmd of [
      "echo curl",
      "git commit -m 'curl --config curl.conf'",
      "cat config.txt",
    ]) {
      expect(hasSchemelessNetworkTarget(cmd), cmd).toBe(false);
    }
  });

  it("extracts schemeless network targets only for network clients", () => {
    expect(extractSchemelessNetworkTargets("curl 2130706433:8080/")).toEqual(["2130706433:8080/"]);
    expect(extractSchemelessNetworkTargets("curl > /dev/null 2130706433:8080/")).toEqual(["2130706433:8080/"]);
    expect(extractSchemelessNetworkTargets("curl 2>&1 2130706433:8080/")).toEqual(["2130706433:8080/"]);
    expect(extractSchemelessNetworkTargets("curl //127.0.0.1:8080/")).toEqual(["//127.0.0.1:8080/"]);
    expect(extractSchemelessNetworkTargets("wget 0x7f000001:8080/file")).toEqual(["0x7f000001:8080/file"]);
    expect(extractSchemelessNetworkTargets("nc 017700000001 8080")).toEqual(["017700000001"]);
    expect(extractSchemelessNetworkTargets("netcat 127.1 8080")).toEqual(["127.1"]);
    expect(extractSchemelessNetworkTargets("ssh user@[::1]:22")).toEqual(["user@[::1]:22"]);
    expect(extractSchemelessNetworkTargets("openssl s_client -connect example.com:443")).toEqual(["example.com:443"]);
    expect(extractSchemelessNetworkTargets("git status\ncurl 2130706433:8080/")).toEqual(["2130706433:8080/"]);
    expect(extractSchemelessNetworkTargets("git commit -m 'fix: host:port'")).toEqual([]);
    expect(extractSchemelessNetworkTargets("rustc --cfg feature:enabled src/main.rs")).toEqual([]);
    expect(extractSchemelessNetworkTargets("curl --retry=3 example.com:443")).toEqual(["example.com:443"]);
    expect(extractSchemelessNetworkTargets("curl --resolve=example.com:443:127.0.0.1")).toEqual([
      "example.com",
      "127.0.0.1",
    ]);
    expect(extractSchemelessNetworkTargets("curl C:\\workspace\\file.txt")).toEqual([]);
    expect(extractSchemelessNetworkTargets("curl --header=X-Test:value example.com")).toEqual(["example.com"]);
    expect(hasExplicitUriScheme("curl --retry:3")).toBe(false);
    expect(hasExplicitUriScheme("rustc feature:bar")).toBe(false);
    expect(hasSchemelessNetworkTarget("curl localhost:8080/")).toBe(true);
    expect(hasSchemelessNetworkTarget("cat example.com:8080/file")).toBe(false);
  });

  it("identifies glob and Git pathspec syntax", () => {
    expect(hasPathGlob("/repo/*.rs")).toBe(true);
    expect(hasPathGlob("src/main.rs")).toBe(false);
    expect(hasGitPathspecMagic(":(exclude).nexa")).toBe(true);
    expect(hasGitPathspecMagic("C:\\repo\\src\\main.rs")).toBe(false);
  });

  it("splits portable relative patterns with either separator", () => {
    expect(pathSegments(" docs\\generated//cache/ ")).toEqual(["docs", "generated", "cache"]);
  });
});
