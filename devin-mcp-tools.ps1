#requires -Version 5.1
<#
.SYNOPSIS
    Inspect tools exposed by the MCP servers configured in the Devin CLI.

.DESCRIPTION
    Devin's built-in `devin mcp list` shows server names and commands, but has no
    `tools` subcommand. This wrapper bridges that gap: it reads the Devin MCP
    registry, builds a temporary MCP_SERVERS_CONFIG JSON, and uses the repo's
    mcp_client.py to list (or call) the actual tools.

.PARAMETER Status
    Show server connection statuses instead of tool names.

.PARAMETER Call
    Call a tool by qualified name, e.g. 'server:tool_name'.

.PARAMETER Arguments
    JSON-encoded arguments for the --Call tool (default: '{}').

.PARAMETER Timeout
    Per-server connection timeout in seconds (default: 30).

.EXAMPLE
    .\devin-mcp-tools.ps1

    Lists every tool exposed by every server returned by `devin mcp list`.

.EXAMPLE
    .\devin-mcp-tools.ps1 -Status

    Shows whether each configured server connected and how many tools it exposes.

.EXAMPLE
    .\devin-mcp-tools.ps1 -Call "MCP_DOCKER:some_tool" -Arguments '{"key":"value"}'

    Invokes a specific tool through the temporary MCP bridge.
#>
[CmdletBinding()]
param(
    [switch]$Status,

    [string]$Call,

    [string]$Arguments = "{}",

    [int]$Timeout = 30
)

$ErrorActionPreference = "Stop"

# Devin's MCP registry output uses UTF-8 characters (e.g. the bullet symbol).
# Ensure PowerShell decodes external-process output as UTF-8 instead of the
# legacy console code page, otherwise the server-name parser sees mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Test-DevinCli {
    $devin = Get-Command "devin" -ErrorAction SilentlyContinue
    if (-not $devin) {
        throw "devin CLI not found in PATH. Install it first (see setup.ps1)."
    }
    return $devin.Source
}

function Invoke-DevinMcpList {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "devin"
    $psi.Arguments = "mcp list"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    if ($proc.ExitCode -ne 0) {
        throw "`devin mcp list` failed (exit $($proc.ExitCode)): $stderr"
    }
    return $stdout
}

function ConvertFrom-DevinMcpList {
    param([string]$Text)

    $servers = @()
    $current = $null
    $pastHeader = $false

    foreach ($line in ($Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }

        # The first non-empty line is the header.
        if (-not $pastHeader) {
            $pastHeader = $true
            continue
        }

        # A property line contains a colon ("Key: value").
        if ($current -and ($trimmed -match '^([A-Za-z][A-Za-z0-9_\s]*):\s*(.+)$')) {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            $current.Properties[$key] = $value
            continue
        }

        # Anything else after the header starts a new server block.
        # Devin prints a leading glyph (e.g. a bullet); drop the first token if it is
        # not a normal identifier, otherwise treat the whole line as the server name.
        $first, $rest = $trimmed -split '\s+', 2
        if ($first -match '^[A-Za-z0-9_]+$') {
            $name = $trimmed
        } else {
            $name = $rest
        }
        if ($current) { $servers += $current }
        $current = [pscustomobject]@{ Name = $name; Properties = @{} }
    }

    if ($current) { $servers += $current }
    return $servers
}

function Split-CommandLine {
    param([string]$CommandLine)

    # Simple whitespace split is enough for Devin MCP registry commands.
    # If commands later contain quoted arguments, switch to a parser here.
    return @($CommandLine -split '\s+') | Where-Object { $_ }
}

function ConvertTo-McpServerJson {
    param([array]$Servers)

    $configs = @(
        foreach ($srv in $Servers) {
            $cmd = $srv.Properties['Command']
            if (-not $cmd) {
                throw "Server '$($srv.Name)' has no 'Command' field. Is `devin mcp list` output format unchanged?"
            }

            $parts = Split-CommandLine -CommandLine $cmd
            if ($parts.Count -eq 0) {
                throw "Server '$($srv.Name)' has an empty command."
            }

            [pscustomobject]@{
                name      = $srv.Name
                transport = "stdio"
                command   = $parts[0]
                args      = @($parts | Select-Object -Skip 1)
                timeout   = $Timeout
            }
        }
    )

    return ConvertTo-Json -InputObject $configs -Depth 5 -Compress:$false
}

function Invoke-McpClient {
    param(
        [string]$ConfigPath,
        [switch]$StatusMode,
        [string]$ToolName,
        [string]$ToolArgs
    )

    $py = Get-Command "python" -ErrorAction SilentlyContinue
    if (-not $py) {
        $py = Get-Command "python3" -ErrorAction SilentlyContinue
    }
    if (-not $py) {
        throw "Python is required to run mcp_client.py but was not found in PATH."
    }

    $clientPath = Join-Path $PSScriptRoot "mcp_client.py"
    if (-not (Test-Path $clientPath)) {
        throw "mcp_client.py not found next to this script at $clientPath."
    }

    $argList = @(
        $clientPath,
        "--config",
        $ConfigPath,
        "--timeout",
        "$Timeout"
    )
    if ($StatusMode) {
        $argList += "--status"
    }
    elseif ($ToolName) {
        $argList += @("--call", $ToolName, "--args", $ToolArgs)
    }
    else {
        $argList += "--list"
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $py.Source
    $psi.Arguments = ($argList | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join " "
    $psi.WorkingDirectory = $PSScriptRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    if ($stderr) {
        Write-Warning $stderr
    }
    if ($proc.ExitCode -ne 0) {
        throw "mcp_client.py exited with code $($proc.ExitCode)."
    }

    Write-Output $stdout
}

# --- Main -------------------------------------------------------------------

$devinPath = Test-DevinCli
Write-Verbose "Using devin CLI at $devinPath"

$rawList = Invoke-DevinMcpList
Write-Verbose "`devin mcp list` output:`n$rawList"

$servers = ConvertFrom-DevinMcpList -Text $rawList
if ($servers.Count -eq 0) {
    Write-Host "No MCP servers are configured in the Devin CLI."
    exit 0
}

Write-Verbose "Discovered $($servers.Count) MCP server(s): $($servers.Name -join ', ')"

$configJson = ConvertTo-McpServerJson -Servers $servers

$tempConfig = [System.IO.Path]::GetTempFileName()
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempConfig, $configJson, $utf8NoBom)
    Write-Verbose "Wrote temporary MCP config to $tempConfig"

    Invoke-McpClient -ConfigPath $tempConfig -StatusMode:$Status -ToolName $Call -ToolArgs $Arguments
}
finally {
    if (Test-Path $tempConfig) {
        Remove-Item $tempConfig -Force -ErrorAction SilentlyContinue
    }
}
