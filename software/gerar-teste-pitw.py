# -*- coding: utf-8 -*-
"""
Gera um .PTE pelo NOSSO escritor usando o sinal de um ensaio REAL, para abrir
no PIT-W oficial.

Por que sinal real e nao sintetico: o objetivo do teste e provar o ESCRITOR,
nao o gerador de sinal. Com as amostras do B135-EA e os mesmos parametros,
o traco no PIT-W tem que sair igual ao do arquivo original. Se sair, o
escritor fala o formato de verdade — nao so um dialeto que o nosso proprio
leitor entende.
"""
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pte_writer import write_pte

RAIZ = Path(__file__).resolve().parent.parent
csv_path = RAIZ / "samples" / "B135-EA.samples.csv"
if not csv_path.exists():
    print(f"nao achei {csv_path}")
    sys.exit(1)

amostras = []
with open(csv_path, newline="", encoding="utf-8") as f:
    for linha in csv.DictReader(f):
        if linha["bloco"] == "0":
            amostras.append(float(linha["valor"]))

# Parametros do B135-EA, lidos do proprio arquivo original.
WS, LE, FS, MD, MA, T1 = 4000.0, 9.5, 50000.0, 2.0, 10.0, 50

destino = Path(r"C:\Users\Lucas\Desktop\TESTE-PITW") / "GERADO-PELO-FPIT.PTE"
destino.parent.mkdir(parents=True, exist_ok=True)
write_pte(amostras, destino, ws=WS, le=LE, fs=FS, md=MD, ma=MA, t1=T1)

print(f"amostras usadas : {len(amostras)} (bloco 0 do B135-EA real)")
print(f"parametros      : WS={WS} LE={LE} FS={FS} MD={MD} MA={MA} T1={T1}")
print(f"gerado em       : {destino}  ({destino.stat().st_size} bytes)")
