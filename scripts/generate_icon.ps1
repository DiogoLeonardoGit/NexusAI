$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $projectRoot "frontend\build"
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null

# Normalize the original artwork once so every surface uses the same visible scale.
$sourcePath = Join-Path $projectRoot "media\NexusAI_simbolo_quadrado_512.png"
$pngPath = Join-Path $buildDirectory "icon.png"
$assetPath = Join-Path $projectRoot "frontend\src\assets\nexus-symbol.png"

# Windows chooses a native size for the taskbar, installer and shortcuts.
# Each ICO entry contains a PNG resized from the supplied symbol, with alpha intact.
$original = [System.Drawing.Bitmap]::new($sourcePath)
$source = $null
$entries = @()
try {
    # Find the nontransparent bounds without discarding faint antialiased edges.
    $left = $original.Width
    $top = $original.Height
    $right = -1
    $bottom = -1
    for ($y = 0; $y -lt $original.Height; $y++) {
        for ($x = 0; $x -lt $original.Width; $x++) {
            if ($original.GetPixel($x, $y).A -gt 0) {
                $left = [Math]::Min($left, $x)
                $right = [Math]::Max($right, $x)
                $top = [Math]::Min($top, $y)
                $bottom = [Math]::Max($bottom, $y)
            }
        }
    }
    if ($right -lt $left -or $bottom -lt $top) {
        throw "O símbolo Nexus não contém píxeis visíveis."
    }
    # Preserve proportions on a square canvas, leaving 3% padding on each side.
    $canvasSize = 512
    $padding = [Math]::Round($canvasSize * 0.03)
    $visibleWidth = $right - $left + 1
    $visibleHeight = $bottom - $top + 1
    $scale = ($canvasSize - 2 * $padding) / [Math]::Max($visibleWidth, $visibleHeight)
    $width = $visibleWidth * $scale
    $height = $visibleHeight * $scale
    $source = [System.Drawing.Bitmap]::new($canvasSize, $canvasSize)
    $graphics = [System.Drawing.Graphics]::FromImage($source)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $destination = [System.Drawing.RectangleF]::new(($canvasSize - $width) / 2, ($canvasSize - $height) / 2, $width, $height)
        $bounds = [System.Drawing.RectangleF]::new($left, $top, $visibleWidth, $visibleHeight)
        $graphics.DrawImage($original, $destination, $bounds, [System.Drawing.GraphicsUnit]::Pixel)
    } finally {
        $graphics.Dispose()
    }
    $source.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $source.Save($assetPath, [System.Drawing.Imaging.ImageFormat]::Png)

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
    if ($null -ne $source) { $source.Dispose() }
    $original.Dispose()
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
