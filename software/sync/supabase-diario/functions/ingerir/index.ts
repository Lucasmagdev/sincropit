// ============================================================================
// Edge Function `ingerir` — única porta de entrada do Fpit Sync.
//
// Publicada dentro do projeto Supabase do Diário (Diariosgeoteste), não num
// projeto separado. As tabelas ficam em schema `pit`, isolado de `public`
// (que é do Diário) — ver software/sync/supabase-diario/migrations. Todo
// acesso ao banco aqui usa Accept-Profile/Content-Profile: pit.
//
// O equipamento manda os bytes do ensaio aqui. Esta função é o único lugar do
// sistema que tem a service_role; o PIT-Q nunca vê essa chave.
//
// SEM IMPORTS. Fala com o PostgREST e com o Storage por `fetch` direto.
// A primeira versão importava @supabase/supabase-js de um CDN e o resultado
// foi BOOT_ERROR — a função nem subia. Numa peça que só existe para receber
// dado de campo, dependência de CDN no caminho de inicialização é risco sem
// contrapartida: o cliente HTTP embutido resolve tudo que é preciso aqui.
//
// Requisição:
//   POST /functions/v1/ingerir
//   Authorization: Bearer <token do equipamento>
//   X-Machine-Id:  pit-<uuid>
//   X-Nome-Original: B135-EA.PTE
//   X-Sha256:        (opcional, é CONFERIDO, não aceito)
//   X-Pasta-Origem / X-Criado-Em / X-Detectado-Em  (opcionais)
//   corpo: bytes do arquivo
//
// Resposta:
//   201 {ok:true, duplicado:false, sha256, storage_path}
//   200 {ok:true, duplicado:true,  sha256}   -> cliente marca como enviado
//   4xx {ok:false, erro}                     -> cliente NÃO reenvia
//   5xx {ok:false, erro}                     -> cliente reenvia com backoff
//
// A distinção 4xx/5xx importa: um arquivo rejeitado por extensão inválida
// reenviado em laço infinito seria o pior comportamento possível na obra.
// ============================================================================

const URL_BASE = Deno.env.get("SUPABASE_URL") ?? "";
// service_role vive SÓ aqui, nas variáveis de ambiente da função.
const CHAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EXTENSOES = new Set([".pte", ".ptn", ".pt2"]);
const LIMITE_PADRAO = 8 * 1024 * 1024;
const MAX_POR_HORA = 500; // teto por equipamento; ensaio real não passa disso

// ============================================================================
// Leitura do cabeçalho .PTE
//
// Porta reduzida de software/src/lib/pte.ts: só o cabeçalho, sem tocar em
// amostras nem em processamento de sinal. Mantida sem dependência externa
// pelo mesmo motivo do resto do arquivo.
//
// Formato: sequência de registros [tag u16 LE][len u16 LE][payload].
// Texto = UTF16LE com `len` em CARACTERES; numérico = `len` em BYTES.
// ============================================================================
interface Config {
  WS?: number; LE?: number; MD?: number; MA?: number; FS?: number; L1?: number;
}
interface Cabecalho {
  nome?: string; tipo?: string; area?: number;
  operador?: string; empresa?: string;
  configuracoes: Config[];
  nBlocos: number;
}

const TAG_NUM: Record<string, keyof Config> = {
  "0403": "WS", "0404": "LE", "0405": "MD", "0407": "MA", "0414": "FS", "0419": "L1",
};

function ehTextoUtf16(v: DataView, off: number, chars: number): boolean {
  for (let i = 0; i < chars; i++) {
    if (v.getUint8(off + i * 2 + 1) !== 0) return false;
    const lo = v.getUint8(off + i * 2);
    if (lo < 0x09 || (lo > 0x0d && lo < 0x20) || lo > 0x7e) return false;
  }
  return true;
}

/** Texto aparado. Espaço interno é conteúdo: existe estaca chamada
 *  "C1  154 -2 A" — com espaço duplo mesmo. */
function aparado(s: string): string | undefined {
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/** Só para o campo de TIPO (0304), que nas versões antigas do PIT-W vem num
 *  buffer de 280 caracteres com o valor e o resto em espaços.
 *
 *  Não aplicar ao nome (0303): já foi aplicado, e transformou 59 estacas
 *  "C1  154 -2 X" em 59 estacas chamadas "C1" — o diário mostraria a obra
 *  inteira como uma estaca só. */
function primeiroTrecho(s: string): string | undefined {
  const t = aparado(s);
  if (t === undefined) return undefined;
  const p = t.split(/\s{2,}/)[0].trim();
  return p.length > 0 ? p : undefined;
}

function lerCabecalho(bytes: Uint8Array): Cabecalho {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r: Cabecalho = { configuracoes: [], nBlocos: 0 };
  let atual: Config | null = null;
  let off = 0;

  while (off + 4 <= v.byteLength) {
    const tag = v.getUint16(off, true);
    const len = v.getUint16(off + 2, true);
    const p = off + 4;
    const T = tag.toString(16).padStart(4, "0");

    if (len === 0) { off = p; continue; }

    if (len < 300 && p + len * 2 <= v.byteLength && ehTextoUtf16(v, p, len)) {
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint16(p + i * 2, true));
      if (T === "0303" && !r.nome) r.nome = aparado(s);
      // maiúsculas: o equipamento não normaliza e o mesmo operador digitou
      // "hc" num ensaio e "HC" nos outros
      if (T === "0304" && !r.tipo) { const t = primeiroTrecho(s); if (t) r.tipo = t.toUpperCase(); }
      if (T === "0202" && !r.operador) r.operador = aparado(s);
      if (T === "0203" && !r.empresa) r.empresa = aparado(s);
      off = p + len * 2;
      continue;
    }

    if (len === 8 && p + 8 <= v.byteLength) {
      const num = v.getFloat64(p, true);
      // WS abre uma configuração nova: o equipamento regrava o conjunto
      // inteiro a cada golpe, e o operador pode mudar MD/FS/L1 no meio
      if (T === "0403") { atual = {}; r.configuracoes.push(atual); r.nBlocos++; }
      if (atual && T in TAG_NUM && Number.isFinite(num)) {
        atual[TAG_NUM[T]] = num;
      }
      if (T === "0413" && r.area === undefined && Number.isFinite(num)) r.area = num;
      off = p + 8;
      continue;
    }

    if (len === 4 && p + 4 <= v.byteLength) { off = p + 4; continue; }
    if (len === 16 && p + 16 <= v.byteLength) { off = p + 16; continue; }

    // Saiu do padrão TLV: começaram as amostras. Anda de 2 em 2 procurando o
    // próximo cabeçalho válido, que é como os blocos seguintes são achados.
    off += 2;
  }
  return r;
}

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cabecalhosBanco(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "apikey": CHAVE,
    "authorization": "Bearer " + CHAVE,
    "content-type": "application/json",
    // Este projeto Supabase é compartilhado com o Diário — as tabelas deste
    // módulo vivem em schema PRÓPRIO ("pit"), não em "public". PostgREST só
    // expõe schema por header, não por prefixo na URL: Accept-Profile para
    // leitura (GET), Content-Profile para escrita (POST/PATCH/DELETE). Sem
    // isso as chamadas cairiam em public e "relation does not exist".
    "accept-profile": "pit",
    "content-profile": "pit",
    ...extra,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function selecionar(caminho: string): Promise<any[]> {
  const r = await fetch(`${URL_BASE}/rest/v1/${caminho}`, { headers: cabecalhosBanco() });
  if (!r.ok) throw new Error(`select ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function inserir(tabela: string, linha: Record<string, unknown>): Promise<Response> {
  return await fetch(`${URL_BASE}/rest/v1/${tabela}`, {
    method: "POST",
    headers: cabecalhosBanco({ "prefer": "return=minimal" }),
    body: JSON.stringify(linha),
  });
}

async function registrar(resultado: string, detalhe: string | null, extra: Record<string, unknown> = {}) {
  // Auditoria nunca derruba a requisição: se falhar, segue.
  try {
    await inserir("eventos_envio", { resultado, detalhe, ...extra });
  } catch (_) { /* ignora */ }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const machineId = req.headers.get("x-machine-id") ?? "";
  const nomeOriginal = req.headers.get("x-nome-original") ?? "";

  try {
    // --- 1. identidade -----------------------------------------------------
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token || !machineId) {
      await registrar("rejeitado_token", "token ou machine_id ausente", { machine_id: machineId, ip });
      return json({ ok: false, erro: "credencial ausente" }, 401);
    }

    // Busca pelo HASH do token: o banco nunca guardou o token em claro, e a
    // consulta por igualdade de hash não expõe o segredo nem em log de query.
    const tokenHash = await sha256Hex(new TextEncoder().encode(token));
    const achados = await selecionar(
      `equipamentos?select=id,machine_id,ativo,limite_bytes&token_sha256=eq.${tokenHash}&limit=1`
    );
    const equip = achados.length > 0 ? achados[0] : null;

    // Token inválido, equipamento revogado, ou token de OUTRO equipamento
    // usado com este machine_id — os três caem na mesma resposta genérica,
    // para não dizer a quem tenta adivinhar qual das três coisas errou.
    if (!equip || !equip.ativo || equip.machine_id !== machineId) {
      await registrar("rejeitado_token", "token invalido, revogado ou machine_id divergente", {
        machine_id: machineId, ip,
      });
      return json({ ok: false, erro: "credencial invalida" }, 401);
    }

    // --- 2. extensão -------------------------------------------------------
    const ponto = nomeOriginal.lastIndexOf(".");
    const extensao = ponto >= 0 ? nomeOriginal.slice(ponto).toLowerCase() : "";
    if (!EXTENSOES.has(extensao)) {
      await registrar("rejeitado_extensao", `extensao '${extensao}'`, {
        equipamento_id: equip.id, machine_id: machineId, ip,
      });
      return json({ ok: false, erro: "extensao nao permitida" }, 415);
    }

    // --- 3. tamanho --------------------------------------------------------
    const limite = equip.limite_bytes ?? LIMITE_PADRAO;
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > limite) {
      await registrar("rejeitado_tamanho", `${bytes.length} bytes (limite ${limite})`, {
        equipamento_id: equip.id, machine_id: machineId, bytes: bytes.length, ip,
      });
      return json({ ok: false, erro: "tamanho fora do permitido" }, 413);
    }

    // --- 4. hash calculado AQUI -------------------------------------------
    // O cliente pode mandar o sha256 dele, mas ele é CONFERIDO, não aceito.
    // A identidade do ensaio é o hash dos bytes que chegaram.
    const sha256 = await sha256Hex(bytes);
    const declarado = req.headers.get("x-sha256")?.toLowerCase();
    if (declarado && declarado !== sha256) {
      await registrar("rejeitado_hash", `cliente disse ${declarado}, recebido ${sha256}`, {
        equipamento_id: equip.id, machine_id: machineId, bytes: bytes.length, ip,
      });
      return json({ ok: false, erro: "hash nao confere; conteudo chegou alterado" }, 422);
    }

    // --- 5. duplicado? -----------------------------------------------------
    const jaTem = await selecionar(`ensaios?select=id&sha256=eq.${sha256}&limit=1`);
    if (jaTem.length > 0) {
      await registrar("duplicado", null, {
        equipamento_id: equip.id, machine_id: machineId, sha256, bytes: bytes.length, ip,
      });
      // 200, não erro: o cliente deve marcar como enviado e parar de tentar.
      return json({ ok: true, duplicado: true, sha256 }, 200);
    }

    // --- 6. teto de vazão --------------------------------------------------
    // Token vazado não vira despejo ilimitado no bucket.
    const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
    const contagem = await fetch(
      `${URL_BASE}/rest/v1/eventos_envio?select=id&equipamento_id=eq.${equip.id}` +
      `&resultado=eq.aceito&ocorrido_em=gte.${umaHoraAtras}`,
      { headers: cabecalhosBanco({ "prefer": "count=exact", "range": "0-0" }) }
    );
    const faixa = contagem.headers.get("content-range") ?? "";
    const totalHora = parseInt(faixa.split("/")[1] ?? "0", 10) || 0;
    if (totalHora >= MAX_POR_HORA) {
      await registrar("rejeitado_tamanho", `teto de ${MAX_POR_HORA}/hora atingido`, {
        equipamento_id: equip.id, machine_id: machineId, ip,
      });
      return json({ ok: false, erro: "limite de envios por hora atingido" }, 429);
    }

    // --- 7. grava ----------------------------------------------------------
    // Caminho endereçado por conteúdo: reenviar sobrescreve o mesmo objeto com
    // bytes idênticos, o que é inofensivo. O nome original NÃO entra no
    // caminho (evita path traversal e caractere estranho vindo do campo).
    const dia = new Date().toISOString().slice(0, 10);
    const storagePath = `${machineId}/${dia}/${sha256}${extensao}`;

    const up = await fetch(`${URL_BASE}/storage/v1/object/ensaios/${storagePath}`, {
      method: "POST",
      headers: {
        "apikey": CHAVE,
        "authorization": "Bearer " + CHAVE,
        "content-type": "application/octet-stream",
        "x-upsert": "true",
      },
      body: bytes,
    });
    if (!up.ok) {
      const detalhe = await up.text();
      await registrar("erro_interno", `storage ${up.status}: ${detalhe.slice(0, 200)}`, {
        equipamento_id: equip.id, machine_id: machineId, sha256, bytes: bytes.length, ip,
      });
      return json({ ok: false, erro: "falha ao gravar" }, 500); // 5xx => cliente reenvia
    }

    // --- extração do cabeçalho ---------------------------------------------
    // Falha aqui NUNCA recusa o upload: o arquivo é o entregável, o metadado é
    // bônus. Grava o erro e segue.
    let cab: Cabecalho | null = null;
    let erroExtracao: string | null = null;
    try {
      if (extensao === ".pte") cab = lerCabecalho(bytes);
    } catch (e) {
      erroExtracao = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    // Seção circular: A = π·r². Confere exato em quatro diâmetros comerciais
    // (50, 60, 45, 40 cm). Seção não circular daria número sem sentido.
    const diametroCm =
      cab && cab.area !== undefined && cab.area > 0
        ? 2 * Math.sqrt(cab.area / Math.PI) * 100
        : null;

    const ins = await inserir("ensaios", {
      equipamento_id: equip.id,
      sha256,
      nome_original: nomeOriginal.slice(0, 255),
      extensao,
      bytes: bytes.length,
      storage_path: storagePath,
      pasta_origem: req.headers.get("x-pasta-origem")?.slice(0, 120) ?? null,
      criado_no_equipamento: req.headers.get("x-criado-em") ?? null,
      detectado_em: req.headers.get("x-detectado-em") ?? null,
      estaca_nome: cab?.nome ?? null,
      estaca_tipo: cab?.tipo ?? null,
      area_secao_m2: cab?.area ?? null,
      diametro_cm: diametroCm,
      operador_data: cab?.operador ?? null,
      empresa: cab?.empresa ?? null,
      n_blocos: cab?.nBlocos ?? null,
      n_configuracoes: cab?.configuracoes.length ?? null,
      extraido_em: cab ? new Date().toISOString() : null,
      extracao_erro: erroExtracao,
    });

    if (!ins.ok) {
      const detalhe = await ins.text();
      // Corrida: dois envios do mesmo conteúdo ao mesmo tempo. O índice único
      // em sha256 é quem decide, e o perdedor é duplicado — não é erro.
      if (ins.status === 409 || detalhe.indexOf("23505") >= 0) {
        await registrar("duplicado", "corrida no indice unico", {
          equipamento_id: equip.id, machine_id: machineId, sha256, bytes: bytes.length, ip,
        });
        return json({ ok: true, duplicado: true, sha256 }, 200);
      }
      await registrar("erro_interno", `insert ${ins.status}: ${detalhe.slice(0, 200)}`, {
        equipamento_id: equip.id, machine_id: machineId, sha256, bytes: bytes.length, ip,
      });
      return json({ ok: false, erro: "falha ao registrar" }, 500);
    }

    // Parâmetros por configuração. O ensaio já está gravado neste ponto —
    // se esta parte falhar, o arquivo continua salvo e o diário simplesmente
    // não recebe a sugestão.
    if (cab && cab.configuracoes.length > 0) {
      try {
        const ids = await selecionar(`ensaios?select=id&sha256=eq.${sha256}&limit=1`);
        if (ids.length > 0) {
          await inserir(
            "ensaio_parametros",
            cab.configuracoes.map((c, i) => ({
              ensaio_id: ids[0].id,
              ordem: i,
              velocidade_onda_ms: c.WS ?? null,
              comprimento_le_m: c.LE ?? null,
              md_m: c.MD ?? null,
              ma: c.MA ?? null,
              taxa_amostragem_hz: c.FS ?? null,
              arrasamento_m: c.L1 ?? null,
            })) as unknown as Record<string, unknown>
          );
        }
      } catch (_) { /* metadado é bônus */ }
    }

    await fetch(`${URL_BASE}/rest/v1/equipamentos?id=eq.${equip.id}`, {
      method: "PATCH",
      headers: cabecalhosBanco({ "prefer": "return=minimal" }),
      body: JSON.stringify({ ultimo_contato: new Date().toISOString(), ultimo_ip: ip }),
    });

    await registrar("aceito", null, {
      equipamento_id: equip.id, machine_id: machineId, sha256, bytes: bytes.length, ip,
    });

    return json({ ok: true, duplicado: false, sha256, storage_path: storagePath }, 201);
  } catch (e) {
    // Qualquer coisa inesperada vira 5xx: o cliente reenvia depois em vez de
    // dar o ensaio por perdido.
    const msg = e instanceof Error ? e.message : String(e);
    await registrar("erro_interno", msg.slice(0, 400), { machine_id: machineId, ip });
    return json({ ok: false, erro: "erro interno" }, 500);
  }
});
