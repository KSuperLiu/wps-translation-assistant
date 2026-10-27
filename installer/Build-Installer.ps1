param([string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$FilePath) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($FilePath))).Replace('-','') }
    finally { $sha.Dispose() }
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [Version]$package.version
$outputRoot = Split-Path -Parent $projectRoot
if (-not $BuildDirectory) { $BuildDirectory = Join-Path ([IO.Path]::GetTempPath()) 'WpsTranslationAssistant-native-build' }
$buildRoot = [IO.Path]::GetFullPath($BuildDirectory)
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$stage = [IO.Path]::GetFullPath((Join-Path $buildRoot 'payload-stage'))
if (-not $stage.StartsWith($buildRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($stage) -ne 'payload-stage') { throw '临时目录路径验证失败' }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
$dist = Join-Path $projectRoot 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $dist 'pane.html'))) { throw '请先运行 npm run build' }
Get-ChildItem -LiteralPath $dist -Force | Copy-Item -Destination $stage -Recurse -Force
$manifest = [Xml.XmlDocument]::new()
$root = $manifest.CreateElement('translationAssistant')
[void]$manifest.AppendChild($root)
$root.SetAttribute('product', 'WpsTranslationAssistant')
$root.SetAttribute('version', $package.version)
foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName) {
    $relative = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
    $node = $manifest.CreateElement('file')
    $node.SetAttribute('path', $relative)
    $node.SetAttribute('sha256', (Get-Sha256 $file.FullName))
    [void]$root.AppendChild($node)
}
$manifest.Save((Join-Path $stage '.translation-assistant-install.xml'))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$payload = Join-Path $buildRoot 'payload.zip'
if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload -Force }
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
$candidates = @((Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'), (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'))
$compiler = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw '找不到 Windows .NET Framework C# 编译器' }
$references = @('/r:System.Core.dll','/r:System.Xml.dll','/r:System.Management.dll','/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll')
$engine = Join-Path $PSScriptRoot 'InstallerEngine.cs'
$testExe = Join-Path $buildRoot 'InstallerEngineTests.exe'
& $compiler '/nologo' '/codepage:65001' '/optimize+' '/target:exe' ("/out:$testExe") @references $engine (Join-Path $PSScriptRoot 'EngineTests.cs')
if ($LASTEXITCODE -ne 0) { throw '安装器测试程序编译失败' }
& $testExe (Join-Path $buildRoot 'isolated-tests') $payload
if ($LASTEXITCODE -ne 0) { throw '安装器隔离测试失败' }
$integrationTest = Join-Path $buildRoot 'WindowsIntegrationTests.exe'
& $compiler '/nologo' '/codepage:65001' '/optimize+' '/target:exe' ("/out:$integrationTest") @references $engine (Join-Path $PSScriptRoot 'WindowsIntegration.cs') (Join-Path $PSScriptRoot 'WindowsIntegrationTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Windows 集成测试程序编译失败' }
& $integrationTest (Join-Path $buildRoot 'isolated-tests')
if ($LASTEXITCODE -ne 0) { throw 'Windows 卸载入口与快捷方式隔离测试失败' }
$assemblyInfo = Join-Path $buildRoot 'AssemblyInfo.cs'
$versionFour = '{0}.{1}.{2}.0' -f $version.Major,$version.Minor,$version.Build
$assemblySource = @"
using System.Reflection;
[assembly: AssemblyTitle("WPS 翻译助手安装与管理")]
[assembly: AssemblyProduct("WPS 翻译助手")]
[assembly: AssemblyDescription("当前用户离线安装、升级与卸载")]
[assembly: AssemblyVersion("$versionFour")]
[assembly: AssemblyFileVersion("$versionFour")]
"@
[IO.File]::WriteAllText($assemblyInfo, $assemblySource, [Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.Drawing
$iconFile = Join-Path $buildRoot 'assistant.ico'
$bitmap = [Drawing.Bitmap]::new(32,32)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(32,116,91))
$pen = [Drawing.Pen]::new([Drawing.Color]::White,2)
try {
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.FillRectangle($brush,2,4,28,24)
    $graphics.DrawRectangle($pen,5,7,22,18)
    $graphics.DrawLine($pen,19,7,19,25)
    $graphics.DrawLine($pen,8,12,15,12)
    $graphics.DrawLine($pen,8,17,15,17)
    $graphics.DrawLine($pen,8,22,12,22)
    $icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
    try { $stream = [IO.File]::Create($iconFile); try { $icon.Save($stream) } finally { $stream.Dispose() } } finally { $icon.Dispose() }
} finally { $pen.Dispose(); $brush.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
$output = Join-Path $outputRoot ('WPS翻译助手-' + $package.version + '-离线安装.exe')
& $compiler '/nologo' '/codepage:65001' '/optimize+' '/target:winexe' '/platform:anycpu' ("/out:$output") ("/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')") ("/win32icon:$iconFile") ("/resource:$payload,payload.zip") @references '/r:System.Windows.Forms.dll' '/r:System.Drawing.dll' $engine (Join-Path $PSScriptRoot 'WindowsIntegration.cs') (Join-Path $PSScriptRoot 'Program.cs') $assemblyInfo
if ($LASTEXITCODE -ne 0) { throw '安装器编译失败' }
$hash = Get-Sha256 $output
[IO.File]::WriteAllText(($output + '.sha256'), $hash + '  ' + [IO.Path]::GetFileName($output) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$instructions = Join-Path $outputRoot 'WPS翻译助手-离线安装说明.txt'
$instructionsText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '使用说明.txt'), [Text.Encoding]::UTF8).Replace('{{VERSION}}', $package.version)
[IO.File]::WriteAllText($instructions, $instructionsText, [Text.UTF8Encoding]::new($true))
$distribution = Join-Path $outputRoot ('WPS翻译助手-' + $package.version + '-Windows离线安装包.zip')
if (Test-Path -LiteralPath $distribution) { Remove-Item -LiteralPath $distribution -Force }
$zip = [IO.Compression.ZipFile]::Open($distribution, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in @($output, ($output + '.sha256'), $instructions)) {
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, [IO.Path]::GetFileName($file), [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $zip.Dispose() }
Write-Output ('安装包生成：' + $output)
Write-Output ('分发 ZIP：' + $distribution)
Write-Output ('大小：' + (Get-Item -LiteralPath $output).Length + ' bytes；SHA-256：' + $hash)
