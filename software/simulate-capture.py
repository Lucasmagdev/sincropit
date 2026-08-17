#!/usr/bin/env python3
"""
DEPRECATED: use o botão "simular batida" dentro do app Fpit em vez deste
script — ele gera o .PTE em memória, no formato TLV real (mesma lógica
validada em pte_writer.py), e já mostra o gráfico na hora, sem precisar
rodar nada pelo terminal. Este script fica só de referência/histórico;
o formato que ele escreve abaixo NÃO é TLV válido e não abre no Fpit.
"""

import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import struct
import math
from pathlib import Path
from datetime import datetime

def generate_fake_signal(duration_sec: float = 5, sample_rate: int = 10000) -> bytes:
    """Gera sinal fake de batida (rampa + oscilação amortecida)."""
    num_samples = int(duration_sec * sample_rate)
    data = b''

    for i in range(num_samples):
        t = i / sample_rate

        # Impulso no início (simulação de golpe)
        if t < 0.1:
            amplitude = 1000 * (1 - (t / 0.1))  # rampa decrescente
            frequency = 500  # Hz
            signal = amplitude * math.sin(2 * math.pi * frequency * t)
        else:
            # Decaimento exponencial após impulso
            signal = 100 * math.exp(-5 * (t - 0.1)) * math.sin(2 * math.pi * 100 * t)

        # Quantiza pra int32 (raw ADC)
        sample = int(signal)
        data += struct.pack('<i', sample)  # little-endian int32

    return data

def save_pte_file(data: bytes, output_path: Path) -> None:
    """Salva dados como .PTE simplificado."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'wb') as f:
        # Header simples: magic + timestamp + sample_rate + data_size
        f.write(b'PITQ')  # magic
        f.write(struct.pack('<Q', int(datetime.now().timestamp() * 1000)))  # ms timestamp
        f.write(struct.pack('<I', 10000))  # sample rate (Hz)
        f.write(struct.pack('<I', len(data)))  # tamanho dos dados
        f.write(data)

    print(f"✓ Salvo em {output_path}")
    print(f"  Tamanho: {len(data)} bytes ({len(data) // 4} samples)")

def main():
    print("=" * 60)
    print("SIMULADOR DE BATIDA - Gera dados fake de PIT-Q")
    print("=" * 60)

    # Gera sinal
    print("\nGerando sinal fake (5s, 10kHz)...")
    signal = generate_fake_signal(duration_sec=5, sample_rate=10000)

    # Salva
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path.cwd() / "capture" / f"pit_simulated_{timestamp}.pte"
    save_pte_file(signal, output_path)

    print("\n✓ Simulação concluída!")
    print(f"  Abra {output_path} no Fpit visualizador")

if __name__ == '__main__':
    main()
