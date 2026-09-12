# Upstream Pi audit

Audit date: 2026-09-12.

The Pi executable was subsequently found in the user's PowerShell PATH under the protected WinGet directory `C:/Users/chujiu/AppData/Local/Microsoft/WinGet/Packages/EarendilWorks.pi_Microsoft.Winget.Source_8wekyb3d8bbwe/pi.exe`. Its local manifest identifies `@earendil-works/pi-coding-agent` version `0.85.1`, repository `github.com/earendil-works/pi`, and Node engine `>=22.19.0`. The install is a bundled binary distribution, not a source checkout; its `node_modules`, docs and examples are readable with elevated inspection.

The installed `docs/extensions.md` verifies the extension factory, `input`, `before_agent_start`, `before_provider_request`, `tool_call`, `tool_result`, `session_start`, `session_before_switch`, `session_shutdown`, and `registerCommand` APIs. It explicitly states that `before_provider_request` can inspect/replace payloads but does not provide a blocking return, while `tool_call` can block. It also states that extension errors are logged and the agent continues. The project extension therefore records the real lifecycle and injects a manifest at `before_agent_start` only in active mode; the independent core adapter remains the authoritative provider gate. A hard provider-call gate will require a host/wrapper or upstream patch, not an invented extension behavior.
