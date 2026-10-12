const SUBJECTS = [ ['数学', '#3267a6'], ['英語', '#de8b17'], ['国語', '#d95749'], ['理科', '#239774'], ['社会', '#7464ba'] ];
const monthLabel = month => `${Number(month.slice(0,4))}年${Number(month.slice(5))}月`;
const fetchedTime = value => new Intl.DateTimeFormat('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Tokyo', hourCycle:'h23' }).format(new Date(value));
const difference = (count, target) => count > target ? `+${count-target}` : String(count-target);

export function MonthlyStudy({ record, error, today, history = false }) {
  const month = record?.month || today?.slice(0,7);
  return <section className="monthly-study" aria-label={history ? `${monthLabel(month)}の取り組み履歴` : '今月の取り組み'}>
    <header className="monthly-heading"><h2>{month ? `${monthLabel(month)}の取り組み` : '今月の取り組み'}</h2>{record && <span>中{record.grade}</span>}</header>
    {error && <p className="monthly-error" role="status">{error}</p>}
    {record ? <>
      <div className="monthly-summary"><div><span>実績</span><strong>{record.total_count}</strong></div><div><span>目安</span><strong>{record.target_count}</strong></div><time dateTime={record.fetched_at}>最終取得 {fetchedTime(record.fetched_at)}</time></div>
      <table className="monthly-table"><caption className="sr-only">完了した通常講座と達成したミッションの数</caption><thead><tr><th scope="col">教科</th><th scope="col">実績</th><th scope="col">目安</th><th scope="col">目安との差</th></tr></thead><tbody>
        {SUBJECTS.map(([name,color]) => record.subjects[name] && <tr key={name}><th scope="row"><span className="monthly-subject"><span aria-hidden="true" style={{backgroundColor:color}}/>{name}</span></th><td>{record.subjects[name].count}</td><td>{record.subjects[name].target}</td><td className={record.subjects[name].count>=record.subjects[name].target ? 'monthly-ahead' : ''}>{difference(record.subjects[name].count,record.subjects[name].target)}</td></tr>)}
      </tbody></table>
    </> : <p className="monthly-empty">今月の取り組みはまだ取得していません。</p>}
  </section>;
}
export function MonthlyHistory({ records = [] }) {
  return <section className="monthly-history" aria-label="月別の取り組み履歴"><h2>月別の取り組み履歴</h2>{records.length ? records.map(record=><MonthlyStudy key={record.month} record={record} history/>) : <p className="monthly-empty">月の記録はまだありません。</p>}</section>;
}
