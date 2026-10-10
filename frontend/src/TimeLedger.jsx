import { AlertCircle } from 'lucide-react';

const time = value => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo', hourCycle: 'h23' }).format(new Date(value));
function Amount({ value }) { return <>{value == null ? '—' : value}<small>{value == null ? '' : ' 分'}</small></>; }
export function TimeBalance({ ledger, error, record, today }) {
  const recent=ledger?.recent;
  const learned=recent?.today_learning_minutes ?? (record?.date===today ? record.total_minutes : null);
  const date=value=>value ? value.slice(5).replace('-','/') : '';
  return <section className="day-overview" aria-label="今日の学習と時間の残高">
    <div className="overview-metrics">
      <div className="overview-metric"><h2>今日の学習時間</h2><div className="total"><span className="total-number">{learned ?? '—'}</span>{learned!=null && <span className="total-unit">分</span>}</div></div>
      <div className="overview-metric"><h2>時間の残高</h2><div className="ledger-balance"><strong className={`${recent?.balance_minutes<0 ? 'negative' : ''} ${String(recent?.balance_minutes ?? '').length>5 ? 'compact-amount' : ''}`}><Amount value={recent?.balance_minutes} /></strong></div><p className="balance-period">昨日・今日 {recent ? `（${date(recent.window_start)}・${date(recent.window_end)}）` : ''}</p></div>
    </div>
    {recent ? <>
      <dl className="ledger-totals"><div><dt>2日分の学習</dt><dd><Amount value={recent.total_learning_minutes} /></dd></div><div><dt>2日分の付与（確認済み）</dt><dd><Amount value={recent.total_granted_minutes} /></dd></div></dl>
      {recent.pending_count>0 && <p className="ledger-pending"><AlertCircle size={18}/><span>昨日・今日の付与{recent.pending_count}件が未確認です。</span></p>}
      {recent.missing_learning_days.length>0 && <p className="ledger-note">{recent.missing_learning_days.map(date).join('・')}の学習記録が未取得です。</p>}
      {recent.integration_status!=='connected' && <p className="ledger-note">PCの最新記録を確認できていません。</p>}
    </> : <p className="ledger-note">{error || 'PCの時間記録はまだ接続されていません。'}</p>}
  </section>;
}
export function TimeHistory({ ledger }) {
  return <div className="ledger-history">
    <section><h2>PC時間の付与履歴</h2><div className="ledger-table-scroll"><table><thead><tr><th>日時</th><th>付与時間</th><th>確認状態</th></tr></thead>
      <tbody>{ledger?.grant_history?.length ? ledger.grant_history.map(e => <tr key={e.event_id}>
        <td><time dateTime={e.occurred_at}>{time(e.occurred_at)}</time><small className="ledger-source">Windowsの追加時間記録</small></td>
        <td>{e.confirmation_status === 'confirmed' ? `${e.granted_minutes}分` : e.estimated_minutes == null ? '分数不明' : `推定 ${e.estimated_minutes}分`}</td>
        <td><span className={`ledger-status ${e.confirmation_status === 'confirmed' ? 'confirmed' : ''}`}>{e.confirmation_status === 'confirmed' ? '確認済み' : '要確認'}</span></td>
      </tr>) : <tr><td colSpan="3">付与記録はまだありません。</td></tr>}</tbody></table></div></section>
    <section><h2>日別の学習履歴</h2><table><thead><tr><th>学習日</th><th>学習時間</th><th>最終取得</th></tr></thead><tbody>
      {ledger?.learning_history?.length ? ledger.learning_history.map(d => <tr key={d.date}><td>{d.date}</td><td>{d.total_minutes}分</td><td>{time(d.fetched_at)}</td></tr>) : <tr><td colSpan="3">学習記録はまだありません。</td></tr>}
    </tbody></table></section>
  </div>;
}
