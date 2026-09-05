"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ResearchFocus } from "@insightforge/domain";
import { BrowserApiError, createResearchRun } from "@/lib/api-client";

const focusOptions: ReadonlyArray<{ value: ResearchFocus; label: string }> = [
  { value: "comprehensive", label: "综合分析" },
  { value: "product", label: "产品与业务" },
  { value: "technology", label: "技术能力" },
  { value: "business", label: "商业模式" },
  { value: "competition", label: "竞争格局" },
];

const presets: ReadonlyArray<{
  company: string;
  focus: ResearchFocus;
  label: string;
}> = [
  { company: "字节跳动", focus: "comprehensive", label: "字节跳动 · 综合" },
  { company: "小米集团", focus: "product", label: "小米 · 产品" },
  { company: "宁德时代", focus: "competition", label: "宁德时代 · 竞争" },
];

export function CreateRunForm() {
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [focus, setFocus] = useState<ResearchFocus>("comprehensive");
  const [companyTouched, setCompanyTouched] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const companyError =
    companyTouched && company.trim().length < 2
      ? "公司名称至少需要 2 个字符，请补充后再开始调研。"
      : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCompanyTouched(true);
    if (company.trim().length < 2 || status === "loading") return;

    setStatus("loading");
    setError(null);
    try {
      const run = await createResearchRun({
        company: company.trim(),
        focus,
        depth: "quick",
        documentIds: [],
      });
      router.push(`/runs/${run.runId}`);
    } catch (cause) {
      setStatus("error");
      if (cause instanceof BrowserApiError) {
        setError(
          cause.code === "RUN_RATE_LIMITED" && cause.retryAfterSeconds
            ? `今日快速调研额度已用完，请在约 ${Math.ceil(cause.retryAfterSeconds / 3600)} 小时后重试。`
            : cause.message,
        );
      } else {
        setError("未能创建调研任务，请检查网络连接后重试。");
      }
    }
  };

  return (
    <form className="run-form" id="create-run" onSubmit={submit} noValidate>
      <div className="run-form__heading">
        <span className="mono-label">POST /api/runs</span>
        <h2>创建一次快速调研</h2>
        <p>游客每天可运行 1 次。模型用量和预估成本会随任务保存。</p>
      </div>

      <fieldset className="preset-list">
        <legend>从示例问题开始</legend>
        <div className="preset-list__items" id="examples">
          {presets.map((preset) => (
            <button
              type="button"
              key={preset.label}
              onClick={() => {
                setCompany(preset.company);
                setFocus(preset.focus);
                setCompanyTouched(false);
                setError(null);
                setStatus("idle");
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="company">公司名称</label>
        <input
          id="company"
          name="company"
          value={company}
          minLength={2}
          maxLength={120}
          required
          aria-required="true"
          aria-invalid={Boolean(companyError)}
          aria-describedby="company-help"
          placeholder="例如：字节跳动"
          autoComplete="organization"
          onBlur={() => setCompanyTouched(true)}
          onChange={(event) => {
            setCompany(event.target.value);
            if (status === "error") setStatus("idle");
          }}
        />
        <p
          className={
            companyError ? "field__help field__help--error" : "field__help"
          }
          id="company-help"
        >
          {companyError ?? "使用企业常用全称，可以减少搜索歧义。"}
        </p>
      </div>

      <div className="field">
        <label htmlFor="focus">关注方向</label>
        <select
          id="focus"
          name="focus"
          value={focus}
          onChange={(event) => setFocus(event.target.value as ResearchFocus)}
        >
          {focusOptions.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="field__help">Agent 会围绕该方向规划问题和筛选证据。</p>
      </div>

      <fieldset className="depth-options">
        <legend>调研深度</legend>
        <label className="depth-option depth-option--active">
          <input type="radio" name="depth" value="quick" defaultChecked />
          <span>
            <strong>快速调研</strong>
            <small>公开网页检索、证据提取与一次报告评审</small>
          </span>
        </label>
        <label
          className="depth-option depth-option--disabled"
          aria-disabled="true"
        >
          <input type="radio" name="depth" value="deep" disabled />
          <span>
            <strong>深度调研</strong>
            <small>当前游客体验未开放，需要显式账号权限</small>
          </span>
        </label>
      </fieldset>

      <div className="field field--disabled">
        <label htmlFor="documents">上传内部资料</label>
        <input id="documents" type="file" disabled aria-disabled="true" />
        <p className="field__help">
          当前创建接口会立即入队，尚不能保证后上传文件进入本次运行，因此暂不开放。
        </p>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      ) : null}

      <button
        className="primary-button"
        type="submit"
        disabled={status === "loading" || Boolean(companyError)}
        aria-busy={status === "loading"}
      >
        {status === "loading" ? "正在创建任务…" : "开始快速调研"}
      </button>
    </form>
  );
}
