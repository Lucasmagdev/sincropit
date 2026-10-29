param(
    # Ex.: -Somente 'pit-02','pit-03'. Sem o parametro, compila todos que tiverem credencial.
    [string[]]$Somente
)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$sourcePath = Join-Path $PSScriptRoot 'SincronPIT.cs'
$iconPath = Join-Path $PSScriptRoot 'SincronPIT.ico'
$outputRoot = Join-Path $PSScriptRoot 'distribuir'
$devices = @(
    @{ Nome = 'PIT-01';        MachineId = 'pit-01' },
    @{ Nome = 'PIT-02-4959CF'; MachineId = 'pit-02' },
    @{ Nome = 'PIT-03-4949CF'; MachineId = 'pit-03' },
    @{ Nome = 'PIT-04-4960CF'; MachineId = 'pit-04' },
    @{ Nome = 'PIT-05-5104CF'; MachineId = 'pit-05' },
    @{ Nome = 'PIT-06-5725CF'; MachineId = 'pit-06' },
    @{ Nome = 'PIT-07-5726CF'; MachineId = 'pit-07' }
)
foreach ($dev in $devices) {
    $device = $dev.Nome
    $machineId = $dev.MachineId
    if ($Somente -and ($Somente -notcontains $machineId)) { continue }
    $profilePath = Join-Path $PSScriptRoot ('.credentials\' + $machineId + '.txt')
    if (-not (Test-Path -LiteralPath $profilePath)) {
        if ($Somente) { throw "Credencial ausente para $machineId" }
        Write-Output "Pulado (sem credencial): $machineId"; continue
    }
    $profile = Get-Content -Raw -LiteralPath $profilePath
    if ($profile -notmatch ('(?m)^machineid=' + [regex]::Escape($machineId) + '\s*$')) {
        throw "Perfil nao pertence ao cadastro $machineId"
    }
    if ($profile -notmatch '(?m)^token=[a-f0-9]{64}\s*$') {
        throw "Token ausente para $machineId. Nao sera gerado outro EXE sem envio online."
    }
    $outputPath = Join-Path $outputRoot ('SincronPIT-' + $device + '.exe')
    & $compiler /nologo /target:winexe /optimize+ /platform:anycpu /codepage:65001 `
        "/out:$outputPath" "/win32icon:$iconPath" "/resource:$profilePath,SincronPIT.perfil" `
        /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll `
        /reference:System.Windows.Forms.dll $sourcePath
    if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar $device" }
    Copy-Item -LiteralPath $outputPath -Destination (Join-Path $outputRoot ('SincronPIT-' + $device + '-ONLINE.exe')) -Force
    Write-Output "Gerado: $outputPath"
}
