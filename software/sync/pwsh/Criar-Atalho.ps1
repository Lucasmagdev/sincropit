<#
  Gera o icone e o atalho do SincronPIT.

  Rodar UMA VEZ, aqui ou no PIT-Q. Produz, ao lado:
    SincronPIT.ico   - icone desenhado em codigo (nada para baixar)
    SincronPIT.lnk   - atalho que abre o app sem janela preta de console

  O atalho existe por um motivo pratico: o operador nao vai digitar linha de
  comando. Duplo clique e so.
#>
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$raiz = $PSScriptRoot
if (-not $raiz) { $raiz = Split-Path -Parent $MyInvocation.MyCommand.Path }

$caminhoIco = Join-Path $raiz "SincronPIT.ico"
$caminhoPs1 = Join-Path $raiz "SincronPIT.ps1"
$caminhoLnk = Join-Path $raiz "SincronPIT.lnk"

# ---------------------------------------------------------------------------
# Desenha um tamanho do icone: quadrado azul arredondado, seta subindo, e a
# linha de base representando a estaca. Sem arquivo externo para nao depender
# de download numa maquina sem internet.
# ---------------------------------------------------------------------------
function New-Bitmap([int]$lado) {
  $bmp = New-Object System.Drawing.Bitmap($lado, $lado)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.Clear([System.Drawing.Color]::Transparent)

  $e = $lado / 32.0   # escala relativa ao desenho base de 32px

  # fundo arredondado
  $raioCanto = [int](6 * $e)
  # A conta sai ANTES da chamada: New-Object Tipo(a, b, $x - 1) faz o
  # PowerShell montar um array e so depois tentar subtrair dele, o que falha
  # com "does not contain a method named op_Subtraction".
  $ladoMenos1 = $lado - 1
  $ret = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $ladoMenos1, $ladoMenos1
  $caminho = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $raioCanto * 2
  $caminho.AddArc($ret.X, $ret.Y, $d, $d, 180, 90)
  $caminho.AddArc($ret.Right - $d, $ret.Y, $d, $d, 270, 90)
  $caminho.AddArc($ret.Right - $d, $ret.Bottom - $d, $d, $d, 0, 90)
  $caminho.AddArc($ret.X, $ret.Bottom - $d, $d, $d, 90, 90)
  $caminho.CloseFigure()

  $fundo = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $ret,
    [System.Drawing.Color]::FromArgb(255, 30, 110, 190),
    [System.Drawing.Color]::FromArgb(255, 18, 66, 122),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $g.FillPath($fundo, $caminho)

  $branco = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

  # seta subindo (envio)
  $meio = $lado / 2.0
  $pontos = @(
    (New-Object System.Drawing.PointF($meio,            (7 * $e))),
    (New-Object System.Drawing.PointF(($meio + 7 * $e), (15 * $e))),
    (New-Object System.Drawing.PointF(($meio + 3 * $e), (15 * $e))),
    (New-Object System.Drawing.PointF(($meio + 3 * $e), (21 * $e))),
    (New-Object System.Drawing.PointF(($meio - 3 * $e), (21 * $e))),
    (New-Object System.Drawing.PointF(($meio - 3 * $e), (15 * $e))),
    (New-Object System.Drawing.PointF(($meio - 7 * $e), (15 * $e)))
  )
  $g.FillPolygon($branco, $pontos)

  # base: a estaca
  $g.FillRectangle($branco, (8 * $e), (24 * $e), (16 * $e), (2.5 * $e))

  $g.Dispose()
  return $bmp
}

# ---------------------------------------------------------------------------
# Monta o .ico. Formato: ICONDIR + uma ICONDIRENTRY por tamanho + os PNGs.
# PNG dentro de .ico e aceito do Vista em diante; o PIT-Q e Windows 10.
# ---------------------------------------------------------------------------
$tamanhos = @(16, 32, 48, 256)
$imagens = @()
foreach ($t in $tamanhos) {
  $bmp = New-Bitmap $t
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $imagens += ,@{ Lado = $t; Bytes = $ms.ToArray() }
  $ms.Dispose(); $bmp.Dispose()
}

$saida = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($saida)
$w.Write([uint16]0)                    # reservado
$w.Write([uint16]1)                    # tipo 1 = icone
$w.Write([uint16]$imagens.Count)

$deslocamento = 6 + (16 * $imagens.Count)
foreach ($img in $imagens) {
  # 256 e gravado como 0 na tabela de diretorio (campo de 1 byte)
  $w.Write([byte]$(if ($img.Lado -ge 256) { 0 } else { $img.Lado }))
  $w.Write([byte]$(if ($img.Lado -ge 256) { 0 } else { $img.Lado }))
  $w.Write([byte]0)                    # cores da paleta
  $w.Write([byte]0)                    # reservado
  $w.Write([uint16]1)                  # planos
  $w.Write([uint16]32)                 # bits por pixel
  $w.Write([uint32]$img.Bytes.Length)
  $w.Write([uint32]$deslocamento)
  $deslocamento += $img.Bytes.Length
}
foreach ($img in $imagens) { $w.Write($img.Bytes) }
$w.Flush()
[System.IO.File]::WriteAllBytes($caminhoIco, $saida.ToArray())
$w.Dispose(); $saida.Dispose()
Write-Host "icone gerado: $caminhoIco"

# ---------------------------------------------------------------------------
# Atalho. -WindowStyle Hidden esconde o console: o operador ve so a janela do
# app, nao uma tela preta de comando junto.
# ---------------------------------------------------------------------------
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($caminhoLnk)
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$caminhoPs1`""
$lnk.WorkingDirectory = $raiz
$lnk.IconLocation = "$caminhoIco,0"
$lnk.Description = "Envia os ensaios do PIT-Q para a nuvem"
$lnk.Save()
Write-Host "atalho gerado: $caminhoLnk"
Write-Host ""
Write-Host "Copie a pasta inteira para o PIT-Q e clique duas vezes em SincronPIT.lnk"
