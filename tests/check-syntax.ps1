$ErrorActionPreference = "Stop"

$files = Get-ChildItem -Path "src" -Recurse -Filter "*.js" | Sort-Object FullName
foreach ($file in $files) {
  node --check $file.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Syntax check failed: $($file.FullName)"
  }
}

Write-Output "Checked $($files.Count) JavaScript files as modules"
