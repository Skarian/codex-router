# Local gateway ownership

The gateway uses an operating-system lock on the permanent `lock` file in its state directory. Only one gateway can own that file.

A process crash releases ownership. A paused process retains ownership. The gateway does not use heartbeat expiry to transfer ownership.

The adjacent `owner.json` file supplies PID and token data for diagnostics. It does not grant ownership. The gateway never deletes or replaces `lock` during normal operation.

## Scope

This lock supports local filesystems. Native platform tests qualify the supported package binaries. Network filesystems require separate qualification.

The lock provides process exclusion. It does not change the storage system's power-loss guarantees. Windows flushes file contents before replacement, but Node does not support directory flushing there.

## Windows executable

If `codex.exe` is absent from PATH, set its absolute path before starting the router:

```powershell
$env:CODEX_ROUTER_CODEX_EXECUTABLE = 'C:\path\to\codex.exe'
```

The setting applies to local executable launches and diagnostics. SSH targets still use their own `codex` command.
