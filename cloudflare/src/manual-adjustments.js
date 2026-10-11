import { todayJst } from './learning.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function readAdjustments(db) {
  return (await db.prepare('SELECT request_id,effective_date,created_at,delta_minutes,note,reversal_of FROM manual_adjustments ORDER BY created_at DESC,request_id').all()).results;
}
export async function adjustmentApi(request,env,now=Date.now()) {
  const url=new URL(request.url);
  if (request.method!=='POST') return [405,{message:'method_not_allowed'}];
  if (request.headers.get('Origin')!==url.origin || request.headers.get('X-Balance-Request')!=='1') return [403,{message:'forbidden'}];
  if (!env.LEDGER_DB) return [503,{message:'調整の保存先を利用できません。'}];
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return [415,{message:'json_required'}];
  const body=await request.text();
  if (body.length>4096) return [413,{message:'request_too_large'}];
  let value;
  try { value=JSON.parse(body); } catch { return [400,{message:'入力内容を確認してください。'}]; }
  const undo=typeof value?.reversal_of==='string';
  const fields=undo ? ['request_id','reversal_of'] : ['request_id','delta_minutes','note'];
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!fields.includes(k)) ||
    typeof value.request_id!=='string' || !uuid.test(value.request_id) || (undo ? !uuid.test(value.reversal_of) : !Number.isInteger(value.delta_minutes) ||
    value.delta_minutes===0 || Math.abs(value.delta_minutes)>1440 || (value.note!=null && (typeof value.note!=='string' || value.note.length>120)))) return [400,{message:'入力内容を確認してください。'}];
  try {
    const match=row=>undo ? row.reversal_of===value.reversal_of : row.reversal_of==null && row.delta_minutes===value.delta_minutes && row.note===(value.note || '');
    const existing=await env.LEDGER_DB.prepare('SELECT delta_minutes,note,reversal_of FROM manual_adjustments WHERE request_id=?').bind(value.request_id).first();
    if (existing) return match(existing) ? [200,{saved:true,replayed:true}] : [409,{message:'同じ操作番号に違う調整が届きました。画面を読み直してください。'}];
    let delta=value.delta_minutes,date=todayJst(now),note=value.note || '';
    if (undo) {
      const original=await env.LEDGER_DB.prepare('SELECT effective_date,delta_minutes,reversal_of FROM manual_adjustments WHERE request_id=?').bind(value.reversal_of).first();
      if (!original) return [404,{message:'調整の記録が見つかりません。'}];
      if (original.reversal_of!=null || original.effective_date<todayJst(now-86400000) || original.effective_date>date) return [409,{message:'この調整は取り消せません。対象は今日・昨日の調整です。'}];
      // A cancellation expires with its original, even when canceled on the following day.
      delta=-original.delta_minutes;date=original.effective_date;note='取り消し';
    }
    await env.LEDGER_DB.prepare(`INSERT INTO manual_adjustments(request_id,effective_date,created_at,delta_minutes,note,reversal_of)
      VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(value.request_id,date,new Date(now).toISOString(),delta,note,undo ? value.reversal_of : null).run();
    const stored=await env.LEDGER_DB.prepare('SELECT delta_minutes,note,reversal_of FROM manual_adjustments WHERE request_id=?').bind(value.request_id).first();
    return stored && match(stored) ? [200,{saved:true}] : [409,{message:'すでに取り消されたか、同じ操作番号で別の調整が保存されています。画面を読み直してください。'}];
  } catch { return [503,{message:'調整を保存できませんでした。前の記録は保持しています。'}]; }
}
