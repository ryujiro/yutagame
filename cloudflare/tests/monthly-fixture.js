// Synthetic records use the observed API/DOM structure, not a real child's counts.
export function monthlyApi() {
  return { response_data: { monthly_reports: [{ year: 2026, month: 10, grade: 1, report: {
    total_studied_count: 15, total_guide_study_count: 10,
    subjects_report: ['MAT','ENG','JPN','SCI','SOC'].map((subject,index)=>({subject,studied_count:index+1,guide_study_count:2})),
  } }] } };
}
export function monthlyHtml(mismatch = false) {
  return `<div class="monthlyRoot__sslKD"><div class="title__WpbZL"><div class="gradeText__hL0ZG">中1</div><div>10月の学習</div></div><div class="totalContainer__XpCSt"><span class="studiedCount__ITtrS">15</span><span class="totalCount__sao43">/10</span></div>${['数学','英語','国語','理科','社会'].map((name,index)=>`<div class="statusRoot__GYJb7"><div class="subjectText__bwaB5">${name}</div><div class="subjectCount__HmPoV"><span class="studiedCount__mtwi1">${index+1+(mismatch && index===0 ? 1 : 0)}</span><span class="totalCount__GuHj5">/2</span></div></div>`).join('')}</div>`;
}
