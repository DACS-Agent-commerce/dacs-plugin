// Reads a server log at info or debug level. At info the server writes one
// `purchase_timeline` line per purchase stage carrying that stage's steps; at
// debug it also writes every step as its own `purchase_step` line. For each
// purchase the per-step lines are used when the log has any, otherwise the
// steps from its timeline lines, so no step is counted twice.
export function purchaseTimeline(log) {
  const steps=new Map(),summaries=new Map();
  const add=(map,event)=>{const rows=map.get(event.purchaseId) ?? [];rows.push(event);map.set(event.purchaseId,rows);};
  const valid=(event)=>Number.isSafeInteger(event?.timestampMs)&&typeof event.purchaseId==='string';
  for(const line of log.split('\n')) {
    let entry;
    try { entry=JSON.parse(line.slice(line.indexOf('{'))); } catch { continue; /* mixed server logs */ }
    if(entry?.event==='purchase_step'&&valid(entry))add(steps,entry);
    else if(entry?.event==='purchase_timeline'&&typeof entry.purchaseId==='string'&&Array.isArray(entry.steps)) {
      for(const step of entry.steps){const event={...step,event:'purchase_step',purchaseId:entry.purchaseId,jobId:entry.jobId ?? null};if(valid(event))add(summaries,event);}
    }
  }
  const purchases=new Map();
  for(const id of new Set([...steps.keys(),...summaries.keys()])) {
    const rows=[];
    for(const event of [...(steps.get(id) ?? summaries.get(id))].sort((a,b)=>a.timestampMs-b.timestampMs)) {
      const previous=rows.at(-1),previousAt=previous?(previous.lastTimestampMs ?? previous.timestampMs):0;
      rows.push({...event,gapMs:previous?Math.max(0,event.timestampMs-(event.durationMs ?? 0)-previousAt):0});
    }
    purchases.set(id,rows);
  }
  return purchases;
}

export function formatTimeline(log) {
  return [...purchaseTimeline(log)].map(([id,events])=>[id,'  elapsed ms | duration ms | gap ms | step',...events.map(event=>`  ${String(event.timestampMs-events[0].timestampMs).padStart(10)} | ${String(event.durationMs ?? '—').padStart(11)} | ${String(event.gapMs).padStart(6)} | ${event.artifactKind ? `${event.artifactKind} ` : ''}${event.step} ${event.phase}${event.action ? ` ${event.action}` : ''}${event.stage ? ` ${event.stage}` : ''}${event.hash ? ` ${event.hash.slice(0,12)}` : ''}${event.count>1 ? ` x${event.count} over ${event.lastTimestampMs-event.timestampMs} ms` : ''}`)].join('\n')).join('\n\n');
}
