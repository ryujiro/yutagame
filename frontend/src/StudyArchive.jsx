import { useState } from 'react';

const duration = minutes => `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
const dateLabel = day => day.replaceAll('-', '/');
const monthLabel = month => `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;

export function StudyArchive({ data, error }) {
  const [month, setMonth] = useState('all');
  const months = data?.months || [];
  const selected = months.some(row => row.month === month) ? month : 'all';
  const days = (data?.days || []).filter(row => selected === 'all' || row.date.startsWith(selected));
  return <section className="study-archive" aria-labelledby="archive-title">
    <h2 id="archive-title">これまでの取り組み</h2>
    {error && <p className="archive-status archive-error" role="status">{error}</p>}
    {data?.total_minutes != null ? <>
      <div className="archive-summary"><div><span>累計学習時間</span><strong>{duration(data.total_minutes)}</strong><small>{data.total_minutes.toLocaleString('ja-JP')}分</small></div><div><span>記録のある日</span><strong>{data.recorded_days}<small>日</small></strong></div></div>
      <p className="archive-period">{dateLabel(data.first_date)} 〜 {dateLabel(data.last_date)}</p>
      <p className={`archive-status ${data.scan?.status === 'error' ? 'archive-error' : ''}`} role="status">{data.scan?.status === 'complete' ? '中学生コースの取得可能な履歴を取得済み' : data.scan?.status === 'error' ? '過去の取得が途中で止まりました。取得済みの記録を表示しています。' : data.scan?.status === 'partial' ? '過去の記録を取得途中です。' : '保存済みの学習記録'}</p>
      <table className="archive-table"><caption className="sr-only">月別の累計学習時間</caption><thead><tr><th scope="col">月</th><th scope="col">学習時間</th><th scope="col">記録日数</th></tr></thead><tbody>{months.map(row => <tr key={row.month}><th scope="row">{monthLabel(row.month)}</th><td>{row.total_minutes.toLocaleString('ja-JP')}分</td><td>{row.recorded_days}日</td></tr>)}</tbody></table>
      <details className="archive-days"><summary>日別の記録</summary><label className="archive-filter">表示する月<select value={selected} onChange={event => setMonth(event.target.value)}><option value="all">すべて</option>{months.map(row => <option key={row.month} value={row.month}>{monthLabel(row.month)}</option>)}</select></label><table className="archive-table"><caption className="sr-only">日別の学習時間</caption><thead><tr><th scope="col">学習日</th><th scope="col">学習時間</th></tr></thead><tbody>{days.map(row => <tr key={row.date}><th scope="row"><time dateTime={row.date}>{dateLabel(row.date)}</time></th><td>{row.total_minutes}分</td></tr>)}</tbody></table></details>
    </> : <p className="archive-status">過去の学習時間はまだ取得していません。</p>}
  </section>;
}
