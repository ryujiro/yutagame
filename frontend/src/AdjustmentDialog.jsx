import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Minus, X, Undo2 } from 'lucide-react';

export const signedMinutes=value=>`${value>0 ? '+' : ''}${value}分`;
export function AdjustmentDialog({ undo, onClose, onSaved }) {
  const dialog=useRef(null),operation=useRef(null);
  const [minutes,setMinutes]=useState(30),[direction,setDirection]=useState(1),[note,setNote]=useState('');
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const node=dialog.current;node.showModal();return ()=>node.close();},[]);
  async function submit(event) {
    event.preventDefault();if(busy) return;
    if (!undo && (!Number.isInteger(Number(minutes)) || Number(minutes)<1 || Number(minutes)>1440)) {setError('分数は1〜1440の整数で入力してください。');return;}
    const payload=operation.current || {request_id:crypto.randomUUID(),...(undo ? {reversal_of:undo.request_id} : {delta_minutes:direction*Number(minutes),note:note.trim()})};
    operation.current=payload;setBusy(true);setError('');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch('/api/manual-adjustments',{method:'POST',headers:{'Content-Type':'application/json','X-Balance-Request':'1'},body:JSON.stringify(payload),signal:controller.signal});
      const result=await response.json();
      if(response.ok && result.saved) {await onSaved();return;}
      if(response.status<500) {operation.current=null;setUncertain(false);setError(result.message || '入力内容を確認してください。');return;}
      throw new Error('unconfirmed');
    } catch {
      // Reconcile a lost acknowledgement with GET; never automatically repeat a write.
      const check=new AbortController(),checkTimer=setTimeout(()=>check.abort(),5000);
      try {
        const response=await fetch('/api/dashboard',{cache:'no-store',signal:check.signal}),data=await response.json();
        if(response.ok && data.ledger?.adjustment_history?.some(a=>a.request_id===payload.request_id)) {await onSaved();return;}
      } catch { /* Keep the same operation id for a deliberate retry. */ }
      finally {clearTimeout(checkTimer);}
      setUncertain(true);setError('保存結果を確認できませんでした。再確認しても同じ調整は重複しません。');
    } finally {clearTimeout(timer);setBusy(false);}
  }
  return <dialog ref={dialog} className="adjustment-dialog" aria-labelledby="adjustment-title" onCancel={event=>{event.preventDefault();if(!busy) onClose();}}>
    <form onSubmit={submit}>
      <header><h2 id="adjustment-title">{undo ? '調整を取り消す' : '手動調整を追加'}</h2><button type="button" className="icon-button" title="閉じる" aria-label="閉じる" disabled={busy} onClick={onClose}><X size={20}/></button></header>
      {undo ? <div className="undo-summary"><Undo2 size={20}/><strong>{signedMinutes(undo.delta_minutes)}</strong><span>{undo.note || '手動調整'}</span></div> : <fieldset disabled={busy || uncertain}>
        <legend className="sr-only">調整内容</legend>
        <div className="adjustment-modes" role="group" aria-label="加算・減算">
          <button type="button" aria-pressed={direction===1} onClick={()=>setDirection(1)}><Plus size={18}/>加算</button>
          <button type="button" aria-pressed={direction===-1} onClick={()=>setDirection(-1)}><Minus size={18}/>減算</button>
        </div>
        <label className="adjustment-field">調整時間（分）<input type="number" min="1" max="1440" step="1" required value={minutes} onChange={event=>setMinutes(event.target.value)} autoFocus inputMode="numeric"/></label>
        <div className="adjustment-presets">{[10,30,60].map(value=><button type="button" key={value} onClick={()=>setMinutes(value)} aria-pressed={Number(minutes)===value}>{value}分</button>)}</div>
        <label className="adjustment-field">メモ（任意）<input type="text" maxLength="120" value={note} onChange={event=>setNote(event.target.value)}/></label>
      </fieldset>}
      {error && <p className="adjustment-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>キャンセル</button><button type="submit" className="adjustment-submit" disabled={busy}>{undo ? <Undo2 size={18}/> : <Check size={18}/>}<span>{busy ? '保存中' : uncertain ? '保存結果を再確認' : undo ? '取り消す' : '追加する'}</span></button></footer>
    </form>
  </dialog>;
}
