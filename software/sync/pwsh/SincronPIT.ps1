<#
==============================================================================
  SincronPIT — envia os ensaios do PIT-Q para a nuvem.

  Arquivo unico de proposito. O PIT-Q roda Windows 10 LTSB 1607 com usuario
  SEM privilegio de administrador: nada pode ser instalado. Isto usa apenas o
  que ja existe na maquina (PowerShell 5.1 + .NET Framework 4.7.2).

  REGRA ABSOLUTA: o ensaio original nunca e alterado, movido nem apagado.
  Tudo aqui abre arquivo somente para leitura.

    powershell -ExecutionPolicy Bypass -File SincronPIT.ps1
    powershell -ExecutionPolicy Bypass -File SincronPIT.ps1 -Teste
==============================================================================
#>
param(
  [switch]$Teste,          # roda autoteste sem abrir janela
  [string]$PastaConfig     # sobrepoe %APPDATA%\FpitSync (usado pelo autoteste)
)

$ErrorActionPreference = "Stop"

# --- TLS 1.2 ----------------------------------------------------------------
# Windows 10 1607 negocia TLS 1.0 por padrao no .NET Framework. O Supabase
# recusa TLS 1.0, e o erro que aparece e um generico "conexao encerrada" que
# nao aponta para lugar nenhum. Forcar aqui evita horas de depuracao no campo.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }

# ============================================================================
# Configuracao
# ============================================================================
function Get-PastaDados {
  if ($script:PastaConfigEfetiva) { return $script:PastaConfigEfetiva }
  return (Join-Path $env:APPDATA "FpitSync")
}

$script:PastaConfigEfetiva = $PastaConfig

function Get-CaminhoConfig  { Join-Path (Get-PastaDados) "config.json" }
function Get-CaminhoEnviados { Join-Path (Get-PastaDados) "enviados.txt" }

function New-ConfigPadrao {
  [pscustomobject]@{
    # As duas pastas que a sonda encontrou no PIT-Q real. Ele grava o mesmo
    # ensaio nas duas ao mesmo tempo; a deduplicacao por conteudo resolve.
    pastas       = @(
      (Join-Path $env:APPDATA "PDI\PIT"),
      (Join-Path $env:PUBLIC  "Documents\PDI\PIT")
    )
    urlIngerir   = ""
    token        = ""
    machineId    = "pit-" + [guid]::NewGuid().ToString()
    extensoes    = @(".pte", ".ptn", ".pt2")
    pastaExport  = ""
  }
}

function Read-Config {
  $arq = Get-CaminhoConfig
  if (Test-Path $arq) {
    try {
      $c = Get-Content $arq -Raw -Encoding UTF8 | ConvertFrom-Json
      # Config antiga ou incompleta nao pode derrubar o app: completa o que falta.
      $p = New-ConfigPadrao
      foreach ($campo in $p.PSObject.Properties.Name) {
        if ($null -eq $c.$campo -or "$($c.$campo)" -eq "") {
          $c | Add-Member -NotePropertyName $campo -NotePropertyValue $p.$campo -Force
        }
      }
      return $c
    } catch {
      # config corrompida: recomeca do padrao em vez de travar
      return New-ConfigPadrao
    }
  }
  return New-ConfigPadrao
}

function Write-Config($cfg) {
  $dir = Get-PastaDados
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # grava em temporario e renomeia: falta de energia no meio nao deixa a
  # config pela metade
  $tmp = (Get-CaminhoConfig) + ".tmp"
  ($cfg | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination (Get-CaminhoConfig) -Force
}

# ============================================================================
# Registro do que ja subiu — por CONTEUDO, nunca por nome
#
# O PIT-Q grava o mesmo ensaio em duas pastas, e o operador copia arquivo
# entre obras. Nome nao identifica nada; o sha256 identifica.
# ============================================================================
function Read-Enviados {
  $tabela = @{}
  $arq = Get-CaminhoEnviados
  if (Test-Path $arq) {
    foreach ($linha in [System.IO.File]::ReadAllLines($arq)) {
      $h = $linha.Trim()
      if ($h.Length -eq 64) { $tabela[$h] = $true }
    }
  }
  return $tabela
}

function Add-Enviado($sha) {
  $dir = Get-PastaDados
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # Append imediato, um hash por linha. Se o app for fechado no meio da
  # sincronizacao, o que ja subiu continua registrado — nada sobe duas vezes
  # na proxima abertura.
  [System.IO.File]::AppendAllText((Get-CaminhoEnviados), "$sha`r`n")
}

function Get-Sha256Arquivo($caminho) {
  # Streaming: nao carrega o arquivo inteiro na memoria. Numa maquina de
  # 1,9 GB isso importa quando a pasta tem 31 mil ensaios.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($caminho, [System.IO.FileMode]::Open,
                                 [System.IO.FileAccess]::Read,
                                 [System.IO.FileShare]::ReadWrite)
    $bytes = $sha.ComputeHash($fs)
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
  } finally {
    if ($fs) { $fs.Dispose() }
    $sha.Dispose()
  }
}

# ============================================================================
# Varredura
# ============================================================================
function Get-Ensaios($cfg) {
  $lista = New-Object System.Collections.ArrayList
  $vistosRelativos = @{}

  foreach ($raiz in $cfg.pastas) {
    if (-not $raiz -or -not (Test-Path $raiz)) { continue }
    $prefixo = (Resolve-Path -LiteralPath $raiz).Path.TrimEnd('\')

    foreach ($f in (Get-ChildItem -LiteralPath $raiz -Recurse -File -ErrorAction SilentlyContinue)) {
      if ($cfg.extensoes -notcontains $f.Extension.ToLower()) { continue }

      # O PIT-Q grava o MESMO ensaio nas duas pastas configuradas. Contar os
      # dois faria a tela dizer 546 onde ha 273 — numero que o operador usaria
      # para decidir o que subir. Colapsa pelo caminho RELATIVO a cada raiz
      # (ex: "OBRA X\E01.PTE"), que e identico entre os espelhos e diferente
      # entre ensaios de verdade. Nao usa nome solto: duas obras podem ter
      # E01.PTE, e sao arquivos diferentes.
      $relativo = $f.FullName.Substring($prefixo.Length).TrimStart('\').ToLower()
      if ($vistosRelativos.ContainsKey($relativo)) { continue }
      $vistosRelativos[$relativo] = $true
      [void]$lista.Add($f)
    }
  }
  return $lista
}

function Group-PorObra($ensaios, $cfg) {
  # "Obra" = pasta imediata do ensaio. E como o operador pensa o trabalho,
  # e e a unidade que ele vai querer marcar ou desmarcar na tela.
  $grupos = @{}
  foreach ($f in $ensaios) {
    $obra = Split-Path (Split-Path $f.FullName -Parent) -Leaf
    if (-not $grupos.ContainsKey($obra)) {
      $grupos[$obra] = [pscustomobject]@{ Obra = $obra; Arquivos = (New-Object System.Collections.ArrayList); Bytes = [long]0 }
    }
    [void]$grupos[$obra].Arquivos.Add($f)
    $grupos[$obra].Bytes += $f.Length
  }
  return $grupos.Values | Sort-Object { $_.Arquivos.Count } -Descending
}

# ============================================================================
# Envio
# ============================================================================
function Test-Internet {
  try {
    $cli = New-Object System.Net.Sockets.TcpClient
    $req = $cli.BeginConnect("1.1.1.1", 443, $null, $null)
    $ok = $req.AsyncWaitHandle.WaitOne(3000, $false) -and $cli.Connected
    $cli.Close()
    return $ok
  } catch { return $false }
}

<#
  Resultado do envio de um ensaio.

  A distincao entre "reenviar depois" e "nunca reenviar" e o ponto mais
  importante daqui. Um arquivo recusado por extensao invalida, se voltasse
  para a fila, seria retentado para sempre — em obra, isso vira um app
  travado que nao explica nada.

  Estado devolvido:
    Enviado    -> gravou agora
    Duplicado  -> ja existia na nuvem; conta como enviado
    Permanente -> recusado de vez (401/413/415). Nao reenviar
    Temporario -> falha de rede ou servidor. Reenviar depois
#>
function Send-Ensaio($cfg, $caminho, $sha, $bytes) {
  $nome = Split-Path $caminho -Leaf
  $pastaOrigem = Split-Path (Split-Path $caminho -Parent) -Leaf
  $criadoEm = ""
  try { $criadoEm = (Get-Item -LiteralPath $caminho).LastWriteTimeUtc.ToString("o") } catch { }

  $cabecalhos = @{
    "Authorization"   = "Bearer $($cfg.token)"
    "X-Machine-Id"    = $cfg.machineId
    "X-Nome-Original" = $nome
    "X-Sha256"        = $sha
    "X-Pasta-Origem"  = $pastaOrigem
    "X-Criado-Em"     = $criadoEm
    "X-Detectado-Em"  = (Get-Date).ToUniversalTime().ToString("o")
  }

  try {
    $r = Invoke-RestMethod -Uri $cfg.urlIngerir -Method Post -Body $bytes `
                           -Headers $cabecalhos -ContentType "application/octet-stream" `
                           -TimeoutSec 120
    if ($r.duplicado) { return @{ Estado = "Duplicado"; Detalhe = "ja existia na nuvem" } }
    return @{ Estado = "Enviado"; Detalhe = "" }
  } catch {
    $resp = $_.Exception.Response
    $codigo = 0
    if ($resp) { try { $codigo = [int]$resp.StatusCode } catch { } }

    switch ($codigo) {
      401 { return @{ Estado = "Permanente"; Detalhe = "token invalido ou revogado" } }
      413 { return @{ Estado = "Permanente"; Detalhe = "arquivo grande demais" } }
      415 { return @{ Estado = "Permanente"; Detalhe = "extensao nao aceita pelo servidor" } }
      429 { return @{ Estado = "Temporario"; Detalhe = "limite por hora atingido" } }
      default {
        return @{ Estado = "Temporario"; Detalhe = "$(if ($codigo) { "HTTP $codigo" } else { $_.Exception.Message })" }
      }
    }
  }
}

function Export-Ensaio($cfg, $caminho, $sha) {
  # Saida alternativa: sem internet, copia para pendrive mantendo a obra.
  # Hoje o PIT-Q nao tem rede, entao este e o unico caminho que funciona.
  $obra = Split-Path (Split-Path $caminho -Parent) -Leaf
  $destino = Join-Path (Join-Path $cfg.pastaExport $cfg.machineId) $obra
  if (-not (Test-Path $destino)) { New-Item -ItemType Directory -Path $destino -Force | Out-Null }

  $nome = Split-Path $caminho -Leaf
  $ext  = [System.IO.Path]::GetExtension($nome)
  $base = [System.IO.Path]::GetFileNameWithoutExtension($nome)
  # sha no nome: dois ensaios de nome igual e conteudo diferente nao se
  # sobrescrevem no pendrive
  $alvo = Join-Path $destino "$base.$($sha.Substring(0,12))$ext"

  # copia para temporario e renomeia: pendrive arrancado no meio nao deixa
  # arquivo parcial parecendo integro
  $tmp = "$alvo.parcial"
  Copy-Item -LiteralPath $caminho -Destination $tmp -Force
  Move-Item -LiteralPath $tmp -Destination $alvo -Force
  return $alvo
}

# ============================================================================
# Nucleo: processa uma lista de arquivos
# ============================================================================
function Invoke-Sincronizacao {
  param(
    $cfg,
    $arquivos,
    [string]$Modo,            # "enviar" ou "exportar"
    [scriptblock]$AoProgredir # recebe (indice, total, texto)
  )

  $enviados = Read-Enviados
  $res = [pscustomobject]@{
    Total = $arquivos.Count; Novos = 0; Duplicados = 0
    Falhas = 0; Permanentes = 0; Erros = (New-Object System.Collections.ArrayList)
  }

  $i = 0
  foreach ($f in $arquivos) {
    $i++
    $nome = Split-Path $f.FullName -Leaf
    if ($AoProgredir) { & $AoProgredir $i $arquivos.Count $nome }

    try {
      $sha = Get-Sha256Arquivo $f.FullName
    } catch {
      $res.Falhas++
      [void]$res.Erros.Add("$nome : nao consegui ler ($($_.Exception.Message))")
      continue
    }

    # Dedup local. Pega tanto o reenvio quanto o espelho da outra pasta.
    if ($enviados.ContainsKey($sha)) { $res.Duplicados++; continue }

    if ($Modo -eq "exportar") {
      try {
        Export-Ensaio $cfg $f.FullName $sha | Out-Null
        Add-Enviado $sha; $enviados[$sha] = $true; $res.Novos++
      } catch {
        $res.Falhas++
        [void]$res.Erros.Add("$nome : falha ao copiar ($($_.Exception.Message))")
      }
      continue
    }

    try {
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    } catch {
      $res.Falhas++
      [void]$res.Erros.Add("$nome : nao consegui ler")
      continue
    }

    $r = Send-Ensaio $cfg $f.FullName $sha $bytes
    switch ($r.Estado) {
      "Enviado"   { Add-Enviado $sha; $enviados[$sha] = $true; $res.Novos++ }
      "Duplicado" { Add-Enviado $sha; $enviados[$sha] = $true; $res.Duplicados++ }
      "Permanente" {
        $res.Permanentes++
        [void]$res.Erros.Add("$nome : $($r.Detalhe) [nao sera tentado de novo]")
      }
      default {
        $res.Falhas++
        [void]$res.Erros.Add("$nome : $($r.Detalhe)")
      }
    }
  }
  return $res
}

# ============================================================================
# Autoteste — roda sem janela e sem rede
# ============================================================================
function Invoke-Autoteste {
  $falhas = 0
  function Verificar($nome, $condicao, $detalhe) {
    if ($condicao) { Write-Host "  ok    $nome" }
    else { Write-Host "  FALHA $nome  -> $detalhe" -ForegroundColor Red; $script:falhasTeste++ }
  }
  $script:falhasTeste = 0

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sincronpit-teste-" + [guid]::NewGuid().ToString("N").Substring(0,8))
  $origem = Join-Path $tmp "origem\OBRA X"
  $espelho = Join-Path $tmp "espelho\OBRA X"
  $export = Join-Path $tmp "export"
  New-Item -ItemType Directory -Path $origem, $espelho, $export, (Join-Path $tmp "cfg") -Force | Out-Null

  $script:PastaConfigEfetiva = Join-Path $tmp "cfg"

  # dois ensaios distintos + um espelho identico (o caso real do PIT-Q)
  [System.IO.File]::WriteAllBytes((Join-Path $origem "E01.PTE"), [byte[]](1..200))
  [System.IO.File]::WriteAllBytes((Join-Path $origem "E02.PTE"), [byte[]](50..250))
  Copy-Item (Join-Path $origem "E01.PTE") (Join-Path $espelho "E01.PTE")
  # mesmo conteudo, nome diferente: escapa do colapso por caminho e tem que
  # ser pego pelo sha256 na hora do envio
  Copy-Item (Join-Path $origem "E02.PTE") (Join-Path $espelho "OUTRO-NOME.PTE")
  # extensao fora da lista: nao pode entrar
  [System.IO.File]::WriteAllText((Join-Path $origem "leiame.txt"), "ignorar")

  # obra diferente com nome de arquivo IGUAL: nao pode ser colapsada, sao
  # ensaios distintos de estacas distintas
  $outraObra = Join-Path $tmp "origem\OBRA Y"
  New-Item -ItemType Directory -Path $outraObra -Force | Out-Null
  [System.IO.File]::WriteAllBytes((Join-Path $outraObra "E01.PTE"), [byte[]](90..255))

  $cfg = New-ConfigPadrao
  $cfg.pastas = @((Join-Path $tmp "origem"), (Join-Path $tmp "espelho"))
  $cfg.pastaExport = $export

  Write-Host "`nautoteste SincronPIT"
  Write-Host "  pasta temporaria: $tmp`n"

  $ensaios = Get-Ensaios $cfg
  # origem: OBRA X\E01, OBRA X\E02, OBRA Y\E01 | espelho: OBRA X\E01 (colapsa),
  # OBRA X\OUTRO-NOME (fica). .txt fora. Total: 4.
  Verificar "espelho colapsado, .txt ignorado (4 de 6)" ($ensaios.Count -eq 4) "achou $($ensaios.Count)"
  Verificar "obra diferente com mesmo nome nao colapsa" (@($ensaios | Where-Object { $_.Name -eq "E01.PTE" }).Count -eq 2) "E01.PTE apareceu $(@($ensaios | Where-Object { $_.Name -eq 'E01.PTE' }).Count)x"

  $antes = @{}
  foreach ($f in $ensaios) { $antes[$f.FullName] = (Get-Sha256Arquivo $f.FullName) }

  $r = Invoke-Sincronizacao $cfg $ensaios "exportar" $null
  # 3 conteudos unicos; OUTRO-NOME.PTE repete o conteudo de E02 e cai no sha256
  Verificar "sobe 3 unicos, sha256 pega a copia renomeada" ($r.Novos -eq 3 -and $r.Duplicados -eq 1) "novos=$($r.Novos) dup=$($r.Duplicados)"
  Verificar "nenhuma falha" ($r.Falhas -eq 0) "falhas=$($r.Falhas)"

  # o ponto inegociavel: original intocado
  $mudou = @()
  foreach ($f in $ensaios) {
    if ((Get-Sha256Arquivo $f.FullName) -ne $antes[$f.FullName]) { $mudou += $f.Name }
  }
  Verificar "nenhum ensaio original foi alterado" ($mudou.Count -eq 0) "alterados: $($mudou -join ', ')"
  Verificar "todos os originais continuam existindo" (@($ensaios | Where-Object { Test-Path $_.FullName }).Count -eq $ensaios.Count) "sumiu algum"
  # os 6 arquivos do disco (inclusive os colapsados e o .txt) seguem intactos
  Verificar "nada foi apagado das pastas de origem" (@(Get-ChildItem -Path (Join-Path $tmp "origem"), (Join-Path $tmp "espelho") -Recurse -File).Count -eq 6) "sobrou outra quantidade"

  # integridade da copia
  $copiados = Get-ChildItem -Path $export -Recurse -File
  Verificar "exportou 3 arquivos" ($copiados.Count -eq 3) "exportou $($copiados.Count)"
  $integros = $true
  foreach ($c in $copiados) {
    $shaDestino = Get-Sha256Arquivo $c.FullName
    if (-not ($antes.Values -contains $shaDestino)) { $integros = $false }
  }
  Verificar "copia bate byte a byte com a origem" $integros "sha do destino nao confere"

  # rodar de novo nao pode reenviar nada
  $r2 = Invoke-Sincronizacao $cfg $ensaios "exportar" $null
  Verificar "segunda rodada nao reenvia nada" ($r2.Novos -eq 0 -and $r2.Duplicados -eq 4) "novos=$($r2.Novos) dup=$($r2.Duplicados)"

  # persistencia: simula reinicio relendo o registro do disco
  $tabela = Read-Enviados
  Verificar "registro sobrevive a reinicio (3 hashes)" ($tabela.Count -eq 3) "tem $($tabela.Count)"

  # config corrompida nao pode derrubar o app
  Set-Content -LiteralPath (Get-CaminhoConfig) -Value "{lixo{{" -Encoding UTF8
  $cfgRuim = Read-Config
  Verificar "config corrompida cai no padrao" ($null -ne $cfgRuim.machineId) "voltou nulo"

  # agrupamento por obra
  $grupos = @(Group-PorObra $ensaios $cfg)
  Verificar "agrupa por obra" ($grupos.Count -ge 1 -and $grupos[0].Obra -eq "OBRA X") "obra=$($grupos[0].Obra)"

  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

  Write-Host ""
  if ($script:falhasTeste -eq 0) { Write-Host "TODOS OS TESTES PASSARAM" -ForegroundColor Green; return 0 }
  Write-Host "$($script:falhasTeste) TESTE(S) FALHARAM" -ForegroundColor Red
  return 1
}

if ($Teste) { exit (Invoke-Autoteste) }

# ============================================================================
# Janela
# ============================================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$cfg = Read-Config
Write-Config $cfg   # garante machineId gravado ja na primeira abertura

$form = New-Object System.Windows.Forms.Form
$form.Text = "SincronPIT"
$form.Size = New-Object System.Drawing.Size(720, 560)
$form.MinimumSize = New-Object System.Drawing.Size(640, 480)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(12, 12)
$lblStatus.Size = New-Object System.Drawing.Size(690, 40)
$form.Controls.Add($lblStatus)

$lista = New-Object System.Windows.Forms.ListView
$lista.Location = New-Object System.Drawing.Point(12, 58)
$lista.Size = New-Object System.Drawing.Size(690, 250)
$lista.View = "Details"
$lista.CheckBoxes = $true
$lista.FullRowSelect = $true
$lista.Anchor = "Top,Left,Right,Bottom"
[void]$lista.Columns.Add("Obra", 380)
[void]$lista.Columns.Add("Ensaios", 90)
[void]$lista.Columns.Add("Tamanho", 100)
$form.Controls.Add($lista)

$barra = New-Object System.Windows.Forms.ProgressBar
$barra.Location = New-Object System.Drawing.Point(12, 318)
$barra.Size = New-Object System.Drawing.Size(690, 18)
$barra.Anchor = "Left,Right,Bottom"
$form.Controls.Add($barra)

$log = New-Object System.Windows.Forms.TextBox
$log.Location = New-Object System.Drawing.Point(12, 344)
$log.Size = New-Object System.Drawing.Size(690, 120)
$log.Multiline = $true
$log.ScrollBars = "Vertical"
$log.ReadOnly = $true
$log.Anchor = "Left,Right,Bottom"
$form.Controls.Add($log)

$btnSincronizar = New-Object System.Windows.Forms.Button
$btnSincronizar.Text = "Sincronizar"
$btnSincronizar.Location = New-Object System.Drawing.Point(12, 474)
$btnSincronizar.Size = New-Object System.Drawing.Size(150, 34)
$btnSincronizar.Anchor = "Left,Bottom"
$form.Controls.Add($btnSincronizar)

$btnAtualizar = New-Object System.Windows.Forms.Button
$btnAtualizar.Text = "Atualizar lista"
$btnAtualizar.Location = New-Object System.Drawing.Point(172, 474)
$btnAtualizar.Size = New-Object System.Drawing.Size(120, 34)
$btnAtualizar.Anchor = "Left,Bottom"
$form.Controls.Add($btnAtualizar)

$btnConfig = New-Object System.Windows.Forms.Button
$btnConfig.Text = "Configurar"
$btnConfig.Location = New-Object System.Drawing.Point(302, 474)
$btnConfig.Size = New-Object System.Drawing.Size(110, 34)
$btnConfig.Anchor = "Left,Bottom"
$form.Controls.Add($btnConfig)

function Escrever($txt) {
  $log.AppendText("$(Get-Date -Format 'HH:mm:ss')  $txt`r`n")
  $log.SelectionStart = $log.TextLength
  $log.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

$script:grupos = @()

function Atualizar-Lista {
  $lista.Items.Clear()
  $lblStatus.Text = "Procurando ensaios..."
  [System.Windows.Forms.Application]::DoEvents()

  $enviados = Read-Enviados
  $todos = Get-Ensaios $cfg
  # Nao calcula sha de 31 mil arquivos so para montar a tela — isso levaria
  # minutos num Atom. A contagem exibida e do que existe; o que ja subiu e
  # descartado na hora do envio, que e onde o hash e necessario de qualquer jeito.
  $script:grupos = @(Group-PorObra $todos $cfg)

  foreach ($g in $script:grupos) {
    $item = New-Object System.Windows.Forms.ListViewItem($g.Obra)
    [void]$item.SubItems.Add("$($g.Arquivos.Count)")
    [void]$item.SubItems.Add("$([math]::Round($g.Bytes / 1MB, 1)) MB")
    $item.Tag = $g
    [void]$lista.Items.Add($item)
  }

  $online = Test-Internet
  $modo = if ($online) { "envio para a nuvem" } else { "SEM INTERNET - exportacao para pendrive" }
  $lblStatus.Text = "$($todos.Count) ensaios em $($script:grupos.Count) obras.  Ja sincronizados: $($enviados.Count).`r`nModo: $modo   Equipamento: $($cfg.machineId)"
  $btnSincronizar.Text = if ($online) { "Sincronizar" } else { "Exportar" }
}

$btnAtualizar.Add_Click({ Atualizar-Lista })

$btnConfig.Add_Click({
  $url = [Microsoft.VisualBasic.Interaction]::InputBox("URL da funcao ingerir:", "SincronPIT", $cfg.urlIngerir)
  if ($url) { $cfg.urlIngerir = $url }
  $tk = [Microsoft.VisualBasic.Interaction]::InputBox("Token do equipamento:", "SincronPIT", $cfg.token)
  if ($tk) { $cfg.token = $tk }
  Write-Config $cfg
  Escrever "configuracao salva em $(Get-CaminhoConfig)"
  Escrever "machine_id deste equipamento: $($cfg.machineId)"
})

$btnSincronizar.Add_Click({
  $marcados = @($lista.CheckedItems)
  if ($marcados.Count -eq 0) {
    [System.Windows.Forms.MessageBox]::Show("Marque pelo menos uma obra na lista.", "SincronPIT") | Out-Null
    return
  }

  $online = Test-Internet
  $modo = if ($online) { "enviar" } else { "exportar" }

  if ($modo -eq "enviar" -and (-not $cfg.urlIngerir -or -not $cfg.token)) {
    [System.Windows.Forms.MessageBox]::Show("Falta configurar a URL e o token. Clique em Configurar.", "SincronPIT") | Out-Null
    return
  }
  if ($modo -eq "exportar") {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Sem internet. Escolha o pendrive para exportar os ensaios."
    if ($dlg.ShowDialog() -ne "OK") { return }
    $cfg.pastaExport = $dlg.SelectedPath
    Write-Config $cfg
  }

  $arquivos = New-Object System.Collections.ArrayList
  foreach ($item in $marcados) { foreach ($f in $item.Tag.Arquivos) { [void]$arquivos.Add($f) } }

  $btnSincronizar.Enabled = $false; $btnAtualizar.Enabled = $false
  $barra.Value = 0; $barra.Maximum = $arquivos.Count
  Escrever "iniciando: $($arquivos.Count) arquivos, modo $modo"

  $progresso = {
    param($i, $total, $nome)
    $barra.Value = [Math]::Min($i, $barra.Maximum)
    $lblStatus.Text = "$i de $total   $nome"
    [System.Windows.Forms.Application]::DoEvents()
  }

  try {
    $r = Invoke-Sincronizacao $cfg $arquivos $modo $progresso
    Escrever "novos: $($r.Novos)   ja existiam: $($r.Duplicados)   falhas: $($r.Falhas)   recusados: $($r.Permanentes)"
    foreach ($e in ($r.Erros | Select-Object -First 20)) { Escrever "  $e" }
    if ($r.Erros.Count -gt 20) { Escrever "  ... e mais $($r.Erros.Count - 20)" }
    if ($r.Falhas -gt 0) { Escrever "as falhas sao temporarias: clique de novo mais tarde que ele retoma de onde parou" }
  } catch {
    Escrever "ERRO: $($_.Exception.Message)"
  } finally {
    $btnSincronizar.Enabled = $true; $btnAtualizar.Enabled = $true
    Atualizar-Lista
  }
})

Add-Type -AssemblyName Microsoft.VisualBasic
$form.Add_Shown({ Atualizar-Lista })
[void]$form.ShowDialog()
