// ===========================================================================
// Backfill dos metadados dos ensaios que subiram antes da extração existir.
//
// Baixa cada arquivo do Storage, lê o cabeçalho com a MESMA lógica da Edge
// Function, e preenche as colunas. Não altera bytes de nada: o objeto no
// Storage é só lido.
//
// Uso: node backfill-metadados.mjs <ref> <management-token> <service-role-key>
// ===========================================================================
const [REF, TOKEN, SERVICE] = process.argv.slice(2);
if (!REF || !TOKEN || !SERVICE) { console.error("faltam argumentos"); process.exit(2); }
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const BASE = `https://${REF}.supabase.co`;

async function sql(query) {
  const r = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// --- leitor de cabeçalho: mesma lógica da Edge Function --------------------
const TAG_NUM = { "0403":"WS","0404":"LE","0405":"MD","0407":"MA","0414":"FS","0419":"L1" };
function ehTextoUtf16(v,off,chars){for(let i=0;i<chars;i++){if(v.getUint8(off+i*2+1)!==0)return false;const lo=v.getUint8(off+i*2);if(lo<0x09||(lo>0x0d&&lo<0x20)||lo>0x7e)return false;}return true;}
function aparado(s){const t=s.trim();return t.length>0?t:undefined;}
function primeiroTrecho(s){const t=aparado(s);if(t===undefined)return undefined;const p=t.split(/\s{2,}/)[0].trim();return p.length>0?p:undefined;}
function lerCabecalho(bytes){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const r={configuracoes:[],nBlocos:0}; let atual=null,off=0;
  while(off+4<=v.byteLength){
    const tag=v.getUint16(off,true),len=v.getUint16(off+2,true),p=off+4;
    const T=tag.toString(16).padStart(4,"0");
    if(len===0){off=p;continue;}
    if(len<300&&p+len*2<=v.byteLength&&ehTextoUtf16(v,p,len)){
      let s="";for(let i=0;i<len;i++)s+=String.fromCharCode(v.getUint16(p+i*2,true));
      if(T==="0303"&&!r.nome)r.nome=aparado(s);
      if(T==="0304"&&!r.tipo){const x=primeiroTrecho(s);if(x)r.tipo=x.toUpperCase();}
      if(T==="0202"&&!r.operador)r.operador=aparado(s);
      if(T==="0203"&&!r.empresa)r.empresa=aparado(s);
      off=p+len*2;continue;}
    if(len===8&&p+8<=v.byteLength){
      const num=v.getFloat64(p,true);
      if(T==="0403"){atual={};r.configuracoes.push(atual);r.nBlocos++;}
      if(atual&&T in TAG_NUM&&Number.isFinite(num))atual[TAG_NUM[T]]=num;
      if(T==="0413"&&r.area===undefined&&Number.isFinite(num))r.area=num;
      off=p+8;continue;}
    if(len===4&&p+4<=v.byteLength){off=p+4;continue;}
    if(len===16&&p+16<=v.byteLength){off=p+16;continue;}
    off+=2;
  }
  return r;
}
const q = (s) => s === undefined || s === null ? "null" : `'${String(s).replace(/'/g, "''")}'`;
const nq = (n) => n === undefined || n === null || !Number.isFinite(n) ? "null" : String(n);

const pendentes = await sql(
  "select id, storage_path, extensao, nome_original from public.ensaios where extraido_em is null and extracao_erro is null order by recebido_em"
);
console.log(`${pendentes.length} ensaios para processar\n`);

let ok = 0, pulados = 0, erros = 0;
for (const e of pendentes) {
  if (e.extensao !== ".pte") { pulados++; continue; }
  try {
    const r = await fetch(`${BASE}/storage/v1/object/ensaios/${e.storage_path}`, {
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    });
    if (!r.ok) throw new Error(`storage ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const cab = lerCabecalho(bytes);
    const d = cab.area > 0 ? 2 * Math.sqrt(cab.area / Math.PI) * 100 : null;

    let stmt = `update public.ensaios set estaca_nome=${q(cab.nome)}, estaca_tipo=${q(cab.tipo)},` +
      ` area_secao_m2=${nq(cab.area)}, diametro_cm=${nq(d)}, operador_data=${q(cab.operador)},` +
      ` empresa=${q(cab.empresa)}, n_blocos=${nq(cab.nBlocos)}, n_configuracoes=${cab.configuracoes.length},` +
      ` extraido_em=now() where id='${e.id}';`;
    if (cab.configuracoes.length) {
      const vals = cab.configuracoes.map((c, i) =>
        `('${e.id}',${i},${nq(c.WS)},${nq(c.LE)},${nq(c.MD)},${nq(c.MA)},${nq(c.FS)},${nq(c.L1)})`).join(",");
      stmt += ` insert into public.ensaio_parametros (ensaio_id,ordem,velocidade_onda_ms,comprimento_le_m,md_m,ma,taxa_amostragem_hz,arrasamento_m)` +
        ` values ${vals} on conflict (ensaio_id,ordem) do nothing;`;
    }
    await sql(stmt);
    ok++;
    if (ok % 10 === 0) console.log(`  ${ok} processados...`);
  } catch (err) {
    erros++;
    console.log(`  erro em ${e.nome_original}: ${err.message}`);
    await sql(`update public.ensaios set extracao_erro=${q(String(err.message).slice(0,300))} where id='${e.id}'`);
  }
}
console.log(`\nextraidos: ${ok}   pulados (nao .pte): ${pulados}   erros: ${erros}`);
