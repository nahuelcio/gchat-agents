$ErrorActionPreference = "Stop"
$repo = if ($env:SWITCHBOARD_REPO) { $env:SWITCHBOARD_REPO } else { "nahuelcio/gchat-agents" }
$dir = if ($env:SWITCHBOARD_DIR) { $env:SWITCHBOARD_DIR } else { Join-Path $env:LOCALAPPDATA "switchboard" }
$asset = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { throw "Windows ARM64 is not published yet" } else { "switchboard-windows-x64.exe" }
New-Item -ItemType Directory -Force $dir | Out-Null
$exe = Join-Path $dir "switchboard.exe"
if (Get-Command gh -ErrorAction SilentlyContinue) {
  gh release download --repo $repo --pattern $asset --output $exe --clobber
} else {
  Invoke-WebRequest "https://github.com/$repo/releases/latest/download/$asset" -OutFile $exe
}
Write-Host "installed $exe"
Write-Host "run: cd `"$dir`"; .\switchboard.exe   then open http://127.0.0.1:8081"
