import type { PublicPublishedReport } from "@insightforge/domain";

export function QualitySummary({ report }: { report: PublicPublishedReport }) {
  return (
    <aside className="quality-summary" aria-labelledby="quality-title">
      <div>
        <p className="mono-label">REPORT META</p>
        <h2 id="quality-title">阅读前先看边界</h2>
      </div>
      <dl>
        <div>
          <dt>公开引用</dt>
          <dd>{report.citations.length}</dd>
        </div>
        <div>
          <dt>报告章节</dt>
          <dd>{report.content.sections.length}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{report.version}</dd>
        </div>
      </dl>
      <p>
        本报告由 AI
        根据检索材料生成。事实引用经过程序校验，但结论、遗漏与来源时效仍需人工判断。
      </p>
      {report.qualityWarning ? (
        <p className="quality-summary__warning" role="note">
          <strong>质量提示：</strong> {report.qualityWarning}
        </p>
      ) : null}
    </aside>
  );
}
