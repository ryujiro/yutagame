import { useState } from 'react';
import { AlertCircle, Info, Plus, Undo2, RefreshCw } from 'lucide-react';
import { AdjustmentDialog, signedMinutes } from './AdjustmentDialog.jsx';

const time = value => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo', hourCycle: 'h23' }).format(new Date(value));
const jstDay = value => new Date(Date.parse(value)+9*3600000).toISOString().slice(0,10);
function Amount({ value }) { return <>{value == null ? '—' : value}<small>{value == null ? '' : ' 分'}</small></>; }
export function TimeBalance({ ledger, error, record, today, reload }) {
  const [editing,setEditing]=useState(null),[notice,setNotice]=useState('');
  const [reloading,setReloading]=useState(false);
  const recent=ledger?.carry;
  const estimated=recent?.pending_count>0;
  const balance=recent?.estimated_balance_minutes;
  const granted=recent?.today_granted_minutes;
  const refreshBalance=async()=>{setReloading(true);try {await reload();} finally {setReloading(false);}};
  const learned=recent?.today_learning_minutes ?? (record?.date===today ? record.total_minutes : null);
  const date=value=>value ? value.slice(5).replace('-','/') : '';
  const canceled=new Set((ledger?.adjustment_history || []).map(a=>a.reversal_of).filter(Boolean));
  const close=()=>{setEditing(null);reload();};
  const saved=async()=>{await reload();setNotice(editing?.undo ? '調整を取り消しました。' : '調整を追加しました。');setEditing(null);};
  return <section className="day-overview" aria-label="今日の学習と時間の残高">
    <div className="overview-metrics">
      <div className="overview-metric"><h2>今日の学習時間</h2><div className="total"><span className="total-number">{learned ?? '—'}</span>{learned!=null && <span className="total-unit">分</span>}</div></div>
      <div className="overview-metric"><div className="balance-heading"><h2>時間の残高</h2><button type="button" className="icon-button balance-refresh" title="残高の記録を更新" aria-label="残高を更新" disabled={reloading} onClick={refreshBalance}><RefreshCw size={17} className={reloading ? 'spinning' : ''}/></button></div><div className="ledger-balance"><strong className={`${balance<0 ? 'negative' : ''} ${String(balance ?? '').length>5 ? 'compact-amount' : ''}`}><Amount value={balance} /></strong></div>{estimated && <p className="balance-basis">推定</p>}<p className="balance-period">繰り越し＋今日の増減</p></div>
    </div>
    <div className="manual-adjustments">
      <div className="adjustment-heading"><h3>手動調整</h3><button type="button" className="icon-button" title="調整を追加" aria-label="手動調整を追加" disabled={!ledger?.adjustment_ready} onClick={()=>{setNotice('');setEditing({});}}><Plus size={20}/></button></div>
      {recent?.adjustment_history?.length ? <ul className="adjustment-list">{recent.adjustment_history.map(a=><li key={a.request_id} className={canceled.has(a.request_id) ? 'canceled' : ''}>
        <div><span className="adjustment-label">{a.reversal_of ? '取り消し' : a.note || '手動調整'}{canceled.has(a.request_id) && <small>取消済み</small>}</span><time dateTime={a.created_at}>{time(a.created_at)}{a.effective_date!==jstDay(a.created_at) ? `（${date(a.effective_date)}分）` : ''}</time></div>
        <strong className={a.delta_minutes<0 ? 'negative' : ''}>{signedMinutes(a.delta_minutes)}</strong>
        {!a.reversal_of && !canceled.has(a.request_id) ? <button type="button" className="icon-button" title="この調整を取り消す" aria-label={`取り消す ${signedMinutes(a.delta_minutes)}`} disabled={!ledger?.adjustment_ready} onClick={()=>{setNotice('');setEditing({undo:a});}}><Undo2 size={18}/></button> : <span className="adjustment-action-placeholder"/>}
      </li>)}</ul> : <p className="adjustment-empty">調整なし</p>}
      {ledger?.adjustment_error && <p className="adjustment-error" role="alert">{ledger.adjustment_error}</p>}
      {notice && <p className="adjustment-notice" role="status">{notice}</p>}
    </div>
    {recent ? <>
      <dl className="ledger-totals carry-totals"><div><dt>以前からの繰り越し</dt><dd><Amount value={recent.earlier_carry_minutes} /></dd></div><div><dt>昨日の増減</dt><dd><Amount value={recent.yesterday_net_minutes} /></dd></div><div><dt>今日への繰り越し</dt><dd><Amount value={recent.carry_in_minutes} /></dd></div></dl>
      <p className="ledger-note">昨日の増減＝学習−PC付与＋調整。前日終了時の残高がマイナスなら、翌日の繰り越しは0分です。</p>
      <dl className="ledger-totals today-totals"><div><dt>今日の学習</dt><dd><Amount value={recent.today_learning_minutes} /></dd></div><div><dt>今日のPC付与（{recent.today_pending_count>0 ? '推定含む' : '確認済み'}）</dt><dd><Amount value={granted} /></dd></div><div><dt>今日の手動調整</dt><dd><Amount value={recent.manual_adjustment_minutes ?? 0} /></dd></div></dl>
      {recent.unestimated_grant_count>0 ? <p className="ledger-pending"><AlertCircle size={18}/><span>付与{recent.unestimated_grant_count}件の分数が不明です。</span></p> : estimated && <p className="ledger-estimated"><Info size={18}/><span>推定の付与{recent.pending_count}件を含みます。</span></p>}
      {recent.missing_learning_days.length>0 && <p className="ledger-note">{recent.missing_learning_days.map(date).join('・')}の学習記録が未取得です。</p>}
      {recent.integration_status!=='connected' && <p className="ledger-note">PCの最新記録を確認できていません。{recent.last_sync_at && `最終受信 ${time(recent.last_sync_at)}時点の記録です。`}</p>}
    </> : <p className="ledger-note">{error || ledger?.carry_error || ledger?.adjustment_error || 'PCの時間記録はまだ接続されていません。'}</p>}
    {editing && <AdjustmentDialog undo={editing.undo} onClose={close} onSaved={saved}/>}
  </section>;
}
export function TimeHistory({ ledger }) {
  return <div className="ledger-history">
    <section><h2>手動調整の履歴</h2><table><thead><tr><th>日時</th><th>調整時間</th><th>メモ</th></tr></thead><tbody>
      {ledger?.adjustment_history?.length ? ledger.adjustment_history.map(a=><tr key={a.request_id}><td><time dateTime={a.created_at}>{time(a.created_at)}</time><small className="ledger-source">{a.effective_date}分</small></td><td>{signedMinutes(a.delta_minutes)}</td><td>{a.note || '手動調整'}</td></tr>) : <tr><td colSpan="3">調整記録はまだありません。</td></tr>}
    </tbody></table></section>
    <section><h2>PC時間の付与履歴</h2><div className="ledger-table-scroll"><table><thead><tr><th>日時</th><th>付与時間</th><th>確認状態</th></tr></thead>
      <tbody>{ledger?.grant_history?.length ? ledger.grant_history.map(e => <tr key={e.event_id}>
        <td><time dateTime={e.occurred_at}>{time(e.occurred_at)}</time><small className="ledger-source">Windowsの追加時間記録</small></td>
        <td>{e.confirmation_status === 'confirmed' ? `${e.granted_minutes}分` : e.estimated_minutes == null ? '分数不明' : `推定 ${e.estimated_minutes}分`}</td>
        <td><span className={`ledger-status ${e.confirmation_status === 'confirmed' ? 'confirmed' : ''}`}>{e.confirmation_status === 'confirmed' ? '確認済み' : e.estimated_minutes==null ? '分数不明' : '推定'}</span></td>
      </tr>) : <tr><td colSpan="3">付与記録はまだありません。</td></tr>}</tbody></table></div></section>
    <section><h2>日別の学習履歴</h2><table><thead><tr><th>学習日</th><th>学習時間</th><th>最終取得</th></tr></thead><tbody>
      {ledger?.learning_history?.length ? ledger.learning_history.map(d => <tr key={d.date}><td>{d.date}</td><td>{d.total_minutes}分</td><td>{time(d.fetched_at)}</td></tr>) : <tr><td colSpan="3">学習記録はまだありません。</td></tr>}
    </tbody></table></section>
  </div>;
}
