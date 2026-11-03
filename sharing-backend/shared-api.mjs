// Shared by the local preview and Cloudflare Worker. No private tokens are stored.
export const TTL = 7 * 86400000;
const MAX = 1e9;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
export async function hash(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join(''); }
export const secret = () => crypto.randomUUID() + crypto.randomUUID();
function validateBoard(input) {
  if (!input || input.version !== 2 || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 12 || input.rows.some(n => !Number.isInteger(n) || n < 1 || n > 12)) fail('行の設定が不正です');
  if (!Array.isArray(input.panels) || input.panels.length !== input.rows.reduce((a,b)=>a+b,0)) fail('パネル数が不正です');
  if(input.backgroundImage)fail('画像は共有サーバーに送信できません');
  const ids=new Set();
  if (!['normal','reveal'].includes(input.displayMode) || !['purple','blue','pink','orange'].includes(input.theme)) fail('表示設定が不正です');
  const panels = input.panels.map(p => {
    if (!p || !['gift','mission','free','empty'].includes(p.type) || typeof p.done !== 'boolean') fail('パネルが不正です');
    for (const k of ['price','required','used']) if (!Number.isSafeInteger(p[k]) || p[k] < (k === 'required' ? 1 : 0) || p[k] > MAX) fail('数値が不正です');
    if (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 2000)) fail('ミッション文が不正です');
    if(p.image)fail('画像は共有サーバーに送信できません');if(typeof p.sharedId!=='string'||!/^[0-9a-f-]{36}$/.test(p.sharedId)||ids.has(p.sharedId))fail('パネルIDが不正です');ids.add(p.sharedId);if(p.supporterNote!==undefined&&(typeof p.supporterNote!=='string'||p.supporterNote.length>100))fail('メモは100文字以内です');return {sharedId:p.sharedId,supporterNote:p.supporterNote||'',type:p.type,text:p.text||'',price:p.price,required:p.required,used:p.used,done:p.done};
  });
  const output = input.backgroundOutput;
  if (output && (!Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < 1 || output.height < 1 || output.width > 8192 || output.height > 8192 || output.width * output.height > 16000000)) fail('出力サイズが不正です');
  return {version:2, rows:[...input.rows], panels, displayMode:input.displayMode, theme:input.theme,  ...(output ? {backgroundOutput:output} : {})};
}
function validateGiftImages(input,board){
  if(input===undefined)return {};
  if(!input||typeof input!=='object'||Array.isArray(input))fail('ギフト画像が不正です');
  const allowed=new Set(board.panels.filter(p=>p.type==='gift').map(p=>p.sharedId)),result={};let total=0;
  for(const [id,src] of Object.entries(input)){
    if(!allowed.has(id)||typeof src!=='string'||src.length>3500||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(src))fail('共有用ギフト画像が不正です');
    total+=src.length;if(total>512*1024)fail('共有用ギフト画像は合計512KB以内です');
    let bytes;try{bytes=Uint8Array.from(atob(src.split(',')[1]),c=>c.charCodeAt(0));}catch{fail('画像形式が不正です');}
    if(bytes[0]!==255||bytes[1]!==216)fail('JPEG画像を指定してください');
    let valid=false;for(let i=2;i+8<bytes.length;){if(bytes[i++]!==255)break;while(bytes[i]===255)i++;const marker=bytes[i++];if(marker===218||marker===217)break;const length=bytes[i]*256+bytes[i+1];if(length<2||i+length>bytes.length)break;if([192,193,194].includes(marker)){const h=bytes[i+3]*256+bytes[i+4],w=bytes[i+5]*256+bytes[i+6];valid=w>0&&h>0&&w<=128&&h<=128;break;}i+=length;}
    if(!valid)fail('共有用画像は128px以内に縮小してください');result[id]=src;
  }return result;
}
async function prepare(payload){if(!payload||payload.assets)fail('画像データは送信できません');const board=validateBoard(payload.board);return{board,giftImages:validateGiftImages(payload.giftImages,board)};}
function publicRoom(room, actor) {
  return {id:room.id, hasGiftImages:!!room.hasGiftImages, revision:room.revision, board:room.board, expires:room.expires, role:actor.role, actorId:actor.id, name:actor.name, history:room.history,
    supporters:actor.role==='admin' ? room.supporters.map(({id,name})=>({id,name})) : [], settingsNotice:room.settingsNotice || 0};
}
async function identity(room, token) {
  const digest=await hash(token);
  if (digest===room.admin) return {id:'admin',role:'admin',name:'管理者'};
  const person=room.supporters.find(p=>p.token===digest);
  if (!person) fail('リンクが無効です。管理者に再招待を依頼してください',403);
  return {...person,role:'supporter'};
}
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail('JSONを指定してください',415);
  if (!request.body) fail('データがありません');
  const reader=request.body.getReader(); let size=0; const chunks=[];
  while(true) { const {value,done}=await reader.read(); if(done)break; size+=value.length; if(size>1024*1024){await reader.cancel();fail('データが大きすぎます',413);} chunks.push(value); }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { fail('JSON形式が不正です'); }
}
export async function cleanup(store, now=Date.now()) {
  for (const id of await store.expired(now)) { const room=await store.get(id); if(room && room.expires<=now) { await store.remove(id,room.revision); } }

}
export async function api(request, store, allowedOrigin) {
  const url=new URL(request.url), origin=request.headers.get('Origin');
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if (origin && origin===allowedOrigin) Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
  try {
    if(origin && origin!==allowedOrigin) fail('このサイトからの接続は許可されていません',403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(!['GET','POST'].includes(request.method))fail('操作が不正です',405);
    const ip=request.headers.get('CF-Connecting-IP') || 'local';
    if(!await store.rate(await hash(ip+request.method),Date.now(),request.method==='POST'?60:240))fail('操作が多すぎます。少し待ってください',429);
    if(url.pathname==='/api/rooms' && request.method==='POST') {
      if(await store.count()>=10)fail('試験運用中のルーム上限に達しました',429);
      const data=await body(request), prepared=await prepare(data), token=secret(), id=crypto.randomUUID(), now=Date.now();
      const room={id,format:'metadata-v1',hasGiftImages:Object.keys(prepared.giftImages).length>0,revision:1,admin:await hash(token),supporters:[],board:prepared.board,history:[],requests:[],expires:now+TTL};
      await store.create(room,prepared.giftImages);
      return json({room:publicRoom(room,{id:'admin',role:'admin',name:'管理者'}),token},201);
    }
    const match=/^\/api\/rooms\/([0-9a-f-]{36})(\/gift-images)?$/.exec(url.pathname);
    if(!match)fail('ルームが見つかりません',404);
    const [,id]=match, token=request.headers.get('Authorization')?.replace(/^Bearer /,'');
    if(!token || token.length>200)fail('招待リンクから入室してください',401);
    let prepared;
    const data=request.method==='POST'?await body(request):null;
    for(let attempt=0;attempt<6;attempt++) {
      const room=await store.get(id);
      if(!room)fail('ルームが削除されたか、期限が切れています',410);
      if(room.expires<=Date.now()){await cleanup(store);fail('ルームの期限が切れています',410);}
      const actor=await identity(room,token);
      if(match[2]){if(request.method!=='GET')fail('操作が不正です',405);return json({giftImages:await store.giftImages(id)});}if(request.method==='GET')return json({room:publicRoom(room,actor)});
      if(typeof data.requestId!=='string' || !/^[0-9a-f-]{36}$/.test(data.requestId))fail('操作IDが不正です');
      if(room.requests.includes(data.requestId))return json({room:publicRoom(room,actor),replayed:true});
      const previous=room.revision, action=data.action;
      if(['invite','revoke','replace','end'].includes(action) && actor.role!=='admin')fail('管理者のみ操作できます',403);
      let issued, entry;
      if(action==='invite') {
        if(room.supporters.length>=5)fail('サポーターは5人までです');
        if(typeof data.name!=='string' || !data.name.trim() || data.name.length>30)fail('表示名は1〜30文字で指定してください');
        issued=secret();room.supporters.push({id:crypto.randomUUID(),name:data.name.trim(),token:await hash(issued)});
      } else if(action==='revoke') {
        if(!room.supporters.some(p=>p.id===data.supporterId))fail('サポーターが見つかりません');
        room.supporters=room.supporters.filter(p=>p.id!==data.supporterId);
      } else if(action==='replace') {
        fail('共有中は設定を変更できません。共有を終了してから変更してください',403);
      } else if(action==='end') {
        if(data.revision!==previous)fail('他の更新があります。最新状態を取得してください',409);
        if(!await store.remove(id,previous))continue;
        return json({ended:true});
      } else if(['increment','setUsed','setDone'].includes(action)) {
        if(data.settingsNotice!==room.settingsNotice && (data.settingsNotice||room.settingsNotice))fail('盤面の設定が変わりました。最新状態を確認してください',409);
        const p=room.board.panels[data.panel]; if(!Number.isInteger(data.panel)||!p)fail('パネルがありません');
        const field=action==='setDone'?'done':'used', before=p[field];
        if(field==='done' && p.type!=='mission' || field==='used' && p.type!=='gift')fail('パネルの種類が異なります');
        if(action==='increment') {
          if(![-1,1,10].includes(data.delta))fail('加算数が不正です');
          p.used=Math.min(MAX,Math.max(0,p.used+data.delta));
        } else {
          if(data.expected!==before)fail('別の更新が入りました。最新の値を確認して訂正してください',409);
          if(field==='done'?typeof data.value!=='boolean':!Number.isSafeInteger(data.value)||data.value<0||data.value>MAX)fail('値が不正です');
          p[field]=data.value;
        }
        entry={id:data.requestId,kind:'progress',actor:actor.name,actorId:actor.id,panel:data.panel,field,before,after:p[field],at:Date.now()};
      } else if(action==='undo') {
        const item=room.history.find(h=>h.id===data.entryId);
        if(!item || item.undone || item.obsolete || item.kind!=='progress')fail('この操作は取り消せません');
        if(actor.role!=='admin' && item.actorId!==actor.id)fail('他の人の操作は管理者が取り消してください',403);
        const p=room.board.panels[item.panel];
        if(!p || p[item.field]!==item.after)fail('その後に変更されています。最新の値を確認して訂正してください',409);
        p[item.field]=item.before;item.undone=true;
        entry={id:data.requestId,kind:'undo',actor:actor.name,actorId:actor.id,panel:item.panel,at:Date.now()};
      } else fail('操作が不正です');
      if(!entry)entry={id:data.requestId,kind:action,actor:actor.name,actorId:actor.id,at:Date.now()};
      room.history=[entry,...room.history].slice(0,100);room.requests=[data.requestId,...room.requests].slice(0,200);room.revision++;room.expires=Date.now()+TTL;
      if(await store.cas(room,previous)) {

        return json({room:publicRoom(room,actor),...(issued?{token:issued,supporterId:room.supporters.at(-1).id}:{})});
      }
    }
    fail('更新が競合しました。最新状態を確認して再度操作してください',409);
  } catch(error) { return json({error:error.status?error.message:'共有サーバーでエラーが発生しました'},error.status||500); }
}
