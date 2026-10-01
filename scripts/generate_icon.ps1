Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $projectRoot "frontend\build"
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null

$size = 512
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(11, 14, 19))

$green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(201, 242, 123))
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(18, 23, 11))
$graphics.FillRectangle($green, 48, 48, 416, 416)

$font = New-Object System.Drawing.Font "Segoe UI", 270, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString("N", $font, $dark, (New-Object System.Drawing.RectangleF 48, 34, 416, 416), $format)

$pngPath = Join-Path $buildDirectory "icon.png"
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$format.Dispose()
$font.Dispose()
$green.Dispose()
$dark.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

$png = [IO.File]::ReadAllBytes($pngPath)
$icoPath = Join-Path $buildDirectory "icon.ico"
$stream = [IO.File]::Create($icoPath)
$writer = New-Object IO.BinaryWriter $stream
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$png.Length)
$writer.Write([UInt32]22)
$writer.Write($png)
$writer.Dispose()

Write-Output $icoPath
