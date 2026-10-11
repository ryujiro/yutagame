import { useState } from 'react';
import { BookOpen, History, RefreshCw, ChevronRight, Info, AlertCircle, ArrowLeft } from 'lucide-react';
import { useDashboard } from './useDashboard.js';
import { TimeBalance, TimeHistory } from './TimeLedger.jsx';

const COLORS = ['#777cf5', '#f19a85', '#91b8a0', '#e9be75', '#89b9d5', '#b7a0d6'];
const ORDER = ['数学', '国語', '理科', '社会', '英語'];
function subjectsOf(record) {
  return Object.entries(record?.subjects || {}).sort(([a], [b]) => {
    const ai = ORDER.indexOf(a), bi = ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  }).map(([name, minutes], index) => ({ name, minutes, color: COLORS[index % COLORS.length] }));
}
function longDate(day) {
  const date = new Date(`${day}T12:00:00+09:00`);
  const weekday = new Intl.DateTimeFormat('ja-JP', { weekday: 'short', timeZone: 'Asia/Tokyo' }).format(date);
  const [y, m, d] = day.split('-').map(Number);
  return `${y}年${m}月${d}日（${weekday}）`;
}
function shortDate(day) { return longDate(day).replace(/^\d+年/, ''); }
function fetchedTime(value) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Tokyo' }).format(new Date(value)).replace(/(\d+)\/(\d+)/, '$1月$2日');
}

function Sidebar({ page, setPage }) {
  return <aside className="sidebar">
    <a className="brand" href="#today" onClick={(event) => { event.preventDefault(); setPage('today'); }}>まなびノート</a>
    <nav aria-label="メインナビゲーション">
      <button className={`nav-item ${page === 'today' ? 'active' : ''}`} aria-current={page === 'today' ? 'page' : undefined} onClick={() => setPage('today')}><BookOpen aria-hidden="true" /><span>今日の学習</span></button>
      <button className={`nav-item ${page === 'history' ? 'active' : ''}`} aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}><History aria-hidden="true" /><span>取得履歴</span></button>
    </nav>
  </aside>;
}

function RefreshControl({ dashboard }) {
  const { data, updating, remaining, refresh } = dashboard;
  const busy = updating || data?.refreshing;
  const savedMode = data?.refresh_mode === 'saved_records';
  const disabled = !data || busy || remaining > 0 || (!savedMode && !data.credentials_ready);
  const hint = busy ? '学習記録を確認しています…' : remaining > 0 ? `次の更新まで ${Math.floor(remaining / 60)}分${String(remaining % 60).padStart(2, '0')}秒` : '';
  return <div className="refresh-control">
    <button className="refresh-button" onClick={refresh} disabled={disabled} aria-describedby="refresh-hint">
      <RefreshCw size={25} aria-hidden="true" className={busy ? 'spinning' : ''} /><span>{savedMode ? busy ? '表示を更新中' : '表示を更新' : busy ? '学習時間を取得中' : '学習時間を更新'}</span>
    </button>
    <p className="last-fetched">{data?.record ? `最終取得 ${fetchedTime(data.record.fetched_at)}` : 'まだ取得していません'}</p>
    <p id="refresh-hint" className="refresh-hint">{hint}</p>
  </div>;
}

function Notice({ children, title, warning = false }) {
  const Icon = warning ? AlertCircle : Info;
  return <div className={`notice ${warning ? 'warning' : ''}`} role={warning ? 'alert' : 'status'}>
    <Icon size={20} aria-hidden="true" /><div>{title && <strong>{title}</strong>}<p>{children}</p></div>
  </div>;
}

function Subjects({ record }) {
  const subjects = subjectsOf(record);
  return <section className="subjects" aria-labelledby="subjects-title">
    <h2 id="subjects-title">教科ごとの学習時間</h2>
    {subjects.length ? <ul className="subject-list">{subjects.map(subject => <li className="subject-row" key={subject.name}>
      <span className="subject-name"><span className="subject-dot" style={{ backgroundColor: subject.color }} /><span>{subject.name}</span></span>
      <div className="subject-track" aria-hidden="true"><span style={{ backgroundColor: subject.color, width: `${record.total_minutes ? subject.minutes / record.total_minutes * 100 : 0}%` }} /></div>
      <span className="subject-time"><strong>{subject.minutes}</strong><span>分</span></span>
    </li>)}</ul> : <div className="subjects-empty"><BookOpen size={32} aria-hidden="true" /><p>教科別の記録はありません。</p></div>}
  </section>;
}

function HistoryTable({ history, full = false, onShowAll }) {
  const rows = full ? history : history.slice(0, 3);
  return <section className={`history-section ${full ? 'full-history' : ''}`} aria-labelledby={full ? 'page-title' : 'history-title'}>
    {!full && <div className="section-header"><h2 id="history-title">取得履歴</h2><button className="text-button" onClick={onShowAll}>すべて見る<ChevronRight size={20} aria-hidden="true" /></button></div>}
    <table><caption className="sr-only">保存された学習記録の取得履歴</caption><thead><tr><th scope="col">学習日</th><th scope="col">合計時間</th><th scope="col">取得日時</th></tr></thead>
      <tbody>{rows.length ? rows.map(record => <tr key={record.fetched_at}><td><span className="history-date">{shortDate(record.date)}</span>{full && <span className="history-year">{record.date.slice(0, 4)}年</span>}</td><td><strong>{record.total_minutes}</strong>分</td><td><time dateTime={record.fetched_at}>{fetchedTime(record.fetched_at)}</time></td></tr>) : <tr><td colSpan="3" className="empty-history">取得した記録はまだありません。</td></tr>}</tbody>
    </table>
    <p className="footer-note">表示されているのは、最後に取得した学習記録です。</p>
  </section>;
}

export default function App() {
  const [page, setPage] = useState('today');
  const dashboard = useDashboard();
  const { data, loading, networkError, reload } = dashboard;
  const record = data?.record;
  const pastDay = record && record.date !== data.today;
  const goTo = (next) => { setPage(next); window.scrollTo({ top: 0, behavior: 'instant' }); };
  return <div className="app-shell">
    <Sidebar page={page} setPage={goTo} />
    <main id="main-content" className="main-content">
      <header className="page-header"><div><h1 id="page-title">{page === 'history' ? '取得履歴' : '今日の学習'}</h1><p className="page-date">{page === 'history' ? '' : data ? longDate(data.today) : '学習記録を読み込んでいます'}</p></div><RefreshControl dashboard={dashboard} /></header>
      <div className="announcements" aria-live="polite">
        {networkError && <Notice warning>{networkError}{!data && <button className="retry-link" onClick={reload}>もう一度読み込む</button>}</Notice>}
        {data?.error && <Notice warning title={data.error.title}>{data.error.message}{record && ' 前回の取得結果を表示しています。'}</Notice>}
        {data?.refresh_mode === 'saved_records' && <Notice title={['not_configured', 'missing_credentials'].includes(data.collection_status) ? '自動取得は準備中です' : '定期的に記録を取得します'}>{['not_configured', 'missing_credentials'].includes(data.collection_status) ? '取得設定が完了すると、新しい学習記録が届きます。現在は保存された記録を表示しています。' : '15〜22時に約1時間ごとに取得します。「表示を更新」は保存記録の読み直しです。'}</Notice>}
        {data && data.refresh_mode !== 'saved_records' && !data.credentials_ready && !data.error && <Notice title="ログイン設定が必要です">スマイルゼミのログイン情報がまだ登録されていません。</Notice>}
        {pastDay && page === 'today' && <Notice>前回取得した{shortDate(record.date)}の記録です。{data.refresh_mode === 'saved_records' ? '今日の記録が取得されると、表示を更新できます。' : '今日の記録は「学習時間を更新」から取得してください。'}</Notice>}
      </div>
      {loading && !data ? <div className="loading-state" role="status"><RefreshCw className="spinning" size={28} aria-hidden="true" /><p>学習記録を読み込んでいます…</p></div> : <>
        {page === 'today' ? <><TimeBalance ledger={data?.ledger} error={data?.ledger_error} record={record} today={data?.today} reload={reload} /><div className="learning-details"><Subjects record={record?.date===data?.today ? record : null} /></div></> : <><button className="back-button" onClick={() => goTo('today')}><ArrowLeft size={18} aria-hidden="true" />今日の学習に戻る</button><HistoryTable history={data?.history || []} full /><TimeHistory ledger={data?.ledger} /></>}
      </>}
    </main>
  </div>;
}
