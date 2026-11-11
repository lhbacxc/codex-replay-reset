$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$PSDefaultParameterValues['*:Encoding'] = 'UTF8'

$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Encoding UTF8 | ConvertFrom-Json
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'codexpp.json') -Encoding UTF8 | ConvertFrom-Json
if ($taskPackage.version -ne $taskManifest.version) { throw 'package.json 与拓展清单版本不一致' }
$taskDist = [System.IO.Path]::GetFullPath((Join-Path $taskRoot 'dist'))
$taskZipPath = [System.IO.Path]::GetFullPath((Join-Path $taskDist ('codex-replay-reset-' + $taskPackage.version + '.zip')))
if (-not $taskDist.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar) -or [System.IO.Path]::GetDirectoryName($taskZipPath) -ne $taskDist) { throw '打包目标不在项目 dist 目录中' }
if (-not (Test-Path -LiteralPath $taskDist)) { $null = New-Item -Path $taskDist -ItemType Directory }

$taskRelativeFiles = @('codexpp.json', 'package.json', 'renderer.js', 'backend', 'bridge', 'core', 'launch', 'test', 'scripts', 'docs', 'README.md', 'AIREADME.md', 'AGENTS.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE')
$taskFiles = @($taskRelativeFiles | ForEach-Object {
    $taskFile = [System.IO.Path]::GetFullPath((Join-Path $taskRoot $_))
    if (-not $taskFile.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar)) { throw '打包来源越界' }
    if (-not (Test-Path -LiteralPath $taskFile)) { throw ('打包文件不存在：' + $_) }
    $taskFile
})
Compress-Archive -LiteralPath $taskFiles -DestinationPath $taskZipPath -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip = [System.IO.Compression.ZipFile]::OpenRead($taskZipPath)
try {
    $taskNames = @($taskZip.Entries | ForEach-Object FullName)
    if ($taskNames | Where-Object { $_ -match '(^|/)(\.runtime|node_modules|dist|\.git)(/|$)' }) { throw '安装包包含运行状态或生成目录' }
    if ($taskNames -notcontains 'codexpp.json') { throw '安装包缺少根级拓展清单' }
    [pscustomobject]@{artifact=$taskZipPath;files=$taskNames.Count;bytes=(Get-Item -LiteralPath $taskZipPath).Length} | ConvertTo-Json
} finally { $taskZip.Dispose() }
