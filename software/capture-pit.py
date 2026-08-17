#!/usr/bin/env python3
"""
Captura de sinal PIT-Q em tempo real via USB. Conecta na porta serial e
escuta.

LIMITAÇÃO CONHECIDA (ver reverse-engineering/protocolo-live.md): escuta
passiva de porta serial JÁ foi tentada antes (`serial-sniff.ps1`) e NÃO
funcionou — o sensor não transmite sozinho, só fala depois que o software
oficial (PIT-Q.exe) manda um comando de "iniciar captura" cujo protocolo
exato ainda não foi decifrado. Ou seja, este script provavelmente só
recebe dado se rodar AO MESMO TEMPO que o PIT-Q.exe oficial (não no lugar
dele) — e mesmo assim, o Windows só deixa 1 processo abrir a mesma porta
COM por vez, então pode dar erro de "porta ocupada" se o oficial já tiver
o handle. Vale tentar nas portas COM3/COM4/COM11 (chip FTDI multi-canal
documentado) caso alguma fique livre.

Achado confirmado à parte (sessão anterior): o equipamento só efetivamente
transmite os dados pra USB quando o usuário clica "Salvar" NO SOFTWARE
OFICIAL — não no instante do impacto do martelo — com atraso de ~130s
depois do clique. O timeout abaixo cobre essa janela.
"""

import sys

# console do Windows (cp1252) não sabe imprimir ✓/✗ por padrão — força
# UTF-8 pra não travar com UnicodeEncodeError no meio de uma captura real.
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

try:
    import serial
    import serial.tools.list_ports
except ModuleNotFoundError:
    # Em campo, um ModuleNotFoundError cru não diz o que fazer. A dependência
    # é uma só e a instalação é uma linha.
    print("Falta a biblioteca 'pyserial' pra falar com a porta USB.")
    print("Instale com:  python -m pip install pyserial")
    print("(se tiver mais de um Python instalado, use o mesmo que roda este script)")
    raise SystemExit(1)

import struct
import time
from datetime import datetime
from pathlib import Path

from pte_writer import write_pte

def list_ports():
    """Lista portas seriais disponíveis."""
    ports = serial.tools.list_ports.comports()
    for p in ports:
        print(f"  {p.device}: {p.description}")
    return ports

def connect_port(port_name: str, baudrate: int = 115200) -> serial.Serial:
    """Conecta na porta serial."""
    try:
        ser = serial.Serial(port_name, baudrate, timeout=2)
        print(f"✓ Conectado em {port_name} @ {baudrate} baud")
        return ser
    except Exception as e:
        print(f"✗ Erro ao conectar: {e}")
        if "PermissionError" in type(e).__name__ or "Access is denied" in str(e):
            print("  → provável causa: o software oficial (PIT-Q.exe) já tem essa porta aberta.")
            print("  → tenta outra porta COM (o chip FTDI expõe várias) ou feche o PIT-Q.exe.")
        return None

def read_samples(ser: serial.Serial, timeout_sec: float = 180) -> bytes:
    """Lê amostras da porta até timeout ou detecção de fim.

    Default de 180s cobre o atraso de ~130s entre o clique em "Salvar" no
    software oficial e a transmissão real (achado documentado em
    protocolo-live.md) — um timeout de 30s (valor anterior) nunca teria
    tempo de capturar nada real.
    """
    print(f"Aguardando dados por {timeout_sec}s...")
    print("  → dê a batida E clique 'Salvar' no software oficial do PIT-Q")
    print("  → a transmissão real só começa uns 130s DEPOIS do clique em Salvar")
    data = b''
    start = time.time()

    while time.time() - start < timeout_sec:
        chunk = ser.read(1024)
        if chunk:
            data += chunk
            print(f"  Recebeu {len(chunk)} bytes (total: {len(data)})")
        else:
            # Se sem dados por 2s, pode ter acabado a transmissão
            if data and time.time() - start > 2:
                break

    if not data:
        print("✗ Nenhum dado recebido")
        return None

    print(f"✓ Total recebido: {len(data)} bytes")
    return data

def raw_bytes_to_samples(data: bytes) -> list:
    """Converte bytes brutos capturados via USB em lista de amostras.

    Hipótese da engenharia reversa do protocolo live (ver
    reverse-engineering/protocolo-live.md): o stream USB manda inteiros
    de 32 bits, não os float64 que o arquivo .PTE salvo usa — então
    convertemos aqui antes de gravar no formato TLV real.
    """
    n = len(data) // 4
    if n == 0:
        return []
    return list(struct.unpack(f'<{n}i', data[:n * 4]))


def save_pte(data: bytes, output_path: Path, ws: float, le: float, fs: float) -> int:
    """Converte bytes brutos capturados e grava um .PTE TLV válido
    (mesmo formato que o parser do Fpit / equipamento real usa —
    ver software/pte_writer.py). Retorna o nº de amostras gravadas.

    ws/le/fs vêm de fora porque o script NÃO tem como descobri-los: são
    configurados no equipamento pelo operador. Inventar valores aqui
    gravaria um arquivo que afirma um comprimento de estaca que não é o
    real — e o app usaria isso pra posicionar o eixo e a linha do Toe.
    """
    samples = raw_bytes_to_samples(data)
    if not samples:
        raise ValueError("dados insuficientes pra formar nem uma amostra (menos de 4 bytes)")

    t1 = min(500, max(1, len(samples) // 10))
    write_pte(samples, output_path, ws=ws, le=le, fs=fs, t1=t1)
    print(f"✓ Salvo em {output_path} ({len(samples)} amostras, T1={t1}, LE={le}m, WS={ws}m/s, FS={fs}Hz)")
    return len(samples)

def main():
    import argparse

    p = argparse.ArgumentParser(
        description="Captura o sinal do PIT-Q pela porta serial e grava um .PTE.",
        epilog=(
            "LE, WS e FS são obrigatórios porque este script não tem como "
            "descobri-los — são configurados no equipamento. Sem eles o arquivo "
            "sairia afirmando um comprimento de estaca que não é o real, e o "
            "Fpit posicionaria o eixo e a linha do Toe por esse valor falso."
        ),
    )
    p.add_argument("porta", nargs="?", default="0",
                   help="índice (0, 1, ...) ou nome (COM3). Padrão: 0")
    p.add_argument("--le", type=float, required=True,
                   help="comprimento da estaca em metros (do ensaio real)")
    p.add_argument("--ws", type=float, required=True,
                   help="velocidade de onda em m/s (do ensaio real, ex: 4000)")
    p.add_argument("--fs", type=float, required=True,
                   help="taxa de amostragem em Hz (do equipamento, ex: 50000)")
    p.add_argument("--md", type=float, default=2,
                   help="Magnification Delay em metros (padrão: 2)")
    args = p.parse_args()

    print("=" * 60)
    print("CAPTURA PIT-Q - Sinal ao vivo via USB")
    print("=" * 60)

    # Lista portas
    print("\nPortas disponíveis:")
    ports = list_ports()
    if not ports:
        print("  (nenhuma porta encontrada)")
        return

    port_name = None
    if args.porta.isdigit():
        idx = int(args.porta)
        if idx < len(ports):
            port_name = ports[idx].device
    else:
        port_name = args.porta

    if not port_name:
        print(f"✗ Porta inválida: {args.porta}")
        return

    print(f"\n→ Usando porta: {port_name}")
    print(f"→ Estaca: LE={args.le}m, WS={args.ws}m/s, FS={args.fs}Hz")

    # Conecta
    ser = connect_port(port_name)
    if not ser:
        return

    try:
        # Lê dados
        data = read_samples(ser)
        if not data:
            return

        # Salva
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = Path.cwd() / "capture" / f"pit_capture_{timestamp}.PTE"
        n_samples = save_pte(data, output_path, ws=args.ws, le=args.le, fs=args.fs)

        print(f"\n✓ Captura concluída!")
        print(f"  Arquivo: {output_path}")
        print(f"  Bytes brutos: {len(data)} | Amostras: {n_samples}")

    finally:
        ser.close()
        print("✓ Porta fechada")

if __name__ == '__main__':
    main()
