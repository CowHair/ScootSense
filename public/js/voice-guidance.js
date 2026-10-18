export function turnInstruction(step) {
  const direction = (step.modifier || '').replaceAll('_',' ');
  const road = step.name ? ` onto ${step.name}` : '';
  if(step.type==='roundabout'||step.type==='rotary')return `Enter the roundabout${step.exit ? ` and take exit ${step.exit}` : ''}${road}`;
  if(step.type==='fork')return `Keep ${direction || 'following the route'}${road}`;
  if(step.type==='merge')return `Merge ${direction}${road}`;
  if(step.type==='end of road')return `At the end of the road, turn ${direction}${road}`;
  if(direction==='uturn')return `Make a U turn${road}`;
  return direction && direction!=='straight' ? `Turn ${direction}${road}` : `Continue straight${road}`;
}
export function buildVoiceCues(steps,total) {
  let travelled=0;
  return steps.map((step,index)=>{
    const cue={id:index,remaining:Math.max(0,total-travelled),text:turnInstruction(step),type:step.type,modifier:step.modifier};
    travelled+=step.distance;
    return cue;
  }).filter(cue=>!['depart','arrive','notification'].includes(cue.type));
}
export class VoiceGuidance {
  enabled=false; cues=[]; announced=new Set(); lastSpoken=0;
  prepare(){if(this.supported())window.speechSynthesis.getVoices();}
  supported(){return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;}
  toggle(){this.enabled=!this.enabled;this.cancel();if(this.enabled)this.say('Voice guidance on.');return this.enabled;}
  cancel(){if(this.supported())window.speechSynthesis.cancel();}
  setRoute(steps,total){this.cancel();this.cues=buildVoiceCues(steps,total);this.announced.clear();}
  say(text){
    if(!this.enabled||!this.supported()||document.hidden)return false;
    const utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-CA';utterance.rate=1;
    const voices=window.speechSynthesis.getVoices();
    utterance.voice=voices.find(v=>v.localService&&v.lang==='en-CA')||voices.find(v=>v.localService&&v.lang.startsWith('en'))||null;
    this.cancel();window.speechSynthesis.speak(utterance);this.lastSpoken=Date.now();return true;
  }
  nextInstruction(remaining) {
    const cue=this.cues.find(c=>remaining-c.remaining>=-12);
    if(!cue)return null;
    const metres=Math.max(0,remaining-cue.remaining);
    return {...cue,metres};
  }
  update(remaining,mode){
    if(!this.enabled)return;
    const upcoming=this.nextInstruction(remaining);
    if(!upcoming)return;
    const until=upcoming.metres;
    const limits=mode==='driving'?[500,150,25]:mode==='cycling'?[200,60,15]:[120,35,12];
    if(until>limits[0])return;
    const stage=until<=limits[2]?'now':until<=limits[1]?'near':'ahead';
    const key=`${upcoming.id}:${stage}`;
    if(this.announced.has(key))return;
    // Stage IDs prevent repeats. A time cooldown delays new turns unnecessarily.
    // A new stage replaces older queued speech immediately.
    const instruction=upcoming.text;
    const text=stage==='now'
      ? (instruction.includes(' onto ') ? instruction.replace(' onto ',' now onto ') : `${instruction} now`)
      : `In ${Math.max(20,Math.round(until/10)*10)} metres, ${instruction[0].toLowerCase()+instruction.slice(1)}`;
    if(this.say(text)){
      this.announced.add(key);
      if(stage==='near'||stage==='now')this.announced.add(`${upcoming.id}:ahead`);
      if(stage==='now')this.announced.add(`${upcoming.id}:near`);
    }
  }
}
