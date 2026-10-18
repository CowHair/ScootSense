const R = 6371000, rad = Math.PI / 180;
export function distance(a,b) {
  const p=(b[0]-a[0])*rad,q=(b[1]-a[1])*rad;
  const h=Math.sin(p/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(q/2)**2;
  return 2*R*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
export function bearing(a,b) {
  const d=(b[1]-a[1])*rad;
  return (Math.atan2(Math.sin(d)*Math.cos(b[0]*rad),Math.cos(a[0]*rad)*Math.sin(b[0]*rad)-Math.sin(a[0]*rad)*Math.cos(b[0]*rad)*Math.cos(d))/rad+360)%360;
}
// Project onto route segments, rather than treating sparse vertices as off-route.
export function routeProgress(point, coordinates) {
  let best=Infinity,remaining=0;
  const scale=Math.cos(point[0]*rad),meters=R*rad;
  for(let i=coordinates.length-2;i>=0;i--){
    const a=[coordinates[i][1],coordinates[i][0]],b=[coordinates[i+1][1],coordinates[i+1][0]];
    const ax=(a[1]-point[1])*scale*meters,ay=(a[0]-point[0])*meters;
    const bx=(b[1]-point[1])*scale*meters,by=(b[0]-point[0])*meters;
    const dx=bx-ax,dy=by-ay,len=dx*dx+dy*dy;
    const t=len?Math.max(0,Math.min(1,-(ax*dx+ay*dy)/len)):0;
    const gap=Math.hypot(ax+t*dx,ay+t*dy);
    if(gap<best){best=gap;var result={offRoute:gap,remaining:remaining+(1-t)*distance(a,b)};}
    remaining+=distance(a,b);
  }
  return result || {offRoute:Infinity,remaining:Infinity};
}
