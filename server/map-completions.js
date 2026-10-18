import { sql, transaction } from './userdb.js';
import { requireUser } from './auth.js';
import * as store from './store.js';
import * as persist from './persist.js';
const bad = (message,status=400) => Object.assign(new Error(message),{status});
export async function completeMapItem(kind,id,uid) {
  if (!['spot','litter','hazard'].includes(kind) || !/^[1-9]\d*$/.test(String(id))) throw bad('Invalid map item');
  const tables = {spot:['public.spots','id'],litter:['city.litter','no'],hazard:['city.hazards','no']};
  return transaction(async q => {
    const [table,key]=tables[kind];
    const {rows}=await q(`DELETE FROM ${table} WHERE ${key}=$1 RETURNING *`,[id]);
    if(!rows.length) throw bad('This location was already removed. Refresh the map.',409);
    if(kind==='hazard') await q('DELETE FROM city.hazard_photos WHERE hazard_id=$1',[rows[0].id]);
    const pickup=kind!=='hazard';
    await q('INSERT INTO accounts.user_activity(user_id,kind,value,meta) VALUES($1,$2,1,$3)',[uid,pickup?'pickup':'hazard_fixed',JSON.stringify({source:kind,item_id:String(id)})]);
    let pickupId=null;
    if(pickup) { const inserted=await q("INSERT INTO city.pickups(time,count,materials) VALUES(now(),1,'{}') RETURNING seq"); pickupId=inserted.rows[0].seq; }
    await q('UPDATE app.meta SET version=version+1');
    return {ok:true,kind,id:String(id),itemsCollected:pickup?1:0,pickupId};
  });
}
export async function completeAirSpot(id,uid) {
  const spot=store.pollutionHotspots().find(p=>p.id===id);
  if(!spot) throw bad('This air-quality spot was already removed. Refresh the map.',409);
  const keys=new Set(spot.cellKeys);
  const ids=store.getDb().observations.filter(o=>keys.has(`${Math.round(o.lat/.00025)}:${Math.round(o.lng/.00025)}`)).map(o=>o.id);
  return transaction(async q=>{
    const result=await q(`UPDATE sensing.observations SET pm25=NULL, features=COALESCE(features,'{}'::jsonb)-'gas'-'airLevel'
      WHERE id=ANY($1::text[]) AND (pm25 IS NOT NULL OR features ? 'gas' OR features ? 'airLevel') RETURNING id`,[ids]);
    if(!result.rowCount) throw bad('This air-quality spot was already removed. Refresh the map.',409);
    await q('INSERT INTO accounts.user_activity(user_id,kind,value,meta) VALUES($1,$2,1,$3)',[uid,'air_resolved',JSON.stringify({spot_id:id,readings:result.rowCount})]);
    await q('UPDATE app.meta SET version=version+1,obs_epoch=obs_epoch+1');
    return {ok:true,readingsRemoved:result.rowCount};
  });
}
export function mountMapCompletions(app){
 const originCheck=(req,res,next)=>{
  try{if(req.get('origin')&&new URL(req.get('origin')).host!==req.get('host'))throw bad('Invalid request origin',403);next();}catch(e){next(e);}
 };
 for(const [path,kind] of [['spots','spot'],['litter','litter'],['hazards','hazard']]){
  app.post(`/api/${path}/:id/${kind==='hazard'?'complete':'collect'}`,requireUser,originCheck,async(req,res)=>{
   const result=await completeMapItem(kind,req.params.id,req.session.uid);
   await persist.refreshFromDatabase();req.mapCompletion=true;res.json(result);
  });
 }
 app.post('/api/air/:id/complete',requireUser,originCheck,async(req,res)=>{
  const result=await completeAirSpot(req.params.id,req.session.uid);
  await persist.refreshFromDatabase();req.mapCompletion=true;res.json(result);
 });
}
