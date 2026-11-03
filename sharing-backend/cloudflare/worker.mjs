import {api,cleanup} from '../shared-api.mjs';
export function cloudStore(env) {
  const db=env.DB;
  return {
    async giftImages(id){const row=await db.prepare('SELECT data FROM panel_gift_images WHERE room_id=?').bind(id).first();return row?JSON.parse(row.data):{};},
    async get(id){const row=await db.prepare('SELECT data FROM panel_rooms WHERE id=?').bind(id).first();return row?JSON.parse(row.data):null;},
    async count(){return (await db.prepare('SELECT count(*) AS n FROM panel_rooms').first()).n;},
    async create(room,giftImages={}){const results=await db.batch([db.prepare('INSERT INTO panel_rooms(id,revision,expires,data) SELECT ?,?,?,? WHERE (SELECT count(*) FROM panel_rooms)<10').bind(room.id,room.revision,room.expires,JSON.stringify(room)),db.prepare('INSERT INTO panel_gift_images(room_id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM panel_rooms WHERE id=?)').bind(room.id,JSON.stringify(giftImages),room.id)]);if(results[0].meta.changes!==1)throw Object.assign(Error('試験運用中のルーム上限に達しました'),{status:429});},
    async cas(room,revision){const result=await db.prepare('UPDATE panel_rooms SET revision=?,expires=?,data=? WHERE id=? AND revision=?').bind(room.revision,room.expires,JSON.stringify(room),room.id,revision).run();return result.meta.changes===1;},
    async remove(id,revision){const result=await db.prepare('DELETE FROM panel_rooms WHERE id=?'+(revision===undefined?'':' AND revision=?')).bind(...(revision===undefined?[id]:[id,revision])).run();return result.meta.changes>0;},
    async expired(now){return (await db.prepare('SELECT id FROM panel_rooms WHERE expires<=?').bind(now).all()).results.map(r=>r.id);},
    async rate(key,now,limit){const minute=Math.floor(now/60000);const r=await db.prepare('INSERT INTO panel_rate_limits(key,minute,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute RETURNING count').bind(key,minute).first();return r.count<=limit;},

  };
}
export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin'),headers={'Content-Type':'application/json','Cache-Control':'no-store',...(origin===env.ALLOWED_ORIGIN?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})};
    if(origin&&origin!==env.ALLOWED_ORIGIN)return new Response(JSON.stringify({error:'このサイトからの接続は許可されていません'}),{status:403,headers});
    if(request.method!=='OPTIONS'){
      const day=Math.floor(Date.now()/86400000);
      const budget=await env.DB.prepare('INSERT INTO panel_daily_budget VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN day=excluded.day THEN count+1 ELSE 1 END, day=excluded.day WHERE day<>excluded.day OR count<10000 RETURNING count').bind(day).first();
      if(!budget)return new Response(JSON.stringify({error:'本日の共有利用上限に達しました。翌日9時（日本時間）以降に再度お試しください'}),{status:429,headers});
    }
    return api(request,cloudStore(env),env.ALLOWED_ORIGIN);
  },
  async scheduled(event,env,ctx){ctx.waitUntil((async()=>{await cleanup(cloudStore(env));await env.DB.prepare('DELETE FROM panel_rate_limits WHERE minute<?').bind(Math.floor(Date.now()/60000)-60).run();})());}
};
