const NAME = "BitChord Lossless";
const VERSION = "4.0.0";
const JAMENDO_API = "https://api.jamendo.com/v3.0";
const ARCHIVE_API = "https://archive.org";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400"
};
const SUBSONIC_CLIENT = "BitChordWorker";
const SUBSONIC_API_VERSION = "1.16.1";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra }
  });
}
function error(status, message) { return json({ error: message }, status); }

async function fetchResponse(url, init = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: init.redirect || "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": `BitChord-Lossless/${VERSION}`,
        ...(init.headers || {})
      }
    });
  } finally { clearTimeout(timer); }
}

async function fetchJson(url, init = {}, timeoutMs = 9000) {
  const response = await fetchResponse(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) }
  }, timeoutMs);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { response, data, text };
}

// RFC 1321 MD5, used only for standard Subsonic token authentication.
function md5(input) {
  const rol = (x, c) => (x << c) | (x >>> (32 - c));
  const add = (x, y) => {
    const x4 = x & 0x40000000, y4 = y & 0x40000000;
    const x8 = x & 0x80000000, y8 = y & 0x80000000;
    const r = (x & 0x3fffffff) + (y & 0x3fffffff);
    if (x4 & y4) return r ^ 0x80000000 ^ x8 ^ y8;
    if (x4 | y4) return (r & 0x40000000) ? r ^ 0xc0000000 ^ x8 ^ y8 : r ^ 0x40000000 ^ x8 ^ y8;
    return r ^ x8 ^ y8;
  };
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  const step = (fn, a, b, c, d, x, s, k) => add(rol(add(a, add(add(fn(b, c, d), x), k)), s), b);
  const bytes = new TextEncoder().encode(input);
  const n = (((bytes.length + 8) >> 6) + 1) * 16;
  const w = new Array(n).fill(0);
  for (let j = 0; j < bytes.length; j++) w[j >> 2] |= bytes[j] << ((j % 4) * 8);
  w[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  w[n - 2] = bytes.length * 8;
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (let k = 0; k < n; k += 16) {
    const A = a, B = b, C = c, D = d;
    a=step(F,a,b,c,d,w[k],7,0xd76aa478); d=step(F,d,a,b,c,w[k+1],12,0xe8c7b756); c=step(F,c,d,a,b,w[k+2],17,0x242070db); b=step(F,b,c,d,a,w[k+3],22,0xc1bdceee);
    a=step(F,a,b,c,d,w[k+4],7,0xf57c0faf); d=step(F,d,a,b,c,w[k+5],12,0x4787c62a); c=step(F,c,d,a,b,w[k+6],17,0xa8304613); b=step(F,b,c,d,a,w[k+7],22,0xfd469501);
    a=step(F,a,b,c,d,w[k+8],7,0x698098d8); d=step(F,d,a,b,c,w[k+9],12,0x8b44f7af); c=step(F,c,d,a,b,w[k+10],17,0xffff5bb1); b=step(F,b,c,d,a,w[k+11],22,0x895cd7be);
    a=step(F,a,b,c,d,w[k+12],7,0x6b901122); d=step(F,d,a,b,c,w[k+13],12,0xfd987193); c=step(F,c,d,a,b,w[k+14],17,0xa679438e); b=step(F,b,c,d,a,w[k+15],22,0x49b40821);
    a=step(G,a,b,c,d,w[k+1],5,0xf61e2562); d=step(G,d,a,b,c,w[k+6],9,0xc040b340); c=step(G,c,d,a,b,w[k+11],14,0x265e5a51); b=step(G,b,c,d,a,w[k],20,0xe9b6c7aa);
    a=step(G,a,b,c,d,w[k+5],5,0xd62f105d); d=step(G,d,a,b,c,w[k+10],9,0x02441453); c=step(G,c,d,a,b,w[k+15],14,0xd8a1e681); b=step(G,b,c,d,a,w[k+4],20,0xe7d3fbc8);
    a=step(G,a,b,c,d,w[k+9],5,0x21e1cde6); d=step(G,d,a,b,c,w[k+14],9,0xc33707d6); c=step(G,c,d,a,b,w[k+3],14,0xf4d50d87); b=step(G,b,c,d,a,w[k+8],20,0x455a14ed);
    a=step(G,a,b,c,d,w[k+13],5,0xa9e3e905); d=step(G,d,a,b,c,w[k+2],9,0xfcefa3f8); c=step(G,c,d,a,b,w[k+7],14,0x676f02d9); b=step(G,b,c,d,a,w[k+12],20,0x8d2a4c8a);
    a=step(H,a,b,c,d,w[k+5],4,0xfffa3942); d=step(H,d,a,b,c,w[k+8],11,0x8771f681); c=step(H,c,d,a,b,w[k+11],16,0x6d9d6122); b=step(H,b,c,d,a,w[k+14],23,0xfde5380c);
    a=step(H,a,b,c,d,w[k+1],4,0xa4beea44); d=step(H,d,a,b,c,w[k+4],11,0x4bdecfa9); c=step(H,c,d,a,b,w[k+7],16,0xf6bb4b60); b=step(H,b,c,d,a,w[k+10],23,0xbebfbc70);
    a=step(H,a,b,c,d,w[k+13],4,0x289b7ec6); d=step(H,d,a,b,c,w[k],11,0xeaa127fa); c=step(H,c,d,a,b,w[k+3],16,0xd4ef3085); b=step(H,b,c,d,a,w[k+6],23,0x04881d05);
    a=step(H,a,b,c,d,w[k+9],4,0xd9d4d039); d=step(H,d,a,b,c,w[k+12],11,0xe6db99e5); c=step(H,c,d,a,b,w[k+15],16,0x1fa27cf8); b=step(H,b,c,d,a,w[k+2],23,0xc4ac5665);
    a=step(I,a,b,c,d,w[k],6,0xf4292244); d=step(I,d,a,b,c,w[k+7],10,0x432aff97); c=step(I,c,d,a,b,w[k+14],15,0xab9423a7); b=step(I,b,c,d,a,w[k+5],21,0xfc93a039);
    a=step(I,a,b,c,d,w[k+12],6,0x655b59c3); d=step(I,d,a,b,c,w[k+3],10,0x8f0ccc92); c=step(I,c,d,a,b,w[k+10],15,0xffeff47d); b=step(I,b,c,d,a,w[k+1],21,0x85845dd1);
    a=step(I,a,b,c,d,w[k+8],6,0x6fa87e4f); d=step(I,d,a,b,c,w[k+15],10,0xfe2ce6e0); c=step(I,c,d,a,b,w[k+6],15,0xa3014314); b=step(I,b,c,d,a,w[k+13],21,0x4e0811a1);
    a=step(I,a,b,c,d,w[k+4],6,0xf7537e82); d=step(I,d,a,b,c,w[k+11],10,0xbd3af235); c=step(I,c,d,a,b,w[k+2],15,0x2ad7d2bb); b=step(I,b,c,d,a,w[k+9],21,0xeb86d391);
    a=add(a,A); b=add(b,B); c=add(c,C); d=add(d,D);
  }
  const hex=x=>Array.from({length:4},(_,j)=>((x>>>(j*8))&255).toString(16).padStart(2,"0")).join("");
  return hex(a)+hex(b)+hex(c)+hex(d);
}
function randomSalt(n=12){const b=new Uint8Array(n);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,"0")).join("").slice(0,n)}

function loadBackends(env){
  const out=[];
  const add=e=>{if(e?.baseUrl&&e?.username&&e?.password)out.push({type:e.type||"subsonic",baseUrl:String(e.baseUrl).replace(/\/+$/,""),username:String(e.username),password:String(e.password)})};
  if(env.MUSIC_BACKENDS){try{const v=JSON.parse(env.MUSIC_BACKENDS);if(Array.isArray(v))v.forEach(add)}catch{}}
  if(!out.length&&env.SUBSONIC_BASE_URL&&env.SUBSONIC_USERNAME&&env.SUBSONIC_PASSWORD)add({baseUrl:env.SUBSONIC_BASE_URL,username:env.SUBSONIC_USERNAME,password:env.SUBSONIC_PASSWORD});
  return out;
}
function subsonicUrl(b,path,extra={}){
  const s=randomSalt(),u=new URL(b.baseUrl+path);
  const p={u:b.username,t:md5(b.password+s),s,v:SUBSONIC_API_VERSION,c:SUBSONIC_CLIENT,f:"json",...extra};
  for(const[k,v]of Object.entries(p))if(v!=null)u.searchParams.set(k,String(v));
  return u.toString();
}
function isFlacSong(s){return String(s?.suffix||"").toLowerCase()==="flac"||String(s?.contentType||"").toLowerCase()==="audio/flac"}
function normalizeSubsonicSong(b,s){const flac=isFlacSong(s);return{id:`subsonic:${s.id}`,title:s.title||"Unknown Title",artist:s.artist||"Unknown Artist",album:s.album||"",duration:Number(s.duration)||null,artworkURL:s.coverArt?subsonicUrl(b,"/rest/getCoverArt.view",{id:s.coverArt,size:640}):null,format:flac?"flac":String(s.suffix||"unknown"),audioQuality:flac?"LOSSLESS":"LOSSY",provider:"subsonic",backendId:String(s.id),sampleRate:s.samplingRate?Number(s.samplingRate):null,bitDepth:s.bitDepth?Number(s.bitDepth):null}}
async function searchSubsonic(b,q){const {response,data}=await fetchJson(subsonicUrl(b,"/rest/search3.view",{query:q,songCount:25}));if(!response.ok||!data)return null;const root=data["subsonic-response"];if(root?.status!=="ok")return null;return Array.isArray(root.searchResult3?.song)?root.searchResult3.song.map(s=>normalizeSubsonicSong(b,s)):[]}
async function getSubsonicSong(b,id){const {response,data}=await fetchJson(subsonicUrl(b,"/rest/getSong.view",{id}));if(!response.ok||!data)return null;const root=data["subsonic-response"];return root?.status==="ok"?root.song||null:null}
async function resolveSubsonic(b,id){const s=await getSubsonicSong(b,id);if(!s||!isFlacSong(s))return null;return{url:subsonicUrl(b,"/rest/stream.view",{id,format:"raw"}),format:"flac",quality:s.bitDepth?`${s.bitDepth}-bit FLAC`:"FLAC",streamQuality:"[Subsonic] LOSSLESS",audioQuality:"LOSSLESS",codec:"flac",container:"flac",manifest:"none",mimeType:"audio/flac",sampleRate:s.samplingRate?Number(s.samplingRate):null,bitDepth:s.bitDepth?Number(s.bitDepth):null,provider:"subsonic"}}

function jamendoClientId(env){const v=env?.JAMENDO_CLIENT_ID;return typeof v==="string"&&v.trim()?v.trim():null}
function jamendoUrl(path,env,extra={}){const c=jamendoClientId(env);if(!c)return null;const u=new URL(JAMENDO_API+path);u.searchParams.set("client_id",c);for(const[k,v]of Object.entries(extra))if(v!=null&&v!=="")u.searchParams.set(k,String(v));return u.toString()}
function jamendoAllowed(t){return(t?.audiodownload_allowed??t?.track_audiodownload_allowed)!==false}
function isFlacUrl(v){return typeof v==="string"&&/^https?:\/\//i.test(v)&&/\.flac(?:[?#]|$)/i.test(v)}
function normalizeJamendoTrack(t){const url=typeof t.audio==="string"?t.audio:null;return{id:`jamendo:${t.id}`,title:t.name||"Unknown Title",artist:t.artist_name||"Unknown Artist",album:t.album_name||"",duration:Number(t.duration)||null,artworkURL:t.album_image||t.image||null,format:"flac",audioQuality:"LOSSLESS",provider:"jamendo",jamendoId:String(t.id),license:t.license_ccurl||null,streamable:Boolean(url&&isFlacUrl(url)&&jamendoAllowed(t))}}
async function searchJamendo(env,q){const u=jamendoUrl("/tracks/",env,{format:"json",namesearch:q,audioformat:"flac",audiodlformat:"flac",limit:20,imagesize:600});if(!u)return null;const {response,data}=await fetchJson(u);if(!response.ok||data?.headers?.status!=="success")return null;return(Array.isArray(data.results)?data.results:[]).map(normalizeJamendoTrack).filter(t=>t.streamable)}
async function getJamendoTrack(env,id){const u=jamendoUrl("/tracks/",env,{format:"json",id,audioformat:"flac",audiodlformat:"flac",imagesize:600});if(!u)return null;const {response,data}=await fetchJson(u);if(!response.ok||data?.headers?.status!=="success")return null;return data.results?.[0]||null}
async function resolveJamendo(env,id){const t=await getJamendoTrack(env,id);if(!t||!jamendoAllowed(t))return null;let url=typeof t.audio==="string"?t.audio:null;if(!isFlacUrl(url)){const u=jamendoUrl("/tracks/file/",env,{id,audioformat:"flac",action:"stream"});if(!u)return null;const r=await fetchResponse(u,{redirect:"follow"});if(!r.ok||!r.url||!isFlacUrl(r.url))return null;url=r.url}return{url,format:"flac",quality:t.bit_depth?`${t.bit_depth}-bit FLAC`:"FLAC",streamQuality:"[Jamendo] LOSSLESS",audioQuality:"LOSSLESS",codec:"flac",container:"flac",manifest:"none",mimeType:"audio/flac",sampleRate:Number(t.sampling_rate||t.samplerate)||null,bitDepth:Number(t.bit_depth||t.bitdepth)||null,provider:"jamendo",license:t.license_ccurl||null}}

function archiveFileIsFlac(file){const name=String(file?.name||"").toLowerCase(),format=String(file?.format||"").toLowerCase();return Boolean((name.endsWith(".flac")||format.includes("flac"))&&!file?.private)}
function archiveLicensed(meta){const m=meta?.metadata||{},license=String(m.licenseurl||m.license||"").toLowerCase(),rights=String(m.rights||"").toLowerCase();return Boolean(license||/creative commons|public domain|cc by|cc0/.test(rights))}
function normalizeArchiveTrack(identifier,meta,file){const m=meta?.metadata||{};return{id:`archive:${identifier}/${file.name}`,title:m.title||file.name,artist:m.creator||"Internet Archive",album:m.collection?String(m.collection):"",duration:Number(file.length)||null,artworkURL:m.identifier?`${ARCHIVE_API}/services/img/${encodeURIComponent(m.identifier)}`:null,format:"flac",audioQuality:"LOSSLESS",provider:"archive",archiveId:String(identifier),license:m.licenseurl||m.rights||null,streamable:true}}
async function searchArchive(q){const url=`${ARCHIVE_API}/advancedsearch.php?output=json&rows=8&q=${encodeURIComponent(`${q} AND mediatype:audio`)}`;const {response,data}=await fetchJson(url,{},9000);if(!response.ok||!data?.response?.docs)return[];const out=[];for(const doc of data.response.docs){try{const r=await fetchJson(`${ARCHIVE_API}/metadata/${encodeURIComponent(doc.identifier)}`,{},7000);if(!r.response.ok||!r.data||!archiveLicensed(r.data))continue;for(const file of (Array.isArray(r.data.files)?r.data.files:[]).filter(archiveFileIsFlac).slice(0,2))out.push(normalizeArchiveTrack(doc.identifier,r.data,file))}catch{}}return out.slice(0,20)}
async function resolveArchive(id){const slash=id.indexOf("/");if(slash<1)return null;const identifier=id.slice(0,slash),fileName=id.slice(slash+1);const {response,data}=await fetchJson(`${ARCHIVE_API}/metadata/${encodeURIComponent(identifier)}`,{},8000);if(!response.ok||!data||!archiveLicensed(data))return null;const file=(Array.isArray(data.files)?data.files:[]).find(f=>f.name===fileName&&archiveFileIsFlac(f));if(!file)return null;return{url:`${ARCHIVE_API}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`,format:"flac",quality:"FLAC",streamQuality:"[Internet Archive] LOSSLESS",audioQuality:"LOSSLESS",codec:"flac",container:"flac",manifest:"none",mimeType:"audio/flac",sampleRate:null,bitDepth:null,provider:"archive",license:data.metadata?.licenseurl||data.metadata?.rights||null}}

async function resolveStream(backends,env,composite){
  const i=composite.indexOf(":"),provider=i<0?"subsonic":composite.slice(0,i).toLowerCase(),id=i<0?composite:composite.slice(i+1);
  if(provider==="jamendo"){if(!jamendoClientId(env))throw new Error("Jamendo is not configured");const r=await resolveJamendo(env,id);if(r)return r;throw new Error("Jamendo did not return a playable FLAC source")}
  if(provider==="archive"){const r=await resolveArchive(id);if(r)return r;throw new Error("Internet Archive did not return a permitted FLAC source")}
  let last=null;
  for(const b of backends)try{if(b.type==="subsonic"){const r=await resolveSubsonic(b,id);if(r)return r}}catch(e){last=e}
  throw last||new Error("No configured authorized backend returned a genuine FLAC source");
}

async function searchAll(backends,env,q){
  if(!q.trim())return[];const out=[],seen=new Set();const push=list=>{for(const t of list||[])if(t?.id&&!seen.has(t.id)){seen.add(t.id);out.push(t)}};
  if(jamendoClientId(env))try{push(await searchJamendo(env,q))}catch{}
  for(const b of backends)try{push(await searchSubsonic(b,q))}catch{}
  try{push(await searchArchive(q))}catch{}
  return out.slice(0,50);
}

export default {
  async fetch(request,env={}){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
    if(request.method!=="GET")return error(405,"Method not allowed");
    const backends=loadBackends(env),jamendo=Boolean(jamendoClientId(env));
    if(url.pathname==="/"||url.pathname==="/manifest.json")return json({id:"com.kai.jr.bitchord.lossless",name:NAME,version:VERSION,description:"Lossless FLAC source with Jamendo, authorized self-hosted Subsonic/Navidrome, and permission-filtered Internet Archive fallback providers.",author:"KaiX-Jr",resources:["search","stream"],configured:backends.length>0||jamendo,providers:{jamendo:{configured:jamendo},subsonic:{configured:backends.length>0,count:backends.length},archive:{configured:true}}});
    if(url.pathname==="/search"){try{return json({tracks:await searchAll(backends,env,url.searchParams.get("q")||"")})}catch(e){return error(502,`Search upstream unavailable: ${e?.message||"unknown error"}`)}}
    let id=null;if(url.pathname.startsWith("/stream/"))id=decodeURIComponent(url.pathname.slice(8));else if(url.pathname==="/stream"&&url.searchParams.has("id"))id=url.searchParams.get("id");
    if(id!==null){id=String(id||"").trim();if(!id||id.length>400||/\s/.test(id))return error(400,"Invalid stream id");try{return json(await resolveStream(backends,env,id),200,{"Cache-Control":"no-store"})}catch(e){return error(502,`Lossless FLAC stream unavailable: ${e?.message||"unknown error"}`)}}
    if(url.pathname==="/health")return json({ok:true,service:NAME,version:VERSION,mode:"lossless-multi-provider",quality:"LOSSLESS",providers:{jamendo:{configured:jamendo},subsonic:{configured:backends.length>0,count:backends.length},archive:{configured:true}}});
    return error(404,"Not found");
  }
};

export const __test={md5,loadBackends,isFlacSong,jamendoClientId,jamendoAllowed,isFlacUrl,normalizeJamendoTrack,isFlacArchiveFile:archiveFileIsFlac,archiveLicensed,normalizeArchiveTrack};
