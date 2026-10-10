import { AlertCircle, Coins } from 'lucide-react';

const time = value => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo', hourCycle: 'h23' }).format(new Date(value));
function Amount({ value }) { return <>{value == null ? '—' : value}<small>{value == null ? '' : ' 分'}</small></>; }
export function TimeBalance({ ledger, error }) {
  if (!ledger) return <section className="time-ledger"><h2><Coins size={21} />時間の残高</h2><p className="ledger-note">{error || 'PCの時間記録はまだ接続されていません。'}</p></section>;
  const rows = [
    ['今日の学習',ledger.today_learning_minutes], ['今日の付与（確認済み）',ledger.today_granted_minutes],
    ['累計学習',ledger.total_learning_minutes], ['累計付与（確認済み）',ledger.total_granted_minutes],
  ];
  return <section className="time-ledger" aria-label="学習とPC時間の残高">
    <h2><Coins size={21} />時間の残高</h2>
    <div className="ledger-balance"><span>利用可能な残高</span><strong><Amount value={ledger.balance_minutes} /></strong></div>
    <dl className="ledger-totals">{rows.map(([label,value]) => <div key={label}><dt>{label}</dt><dd><Amount value={value} /></dd></div>)}</dl>
    {ledger.pending_count > 0 && <p className="ledger-pending"><AlertCircle size={18} /><span>付与{ledger.pending_count}件が要確認です。</span></p>}
    {ledger.confirmed_balance_minutes != null && <p className="ledger-note">保存済み学習 − 確認済み付与：{ledger.confirmed_balance_minutes}分</p>}
    {ledger.missing_learning_days?.length > 0 && <p className="ledger-note">学習記録がない日が{ledger.missing_learning_days.length}日あります。過去の持ち越し残高は未確定です。</p>}
    {ledger.integration_status !== 'connected' && <p className="ledger-note">{ledger.integration_status === 'stale' ? 'PCの最新記録を確認できていません。' : 'PCからの記録を待っています。'}</p>}
    <p className="ledger-note">記録が残っている期間の集計{ledger.coverage_start ? `（学習：${ledger.coverage_start}から）` : ''}。未確認の付与は累計に含まれていません。</p>
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
