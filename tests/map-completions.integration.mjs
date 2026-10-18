// Real database integration test. All created records are removed in finally.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { config } from '../server/config.js';
const {sql}=await import('../server/userdb.js');
const {mountMapCompletions}=await import('../server/map-completions.js');
const {sessionMiddleware}=await import('../server/auth.js');
const persist=await import('../server/persist.js');
const store=await import('../server/store.js');
const tag='test_completion_'+crypto.randomUUID();
const pickups=[];let spot,litter,hazardNo,server;
const app=express();app.use(express.json(),sessionMiddleware);mountMapCompletions(app);
app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
const tokenBody=Buffer.from(JSON.stringify({uid:tag,exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
const token=tokenBody+'.'+crypto.createHmac('sha256',config.AUTH_SECRET).update(tokenBody).digest('base64url');
try {
 spot=(await sql('INSERT INTO public.spots(coord,type,count) VALUES($1,$2,1) RETURNING id',[ [41.1234,-72.1234,0],tag])).rows[0].id;
 litter=(await sql("INSERT INTO city.litter(id,lat,lng,items) VALUES($1,41.1235,-72.1235,'[]') RETURNING no",[tag])).rows[0].no;
 hazardNo=(await sql('SELECT COALESCE(max(no),0)+100000 AS n FROM city.hazards')).rows[0].n;
 await sql("INSERT INTO city.hazards(id,no,lat,lng,type,severity,max_score) VALUES($1,$2,41.1236,-72.1236,'bump',50,50)",[tag,hazardNo]);
 for(let i=0;i<3;i++)await sql("INSERT INTO sensing.observations(time,id,ride_id,lat,lng,pm25,label,score,features) VALUES(now(),$1,$2,41.1237,-72.1237,100,'smooth',0,'{}')",[tag+i,tag]);
 await persist.refreshFromDatabase();
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(path,auth=true)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Cookie:'ss_session='+token}:{})},body:'{}'});const body=await r.json();if(body.pickupId)pickups.push(body.pickupId);return {status:r.status,body};};
 assert.equal((await post(`/api/spots/${spot}/collect`,false)).status,401);
 const results=await Promise.all([post(`/api/spots/${spot}/collect`),post(`/api/spots/${spot}/collect`)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await post(`/api/litter/${litter}/collect`)).status,200);
 assert.equal((await post(`/api/hazards/${hazardNo}/complete`)).status,200);
 assert.equal((await sql('SELECT id FROM public.spots WHERE id=$1',[spot])).rowCount,0);
 assert.equal((await sql('SELECT id FROM city.litter WHERE id=$1',[tag])).rowCount,0);
 assert.equal((await sql('SELECT id FROM city.hazards WHERE id=$1',[tag])).rowCount,0);
 const air=store.pollutionHotspots().find(p=>Math.abs(p.lat-41.1237)<.0001);assert.ok(air);
 assert.equal((await post(`/api/air/${encodeURIComponent(air.id)}/complete`)).status,200);
 const readings=await sql('SELECT pm25,label FROM sensing.observations WHERE ride_id=$1',[tag]);
 assert.equal(readings.rowCount,3);assert.ok(readings.rows.every(r=>r.pm25===null&&r.label==='smooth'));
 const credit=await sql("SELECT sum(value)::int AS n FROM accounts.user_activity WHERE user_id=$1 AND kind='pickup'",[tag]);assert.equal(credit.rows[0].n,2);
 console.log('PASS: authentication, all four completion types, database removal, double-click deduplication, one-time credit, air clearing preserves road data.');
} finally {
 if(server)await new Promise(r=>server.close(r));
 if(spot)await sql('DELETE FROM public.spots WHERE id=$1',[spot]);
 await sql('DELETE FROM city.litter WHERE id=$1',[tag]);await sql('DELETE FROM city.hazards WHERE id=$1',[tag]);
 await sql('DELETE FROM sensing.observations WHERE ride_id=$1',[tag]);await sql('DELETE FROM accounts.user_activity WHERE user_id=$1',[tag]);
 if(pickups.length)await sql('DELETE FROM city.pickups WHERE seq=ANY($1::int[])',[pickups]);
 await sql('UPDATE app.meta SET version=version+1,obs_epoch=obs_epoch+1');
}
