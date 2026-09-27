import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RouterError } from "./errors.js";
export const noFollowFlag = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const roots = new Map();
const execute = promisify(execFile);
// Windows modes do not represent DACLs. This runs only when opening a private
// router root; ordinary reads/writes use its protected inherited permissions.
const windowsAclPolicy = String.raw `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
function Assert-NoReparsePath([string]$path) {
  $cursor = $path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse_path' }
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if (!$parent) { break }; $cursor = $parent.FullName
  }
}
function Assert-PrivatePath([string]$path) {
  Assert-NoReparsePath $path
  $acl = Get-Acl -LiteralPath $path
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { throw 'missing_dacl' }
  if ($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'unexpected_owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'unsafe_acl' }
  }
}
`;
const windowsAcl = windowsAclPolicy + String.raw `
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_ROUTER_STORAGE_PATH))
Assert-NoReparsePath $root
if (!(Test-Path -LiteralPath $root)) {
  if ($env:CODEX_ROUTER_STORAGE_CREATE -ne '1') { throw 'missing_root' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in $allowed) {
    $identity = New-Object Security.Principal.SecurityIdentifier($principal)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::CreateDirectory($root, $acl) | Out-Null
}
Assert-PrivatePath $root
`;
const windowsExistingAcl = windowsAclPolicy + String.raw `
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_ROUTER_STORAGE_PATH)))
foreach ($path in $paths) {
  if (Test-Path -LiteralPath $path) { Assert-PrivatePath $path }
}
`;
/** Validate named existing inputs, never unrelated descendants. Missing paths
 * are left to callers' required-file/open checks. Trusted principals may create
 * private inherited files during operation without another permission process. */
export async function validateExistingPrivatePaths(paths) {
    if (!paths.length)
        return;
    for (const path of paths)
        assertNativeStoragePath(path);
    if (process.platform !== "win32") {
        for (const path of paths) {
            const stat = await lstat(path).catch((error) => { if (error.code === "ENOENT")
                return undefined; throw error; });
            if (stat)
                await assertPrivatePath(path, stat.isDirectory());
        }
        return;
    }
    try {
        await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsExistingAcl, "utf16le").toString("base64")], {
            windowsHide: true, timeout: 30000, maxBuffer: 16384,
            env: { ...process.env, CODEX_ROUTER_STORAGE_PATH: Buffer.from(JSON.stringify([...new Set(paths)])).toString("base64"), CODEX_ROUTER_STORAGE_CREATE: "0" },
        });
    }
    catch (cause) {
        throw new RouterError("state_invalid", "Gateway storage must be private and must not use links or public access.", { cause });
    }
}
export function assertNativeStoragePath(path) {
    if (!isAbsolute(path))
        throw new RouterError("state_invalid", "Gateway storage paths must be absolute.");
    if (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(":"))) {
        throw new RouterError("state_invalid", "Windows gateway storage requires a local drive path without alternate streams.");
    }
}
async function noLinks(path) {
    let current = resolve(path);
    while (true) {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
            throw new Error("unsafe_path");
        if (current === dirname(current))
            return;
        current = dirname(current);
    }
}
export async function preparePrivateDirectory(path, create = true) {
    assertNativeStoragePath(path);
    try {
        if (process.platform !== "win32") {
            if (create)
                await mkdir(path, { recursive: true, mode: 0o700 });
            await assertPrivatePath(path, true);
            return;
        }
        await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsAcl, "utf16le").toString("base64")], {
            windowsHide: true, timeout: 30000, maxBuffer: 16384,
            env: { ...process.env, CODEX_ROUTER_STORAGE_PATH: Buffer.from(path).toString("base64"), CODEX_ROUTER_STORAGE_CREATE: create ? "1" : "0" },
        });
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("unsafe_directory");
        roots.set(resolve(path), `${stat.dev}:${stat.ino}`);
    }
    catch (cause) {
        throw new RouterError("state_invalid", "Gateway storage must be private and must not use links or inherited public access.", { cause });
    }
}
export async function assertPrivatePath(path, directory) {
    const stat = await lstat(path);
    let safe = !(stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()));
    if (process.platform !== "win32")
        safe &&= stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
    else {
        assertNativeStoragePath(path);
        const root = [...roots].find(([root]) => {
            const suffix = relative(root, resolve(path));
            return !suffix || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
        });
        if (!root)
            safe = false;
        else {
            const parent = await lstat(root[0]);
            safe &&= `${parent.dev}:${parent.ino}` === root[1];
            await noLinks(path);
        }
    }
    if (!safe)
        throw new RouterError("state_invalid", "Gateway storage must be private and must not use links.");
}
/** Windows cannot fsync directories through Node. File contents are still flushed
 * before atomic replacement; do not claim POSIX-equivalent power-loss durability. */
export async function syncDirectory(path) {
    if (process.platform === "win32")
        return;
    const file = await open(path, constants.O_RDONLY);
    try {
        await file.sync();
    }
    finally {
        await file.close();
    }
}
//# sourceMappingURL=platform-storage.js.map