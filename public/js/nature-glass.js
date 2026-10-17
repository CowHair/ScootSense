import { api } from './ui.js';

const SCENERY = '/images/alpine-meadow.jpg';

// A real texture-sampling lens: curved edges displace the scenery, split its
// colour channels slightly, and add a soft interior blur and specular rim.
const FRAGMENT = `
precision mediump float;
uniform sampler2D scene;
uniform vec2 resolution;
uniform vec2 imageSize;
uniform vec4 panel;
uniform vec2 pointer;
uniform float cornerRadius;
float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r;
}
vec2 cover(vec2 uv) {
  float a = resolution.x/resolution.y;
  float b = imageSize.x/imageSize.y;
  vec2 scale = a > b ? vec2(1.,b/a) : vec2(a/b,1.);
  return (uv-.5)*scale+.5;
}
vec3 sampleScene(vec2 uv) { return texture2D(scene,cover(clamp(uv,0.,1.))).rgb; }
void main() {
  vec2 pixel=gl_FragCoord.xy;
  vec2 uv=pixel/resolution;
  vec3 base=sampleScene(uv);
  vec2 center=panel.xy+panel.zw*.5;
  vec2 p=pixel-center;
  float radius=min(cornerRadius,panel.w*.5);
  float d=box(p,panel.zw*.5,radius);
  float mask=1.-smoothstep(-1.,1.,d);
  if(mask>0.) {
    float dx=box(p+vec2(1.,0.),panel.zw*.5,radius)-box(p-vec2(1.,0.),panel.zw*.5,radius);
    float dy=box(p+vec2(0.,1.),panel.zw*.5,radius)-box(p-vec2(0.,1.),panel.zw*.5,radius);
    vec2 n=normalize(vec2(dx,dy)+vec2(.0001));
    float edge=exp(-abs(d)/16.);
    vec2 lens=(uv-center/resolution)*.90+center/resolution;
    lens-=n*edge*46./resolution;
    vec3 blurred=vec3(0.);
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) {
      blurred+=sampleScene(lens+vec2(float(x),float(y))*1.2/resolution);
    }
    blurred/=9.;
    vec2 chroma=n*edge*3.5/resolution;
    blurred.r=mix(blurred.r,sampleScene(lens+chroma).r,.5);
    blurred.b=mix(blurred.b,sampleScene(lens-chroma).b,.5);
    vec3 glass=mix(blurred,vec3(.04,.18,.14),.36);
    float light=max(0.,dot(n,normalize(vec2(-.6,1.))));
    float rim=exp(-abs(d)/1.5);
    float glow=exp(-length((pixel-pointer)/resolution)*5.);
    glass+=rim*(.16+light*.28)+glow*.035;
    base=mix(base,glass,mask);
  }
  gl_FragColor=vec4(base,1.);
}`;

export function initNatureGlass() {
  const host = document.getElementById('nature-stage');
  const canvas = document.getElementById('nature-canvas');
  const panel = document.getElementById('glass-console');
  host.style.setProperty('--scenery', `url("${SCENERY}")`);
  let refreshInFlight = false;
  async function refreshImpact() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const s = await api('/api/stats');
      const metrics = [[s.itemsPickedUp, 'litter items collected', 'eco'], [s.litterCleared, 'litter reports cleared', 'volunteer_activism'], [s.distanceKm, 'kilometres surveyed', 'route']];
      const target = document.getElementById('garden-metrics');
      target.replaceChildren(...metrics.map(([value, label, icon]) => {
        const item = document.createElement('div');
        const symbol = document.createElement('i'); symbol.className = 'material-icons'; symbol.textContent = icon; symbol.setAttribute('aria-hidden','true');
        const number = document.createElement('b'); number.textContent = Number(value || 0).toLocaleString();
        const caption = document.createElement('span'); caption.textContent = label;
        item.append(symbol, number, caption); return item;
      }));
    } catch {
      document.getElementById('garden-metrics').textContent = 'Community contributions are temporarily unavailable.';
    } finally { refreshInFlight = false; }
  }
  refreshImpact();
  window.addEventListener('data-changed', refreshImpact);
  window.addEventListener('hashchange', () => { if (location.hash === '#ride') refreshImpact(); });

  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
  if (!gl) { host.dataset.renderer = 'fallback'; return; }
  let queued = false, ready = false, visible = true, failed = false;
  let mouse = [.5,.5];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fail = () => { failed = true; host.dataset.renderer = 'fallback'; };
  function shader(type, source) {
    const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); throw new Error('Glass shader unavailable'); }
    return s;
  }
  try {
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}');
    const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    gl.attachShader(program,vertex); gl.attachShader(program,fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Glass program unavailable');
    gl.useProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program,'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    const u = Object.fromEntries(['scene','resolution','imageSize','panel','pointer','cornerRadius'].map(name=>[name,gl.getUniformLocation(program,name)]));
    const texture = gl.createTexture();
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    img.onload = () => {
      if(failed) return;
      try {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,img);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        ready = true; schedule();
      } catch { fail(); }
    };
    img.onerror = fail;
    function draw() {
      queued = false;
      if(!ready || failed || !visible || document.hidden) return;
      const rect = host.getBoundingClientRect(), glass = panel.getBoundingClientRect();
      if(!rect.width || !rect.height) return;
      // Cap pixel count on mobile/retina. Rendering happens only when invalidated.
      const scale = Math.min(devicePixelRatio || 1,1.5,1400/rect.width);
      const w = Math.round(rect.width*scale), h = Math.round(rect.height*scale);
      if(canvas.width!==w || canvas.height!==h) { canvas.width=w; canvas.height=h; }
      gl.viewport(0,0,w,h);
      gl.uniform2f(u.resolution,w,h); gl.uniform2f(u.imageSize,img.naturalWidth,img.naturalHeight);
      gl.uniform4f(u.panel,(glass.left-rect.left)*scale,(rect.bottom-glass.bottom)*scale,glass.width*scale,glass.height*scale);
      gl.uniform2f(u.pointer,mouse[0]*w,mouse[1]*h); gl.uniform1i(u.scene,0);
      gl.uniform1f(u.cornerRadius,parseFloat(getComputedStyle(panel).borderTopLeftRadius)*scale);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      host.dataset.renderer = 'webgl';
    }
    function schedule() { if(!queued && !failed) { queued=true; requestAnimationFrame(draw); } }
    new ResizeObserver(schedule).observe(host);
    new ResizeObserver(schedule).observe(panel);
    new IntersectionObserver(entries=>{ visible=entries[0].isIntersecting; if(visible) schedule(); }).observe(host);
    document.addEventListener('visibilitychange',schedule);
    window.addEventListener('resize',schedule);
    document.fonts?.ready.then(schedule);
    host.addEventListener('pointermove',e=>{ if(reduced.matches || e.pointerType==='touch') return; const r=host.getBoundingClientRect(); mouse=[(e.clientX-r.left)/r.width,1-(e.clientY-r.top)/r.height]; schedule(); });
    host.addEventListener('pointerleave',()=>{mouse=[.5,.5];schedule();});
    canvas.addEventListener('webglcontextlost', e=>{e.preventDefault();fail();});
    // Restoration reloads only this decorative module's resources on next visit.
    img.src = SCENERY;
  } catch { fail(); }
}
