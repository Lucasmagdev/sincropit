@echo off
REM ===========================================================================
REM  Compila o SincronPIT.exe usando o compilador C# que JA VEM no Windows.
REM
REM  Nao precisa de Visual Studio, SDK, nem privilegio de administrador. O
REM  csc.exe faz parte do .NET Framework, presente em qualquer Windows 10.
REM  Por isso isto roda igual aqui e no proprio PIT-Q.
REM ===========================================================================
setlocal
cd /d "%~dp0"

set CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo ERRO: compilador C# do .NET Framework nao encontrado.
  echo Procurado em %SystemRoot%\Microsoft.NET\Framework[64]\v4.0.30319\csc.exe
  pause
  exit /b 1
)

echo Compilando com %CSC%
echo.

REM /target:winexe = aplicacao de janela, sem console preto atras
REM /win32icon     = o icone vai DENTRO do exe, nao em arquivo separado
"%CSC%" /nologo /target:winexe /optimize+ /platform:anycpu /codepage:65001 ^
  /out:SincronPIT.exe ^
  /win32icon:SincronPIT.ico ^
  /reference:System.dll ^
  /reference:System.Core.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Windows.Forms.dll ^
  SincronPIT.cs

if errorlevel 1 (
  echo.
  echo FALHOU a compilacao.
  pause
  exit /b 1
)

echo.
echo Gerado: %~dp0SincronPIT.exe
echo.
echo Rodando autoteste...
SincronPIT.exe --teste
echo.
pause
