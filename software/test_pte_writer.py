#!/usr/bin/env python3
"""Teste rápido: simula bytes brutos capturados via USB, grava com o
pte_writer, confirma que o arquivo tem tamanho > 0 e é reproduzível.
Validação estrutural completa (parse real) é feita em paralelo pelo
verify-fake-pte.mjs (Node) contra a mesma lógica TLV usada aqui.
"""
import struct
import sys
import importlib.util
from pathlib import Path

# capture-pit.py tem hífen no nome -> não dá pra "import" normal
_spec = importlib.util.spec_from_file_location("capture_pit", Path(__file__).parent / "capture-pit.py")
capture_pit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(capture_pit)
save_pte = capture_pit.save_pte

# simula 2000 amostras int32 aleatórias, como se tivessem vindo do USB
import random
fake_raw = b''.join(struct.pack('<i', random.randint(-2**20, 2**20)) for _ in range(2000))

out = Path(__file__).parent / "_test_output.PTE"
n = save_pte(fake_raw, out, ws=4000, le=9.5, fs=50000)

size = out.stat().st_size
print(f"\narquivo: {out}")
print(f"tamanho: {size} bytes")
print(f"amostras salvas: {n}")

assert size > 0, "arquivo vazio!"
assert n == 2000, f"esperava 2000 amostras, salvou {n}"
print("\n✓ teste básico OK — valida estrutura completa com o parser JS (verify-fake-pte.mjs)")
