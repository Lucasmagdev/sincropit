<#
  Varredura de campos do cabecalho .PTE — caca ao L1 (arrasamento).

  Motivo: nos 40 arquivos disponiveis fora do PIT-Q, TODOS os campos numericos
  candidatos a arrasamento valem zero — ninguem preencheu o campo naqueles
  ensaios. Sem um arquivo onde o valor exista, a tag nao tem como ser
  identificada. O PIT-Q tem 31 mil ensaios; a chance de algum ter arrasamento
  preenchido e alta.

  Este script le SO o cabecalho (primeiros 4 KB) de cada arquivo, entao roda
  rapido mesmo em 31 mil arquivos num Atom. Somente leitura.

    powershell -ExecutionPolicy Bypass -File varrer-campos-pte.ps1
    powershell -ExecutionPolicy Bypass -File varrer-campos-pte.ps1 -Pastas "D:\ensaios"

  Gera campos-<HOSTNAME>.csv e um resumo na tela.
#>
param(
  [string[]]$Pastas,
  [string]$Saida,
  [int]$Max = 0        # 0 = sem limite
)

$ErrorActionPreference = "SilentlyContinue"

$raiz = $PSScriptRoot
if (-not $raiz) { $raiz = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $raiz) { $raiz = (Get-Location).Path }

if (-not $Pastas -or $Pastas.Count -eq 0) {
  $Pastas = @(
    (Join-Path $env:APPDATA "PDI\PIT"),
    (Join-Path $env:PUBLIC  "Documents\PDI\PIT")
  )
}

# ---------------------------------------------------------------------------
# Leitor TLV. Mesmo formato do parser do app: [tag u16][len u16][payload].
# Texto = UTF16LE com len em CARACTERES; numerico = len em BYTES.
# ---------------------------------------------------------------------------
function EhTextoUtf16([byte[]]$b, [int]$off, [int]$n) {
  for ($i = 0; $i -lt $n; $i++) {
    $lo = $b[$off + $i*2]; $hi = $b[$off + $i*2 + 1]
    if ($hi -ne 0) { return $false }
    if ($lo -lt 0x20 -or $lo -gt 0x7e) {
      if ($lo -ne 9 -and $lo -ne 10 -and $lo -ne 13) { return $false }
    }
  }
  return $true
}

function LerCabecalho([string]$caminho) {
  $m = @{}
  $b = New-Object byte[] 4096
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($caminho, [System.IO.FileMode]::Open,
                                 [System.IO.FileAccess]::Read,
                                 [System.IO.FileShare]::ReadWrite)
    $lidos = $fs.Read($b, 0, 4096)
  } catch { return $null } finally { if ($fs) { $fs.Dispose() } }
  if ($lidos -lt 64) { return $null }

  $off = 0; $n = 0
  while (($off + 4) -le $lidos -and $n -lt 200) {
    $tag = [BitConverter]::ToUInt16($b, $off)
    $len = [BitConverter]::ToUInt16($b, $off + 2)
    $p = $off + 4
    $T = $tag.ToString("x4")
    $n++

    if ($len -eq 0) { $off = $p; continue }

    if ($len -lt 300 -and ($p + $len*2) -le $lidos -and (EhTextoUtf16 $b $p $len)) {
      if (-not $m.ContainsKey($T)) {
        # primeiro trecho nao vazio: o buffer de 280 chars dos arquivos antigos
        # traz o valor seguido de muitos espacos
        $txt = [System.Text.Encoding]::Unicode.GetString($b, $p, $len*2).Trim()
        $m[$T] = ($txt -split '\s{2,}')[0].Trim()
      }
      $off = $p + $len*2; continue
    }
    if ($len -eq 4 -and ($p + 4) -le $lidos) {
      if (-not $m.ContainsKey($T)) { $m[$T] = [BitConverter]::ToInt32($b, $p) }
      $off = $p + 4; continue
    }
    if ($len -eq 8 -and ($p + 8) -le $lidos) {
      if (-not $m.ContainsKey($T)) { $m[$T] = [BitConverter]::ToDouble($b, $p) }
      $off = $p + 8; continue
    }
    if ($len -eq 16 -and ($p + 16) -le $lidos) { $off = $p + 16; continue }
    break
  }
  return $m
}

# Campos numericos que estavam SEMPRE zero nos 40 arquivos conhecidos.
# Um deles deve ser o L1 (arrasamento).
$SUSPEITAS = @("0408","0409","040a","040b","040c","0410","0411",
               "0416","0417","0418","0419","041a","041c","041d")

Write-Host "procurando arquivos..."
$arquivos = @()
foreach ($p in $Pastas) {
  if (-not (Test-Path $p)) { Write-Host "  (nao existe: $p)"; continue }
  # -Include com -LiteralPath e -Recurse filtra errado e perde arquivos
  # (achou 21 de 40 num teste). Filtrar pela extensao depois e confiavel.
  $arquivos += Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue |
               Where-Object { $_.Extension -match '^\.(pte|ptn)$' }
}
if ($Max -gt 0 -and $arquivos.Count -gt $Max) { $arquivos = $arquivos | Select-Object -First $Max }
Write-Host "$($arquivos.Count) arquivos`n"

$estat = @{}     # tag -> lista de valores nao-zero
$exemplos = New-Object System.Collections.ArrayList
$lidos = 0
$relogio = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($f in $arquivos) {
  $m = LerCabecalho $f.FullName
  if (-not $m) { continue }
  $lidos++
  if (($lidos % 2000) -eq 0) { Write-Host "  $lidos lidos..." }

  $achou = @()
  foreach ($t in $SUSPEITAS) {
    if ($m.ContainsKey($t)) {
      $v = $m[$t]
      if ($v -is [double] -or $v -is [int]) {
        if ([double]$v -ne 0.0) {
          $achou += "$t=$v"
          if (-not $estat.ContainsKey($t)) { $estat[$t] = New-Object System.Collections.ArrayList }
          [void]$estat[$t].Add([double]$v)
        }
      }
    }
  }
  if ($achou.Count -gt 0 -and $exemplos.Count -lt 400) {
    [void]$exemplos.Add([pscustomobject]@{
      arquivo   = $f.Name
      pasta     = $f.Directory.Name
      estaca    = $m["0303"]
      tipo      = $m["0304"]
      LE        = $m["0404"]
      area      = $m["0413"]
      campos    = ($achou -join " ")
    })
  }
}
$relogio.Stop()

Write-Host ""
Write-Host "=== RESULTADO ==="
Write-Host "$lidos arquivos lidos em $([math]::Round($relogio.Elapsed.TotalSeconds,1))s"
Write-Host ""

if ($estat.Count -eq 0) {
  Write-Host "Nenhum campo candidato tem valor diferente de zero."
  Write-Host "Ou o arrasamento nunca foi preenchido neste equipamento,"
  Write-Host "ou ele nao e gravado no .PTE."
} else {
  Write-Host "tag  | arquivos | min      | max      | valores distintos"
  foreach ($t in ($estat.Keys | Sort-Object)) {
    $vals = $estat[$t]
    $dist = ($vals | Sort-Object -Unique)
    $amostra = ($dist | Select-Object -First 6) -join ", "
    Write-Host ("{0} | {1,8} | {2,8} | {3,8} | {4}" -f $t, $vals.Count,
      [math]::Round(($vals | Measure-Object -Minimum).Minimum, 3),
      [math]::Round(($vals | Measure-Object -Maximum).Maximum, 3),
      $amostra)
  }
  Write-Host ""
  Write-Host "Arrasamento real costuma ficar entre 0,2 e 2,0 m. A tag cujo"
  Write-Host "intervalo cair nessa faixa e a candidata a L1."
  Write-Host ""
  Write-Host "CONFIRMACAO: abra um dos arquivos abaixo no PIT-W e leia o L1 na"
  Write-Host "tela. Se bater com o valor da tag, esta identificado."
  $exemplos | Select-Object -First 10 | Format-Table -AutoSize
}

if (-not $Saida) { $Saida = Join-Path $raiz "campos-$($env:COMPUTERNAME).csv" }
$exemplos | Export-Csv -LiteralPath $Saida -NoTypeInformation -Encoding UTF8
Write-Host "detalhes em: $Saida"
