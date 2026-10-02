param(
  [Parameter(Mandatory = $true)]
  [string]$Directory,
  [Parameter(Mandatory = $true)]
  [string]$Thumbprint,
  [Parameter(Mandatory = $true)]
  [string]$TimestampUrl
)

$ErrorActionPreference = "Stop"

function Normalize-Thumbprint([string]$Value) {
  return ($Value -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
}

function Find-Signtool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }
  $roots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($root in $roots) {
    $kitRoot = Join-Path $root "Windows Kits\10\bin"
    if (Test-Path -LiteralPath $kitRoot) {
      $candidate = Get-ChildItem -LiteralPath $kitRoot -Filter "signtool.exe" -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
      if ($null -ne $candidate) {
        return $candidate.FullName
      }
    }
  }
  throw "signtool.exe was not found"
}

if ([string]::IsNullOrWhiteSpace($TimestampUrl)) {
  throw "timestamp URL is required"
}
$timestampUri = [Uri]$TimestampUrl
if ($timestampUri.Scheme -notin @("http", "https")) {
  throw "timestamp URL must use HTTP or HTTPS"
}
$expectedThumbprint = Normalize-Thumbprint $Thumbprint
if ($expectedThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw "thumbprint must be a 40-character hexadecimal value"
}
if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
  throw "release asset directory does not exist"
}
$files = @(Get-ChildItem -LiteralPath $Directory -File | Where-Object {
  $_.Extension -ieq ".exe" -or $_.Extension -ieq ".msi"
})
if ($files.Count -eq 0) {
  throw "release contains no Windows executable artifacts"
}
if (-not ($files | Where-Object { $_.Extension -ieq ".exe" })) {
  throw "release contains no Windows executable installer artifact"
}
if (-not ($files | Where-Object { $_.Extension -ieq ".msi" })) {
  throw "release contains no Windows MSI installer artifact"
}
$signtool = Find-Signtool
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status.ToString() -ne "Valid") {
    throw "Authenticode status is not Valid for $($file.Name)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signer certificate is missing for $($file.Name)"
  }
  $actualThumbprint = Normalize-Thumbprint $signature.SignerCertificate.Thumbprint
  if ($actualThumbprint -ne $expectedThumbprint) {
    throw "Authenticode thumbprint does not match for $($file.Name)"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode timestamp is missing for $($file.Name)"
  }
  if (-not $signature.IsOSValid) {
    throw "Authenticode certificate chain is not trusted for $($file.Name)"
  }
  if ($signature.SignerCertificate.SignatureAlgorithm.FriendlyName -notmatch '(?i)sha256') {
    throw "Authenticode signer does not use SHA-256 for $($file.Name)"
  }
  if ($signature.TimeStamperCertificate.SignatureAlgorithm.FriendlyName -notmatch '(?i)sha256') {
    throw "Authenticode timestamp does not use SHA-256 for $($file.Name)"
  }
  $verifyOutput = (& $signtool verify /pa /all /v $file.FullName 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "signtool verification failed for $($file.Name)"
  }
  if ($verifyOutput -notmatch '(?i)timestamp\s+(verified|valid)') {
    throw "trusted timestamp verification is missing for $($file.Name)"
  }
  if ($verifyOutput -notmatch '(?i)hash of file\s*\(sha256\)') {
    throw "SHA-256 file digest is required for $($file.Name)"
  }
}
Write-Output "Windows Authenticode verification passed for $($files.Count) artifacts"
