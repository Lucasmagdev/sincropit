#!/usr/bin/env python3
"""
Escritor de arquivos .PTE em formato TLV real (compatível com o parser
em src/lib/pte.ts). Ver reverse-engineering/formato-pte.md pros detalhes
do formato e a sessão de simular batida no Fpit pra origem das regras
abaixo.

Regra importante: nenhuma amostra pode valer 0.0 exato. Um double 0.0 tem
os 8 bytes zerados, e o parser TLV trata um par de bytes zerado como um
registro válido de tamanho zero — isso faz o "header" vazar pra dentro dos
dados de amostra e corrompe o arquivo inteiro. Por isso toda amostra que
seria zero recebe um deslocamento minúsculo (1e-12), imperceptível no
gráfico.
"""

import struct
import random
from datetime import datetime
from pathlib import Path
from typing import List


def _u16le(n: int) -> bytes:
    return struct.pack('<H', n)


def _tlv_int32(tag: int, value: int) -> bytes:
    return _u16le(tag) + _u16le(4) + struct.pack('<i', value)


def _tlv_float64(tag: int, value: float) -> bytes:
    return _u16le(tag) + _u16le(8) + struct.pack('<d', value)


def _tlv_timestamp(tag: int, dt: datetime) -> bytes:
    # SYSTEMTIME do Win32: wDayOfWeek = 0(domingo)..6(sábado).
    # datetime.weekday() = 0(segunda)..6(domingo) -> conversão abaixo.
    dow = (dt.weekday() + 1) % 7
    vals = [dt.year, dt.month, dow, dt.day, dt.hour, dt.minute, dt.second, dt.microsecond // 1000]
    payload = b''.join(struct.pack('<H', v) for v in vals)
    return _u16le(tag) + _u16le(16) + payload


def _perturb(v: float) -> float:
    """Evita que a amostra vire um 'valor redondo' em bytes IEEE754.

    Não é só 0.0 exato que quebra o parser: QUALQUER valor cujos 32 bits
    baixos da mantissa fiquem zerados colide (um inteiro puro, tipo
    contagem crua de ADC, sempre tem baixa/mantissa zerada — não é caso
    raro, é a regra pra qualquer valor com poucos dígitos significativos).
    Jitter multiplicativo relativo à magnitude do valor resolve em
    qualquer escala; jitter aditivo cobre só o caso v==0.
    """
    if v == 0.0:
        return 1e-12
    return v * (1 + random.uniform(-1e-6, 1e-6))


def _safe_samples_bytes(values: List[float]) -> bytes:
    out = bytearray()
    for v in values:
        out += struct.pack('<d', _perturb(v))
    return bytes(out)


def _filler_block(m: int, tag: int = 0x0605) -> bytes:
    noise = [(random.random() - 0.5) * 2 for _ in range(m)]
    return _tlv_int32(tag, m) + _safe_samples_bytes(noise)


def write_pte(
    samples: List[float],
    output_path: Path,
    *,
    ws: float,
    le: float,
    fs: float,
    md: float = 2,
    ma: float = 10,
    t1: int = 500,
) -> None:
    """Escreve um .PTE válido: 1 bloco com sinal real + 3 blocos de preenchimento
    (mesma estrutura de grupo-de-4 dos arquivos reais — ver formato-pte.md).

    `ws`, `le` e `fs` são OBRIGATÓRIOS de propósito — não têm default.

    Antes eles vinham com os valores da estaca B135 (le=9.5, ws=4000,
    fs=50000) embutidos no código. Consequência: uma captura de QUALQUER
    estaca saía afirmando ter 9.5 m de comprimento, e o app desenhava a linha
    "Toe (LE)" nessa posição e convertia o eixo X com aquele WS. Numa estaca
    de 20 m o gráfico inteiro ficaria errado, sem nada indicando que os
    valores eram inventados — e o arquivo persiste com essa metadata falsa.

    Esses três definem a conversão tempo→distância (`x = t × WS / 2`) e a
    posição do eco de ponta, ou seja, a leitura de integridade inteira.
    Quem captura precisa informá-los a partir do ensaio real.
    """
    for nome, valor in (("ws", ws), ("le", le), ("fs", fs)):
        if not isinstance(valor, (int, float)) or valor <= 0:
            raise ValueError(f"{nome} precisa ser um número positivo (veio {valor!r})")
    if le <= md:
        raise ValueError(f"le ({le}) precisa ser maior que md ({md}) — amplificação indefinida")
    n = len(samples)
    header0 = (
        _tlv_int32(0x0403, int(ws))
        + _tlv_float64(0x0404, le)
        + _tlv_int32(0x0405, int(md))
        + _tlv_int32(0x0407, int(ma))
        + _tlv_int32(0x0414, int(fs))
        + _tlv_timestamp(0x0504, datetime.now())
        + _tlv_int32(0x0604, t1)
        + _tlv_int32(0x0605, n)  # marcador de contagem — precisa ser o último inteiro do header
    )
    block0 = header0 + _safe_samples_bytes(samples)
    full = block0 + _filler_block(8) + _filler_block(8) + _filler_block(8)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'wb') as f:
        f.write(full)
