# Generates branded NSIS installer images (24-bit BMP) for the Catalyst setup:
#   sidebar.bmp (164x314) — Welcome/Finish page art
#   header.bmp  (150x57)  — inner-page top banner
# Dark background + teal hexagon mark + CATALYST wordmark, matching the app brand.
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\src-tauri\installer'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$bg     = [System.Drawing.Color]::FromArgb(6, 8, 13)      # #06080d
$teal   = [System.Drawing.Color]::FromArgb(56, 189, 248)  # #38bdf8
$light  = [System.Drawing.Color]::FromArgb(207, 232, 251) # #cfe8fb
$muted  = [System.Drawing.Color]::FromArgb(120, 150, 180)

# SVG hexagon points in a 0..32 box (from catalyst-mark.svg).
$pts = @(
  @(16.0,6.0), @(24.66,11.0), @(24.66,21.0), @(16.0,26.0), @(7.34,21.0), @(7.34,11.0)
)

function Draw-Mark($g, $cx, $cy, $size, $stroke) {
  $s = $size / 32.0
  $ox = $cx - ($size / 2.0)
  $oy = $cy - ($size / 2.0)
  $poly = New-Object System.Drawing.Drawing2D.GraphicsPath
  $arr = @()
  foreach ($p in $pts) { $arr += New-Object System.Drawing.PointF(($ox + $s*$p[0]), ($oy + $s*$p[1])) }
  $poly.AddPolygon([System.Drawing.PointF[]]$arr)
  $pen = New-Object System.Drawing.Pen($teal, [float]($s*2.2))
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $poly)
  # antenna line (16,6)->(16,3.4)
  $g.DrawLine($pen, [float]($ox+$s*16), [float]($oy+$s*6), [float]($ox+$s*16), [float]($oy+$s*3.4))
  # node circle (16,2.4) r2  + center dot (16,16) r1.5
  $br = New-Object System.Drawing.SolidBrush($teal)
  $nr = $s*2.0
  $g.FillEllipse($br, [float]($ox+$s*16-$nr), [float]($oy+$s*2.4-$nr), [float]($nr*2), [float]($nr*2))
  $dr = $s*1.5
  $dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120,56,189,248))
  $g.FillEllipse($dim, [float]($ox+$s*16-$dr), [float]($oy+$s*16-$dr), [float]($dr*2), [float]($dr*2))
  $pen.Dispose(); $br.Dispose(); $dim.Dispose(); $poly.Dispose()
}

function New-Bmp($w, $h, [scriptblock]$paint, $path) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($bg)
  & $paint $g
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
  Write-Host "wrote $path"
}

# Sidebar 164x314
New-Bmp 164 314 {
  param($g)
  Draw-Mark $g 82 96 78 $teal
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $title = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
  $tb = New-Object System.Drawing.SolidBrush($light)
  $g.DrawString('CATALYST', $title, $tb, (New-Object System.Drawing.RectangleF(0,170,164,30)), $sf)
  $sub = New-Object System.Drawing.Font('Segoe UI', 7)
  $mb = New-Object System.Drawing.SolidBrush($muted)
  $g.DrawString('AI CLI WORKSPACE', $sub, $mb, (New-Object System.Drawing.RectangleF(0,202,164,20)), $sf)
  $title.Dispose(); $sub.Dispose(); $tb.Dispose(); $mb.Dispose(); $sf.Dispose()
} (Join-Path $outDir 'sidebar.bmp')

# Header 150x57
New-Bmp 150 57 {
  param($g)
  Draw-Mark $g 28 28 38 $teal
  $f = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $tb = New-Object System.Drawing.SolidBrush($light)
  $g.DrawString('CATALYST', $f, $tb, [float]52, [float]18)
  $f.Dispose(); $tb.Dispose()
} (Join-Path $outDir 'header.bmp')
