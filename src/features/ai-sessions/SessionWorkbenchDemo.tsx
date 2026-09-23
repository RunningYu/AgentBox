import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Clipboard, FileCode2, GitBranch, ListChecks, Play, RotateCw, TerminalSquare, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

type Stage = '需求理解' | '方案分析' | '文件修改' | '命令执行' | '测试验证' | '遗留问题';
type RecordKind = 'user' | 'assistant' | 'command' | 'file' | 'test';

interface ActivityRecord {
  id: string;
  kind: RecordKind;
  title: string;
  detail: string;
  time: string;
  stage: Stage;
}

const STAGES: Array<{ name: Stage; count: number }> = [
  { name: '需求理解', count: 2 },
  { name: '方案分析', count: 3 },
  { name: '文件修改', count: 6 },
  { name: '命令执行', count: 4 },
  { name: '测试验证', count: 3 },
  { name: '遗留问题', count: 1 },
];

const RECORDS: ActivityRecord[] = [
  { id: 'r1', kind: 'user', title: '优化退款重新下单推流规则', detail: '请梳理 Q1、Q2、Q3 的业务约束，并给出落地方案。', time: '09:42', stage: '需求理解' },
  { id: 'r2', kind: 'assistant', title: '已提取 8 个业务约束', detail: '核心结论：原商户规则只参与排序，不参与过滤；24 小时窗口从退款完成时间起算。', time: '09:43', stage: '需求理解' },
  { id: 'r3', kind: 'assistant', title: '方案拆分为 3 个改动点', detail: '商户匹配过滤、E 等级上限校验、飞书告警通知。', time: '09:48', stage: '方案分析' },
  { id: 'r4', kind: 'file', title: '修改 MallProductSkuStoreService.java', detail: '调整原商户优先排序和库存过滤的执行顺序。', time: '10:06', stage: '文件修改' },
  { id: 'r5', kind: 'file', title: '新增 MerchantLimitValidator.java', detail: '增加同类目或同 SKU 至少一个商户上限为空的校验。', time: '10:18', stage: '文件修改' },
  { id: 'r6', kind: 'command', title: '执行 Maven 单测', detail: 'mvn -pl service -Dtest=MerchantMatchServiceTest test', time: '10:31', stage: '命令执行' },
  { id: 'r7', kind: 'test', title: '测试通过', detail: '18 tests passed · 0 failures · 12.4s', time: '10:32', stage: '测试验证' },
  { id: 'r8', kind: 'assistant', title: '仍需确认 1 个产品决策', detail: '余额阈值 x 的默认值尚未确定，当前代码使用 Apollo 配置兜底。', time: '10:35', stage: '遗留问题' },
];

const FILES = [
  ['MallProductSkuStoreService.java', '修改 42 行', 'src/main/java/.../service'],
  ['MerchantLimitValidator.java', '新增 118 行', 'src/main/java/.../validator'],
  ['MerchantMatchServiceTest.java', '修改 26 行', 'src/test/java/.../service'],
];

export interface SessionWorkbenchDemoProps {
  onBack: () => void;
}

export function SessionWorkbenchDemo({ onBack }: SessionWorkbenchDemoProps) {
  const [activeStage, setActiveStage] = useState<Stage | '全部'>('全部');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');
  const records = activeStage === '全部' ? RECORDS : RECORDS.filter((record) => record.stage === activeStage);

  function toggle(id: string) {
    setCollapsed((current) => ({ ...current, [id]: !current[id] }));
  }

  function notify(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(''), 1800);
  }

  return (
    <section aria-label="会话工作台 Demo" className="session-workbench-demo">
      <header className="workbench-demo-header">
        <div className="workbench-demo-title">
          <button aria-label="返回 AI 工作台" className="icon-button" onClick={onBack} title="返回" type="button"><ArrowLeft size={17} /></button>
          <div><strong>会话工作台</strong><span>服务瘦身 · 自动整理于今天 10:35</span></div>
        </div>
        <div className="workbench-demo-actions">
          <span className="workbench-demo-branch"><GitBranch size={14} /> feature/code-maintenance</span>
          <button className="secondary-button" onClick={() => notify('已重新整理当前会话')} type="button"><RotateCw size={14} />重新整理</button>
          <button aria-label="关闭会话工作台 Demo" className="icon-button" onClick={onBack} title="关闭" type="button"><X size={16} /></button>
        </div>
      </header>

      <div className="workbench-demo-grid">
        <aside className="workbench-stage-panel">
          <div className="workbench-panel-heading"><span>研发阶段</span><small>8 条记录</small></div>
          <button className={activeStage === '全部' ? 'workbench-stage active' : 'workbench-stage'} onClick={() => setActiveStage('全部')} type="button"><span>全部记录</span><b>19</b></button>
          {STAGES.map((stage) => (
            <button className={activeStage === stage.name ? 'workbench-stage active' : 'workbench-stage'} key={stage.name} onClick={() => setActiveStage(stage.name)} type="button">
              <span><i className={`stage-dot stage-${stage.name}`} />{stage.name}</span><b>{stage.count}</b>
            </button>
          ))}
          <div className="workbench-stage-footer"><span>会话状态</span><strong><CheckCircle2 size={14} />已验证</strong></div>
        </aside>

        <section className="workbench-activity-panel">
          <div className="workbench-panel-heading"><span>{activeStage === '全部' ? '会话活动' : activeStage}</span><small>按时间顺序</small></div>
          <div className="workbench-record-list">
            {records.map((record) => {
              const isCollapsed = collapsed[record.id];
              return (
                <article className={`workbench-record record-${record.kind}`} key={record.id}>
                  <div className="workbench-record-marker"><RecordIcon kind={record.kind} /></div>
                  <div className="workbench-record-body">
                    <button className="workbench-record-toggle" onClick={() => toggle(record.id)} type="button">
                      {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}<strong>{record.title}</strong><time>{record.time}</time>
                    </button>
                    {!isCollapsed && <p>{record.detail}</p>}
                    {!isCollapsed && (record.kind === 'file' || record.kind === 'command') && <button className="workbench-inline-action" onClick={() => notify(record.kind === 'file' ? '已跳转到文档查看变更' : '已打开终端记录')} type="button">{record.kind === 'file' ? <><FileCode2 size={13} />查看变更</> : <><TerminalSquare size={13} />查看输出</>}</button>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="workbench-summary-panel">
          <div className="workbench-panel-heading"><span>自动摘要</span><small>实时生成</small></div>
          <div className="workbench-summary-block summary-conclusion"><span className="summary-label">当前结论</span><h3>已完成商户匹配规则调整</h3><p>原商户优先仅用于排序，库存与余额过滤在商户匹配阶段统一执行。</p></div>
          <SummarySection icon={<FileCode2 size={15} />} title="变更文件" action="3 个文件" onClick={() => notify('已打开变更文件列表')}>
            {FILES.map(([name, change, path]) => <button className="workbench-file-row" key={name} onClick={() => notify(`已定位到 ${name}`)} type="button"><strong>{name}</strong><small>{change} · {path}</small></button>)}
          </SummarySection>
          <SummarySection icon={<ListChecks size={15} />} title="待办事项" action="2 项" onClick={() => notify('待办已同步到会话')}>
            <label className="workbench-check-row"><input defaultChecked type="checkbox" />补充 Apollo 默认阈值</label>
            <label className="workbench-check-row"><input type="checkbox" />确认飞书告警文案</label>
          </SummarySection>
          <SummarySection icon={<TerminalSquare size={15} />} title="风险提示" action="1 项" onClick={() => notify('已展开风险详情')}>
            <p className="workbench-risk">余额口径仍依赖现有渠道合并逻辑，发布前建议补充边界用例。</p>
          </SummarySection>
          <button className="workbench-copy-button" onClick={() => notify('摘要已复制')} type="button"><Clipboard size={14} />复制研发摘要</button>
        </aside>
      </div>
      {message && <div className="workbench-demo-toast">{message}</div>}
    </section>
  );
}

function RecordIcon({ kind }: { kind: RecordKind }) {
  if (kind === 'user') return <span className="record-letter">我</span>;
  if (kind === 'assistant') return <span className="record-letter">AI</span>;
  if (kind === 'file') return <FileCode2 size={14} />;
  if (kind === 'command') return <TerminalSquare size={14} />;
  return <CheckCircle2 size={14} />;
}

function SummarySection({ icon, title, action, onClick, children }: { icon: ReactNode; title: string; action: string; onClick: () => void; children: ReactNode }) {
  return <section className="workbench-summary-section"><header><span>{icon}{title}</span><button onClick={onClick} type="button">{action} <Play size={11} /></button></header>{children}</section>;
}
