import * as Cesium from 'cesium';
import {quickSearchOptions} from '../data/redisSearchPresets.js';
import {redisEnabled} from '../data/redisMode.js';
import {getSelectedEntityContext} from '../data/contextStore.js';

export function initRedisSearch({viewer,dataManager,styleManager}) {
  const dock=document.getElementById('command-dock');
  const control=document.createElement('section');control.id='redis-search-panel';control.className='collapsed';
  control.innerHTML=`<button class="redis-search-toggle" type="button" aria-expanded="false" aria-controls="redis-search-output">Redis Search</button>
    <section id="redis-search-output" class="dock-popover-content" aria-label="Redis Search" inert>
      <button class="dock-pin-btn" type="button" aria-label="Pin Redis Search" aria-pressed="false"><img src="/pin.svg" alt=""></button>
      <div class="redis-search-compose"><form>
        <input aria-label="Search request" placeholder="What do you want to search for?" maxlength="1500">
        <button type="submit" class="data-toggle-btn" aria-label="Run custom search" title="Run search">→</button>
        <button id="redis-search-mic" type="button" aria-label="Start voice input" aria-pressed="false" title="Speak your search"><img src="/mic.svg" alt=""></button>
      </form><div class="redis-search-presets" aria-label="Quick searches"></div></div>
      <div class="redis-search-response" hidden>
        <div class="redis-search-heading"><span>Results</span><button class="data-toggle-btn" type="button" data-action="dismiss">Dismiss</button></div>
        <p class="redis-search-status" role="status"></p><p class="redis-search-description"></p><div class="redis-search-results"></div>
        <details class="redis-search-command"><summary>Query</summary><pre></pre></details>
      </div>
    </section>`;
  dock.append(document.getElementById('control-panel'),control,document.getElementById('location-bar'));
  const panel=control.querySelector('#redis-search-output'),toggle=control.querySelector('.redis-search-toggle'),pin=control.querySelector('.dock-pin-btn');
  const button=control.querySelector('#redis-search-mic'),input=panel.querySelector('input'),status=panel.querySelector('[role=status]'),description=panel.querySelector('.redis-search-description'),results=panel.querySelector('.redis-search-results'),command=panel.querySelector('pre'),response=panel.querySelector('.redis-search-response');
  let pinned=false,hoverTimer=null,optionsKey='';
  const keyTooltip='configure openai key for search to work';
  const form=panel.querySelector('form'),submitButton=form.querySelector('[type=submit]');
  let openAIConfigured=false,keyCheck=null;
  function updateKeyState(configured){
    openAIConfigured=configured;
    form.title=configured?'':keyTooltip;
    for(const element of [input,submitButton,button]){
      element.disabled=!configured;
      element.title=configured?(element===button?'Speak your search':element===submitButton?'Run search':''):keyTooltip;
    }
  }
  async function refreshKeyState(){
    if(keyCheck)return keyCheck;
    keyCheck=(async()=>{
      try{
        const result=await fetch('/api/redis/search/status',{cache:'no-store',signal:AbortSignal.timeout(5000)});
        updateKeyState(result.ok&&(await result.json()).openAIConfigured===true);
      }catch{updateKeyState(false);}
      finally{keyCheck=null;}
    })();
    return keyCheck;
  }
  updateKeyState(false);
  void refreshKeyState();
  function positionPanel(){
    // Always stack this tray above any other open dock trays, including pinned ones.
    const dockTop=control.getBoundingClientRect().top;
    const otherTops=['control-panel','location-bar'].map(id=>document.getElementById(id)).filter(el=>el&&!el.classList.contains('collapsed')).map(el=>el.querySelector('.dock-popover-content')?.getBoundingClientRect().top).filter(Number.isFinite);
    const clearance=window.innerWidth<=900?90:20;
    panel.style.bottom=`calc(100% + ${Math.max(clearance,...otherTops.map(top=>dockTop-top+20))}px)`;
  }
  function refreshOptions(){
    const current=context();
    const options=redisEnabled()?quickSearchOptions(current.selected,layerStates(),current):[];
    const key=JSON.stringify([redisEnabled(),options]);if(key===optionsKey)return;optionsKey=key;
    const container=panel.querySelector('.redis-search-presets');container.replaceChildren();
    for(const option of options){const item=document.createElement('button');item.type='button';item.className='location-pill';item.textContent=option.label;item.dataset.preset=option.id;item.addEventListener('click',()=>{if(!dataManager.isEffectivelyEnabled(option.layer)){refreshOptions();return;}void submit(option.label,option.id);});container.append(item);}
    if(!options.length)container.textContent=redisEnabled()?'Search suggestions appear when a searchable layer is on.':'Turn Redis on to explore search suggestions.';
  }
  function open(){clearTimeout(hoverTimer);if(!control.classList.contains('collapsed'))return;for(const id of ['control-panel','location-bar']){styleManager?._setCommandDockPanelPinState(id,false);styleManager?.setPanelCollapsed(id,true);}if(control.classList.contains('collapsed'))void refreshKeyState();refreshOptions();positionPanel();control.classList.remove('collapsed');panel.inert=false;toggle.setAttribute('aria-expanded','true');}
  function resetContent(){dismiss();input.value='';description.textContent='';command.textContent='';panel.querySelector('.redis-search-command').open=false;}
  function close(){clearTimeout(hoverTimer);setPinned(false);control.classList.add('collapsed');panel.inert=true;toggle.setAttribute('aria-expanded','false');}
  function setPinned(value){pinned=value;control.classList.toggle('dock-pinned',value);pin.setAttribute('aria-pressed',String(value));pin.setAttribute('aria-label',`${value?'Unpin':'Pin'} Redis Search`);if(value)open();else resetContent();}
  toggle.addEventListener('click',()=>control.classList.contains('collapsed')?open():close());
  pin.addEventListener('click',()=>setPinned(!pinned));
  control.addEventListener('mouseenter',()=>{clearTimeout(hoverTimer);hoverTimer=setTimeout(open,140);});
  control.addEventListener('mouseleave',()=>{clearTimeout(hoverTimer);hoverTimer=setTimeout(()=>{if(!pinned&&!control.matches(':hover'))close();},420);});
  control.addEventListener('focusin',event=>{if(event.target.matches(':focus-visible'))open();});
  control.addEventListener('focusout',()=>{if(!pinned&&!control.matches(':hover'))hoverTimer=setTimeout(()=>{if(!control.contains(document.activeElement))close();},420);});
  control.addEventListener('keydown',event=>{if(event.key==='Escape'){setPinned(false);toggle.focus();close();}});
  const otherTrayOpened=()=>close();
  window.addEventListener('gev:dock-tray-opened',otherTrayOpened);
  const dockObserver=new MutationObserver(()=>{if(!control.classList.contains('collapsed'))positionPanel();});
  for(const id of ['control-panel','location-bar'])dockObserver.observe(document.getElementById(id),{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',positionPanel);
  // Selection and layer state can change while the tray remains pinned.
  const unsubscribeLayers=dataManager.subscribe(()=>{if(!control.classList.contains('collapsed'))refreshOptions();});
  const optionTimer=setInterval(()=>{if(!control.classList.contains('collapsed'))refreshOptions();},500);
  let epoch=0,abort=null,timer=null,recorder=null,stream=null,audio=null,meterTimer=null,recordTimeout=null,marker=null,selection=null;
  const setStatus=text=>{status.textContent=text;};
  function releaseMicrophone(){clearInterval(meterTimer);clearTimeout(recordTimeout);stream?.getTracks().forEach(t=>t.stop());stream=null;audio?.close().catch(()=>{});audio=null;button.classList.remove('recording');button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Start voice input');}
  function cancel(){epoch++;abort?.abort();clearTimeout(timer);if(recorder?.state==='recording')recorder.stop();releaseMicrophone();recorder=null;}
  function dismiss(){cancel();response.hidden=true;results.replaceChildren();setStatus('');if(marker){if(viewer.selectedEntity===marker)viewer.selectedEntity=undefined;viewer.entities.remove(marker);marker=null;}selection=null;}
  panel.querySelector('[data-action=dismiss]').addEventListener('click',dismiss);
  async function post(path,body,signal,raw=false){
    const response=await fetch('/api/redis/search/'+path,{method:'POST',headers:{'Content-Type':raw?body.type:'application/json'},body:raw?body:JSON.stringify(body),signal});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Redis search failed');return payload;
  }
  function context(){
    let viewport=null;const rect=viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if(rect)viewport=Object.fromEntries(['west','east','south','north'].map(k=>[k,Cesium.Math.toDegrees(rect[k])]));
    const chosen=getSelectedEntityContext({dataManager});
    const selected=marker && viewer.selectedEntity===marker ? selection : chosen?{id:chosen.id,layer:chosen.layerId,label:chosen.label,latitude:chosen.latitude,longitude:chosen.longitude}:null;
    return {viewport,selected};
  }
  async function focus(row,layer,generation){
    if(generation!==epoch)return;
    selection={id:row.id,layer,label:row.name||row.label,latitude:row.latitude,longitude:row.longitude};
    const module=dataManager.layers.get(layer)?.module;
    if(dataManager.isEnabled(layer)){
      const tracked=module?.trackById?.(row.id,{origin:'redis-search'});
      if(tracked)return;
      module?.selectById?.(row.id);
    }
    // A Redis result can outlive its disabled/filtered layer. Show its actual
    // stored position without triggering a new provider fetch or clearing filters.
    if(!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude)){setStatus('Result found · no position available to focus');return;}
    if(marker)viewer.entities.remove(marker);
    const position=Cesium.Cartesian3.fromDegrees(row.longitude,row.latitude,Math.max(0,row.altitudeM||0));
    marker=viewer.entities.add({id:'redis-search-result',position,point:{pixelSize:9,color:Cesium.Color.CYAN,disableDepthTestDistance:Number.POSITIVE_INFINITY},label:{text:String(row.name||row.label||row.id),font:'12px monospace',pixelOffset:new Cesium.Cartesian2(0,-22),disableDepthTestDistance:Number.POSITIVE_INFINITY}});
    viewer.trackedEntity=undefined;viewer.selectedEntity=marker;
    await viewer.flyTo(marker,{duration:1.2,offset:new Cesium.HeadingPitchRange(0,-Math.PI/4,Math.max(8000,Math.min(500000,(row.altitudeM||0)*0.3)))});
    viewer.scene.requestRender();
  }
  function render(result,generation){
    results.replaceChildren();
    description.textContent=[result.explanation,result.regionLabel,result.layer==='satellites'?'Satellite positions and speeds are dated orbital estimates.':''].filter(Boolean).join(' · ');
    command.textContent=result.command.map(arg=>/\s/.test(arg)?JSON.stringify(arg):arg).join(' ');
    if(!result.rows.length){results.textContent='No matching objects in Redis.';return;}
    if(result.operation==='aggregate'){
      const table=document.createElement('table'),head=document.createElement('tr');
      const keys=[...new Set(result.rows.flatMap(row=>Object.keys(row)))];
      for(const key of keys){const th=document.createElement('th');th.textContent=key;head.appendChild(th);}table.appendChild(head);
      for(const row of result.rows){const tr=document.createElement('tr');for(const key of keys){const td=document.createElement('td');const value=row[key];td.textContent=value==null?'—':Number.isFinite(Number(value))?Number(value).toLocaleString(undefined,{maximumFractionDigits:3}):String(value);tr.appendChild(td);}table.appendChild(tr);}
      results.appendChild(table);
    }else{
      for(const row of result.rows){const item=document.createElement('button');item.type='button';item.className='redis-search-result';
        const title=document.createElement('strong');title.textContent=row.name||row.label||row.id;item.appendChild(title);
        const detail=document.createElement('span');detail.textContent=[row.typeName||row.type||row.source?.t,Number.isFinite(row.speedMps)?`${row.speedMps.toFixed(1)} m/s`:null,Number.isFinite(row.distanceM)?`${(row.distanceM/1000).toFixed(1)} km away`:null].filter(Boolean).join(' · ');item.appendChild(detail);
        item.addEventListener('click',()=>void focus(row,result.layer,generation).catch(error=>setStatus(error.message)));results.appendChild(item);
      }
    }
  }
  const layerStates=()=>dataManager.getAll().map(layer=>({id:layer.id,name:layer.name,enabled:dataManager.isEffectivelyEnabled(layer.id)}));
  async function submit(text,presetId=null){
    if(!presetId&&!openAIConfigured)return;
    cancel();open();response.hidden=false;const generation=epoch;abort=new AbortController();const signal=abort.signal;
    input.value=text;results.replaceChildren();description.textContent='';command.textContent='';
    if(!redisEnabled()){setStatus('Turn Redis ON in Data Layers to search.');return;}
    try{
      setStatus(presetId?'Running quick search…':'Reading index schemas · generating query…');
      const plan=await post(presetId?'preset':'plan',{text,presetId,context:context(),layers:layerStates()},signal);if(generation!==epoch)return;
      command.textContent=plan.command.join(' ');setStatus(`Running ${plan.command[0]}…`);
      let first=true;
      const run=async()=>{
        if(!redisEnabled()){setStatus('Turn Redis ON in Data Layers to search.');return;}
        if(!dataManager.isEffectivelyEnabled(plan.layer)){results.replaceChildren();description.textContent='';setStatus(`Enable ${dataManager.layers.get(plan.layer)?.module?.name||plan.layer} in Data Layers before searching it.`);return;}
        const started=performance.now();
        try{
          const result=await post('run',{id:plan.id,layers:layerStates()},signal);if(generation!==epoch)return;
          render(result,generation);
          if(first)setPinned(true);
          setStatus(`${result.operation==='aggregate'?'Live · every 2s':`${result.total} match${result.total===1?'':'es'}`} · ${new Date(result.at).toLocaleTimeString()} · ${result.elapsedMs} ms`);
          if(first&&result.focus&&result.operation!=='aggregate'&&result.rows[0])void focus(result.rows[0],result.layer,generation).catch(error=>{if(generation===epoch)setStatus(error.message);});
          first=false;
        }catch(error){if(generation!==epoch||signal.aborted)return;setStatus(`⚠ ${error.message}${plan.operation==='aggregate'?' · retrying':''}`);}
        if(plan.operation==='aggregate'&&generation===epoch&&!signal.aborted)timer=setTimeout(run,Math.max(0,2000-(performance.now()-started)));
      };
      await run();
    }catch(error){if(!signal.aborted&&generation===epoch)setStatus(`⚠ ${error.message}`);}
  }
  panel.querySelector('form').addEventListener('submit',event=>{event.preventDefault();if(input.value.trim())void submit(input.value.trim());});
  async function listen(){
    if(!openAIConfigured)return;
    if(recorder?.state==='recording'){recorder.stop();return;}
    cancel();open();response.hidden=false;results.replaceChildren();description.textContent='';command.textContent='';
    setStatus('What do you want to search for?');
    if(!redisEnabled()){setStatus('Turn Redis ON in Data Layers to search.');return;}
    const generation=epoch;abort=new AbortController();const signal=abort.signal;
    try{
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Microphone recording is unavailable; type your search below');
      const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
      if(generation!==epoch){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;
      const mime=['audio/webm','audio/mp4','audio/ogg'].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});const chunks=[];const current=recorder;
      current.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      current.onstop=async()=>{
        if(generation!==epoch)return;releaseMicrophone();recorder=null;
        try{setStatus('Transcribing…');const transcript=await post('transcribe',new Blob(chunks,{type:current.mimeType.split(';')[0]}),signal,true);
          if(generation===epoch){if(!transcript.text?.trim())throw new Error('No speech detected. Try again.');await submit(transcript.text.trim());}
        }catch(error){if(!signal.aborted&&generation===epoch)setStatus(`⚠ ${error.message}`);}
      };
      current.onerror=()=>{if(generation===epoch){cancel();setStatus('Recording failed. Try again or type your search.');}};
      const AudioContext=window.AudioContext||window.webkitAudioContext;
      if(AudioContext){
        audio=new AudioContext();await audio.resume();
        const tone=audio.createOscillator(),gain=audio.createGain();tone.connect(gain);gain.connect(audio.destination);
        tone.frequency.setValueAtTime(660,audio.currentTime);tone.frequency.setValueAtTime(880,audio.currentTime+0.09);
        gain.gain.setValueAtTime(0.08,audio.currentTime);gain.gain.exponentialRampToValueAtTime(0.001,audio.currentTime+0.2);
        tone.start();tone.stop(audio.currentTime+0.21);
        await new Promise(resolve=>setTimeout(resolve,260));
        if(generation!==epoch)return;
      }
      current.start();button.setAttribute('aria-label','Stop voice input');button.classList.add('recording');button.setAttribute('aria-pressed','true');setStatus('What do you want to search for? Listening…');
      if(audio){const analyser=audio.createAnalyser();analyser.fftSize=512;audio.createMediaStreamSource(stream).connect(analyser);const samples=new Uint8Array(analyser.fftSize);let heard=false,lastSpeech=performance.now();
        meterTimer=setInterval(()=>{analyser.getByteTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((sum,n)=>sum+((n-128)/128)**2,0)/samples.length);if(rms>0.02){heard=true;lastSpeech=performance.now();}if(heard&&performance.now()-lastSpeech>1400&&current.state==='recording')current.stop();},100);}
      recordTimeout=setTimeout(()=>{if(current.state==='recording')current.stop();},30000);
    }catch(error){if(generation===epoch){releaseMicrophone();setStatus(`⚠ ${error.message}`);}}
  }
  button.addEventListener('click',()=>void listen());
  const api={stop:dismiss,submit,dismiss};
  window.addEventListener('pagehide',()=>{dismiss();clearInterval(optionTimer);unsubscribeLayers();window.removeEventListener('gev:dock-tray-opened',otherTrayOpened);dockObserver.disconnect();window.removeEventListener('resize',positionPanel);});
  return api;
}
