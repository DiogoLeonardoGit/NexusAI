$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $projectRoot "frontend\build"
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null

# Keep the original transparent Nexus artwork for Electron and the system tray.
$sourcePath = Join-Path $projectRoot "media\NexusAI_simbolo_quadrado_512.png"
$pngPath = Join-Path $buildDirectory "icon.png"
Copy-Item -LiteralPath $sourcePath -Destination $pngPath -Force

# Windows chooses a native size for the taskbar, installer and shortcuts.
# Each ICO entry contains a PNG resized from the supplied symbol, with alpha intact.
$source = [System.Drawing.Image]::FromFile($sourcePath)
$entries = @()
try {
    foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
        $bitmap = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $memory = New-Object IO.MemoryStream
        try {
            $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($source, 0, 0, $size, $size)
            $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
            $entries += @{ Size = $size; Bytes = $memory.ToArray() }
        } finally {
            $memory.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $source.Dispose()
}

$icoPath = Join-Path $buildDirectory "icon.ico"
$writer = New-Object IO.BinaryWriter ([IO.File]::Create($icoPath))
try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$entries.Count)
    $offset = 6 + 16 * $entries.Count
    foreach ($entry in $entries) {
        $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
        $writer.Write([Byte]$dimension)
        $writer.Write([Byte]$dimension)
        $writer.Write([Byte]0)
        $writer.Write([Byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$entry.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $entry.Bytes.Length
    }
    foreach ($entry in $entries) { $writer.Write([Byte[]]$entry.Bytes) }
} finally {
    $writer.Dispose()
}

Write-Output $icoPath
