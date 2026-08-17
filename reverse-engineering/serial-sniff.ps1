# Escuta portas seriais e mostra os bytes recebidos (hex + ascii) com timestamp.
# Por padrao tenta COM3, COM4 e COM11 (as que apareceram no Gerenciador de
# Dispositivos) ao mesmo tempo, sem precisar digitar nada.
#
# Uso (duplo-clique em rodar-sniff.bat, ou manual):
#   powershell -ExecutionPolicy Bypass -File serial-sniff.ps1
#   powershell -ExecutionPolicy Bypass -File serial-sniff.ps1 -Port COM3
#
# Fecha o PIT-W oficial antes (a porta precisa estar livre), roda isso,
# bate o martelo na estaca, ve se aparece alguma linha na tela.

param(
  [string]$Port = "",
  [int]$Baud = 115200
)

function PausaESai($code) {
  Write-Host ""
  Write-Host "Aperte Enter pra fechar esta janela..." -ForegroundColor Cyan
  Read-Host | Out-Null
  exit $code
}

Write-Host "=== Escuta de porta serial (PIT) ===" -ForegroundColor Cyan
Write-Host ""

$candidatos = if ($Port) { @($Port) } else { @("COM3", "COM4", "COM11") }
$abertas = New-Object System.Collections.Generic.List[object]

foreach ($p in $candidatos) {
  try {
    $sp = New-Object System.IO.Ports.SerialPort $p, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
    $sp.ReadTimeout = 100
    $sp.Open()
    $abertas.Add(@{ Port = $p; Handle = $sp })
    Write-Host "[$p] aberta com sucesso." -ForegroundColor Green
  } catch {
    Write-Host "[$p] nao abriu: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if ($abertas.Count -eq 0) {
  Write-Host ""
  Write-Host "Nenhuma porta abriu. Possveis causas:" -ForegroundColor Red
  Write-Host "- O PIT-W oficial ainda ta aberto e ocupando a porta (fecha ele)."
  Write-Host "- O nome da porta e outro (confere no Gerenciador de Dispositivos)."
  PausaESai 1
}

Write-Host ""
Write-Host "Escutando $($abertas.Count) porta(s). Bate o martelo na estaca agora." -ForegroundColor Cyan
Write-Host "Ctrl+C pra parar quando terminar."
Write-Host ""

$logFile = Join-Path $PSScriptRoot "serial-sniff-log.txt"
"--- sessao iniciada $(Get-Date -Format o) ---" | Out-File -Append $logFile -Encoding utf8

$semDados = 0
while ($true) {
  $achouAlgo = $false
  foreach ($item in $abertas) {
    $sp = $item.Handle
    try {
      $n = $sp.BytesToRead
      if ($n -gt 0) {
        $buffer = New-Object byte[] $n
        $sp.Read($buffer, 0, $n) | Out-Null
        $hex = ($buffer | ForEach-Object { $_.ToString("x2") }) -join " "
        $ascii = -join ($buffer | ForEach-Object { if ($_ -ge 32 -and $_ -le 126) { [char]$_ } else { "." } })
        $line = "$(Get-Date -Format 'HH:mm:ss.fff')  [$($item.Port)]  [$n bytes]  $hex   |  $ascii"
        Write-Host $line -ForegroundColor White
        $line | Out-File -Append $logFile -Encoding utf8
        $achouAlgo = $true
      }
    } catch {
      # porta pode ter caido; ignora nesse loop
    }
  }
  if (-not $achouAlgo) {
    $semDados++
    if ($semDados % 100 -eq 0) { Write-Host "." -NoNewline }
  } else {
    $semDados = 0
  }
  Start-Sleep -Milliseconds 50
}
