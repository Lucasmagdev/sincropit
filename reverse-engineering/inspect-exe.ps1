# Inspeciona um .exe: metadados (fabricante, versao) + strings internas
# (nomes de DLL, bibliotecas, banners de compilador) — sem instalar nada,
# so PowerShell nativo. Ajuda a identificar linguagem/driver usado.
#
# Pensado pra nunca fechar sozinho, mesmo com erro — sempre mostra o que
# aconteceu e espera Enter antes de sair.

param(
    [string]$Path = "",
  [string]$LogFile = ""
)

function PausaESai($code) {
  Write-Host ""
  Write-Host "Aperte Enter pra fechar esta janela..." -ForegroundColor Cyan
  Read-Host | Out-Null
  exit $code
}

try {
  Write-Host "=== Inspetor de .exe (PIT-Q) ===" -ForegroundColor Cyan
  Write-Host ""

  # se nao passou -Path, tenta achar automaticamente nos locais mais comuns,
  # e se nao achar, pergunta na tela (sem travar/fechar sozinho)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    $candidatos = @(
      "C:\Program Files (x86)\PDI\PIT-Q\PIT-Q.exe",
      "C:\Program Files\PDI\PIT-Q\PIT-Q.exe",
      "C:\Program Files (x86)\PDI\PIT-Q\PIT-Q_Entry.exe",
      "C:\PDI\PIT-Q\PIT-Q.exe",
      "C:\PIT-Q\PIT-Q.exe"
    )
    $achado = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($achado) {
      $Path = $achado
      Write-Host "Achei automaticamente: $Path" -ForegroundColor Green
    } else {
      Write-Host "Nao achei o PIT-Q.exe nos locais padrao." -ForegroundColor Yellow
      Write-Host "Digite o caminho completo do arquivo .exe (ou arrasta o arquivo pra essa janela) e aperta Enter:"
      $Path = Read-Host "Caminho"
    }
  }

  $Path = $Path.Trim('"').Trim()

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Host "Arquivo nao encontrado (ou nao e um arquivo): '$Path'" -ForegroundColor Red
    PausaESai 1
  }

  if ([string]::IsNullOrWhiteSpace($LogFile)) {
    $nomeBase = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    $LogFile = Join-Path $PSScriptRoot "inspect-result-$nomeBase.txt"
  }

  $out = New-Object System.Collections.Generic.List[string]
  $out.Add("=== $Path ===")
  $out.Add("Data da analise: $(Get-Date -Format o)")
  $out.Add("")

  Write-Host "Lendo metadados..."
  $out.Add("--- Metadados (Propriedades > Detalhes) ---")
  try {
    $vi = (Get-Item -LiteralPath $Path).VersionInfo
    $out.Add("CompanyName:      $($vi.CompanyName)")
    $out.Add("ProductName:      $($vi.ProductName)")
    $out.Add("FileDescription:  $($vi.FileDescription)")
    $out.Add("FileVersion:      $($vi.FileVersion)")
    $out.Add("ProductVersion:   $($vi.ProductVersion)")
    $out.Add("Language:         $($vi.Language)")
    $out.Add("OriginalFilename: $($vi.OriginalFilename)")
    $out.Add("LegalCopyright:   $($vi.LegalCopyright)")
  } catch {
    $out.Add("(nao consegui ler metadados: $($_.Exception.Message))")
  }
  $out.Add("")

  Write-Host "Lendo o arquivo e procurando strings (pode levar alguns segundos)..."
  $out.Add("--- Strings suspeitas (DLLs, bibliotecas, banners de compilador) ---")
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    $allStrings = [regex]::Matches($text, "[\x20-\x7E]{5,}") | ForEach-Object { $_.Value }

    $keywords = @(
      "VB6", "VBA6", "MSVBVM", "Borland", "Delphi", "BORLND", "cc32",
      "LabVIEW", "labview", "lvrt", "National Instruments", "nidaqmx", "NIDAQ",
      "Python", "python3", "Qt5", "Qt6", "QtCore", "MFC",
      "FTDI", "FTD2XX", "ftser2k", "D2XX", "VCP",
      "\.NET", "mscorlib", "clr\.dll", "Microsoft Visual C", "GCC", "MinGW"
    )
    $matched = $allStrings | Sort-Object -Unique | Where-Object {
      $s = $_
      ($keywords | Where-Object { $s -match $_ } | Select-Object -First 1) -ne $null
    }
    if ($matched) { $matched | ForEach-Object { $out.Add($_) } }
    else { $out.Add("(nenhuma string bateu com os padroes conhecidos)") }

    $out.Add("")
    $out.Add("--- Todas as *.dll mencionadas no arquivo ---")
    $dlls = $allStrings | Where-Object { $_ -match "\.dll$" } | Sort-Object -Unique
    if ($dlls) { $dlls | ForEach-Object { $out.Add($_) } }
    else { $out.Add("(nenhuma)") }
  } catch {
    $out.Add("(erro lendo strings: $($_.Exception.Message))")
  }

  $out | Out-File -FilePath $LogFile -Encoding utf8
  Write-Host ""
  $out | ForEach-Object { Write-Host $_ }
  Write-Host ""
  Write-Host "Resultado salvo em: $LogFile" -ForegroundColor Green

  PausaESai 0

} catch {
  Write-Host ""
  Write-Host "ERRO INESPERADO: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  PausaESai 1
}
