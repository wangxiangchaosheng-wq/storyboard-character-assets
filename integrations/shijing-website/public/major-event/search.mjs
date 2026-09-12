const norm=v=>String(v??'').toLowerCase().replace(/公元|年|\s/g,'');
export function searchEvents(events,{time='',place='',event=''}={}){
 const query=norm(time),range=query.match(/^(\d+)[-—~至](\d+)$/),single=/^\d+$/.test(query)?Number(query):null;
 return events.filter(e=>{const start=Number(e.year),end=Number(e.endYear??e.year);const inTime=range?start<=Number(range[2])&&end>=Number(range[1]):single!==null?start<=single&&end>=single:norm(`${e.year} ${e.time}`).includes(query);return inTime&&norm((e.places||[]).join(' ')).includes(norm(place))&&norm([e.title,...(e.aliases||[])].join(' ')).includes(norm(event));}).sort((a,b)=>Number(a.year)-Number(b.year)||(a.order??0)-(b.order??0));
}
