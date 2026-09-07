import { CreateRunForm } from "@/components/create-run-form";
import Link from "next/link";

const demoReports = [
  ["字节跳动", "10000000-0000-4000-8000-000000000001"],
  ["阿里巴巴", "10000000-0000-4000-8000-000000000002"],
  ["小米集团", "10000000-0000-4000-8000-000000000003"],
] as const;

export default function HomePage() {
  return (
    <main id="main-content">
      <section
        className="hero-workbench page-shell"
        aria-labelledby="home-title"
      >
        <div className="hero-workbench__copy">
          <p className="mono-label">RESEARCH → EVIDENCE → REPORT</p>
          <h1 id="home-title">从公开资料，建立可追溯的企业判断。</h1>
          <p className="hero-workbench__lede">
            InsightForge
            将问题规划、网页检索、证据提取、报告写作和引用评审编排为一条可观察的
            Agent 工作流。
          </p>
          <dl className="hero-specs" aria-label="体验范围">
            <div>
              <dt>来源</dt>
              <dd>公开网页</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>结构化报告</dd>
            </div>
            <div>
              <dt>依据</dt>
              <dd>逐条引用</dd>
            </div>
          </dl>
        </div>
        <CreateRunForm />
      </section>

      <section
        className="demo-reports page-shell"
        aria-labelledby="demo-reports-title"
      >
        <div className="demo-reports__heading">
          <p className="mono-label">SEE THE EVIDENCE</p>
          <h2 id="demo-reports-title">不等待模型，也能先检查完整证据链。</h2>
          <p>
            三份预置报告只用于演示报告结构、公开引用和原文核对。它们不会伪装成实时企业结论。
          </p>
        </div>
        <ol className="demo-report-list">
          {demoReports.map(([company, reportId], index) => (
            <li key={reportId}>
              <span className="demo-report-list__number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3>{company}</h3>
                <p>企业使命 · 官方来源 · 逐字引文</p>
              </div>
              <Link href={`/reports/${reportId}`}>阅读演示报告 →</Link>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="workflow-band"
        id="workflow"
        aria-labelledby="workflow-title"
      >
        <div className="page-shell workflow-band__inner">
          <div className="workflow-band__heading">
            <p className="mono-label">AGENT GRAPH</p>
            <h2 id="workflow-title">页面展示结果，也展示结果如何产生。</h2>
            <p>
              每个节点都有明确输入和输出。SSE 把 Worker
              进度持续推送到运行页面，刷新后会从服务端状态和事件日志恢复。
            </p>
          </div>
          <ol className="workflow-steps">
            {[
              ["1.0", "Planner", "拆解企业、关注方向与检索问题"],
              ["2.0", "Researcher", "搜索网页并读取上传资料"],
              ["3.0", "Evidence", "验证 URL 与逐字引文，建立证据链"],
              ["4.0", "Writer", "仅使用已验证证据生成结构化章节"],
              ["5.0", "Reviewer", "检查引用覆盖、支持度与冲突处理"],
              ["6.0", "Publisher", "保存版本并发布可阅读报告"],
            ].map(([number, title, description]) => (
              <li key={number}>
                <span>{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        className="trust-section page-shell"
        aria-labelledby="trust-title"
      >
        <div>
          <p className="mono-label">BOUNDARIES</p>
          <h2 id="trust-title">Agent 输出不是事实本身。</h2>
        </div>
        <div className="trust-section__body">
          <p>
            报告中的事实块必须指向服务端验证过的证据
            UUID。网页正文始终被视为不可信数据，不能改变系统指令。
          </p>
          <p>
            公开体验仍可能遗漏信息或产生判断偏差。阅读时应打开引用，核对来源日期、发布方与原文语境。
          </p>
          <a className="text-link" href="#create-run">
            创建一次可追溯调研 →
          </a>
        </div>
      </section>
    </main>
  );
}
