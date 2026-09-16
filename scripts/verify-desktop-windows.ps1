param(
    [string]$DistDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $DistDirectory) {
    $DistDirectory = Join-Path $repositoryRoot "apps/desktop/dist"
}
$dist = (Resolve-Path $DistDirectory).Path
$temporaryRoot = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
}
else {
    [System.IO.Path]::GetTempPath()
}
$installRoot = Join-Path $temporaryRoot "dsh-desktop-install"
$archiveRoot = Join-Path $temporaryRoot "dsh-desktop-archive"
$userDataRoot = Join-Path $temporaryRoot "dsh-desktop-user-data"
$temporaryPaths = @($installRoot, $archiveRoot, $userDataRoot)
Remove-Item $temporaryPaths -Recurse -Force -ErrorAction SilentlyContinue

$installer = @(Get-ChildItem $dist -Filter "DeepSeek-Harness-*-x64.exe")
$archive = @(Get-ChildItem $dist -Filter "DeepSeek-Harness-*-x64.zip")
if (($installer.Count -ne 1) -or ($archive.Count -ne 1)) {
    throw "expected exactly one Windows installer and one ZIP archive"
}

$manifest = Get-Content (Join-Path $dist "SHA256SUMS")
if (-not $manifest -or $manifest.Count -ne 2) {
    throw "SHA256SUMS must contain exactly two Windows distributables"
}
foreach ($line in $manifest) {
    $parts = $line -split "\s{2}", 2
    if ($parts.Count -ne 2) {
        throw "invalid SHA256SUMS line: $line"
    }
    $artifactName = $parts[1]
    $artifactPath = Join-Path $dist $artifactName
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
    if ($actual -ne $parts[0]) {
        throw "checksum mismatch: $artifactName"
    }
}

function Assert-DesktopPayload {
    param([string]$Root)

    $executable = Join-Path $Root "DeepSeek Harness.exe"
    $metadataPath = Join-Path $Root "resources/sidecar/metadata.json"
    if (-not (Test-Path $executable -PathType Leaf)) {
        throw "desktop executable missing from $Root"
    }
    if (-not (Test-Path $metadataPath -PathType Leaf)) {
        throw "sidecar metadata missing from $Root"
    }
    $metadata = Get-Content $metadataPath -Raw | ConvertFrom-Json
    if (($metadata.platform -ne "win32") -or ($metadata.arch -ne "x64")) {
        throw "sidecar target mismatch in $metadataPath"
    }
    return $executable
}

function Close-DesktopThroughCdp {
    param([string]$DebuggerUrl)

    $version = Invoke-RestMethod "$DebuggerUrl/json/version"
    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        $cancellation = [System.Threading.CancellationToken]::None
        $socket.ConnectAsync(
            [System.Uri]$version.webSocketDebuggerUrl,
            $cancellation
        ).GetAwaiter().GetResult()
        $payload = [System.Text.Encoding]::UTF8.GetBytes(
            '{"id":1,"method":"Browser.close"}'
        )
        $socket.SendAsync(
            [System.ArraySegment[byte]]::new($payload),
            [System.Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $cancellation
        ).GetAwaiter().GetResult()
    }
    finally {
        $socket.Dispose()
    }
}

Expand-Archive -LiteralPath $archive[0].FullName -DestinationPath $archiveRoot
Assert-DesktopPayload $archiveRoot | Out-Null

$desktop = $null
try {
    $installation = Start-Process -FilePath $installer[0].FullName -ArgumentList @(
        "/S",
        "/D=$installRoot"
    ) -Wait -PassThru
    if ($installation.ExitCode -ne 0) {
        throw "desktop installer exited with code $($installation.ExitCode)"
    }
    $installedExecutable = Assert-DesktopPayload $installRoot

    $portProbe = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0
    )
    $portProbe.Start()
    $debugPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
    $portProbe.Stop()
    $userDataArgument = "--user-data-dir=`"$userDataRoot`""
    $desktop = Start-Process -FilePath $installedExecutable -ArgumentList @(
        "--remote-debugging-port=$debugPort",
        $userDataArgument
    ) -PassThru

    $target = $null
    $deadline = (Get-Date).AddSeconds(60)
    while ($null -eq $target -and (Get-Date) -lt $deadline) {
        if ($desktop.HasExited) {
            $exitCode = $desktop.ExitCode
            throw "desktop application exited before readiness with code $exitCode"
        }
        try {
            $targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json/list"
            $target = @($targets) |
                Where-Object {
                    $_.type -eq "page" -and $_.url -eq "http://127.0.0.1:37615/"
                } |
                Select-Object -First 1
        }
        catch {
            # CDP connection failures are expected until Electron starts listening.
        }
        if ($null -eq $target) {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -eq $target) {
        throw "desktop application did not expose the React page before the readiness deadline"
    }

    Close-DesktopThroughCdp "http://127.0.0.1:$debugPort"
    if (-not $desktop.WaitForExit(30000)) {
        throw "desktop application did not exit after its window closed"
    }
    if ($desktop.ExitCode -ne 0) {
        $exitCode = $desktop.ExitCode
        throw "desktop application exited with code $exitCode"
    }
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort 37615 -State Listen -ErrorAction SilentlyContinue) {
        throw "desktop sidecar still owns its listener after application exit"
    }
}
finally {
    if ($null -ne $desktop -and -not $desktop.HasExited) {
        taskkill.exe /PID $desktop.Id /T /F | Out-Null
    }
    $uninstaller = Join-Path $installRoot "Uninstall DeepSeek Harness.exe"
    if (Test-Path $uninstaller -PathType Leaf) {
        $uninstallation = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
        if ($uninstallation.ExitCode -ne 0) {
            throw "desktop uninstaller exited with code $($uninstallation.ExitCode)"
        }
    }
    Remove-Item $temporaryPaths -Recurse -Force -ErrorAction SilentlyContinue
}
