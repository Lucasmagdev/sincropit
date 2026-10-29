<#
  Sonda de ambiente - Fpit Sync.

  Roda igual em qualquer Windows (7 ate 11, PowerShell 2.0 ate 7.x). Testa
  aqui, usa no PIT-Q sem mudar nada. Somente leitura: nao instala, nao
  altera nada fora do proprio arquivo de saida.

    powershell -ExecutionPolicy Bypass -File sondar-ambiente.ps1
    powershell -ExecutionPolicy Bypass -File sondar-ambiente.ps1 -Completo
    powershell -ExecutionPolicy Bypass -File sondar-ambiente.ps1 -Segundos 120

  Gera sonda-<HOSTNAME>.txt (e .json) ao lado do script.
#>
param(
  [int]$Segundos = 45,   # orcamento da busca por ensaios
  [switch]$Completo,     # varre discos inteiros, sem limite de tempo
  [string]$Saida         # caminho do relatorio (padrao: ao lado do script)
)

$ErrorActionPreference = "SilentlyContinue"

# --- portabilidade ----------------------------------------------------------
# $PSScriptRoot nao existe em PowerShell 2.0.
$raizScript = $PSScriptRoot
if (-not $raizScript) { $raizScript = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $raizScript) { $raizScript = (Get-Location).Path }

# Get-CimInstance nao existe antes do PS 3.0 / Windows 8.
$temCim = $null -ne (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)
function Wmi($classe, $filtro) {
  if ($temCim) {
    if ($filtro) { Get-CimInstance -ClassName $classe -Filter $filtro } else { Get-CimInstance -ClassName $classe }
  } else {
    if ($filtro) { Get-WmiObject -Class $classe -Filter $filtro } else { Get-WmiObject -Class $classe }
  }
}
function Reg($chave, $nome) {
  $p = Get-ItemProperty -Path $chave -ErrorAction SilentlyContinue
  if ($p) { $p.$nome } else { $null }
}

$L = New-Object System.Collections.ArrayList
function Add($t) { [void]$L.Add($t) }

# Nome de variavel em PowerShell e case-INSENSITIVE: $dados e $DADOS sao a
# mesma coisa. Esta tabela ja se chamou $D e o laco de discos ($d) apagava
# ela inteira em silencio, zerando todo o veredito. Nomes curtos aqui, nao.
$dados = @{}   # dados estruturados, pro JSON

# --- 1. sistema operacional -------------------------------------------------
$os = Wmi Win32_OperatingSystem
$cv = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$build = 0
[void][int]::TryParse("$($os.BuildNumber)", [ref]$build)

$dados.host         = $env:COMPUTERNAME
$dados.so_nome      = "$($os.Caption)".Trim()
$dados.so_versao    = "$($os.Version)"
$dados.so_build     = $build
$dados.so_arq       = "$($os.OSArchitecture)"
$dados.so_display   = "$(Reg $cv 'DisplayVersion')"
$dados.so_release   = "$(Reg $cv 'ReleaseId')"
$dados.so_edicao    = "$(Reg $cv 'EditionID')"
$dados.ram_mb       = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)
$dados.ram_livre_mb = [math]::Round($os.FreePhysicalMemory / 1KB, 0)

Add "=== SONDA FPIT SYNC ==="
Add "coletado_em: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')"
Add "maquina:     $($dados.host)"
Add ""
Add "[SO]"
Add "nome:            $($dados.so_nome)"
Add "versao:          $($dados.so_versao)  build $build"
Add "display_version: $($dados.so_display)  release_id: $($dados.so_release)"
Add "edicao:          $($dados.so_edicao)"
Add "arquitetura_so:  $($dados.so_arq)"
Add "ram_total_mb:    $($dados.ram_mb)   livre_mb: $($dados.ram_livre_mb)"
Add "powershell:      $($PSVersionTable.PSVersion)"

# --- 2. arquitetura ---------------------------------------------------------
$cpu = @(Wmi Win32_Processor)[0]
# 'Program Files (x86)' so existe em Windows 64-bit. Sinal mais confiavel que
# PROCESSOR_ARCHITECTURE, que reporta x86 quando o proprio PowerShell e 32-bit.
$w64 = Test-Path "$env:SystemDrive\Program Files (x86)"
$dados.so_64bit    = [bool]$w64
$dados.cpu         = "$($cpu.Name)".Trim()
$dados.cpu_nucleos = $cpu.NumberOfLogicalProcessors
$dados.cpu_mhz     = $cpu.MaxClockSpeed
$dados.ps_64bit    = [System.IntPtr]::Size -eq 8

Add ""
Add "[CPU / ARQUITETURA]"
Add "cpu:              $($dados.cpu)"
Add "logicos:          $($dados.cpu_nucleos)   clock_max_mhz: $($dados.cpu_mhz)"
Add "windows_64bit:    $w64   (existencia de 'Program Files (x86)')"
Add "powershell_64bit: $($dados.ps_64bit)"
Add "PROCESSOR_ARCHITECTURE: $env:PROCESSOR_ARCHITECTURE   ARCHITEW6432: $env:PROCESSOR_ARCHITEW6432"

# --- 3. disco ---------------------------------------------------------------
Add ""
Add "[DISCO]"
$discos = @()
foreach ($disco in (Wmi Win32_LogicalDisk "DriveType=3")) {
  Add "$($disco.DeviceID) total_gb=$([math]::Round($disco.Size/1GB,1)) livre_gb=$([math]::Round($disco.FreeSpace/1GB,1)) fs=$($disco.FileSystem)"
  $discos += "$($disco.DeviceID)\"
}
$dados.discos = $discos -join ","

# --- 4. runtimes ------------------------------------------------------------
Add ""
Add "[RUNTIMES]"
function Versao($exe, $arg) {
  $c = Get-Command $exe -ErrorAction SilentlyContinue
  if (-not $c) { return "AUSENTE" }
  $v = (& $exe $arg 2>&1 | Out-String).Trim()
  return "$v  [$($c.Source)]"
}
$dados.node           = Versao node "-v"
$dados.python         = Versao python "--version"
$dados.dotnet_release = "$(Reg 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release')"
Add "node:   $($dados.node)"
Add "python: $($dados.python)"
Add ".NET Framework release: $($dados.dotnet_release)"

# --- 5. instalacao do PIT-Q -------------------------------------------------
Add ""
Add "[PIT-Q]"
$achouPit = @()
$candidatos = @(
  "$env:ProgramFiles\PDI", "${env:ProgramFiles(x86)}\PDI",
  "$env:ProgramFiles\PIT-Q", "${env:ProgramFiles(x86)}\PIT-Q",
  "C:\PDI", "C:\PIT-Q", "C:\PIT"
)
foreach ($c in $candidatos) {
  if ($c -and (Test-Path $c)) { Add "instalacao: $c"; $achouPit += $c }
}
if ($achouPit.Count -eq 0) { Add "instalacao: nao encontrada nos caminhos conhecidos" }
$dados.pitq = $achouPit -join ","

# --- 6. onde estao os ensaios ----------------------------------------------
# Caminhador manual com orcamento de tempo. Get-ChildItem -Recurse nao da pra
# interromper no meio; num disco grande isso viraria minutos de espera.
Add ""
Add "[ENSAIOS .PTE / .PTN / .PT2]"
$relogio = [System.Diagnostics.Stopwatch]::StartNew()
$limiteMs = if ($Completo) { [int]::MaxValue } else { $Segundos * 1000 }
$exts = @(".pte", ".ptn", ".pt2")
$achados = New-Object System.Collections.ArrayList
$estourou = $false

# Prioriza os lugares provaveis; os discos inteiros ficam no fim da fila.
$sementes = @(
  "$env:USERPROFILE\Documents", "$env:PUBLIC\Documents", "$env:USERPROFILE\Desktop",
  "$env:USERPROFILE\Downloads", "C:\PDI", "C:\PIT-Q", "C:\PIT"
) + $achouPit + $discos

$fila = New-Object System.Collections.Queue
$vistos = @{}
foreach ($s in $sementes) {
  if ($s -and (Test-Path $s)) { $fila.Enqueue((Resolve-Path $s).Path) }
}

$ignorar = @("\windows", "\`$recycle.bin", "\system volume information", "\node_modules", "\winsxs", "\appdata\local\temp")
while ($fila.Count -gt 0) {
  if ($relogio.ElapsedMilliseconds -gt $limiteMs) { $estourou = $true; break }
  $dir = $fila.Dequeue()
  $chave = "$dir".ToLower()
  if ($vistos.ContainsKey($chave)) { continue }
  $vistos[$chave] = $true

  $pular = $false
  foreach ($ig in $ignorar) { if ($chave -like "*$ig*") { $pular = $true; break } }
  if ($pular) { continue }

  foreach ($e in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
    if ($e.PSIsContainer) { $fila.Enqueue($e.FullName) }
    elseif ($exts -contains "$($e.Extension)".ToLower()) { [void]$achados.Add($e) }
  }
}
$relogio.Stop()

$dados.ensaios_total     = $achados.Count
$dados.busca_ms          = $relogio.ElapsedMilliseconds
$dados.busca_incompleta  = $estourou
$aviso = ""
if ($estourou) { $aviso = "   *** BUSCA INTERROMPIDA pelo limite de tempo; rode com -Completo ***" }
Add "encontrados: $($achados.Count)   tempo: $([math]::Round($relogio.ElapsedMilliseconds/1000,1))s   pastas visitadas: $($vistos.Count)$aviso"

if ($achados.Count -gt 0) {
  Add ""
  Add "-- pastas com mais ensaios (candidatas a pasta observada) --"
  $porPasta = $achados | Group-Object { Split-Path $_.FullName -Parent } | Sort-Object Count -Descending
  foreach ($g in ($porPasta | Select-Object -First 10)) {
    Add "$("$($g.Count)".PadLeft(5))  $($g.Name)"
  }
  $dados.pasta_provavel = @($porPasta)[0].Name

  Add ""
  Add "-- 20 mais recentes --"
  foreach ($f in ($achados | Sort-Object LastWriteTime -Descending | Select-Object -First 20)) {
    Add "$($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))  $("$($f.Length)".PadLeft(9))  $($f.FullName)"
  }
}

# --- 7. politica e permissao ------------------------------------------------
Add ""
Add "[POLITICA]"
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$dados.admin   = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$dados.usuario = $env:USERNAME
Add "usuario: $env:USERNAME   admin: $($dados.admin)"
Add "APPDATA: $env:APPDATA"
Add "execution_policy: $(Get-ExecutionPolicy)"

# --- 8. rede ----------------------------------------------------------------
Add ""
Add "[REDE]"
if (Get-Command Get-NetAdapter -ErrorAction SilentlyContinue) {
  foreach ($a in (Get-NetAdapter | Where-Object { $_.Status -eq "Up" })) {
    Add "$($a.Name) [$($a.InterfaceDescription)] $($a.LinkSpeed)"
  }
} else {
  foreach ($a in (Wmi Win32_NetworkAdapter "NetEnabled=True")) { Add "$($a.Name)" }
}
# ICMP costuma ser bloqueado por firewall corporativo — sozinho gera falso
# negativo. Se o ping falhar, tenta TCP 443, que e o que o upload vai usar.
$pingOk = [bool](Test-Connection -ComputerName 8.8.8.8 -Count 1 -Quiet -ErrorAction SilentlyContinue)
$tcpOk = $false
try {
  $cli = New-Object System.Net.Sockets.TcpClient
  $req = $cli.BeginConnect("1.1.1.1", 443, $null, $null)
  $tcpOk = $req.AsyncWaitHandle.WaitOne(3000, $false) -and $cli.Connected
  $cli.Close()
} catch { $tcpOk = $false }
$dados.internet = $pingOk -or $tcpOk
Add "icmp(8.8.8.8): $(if ($pingOk) { 'SIM' } else { 'NAO' })   tcp443(1.1.1.1): $(if ($tcpOk) { 'SIM' } else { 'NAO' })"
Add "internet: $(if ($dados.internet) { 'SIM' } else { 'NAO' })"

# --- 9. VEREDITO ------------------------------------------------------------
# Regras avaliadas aqui pra nao depender de interpretacao depois:
#   Node 24: exige Windows 10 build >= 17763, x64 ou arm64. 32-bit foi REMOVIDO.
#   node:sqlite embutido: sem flag a partir do Node 23.4; com flag no 22.5+.
Add ""
Add "=== VEREDITO ==="
if (-not $w64) {
  Add "BLOQUEIO: Windows 32-bit. Node 24 nao tem build x86. Caminho: Node 22 x86 (node:sqlite so com --experimental-sqlite) ou trocar a fila SQLite por arquivo append-only."
} elseif ($build -lt 17763) {
  Add "BLOQUEIO: build $build < 17763 (Win10 1809). Node 24 nao roda. Caminho: Node 20 (Win8.1+, sem node:sqlite) ou reescrever em Go."
} else {
  Add "OK: Windows 64-bit, build $build. Node 24 + node:sqlite servem. Manter a stack atual."
}
if ($dados.ram_mb -lt 2048) {
  Add "ATENCAO: RAM $($dados.ram_mb) MB. Node em repouso usa ~54 MB; reavaliar se apertar."
}
if ($dados.ensaios_total -eq 0) {
  Add "ATENCAO: nenhum .PTE/.PTN/.PT2 encontrado. Sem isso a pasta observada continua sendo chute - rode com -Completo."
} else {
  Add "PASTA OBSERVADA candidata: $($dados.pasta_provavel)   ($($dados.ensaios_total) ensaios no total)"
}
if (-not $dados.internet) {
  Add "ATENCAO: sem internet nesta maquina. Fila offline vira o caminho normal, nao a excecao."
}

# --- gravar -----------------------------------------------------------------
if (-not $Saida) { $Saida = Join-Path $raizScript "sonda-$($env:COMPUTERNAME).txt" }
$L | Set-Content -LiteralPath $Saida -Encoding UTF8

# ConvertTo-Json so existe a partir do PS 3.0; sem ele o .txt basta.
if (Get-Command ConvertTo-Json -ErrorAction SilentlyContinue) {
  $jsonPath = [System.IO.Path]::ChangeExtension($Saida, ".json")
  ($dados | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $jsonPath -Encoding UTF8
}

$L | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "relatorio salvo em: $Saida"
