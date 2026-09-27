# Downloads a file with retries and a hard timeout.
# Kept as a standalone script (instead of an inline -Command) because long
# one-liner PowerShell commands inside .bat files are fragile to quote and
# escape, and their failures are hard to read.
# ASCII-only on purpose: the companion .bat file is parsed byte-wise by cmd.exe.
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$TimeoutSec = 300,
    [int]$MaxRetries = 2
)

$ErrorActionPreference = 'Stop'

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Older runtimes may not expose Tls12; continue with the default protocol.
}

function Write-Step {
    param([string]$Message)
    Write-Host "[ensure-node] $Message"
}

# 1) Reachability probe: fail fast with a readable message instead of a wall
#    of red PowerShell text when the network / proxy is unavailable.
try {
    $request = [System.Net.WebRequest]::Create($Url)
    $request.Method = 'HEAD'
    $request.Timeout = 15000
    $response = $request.GetResponse()
    $response.Close()
} catch {
    Write-Step "URL is not reachable: $Url"
    Write-Step ("Reason: " + $_.Exception.Message)
    exit 1
}

# 2) Download with retries.
for ($attempt = 1; $attempt -le ($MaxRetries + 1); $attempt++) {
    try {
        Write-Step "Downloading (attempt $attempt): $Url"
        $webClient = New-Object System.Net.WebClient
        try {
            $webClient.DownloadFile($Url, $OutFile)
        } finally {
            $webClient.Dispose()
        }

        if (-not (Test-Path $OutFile)) {
            throw "Downloaded file is missing: $OutFile"
        }

        $size = (Get-Item $OutFile).Length
        # A Node.js windows x64 zip is far larger than 1 MB; anything smaller
        # means we got an error page / redirect body instead of the real file.
        if ($size -lt 1MB) {
            throw "Downloaded file looks invalid (size=$size bytes)"
        }

        Write-Step ("Download OK: {0:N1} MB" -f ($size / 1MB))
        exit 0
    } catch {
        Write-Step ("Attempt $attempt failed: " + $_.Exception.Message)
        if (Test-Path $OutFile) {
            Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
        }
        if ($attempt -le $MaxRetries) {
            Start-Sleep -Seconds (3 * $attempt)
        }
    }
}

Write-Step "All download attempts failed."
exit 1
