// Import the saved local map snapshot without replacing existing database records.
// Dry run: node scripts/import-map-data.mjs; import: add --apply.
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {databaseURL} from '../server/database-config.js';
const snapshot=JSON.parse(readFileSync(new URL('../data/db.json',import.meta.url),'utf8'));
const rows={
 'sensing.rides': {columns:['id','name','source','device','user_id','started_at','ended_at','distance_m','observations','hazard_hits','avg_score','summary'],values:snapshot.rides.map(r=>[r.id,r.name,r.source,r.device,r.userId,r.startedAt,r.endedAt,r.distanceM,r.observations,r.hazardHits,r.avgScore,r.summary])},
 'sensing.observations': {columns:['time','id','ride_id','t_ms','lat','lng','speed','pm25','label','confidence','model','score','features'],values:snapshot.observations.map(o=>[o.at,o.id,o.rideId,o.t,o.lat,o.lng,o.speed,o.pm25,o.label,o.confidence,o.model,o.score,JSON.stringify(o.f||{})])},
 'city.hazards': {columns:['id','no','lat','lng','type','severity','max_score','hits','ride_ids','first_seen','last_seen','status','votes','photos','notes','voters'],values:snapshot.hazards.map(h=>[h.id,h.no,h.lat,h.lng,h.type,h.severity,h.maxScore,h.hits,h.rideIds,h.firstSeen,h.lastSeen,h.status,JSON.stringify(h.votes||{}),JSON.stringify(h.photos||[]),JSON.stringify(h.notes||[]),JSON.stringify(h.voters||[])])},
 'city.litter': {columns:['id','lat','lng','items','summary','photo','status','reporter_id','at','last_seen','cleared_at','checks'],values:snapshot.litter.map(l=>[l.id,l.lat,l.lng,JSON.stringify(l.items||[]),l.summary,l.photo,l.status,l.reporterId,l.at,l.lastSeen||l.at,l.clearedAt,JSON.stringify(l.checks||[])])},
};
console.log('Source counts:',Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.values.length])));
if(!process.argv.includes('--apply')) process.exit(0);
const url=new URL(databaseURL);const mode=url.searchParams.get('sslmode')||'require';url.searchParams.delete('sslmode');
const client=new pg.Client({connectionString:url.toString(),ssl:mode==='disable'?false:{rejectUnauthorized:mode.startsWith('verify')},connectionTimeoutMillis:8000});
try{
 await client.connect();await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(7224001)');
 const imported={};
 for(const [table,{columns,values}] of Object.entries(rows)){
  imported[table]=0;
  for(let i=0;i<values.length;i+=300){const batch=values.slice(i,i+300);const placeholders=batch.map((r,n)=>'('+r.map((_,j)=>'$'+(n*columns.length+j+1)).join(',')+')').join(',');
   const result=await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,batch.flat());imported[table]+=result.rowCount;
  }
 }
 // Notify running app instances to reload their in-memory map data.
 await client.query('UPDATE app.meta SET version=version+1');
 await client.query('COMMIT');console.log('Imported:',imported);
}catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('Import failed; transaction rolled back:',error.code||error.name);process.exitCode=1;}
finally{await client.end();}
