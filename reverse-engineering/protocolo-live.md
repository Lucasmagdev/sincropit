# Protocolo de captura em tempo real — engenharia reversa (em andamento)

Objetivo desta frente: capturar o golpe do martelo **direto do equipamento**,
sem depender do arquivo `.PTE` já salvo pelo PIT-W. Diferente do trabalho em
`formato-pte.md` (que decifra o arquivo final), aqui o alvo é o **protocolo
de comunicação em tempo real** entre o PIT-W e o sensor.

## Hardware do equipamento (achado via Gerenciador de Dispositivos)

- Nome do PC: **PITQ5725** (bate com serial "5725 CF" do certificado de
  calibração do equipamento).
- CPU: Intel Atom E3825 @ 1.33GHz — PC industrial embarcado.
- **SUSI4 Driver** presente → hardware base é um **Advantech** (rebatizado
  pela PDI).
- **Sem placa DAQ dedicada** (nada de National Instruments, nada em "Data
  Acquisition Devices").
- **USB Serial Converter + USB Serial Converter A + USB Serial Converter B**,
  aparecendo como portas **COM3, COM4, COM11** → assinatura clássica de um
  chip **FTDI multi-canal** (FT2232/FT4232). O sensor conecta via porta
  serial virtual sobre USB, não um cartão de aquisição dedicado — bate com o
  certificado do acelerômetro dizer "chip programmed" (a digitalização
  provavelmente acontece num microcontrolador pequeno dentro do próprio
  conector/cabo do sensor).

## Software oficial

- Instalado em `C:\Program Files (x86)\PDI\PIT-Q\`
- Arquivos: `PIT-Q.exe` (app principal), `PIT-Q_Entry.exe` (entrada/launcher),
  `Pticon_v4.ico`, pastas `MSCATUPDATES`, `Public Documents`, `Step 5
  OwnerFile`.
- Instalador completo também disponível: `PIT-W 2009-4_Setup.exe` (achado no
  Desktop do usuário).
- Ferramenta `inspect-exe.ps1` criada pra identificar linguagem/bibliotecas
  via metadados + strings do `.exe` — **ainda não rodada com resultado
  reportado** (ficou pendente, foco mudou pra captura USB).

## Tentativa 1 — escuta passiva (não funcionou)

Script `serial-sniff.ps1`: abre as portas COM3/COM4/COM11 e escuta
passivamente. Resultado: **nenhum dado capturado**, mesmo batendo o martelo.

Conclusão: o sensor **não transmite por conta própria** — só fala depois que
o PIT-W manda um comando de "iniciar captura" (configurando taxa de
amostragem, pré-trigger etc). Escuta passiva simples não é suficiente.

## Tentativa 2 — Wireshark + USBPcap (funcionou, captura real)

Capturado o tráfego USB completo (PIT-W ↔ sensor) durante duas batidas
diferentes, com o PIT-W rodando normal:
- `aloteste.pcapng` (5.2MB, ~50k pacotes)
- `teste2batidarapida.pcapng` (1.9MB, ~20k pacotes, batida mais rápida/leve)

Ferramenta `parse-pcapng.js` criada pra ler o `.pcapng` sem precisar do
Wireshark instalado (parser próprio do formato + do header do USBPcap).

### Achados

- Em ambas capturas aparece um pacote de exatamente **16572 bytes** — o
  maior pacote da sessão, claramente relacionado à transferência de dados da
  leitura.
- **Comparação diferencial entre as duas capturas** (técnica chave: o que é
  igual nos dois é protocolo/cabeçalho fixo; o que difere é dado real):
  - `0x00`–`0x3d` (61 bytes): **idêntico** nas duas → cabeçalho fixo do
    pacote.
  - `0x3e`–`0x104f` (~4096 bytes): **difere** entre as duas capturas → região
    de dado real. Tamanho (~4096 bytes) é sugestivo: bate com **1024
    amostras × 4 bytes** (int32), ecoando o mesmo "1024 amostras por bloco"
    que já conhecíamos do formato do arquivo `.PTE` — só que aqui parece vir
    como **int32 crú**, não float64 (a conversão pra float64 deve acontecer
    depois, no software, na hora de salvar o arquivo).
  - `0x1050`–`0x2093` e `0x30ac`–`0x40bc` (~4KB cada): **idêntico** nas duas
    → provavelmente canais vazios/padding (bate com a descoberta anterior de
    que só 1 em cada 4 blocos tem dado real).
- Decodificando a região que difere como **int32 LE**: valores mudam de
  forma suave/plausível (não é lixo aleatório) — ex. capture1 fica na faixa
  de ~150-220 milhões, capture2 fica bem menor (~±15 milhões), consistente
  com duas batidas de força diferente.
- **Achado estranho**: um valor quase idêntico (1.610.747.101 vs
  1.610.809.323, diferença de 0.004%) aparece nas duas capturas, mas em
  **índices diferentes** (240 vs 368) dentro da região de dado. Não parece
  amostra real — parece um **marcador/sentinela fixo** cuja posição muda
  porque a quantidade de amostra real antes dele varia entre capturas (ou
  seja, a estrutura pode não ser um bloco de tamanho fixo como eu supunha).

### Possível conexão com a calibração absoluta

Se o dado bruto em tempo real é int32 (não float64), isso pode explicar o
fator ~10⁵ que sobrou sem explicação na tentativa de calibração absoluta
(ver `plano-melhoria.md`) — a conversão int32→float64 feita pelo software ao
salvar o arquivo provavelmente aplica esse fator de escala.

## Pacotes pequenos frequentes — descartados

Os pacotes de 400/401/388 bytes (aparecem ~1000+ vezes cada) foram checados:
contêm uma sequência `01 02 03 04 05 06 07 08 09 0a 0b 0c 0d` característica —
parece relatório HID do **touchscreen** (o equipamento tem tela touch, visto
no Gerenciador de Dispositivos), não dado do sensor. Descartado como pista.

## CORREÇÃO — `.PT2` NÃO é criptografado, é um ZIP comum

A seção abaixo concluiu que o `.PT2` era criptografado por causa da alta
entropia depois do byte 79. **Isso estava errado, e a causa do engano é
instrutiva**: o `.PT2` é um **arquivo ZIP padrão**, e a "aleatoriedade" era
simplesmente compressão deflate.

Verificado em `conhecimento/PIT/Alves Ribeiro 28.05.PT2`:

- começa com a assinatura **`PK\x03\x04`** (cabeçalho local de ZIP);
- o campo de flags do cabeçalho é `0000` — **bit 0 desligado, ou seja, sem
  criptografia de ZIP**; método de compressão 8 (deflate);
- `unzip -l` lista o conteúdo normalmente: **18 arquivos `.PTN`**, um por
  estaca (B26EA, B26EB, B26EC, B26ER1/R2, B27EA…B27ER4, B3EA…, B6EA…).

Ou seja: **o `.PT2` é o pacote do projeto inteiro**, e abrir é trivial —
qualquer descompactador serve, e em Node dá pra ler com qualquer lib de zip.

### O que continua fechado: o `.PTN` de dentro

Cada `.PTN` extraído começa com a assinatura ASCII **`PDI\x01`**, seguida de
um cabeçalho fixo, e aí sim vem payload cifrado. Medido em dois arquivos
(`B26EA.PTN` e `B26EB.PTN`, ambos com exatos 50751 bytes):

| medida | valor | leitura |
|---|---|---|
| entropia do payload | **7.997 bits/byte** | máximo é 8.0 → aleatório |
| prefixo idêntico entre os dois | **191 bytes** | cabeçalho fixo |
| coincidência de bytes depois disso | **0.41%** | acaso puro seria 0.39% |

Tamanho **fixo** entre estacas diferentes (50751) descarta compressão — dado
comprimido varia de tamanho. Combinado com entropia máxima e ausência de
reuso de keystream, a conclusão original **se mantém pro `.PTN`**: é cifra de
verdade, sem brecha óbvia, e não vale perseguir.

**Resumo da correção**: o invólucro (`.PT2`) é aberto; o conteúdo (`.PTN`) é
cifrado. A conclusão de "está tudo criptografado" era pessimista demais e
mediu a compressão do ZIP achando que era cifra.

## Tentativa de atalho na criptografia do .PT2/.PTN — fechada (negativo)

> **Nota**: a análise abaixo mediu o `.PT2` (o ZIP) e concluiu que ele era
> criptografado — ver a correção logo acima. O raciocínio continua válido pro
> `.PTN` interno, não pro contêiner.

Comparei byte a byte os dois `.PT2` (`CONSA_22` e `CONSA_26`, mesma sessão,
batidas diferentes) pra ver se reusam a mesma "chave" (ataque clássico contra
cifra de fluxo/XOR fraco — se dois arquivos compartilham keystream, comparar
os dois revela muito sem precisar saber a chave).

Resultado: os primeiros **79 bytes são idênticos** (cabeçalho/metadados fixos,
esperado), mas a partir do byte 79 vira **ruído genuinamente aleatório**
(entropia 7.987 bits/byte, só 0.8% dos bytes coincidem — nível de coincidência
puramente ao acaso). Não achei brecha. Confirma: é criptografia de verdade,
não uma implementação caseira fraca. **Fechando essa via de vez** — não vale
mais tempo tentando, e como já discutido, entra em território de "quebrar
proteção" que preferimos evitar mesmo que fosse fácil.

## Pacotes de 941 bytes (batida3.pcapng) — checado, não parece ser o alvo

Aparecem só 6 vezes nessa captura (raro). Parcialmente parecidos entre si
(93% dos bytes iguais entre dois consecutivos) — tem estrutura, não é lixo,
mas não é óbvio que seja o canal principal de amostras do acelerômetro (muito
raro pra isso). Não aprofundei mais — não é prioridade sem mais pistas.

## O que falta

1. Achar a forma exata do golpe (subida-pico-descida) dentro da região de
   dado — ainda não identificada claramente. **Atualização**: depois de
   corrigir a leitura pra pular as amostras corrompidas pelo marcador (ver
   achado abaixo), a região inteira (~1024 valores) fica **num patamar quase
   constante (~170-220 milhões em `aloteste`, sem subida-pico-descida
   visível)** — não achei o formato de impulso esperado nesse trecho
   específico. Hipótese mais provável: isso é coerente com o próprio formato
   `.PTE`, onde as ~1024 amostras cruas TAMBÉM têm um offset DC gigante (o
   parser do arquivo final subtrai a média do pré-trigger antes de qualquer
   coisa — ver `process-signal.js`, `baseline`) — ou seja, o "golpe" pode
   estar codificado como uma variação pequena em cima desse platô enorme, não
   seria visível sem replicar o mesmo passo de remoção de baseline + filtro
   que já usamos pro arquivo. Não teve tempo de aplicar esse pipeline aqui
   ainda (falta saber a taxa de amostragem/tempo real desse fluxo USB pra
   fazer o filtro em Hz corretamente). Ficou pendente.
2. ~~Entender o marcador ~1.61×10⁹ e por que sua posição varia~~ **RESOLVIDO**
   — ver achado abaixo. Não é um valor de dado, é um artefato de transporte
   USB com posição **fixa e periódica**, não variável.
3. ~~Confirmar se a região de dado tem tamanho fixo ou variável~~
   **RESOLVIDO** — é fixo: marcador a cada exatos 512 bytes, mesma posição
   nos dois pacotes de 16572 bytes comparados (`aloteste` e
   `teste2batidarapida`), inclusive entre capturas diferentes.
4. Rodar `inspect-exe.ps1` no `PIT-Q.exe` (ficou pendente — só existe no PC
   do equipamento, não temos cópia local pra rodar aqui).
5. Capturar mais exemplos (idealmente variando bem a força do golpe) pra
   fortalecer a análise diferencial.
6. Aplicar baseline-removal + filtro (mesmo pipeline do `process-signal.js`)
   nesse trecho de 1024 valores pra ver se o golpe aparece depois de tirar o
   DC gigante (ver item 1).

## Achado (sessão de testes adicional) — o "marcador ~1.61×10⁹" é artefato de transporte USB, não dado

Escaneando o pacote de 16572 bytes inteiro (não só a região de 4096 bytes que
tinha sido comparada antes) por qualquer palavra de 16 bits com o word alto
`0x6002`, achei **32 ocorrências em intervalos EXATOS de 512 bytes**
(offsets `0x1fe, 0x3fe, 0x5fe, 0x7fe, ...`), **na mesma posição exata** nos
dois pacotes de 16572 bytes de `aloteste.pcapng` e no de
`teste2batidarapida.pcapng` — três capturas independentes, mesmo padrão
byte-a-byte.

Isso explica de vez o "achado estranho" documentado antes (valor quase igual
em índices "diferentes" 240 vs 368 nas duas capturas): não é um marcador que
se move — é **periódico e fixo a cada 512 bytes**; a posição "diferente"
detectada antes era só porque a busca por valor-máximo-absoluto pegava
qualquer uma das ocorrências igualmente espaçadas que caísse dentro da janela
analisada, dependendo de quanto dado real vinha antes.

**512 bytes = tamanho máximo de pacote bulk USB 2.0 High-Speed** — forte
indício de que isso é um artefato da fragmentação da transferência bulk (um
tag/sync de 2 bytes inserido a cada "pacote USB" de 512 bytes pela pilha de
transporte, não parte do array de amostras). Checado também nos pacotes
pequenos de 941 bytes (`batida3.pcapng`, o candidato já descartado antes) —
**zero ocorrências do marcador ali**, o que é consistente com a hipótese: se
vem de outro endpoint USB (ex: interrupt, não bulk), o tamanho máximo de
pacote é diferente e não teria esse padrão de 512 bytes. Reforça que o
marcador é específico do endpoint bulk que carrega os pacotes grandes de
amostra, não um artefato universal de qualquer transferência. Prática: ao reconstruir o
stream de amostras a partir da captura crua, **pular os 2 bytes do marcador
a cada 512 bytes** (ou, equivalentemente, tratar como inválida qualquer
amostra de 4 bytes cuja janela cruze offset `512k+510` / `512k+511`) antes de
interpretar o resto como `int32 LE`.

Testei ler o stream **removendo essas amostras corrompidas** (em vez de
deixá-las contaminar a leitura int32) — 8 das 1024 amostras da região ficam
inválidas por isso (~0.8%), o resto permanece com valores plausíveis/suaves
(order de 10⁸), consistente com a leitura int32 original (não int16 — testei
essa hipótese também interpretando o mesmo trecho como stream de int16 a
cada marcador, mas os valores resultantes oscilam violentamente entre
+32767/-32768 quase amostra a amostra, o que não parece um sinal físico real
— descartada).

**Tentativa de achar o golpe nesse trecho (resultado negativo, documentado
pra não repetir)**: apliquei remoção de baseline (média do trecho todo) +
passa-alta (média móvel, janela 41) no stream corrigido, igual ao pipeline
usado no `.PTE` — não apareceu um pulso claro de subida-pico-descida. O
resíduo fica oscilando em ruído de banda larga (desvio padrão ~6.4 milhões,
sem um pico destacadamente maior que o resto). Duas explicações possíveis,
nenhuma confirmada: (1) esse pacote específico de 16572 bytes pode não conter
o instante exato do impacto (pode ser um buffer de streaming contínuo, e o
golpe está em outro pacote da sequência que não isolamos ainda); (2) sem
saber a taxa de amostragem real desse fluxo USB, o filtro passa-alta usado
pode estar com o cutoff errado pra esse contexto (o valor usado no `.PTE` é
calibrado pra FS=50kHz, não necessariamente o mesmo aqui). Precisa de mais
capturas com timing melhor sincronizado ao momento do golpe (e.g. anotar o
instante exato da batida durante a captura) pra avançar nisso.

## Ferramentas criadas nesta frente

- `serial-sniff.ps1` + `rodar-sniff.bat` — escuta passiva de porta serial
  (mostrou ser insuficiente, mas útil como primeiro teste rápido).
- `inspect-exe.ps1` + `rodar-inspecao.bat` — inspeciona metadados/strings de
  um `.exe`.
- `parse-pcapng.js` — parser de captura `.pcapng` do USBPcap, extrai
  payloads USB crus pra análise em Node.

## DESTRAVADO — os comandos que o PC manda pro sensor estão decodificados

A pergunta "como saber que sinais o computador manda pro sensor?" tinha uma
resposta que já estava no material: **as capturas existentes contêm a direção
de saída, ela nunca foi examinada**. A análise anterior olhou só os pacotes
grandes de dados (sensor → PC).

Ferramenta nova: `comandos-usb.js` (usa `--quadros` pra decodificar).

### Qual dispositivo é o sensor

Nas capturas há vários dispositivos USB. O sensor é o que tem o padrão
clássico de **FTDI**: pares bulk IN/OUT no mesmo dispositivo.

| canal | pacotes | leitura |
|---|---|---|
| `dev4 ep0x81 bulk IN` | 7788 | dados vindo do sensor |
| `dev4 ep0x04 bulk OUT` | 48 | **comandos indo pro sensor** |
| `dev4 ep0x83 bulk IN` | 9036 | 2º canal do FTDI |
| `dev6 ep0x84 bulk IN` | 9958 | outro dispositivo (1.9 MB — não é o sensor) |

### Camada 1: configuração FTDI (endpoint de controle)

Comandos padrão do chip, nada proprietário — úteis porque revelam a
configuração da porta:

| comando | significado |
|---|---|
| `40 00 00 00` | RESET |
| `40 04 08 00` | SET_DATA — 8 bits de dados |
| `40 02 00 00` | SET_FLOW_CTRL |
| `40 03 e2 04` | **SET_BAUD_RATE** (divisor 0x04e2) |
| `40 03 68 c0` | SET_BAUD_RATE (outro divisor, 0xc068) |
| `40 09 10 00` | SET_LATENCY_TIMER = 16 ms |
| `40 01 01 01` | SET_MODEM_CTRL (DTR ligado) |

### Camada 2: protocolo da aplicação (bulk OUT) — **estrutura confirmada**

Validado em **61/61 quadros** das três capturas:

```
offset  tam  campo
0       2    magic 0x6969
2       2    código do comando (u16 LE)
4       4    nonce/marca de tempo (muda a cada quadro)
8       4    identificador de sessão (0x08dee96d nas 3 capturas)
12      4    número de sequência (u32 LE, incrementa de 1 em 1)
16      2    tamanho do payload (u16 LE)
18      2    magic 0x9696
20      N    payload
20+N    1    byte final (checksum)
```

Os dois magics batem em 61/61, e o tamanho total é sempre exatamente
`20 + tamanho_declarado + 1` — nenhuma exceção.

### Comandos observados

| código | vezes | tam. payload |
|---|---|---|
| `0x0005` | 43 | 8 |
| `0x0009` | 9 | 1 |
| `0x0007` | 6 | 8 |
| `0x00e3` | 1 | 0 |
| `0x0061` | 1 | 4 |
| `0x0067` | 1 | 2 |

Sequência de abertura de uma sessão (`aloteste.pcapng`, seq 1 a 24):

```
 1  0x0005  ff00000000000000
 2  0x0005  0100000000000000
 3  0x0005  0600000000000000
 4  0x00e3  (vazio)
 5  0x0061  00000000
 6  0x0067  0004
 7  0x0009  00
 8  0x0005  0800000000100000
 9  0x0005  0900000096000000
10  0x0005  0300000000000000
...
```

O padrão do `0x0005` é evidente: **os 4 primeiros bytes do payload são um
índice de parâmetro** (01, 03, 06, 08, 09, 0b, 0c, 0d, 0e…) e os 4 seguintes
são o **valor**. Ou seja, `0x0005` é provavelmente "escrever parâmetro" — é
assim que o software configura taxa de amostragem, pré-trigger etc.

### O que falta

1. **Fórmula do checksum** — testados XOR, soma, complemento de dois e soma
   apenas do payload: nenhum bate. Provavelmente CRC-8 com polinômio próprio.
   Sem isso não dá pra forjar comando válido.
2. **Qual comando dispara a captura** — precisa de uma captura nova com
   anotação de horário: apertar "iniciar" no software oficial e anotar o
   instante. Aí o comando correspondente se identifica por eliminação.
3. **Significado de cada índice de parâmetro** do `0x0005`.

### Como levantar isso (roteiro pra próxima captura)

1. Abrir o Wireshark com USBPcap no PIT-Q, capturando o dispositivo FTDI
2. Iniciar a captura **antes** de abrir o PIT-Q.exe
3. Anotar o horário de cada ação: abrir software, iniciar ensaio, dar a
   batida, salvar
4. Rodar `node comandos-usb.js captura.pcapng --quadros` e cruzar as
   sequências com os horários anotados

Com isso, identificar o comando de disparo vira questão de comparar listas.
