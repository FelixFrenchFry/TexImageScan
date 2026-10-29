param(
    [string]$Python = "python",
    [switch]$SkipDownload
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$VenvRoot = Join-Path $RepoRoot ".cache/paddle-accuracy/native-venv"
$NativePython = Join-Path $VenvRoot "Scripts/python.exe"
if (-not (Test-Path -LiteralPath $NativePython)) {
    & $Python -m venv $VenvRoot
    if ($LASTEXITCODE -ne 0) { throw "Native venv creation failed" }
}
& $NativePython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot "native-requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Pinned native dependency installation failed" }
if (-not $SkipDownload) {
    & $NativePython (Join-Path $PSScriptRoot "native.py") --download --export-prompts (Join-Path $RepoRoot "artifacts/paddle-diagnostics/prompts.json")
    if ($LASTEXITCODE -ne 0) { throw "Native model verification / prompt export failed" }
}
& $NativePython -m pip freeze | Set-Content -LiteralPath (Join-Path $VenvRoot "resolved-requirements.txt") -Encoding utf8
& $NativePython -c "import torch; print({'torch':torch.__version__,'cuda':torch.version.cuda,'available':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name() if torch.cuda.is_available() else None})"
if ($LASTEXITCODE -ne 0) { throw "Native CUDA inspection failed" }
