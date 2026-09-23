import { Download, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentDefinition } from './AgentCenterDemo';
import {
  applyAgentCenterImport,
  chooseAgentCenterImportFile,
  createAgentCenterExportPayload,
  exportAgentCenterConfig,
  type AgentCenterConflictStrategy,
  type AgentCenterImportPreview,
} from './agentCenterTransfer';

interface AgentCenterTransferDialogProps {
  agents: AgentDefinition[];
  onApplyImport: (agents: AgentDefinition[]) => Promise<void> | void;
  onClose: () => void;
  onMessage: (message: string) => void;
}

export function AgentCenterTransferDialog({ agents, onApplyImport, onClose, onMessage }: AgentCenterTransferDialogProps) {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [preview, setPreview] = useState<AgentCenterImportPreview | null>(null);
  const [conflictStrategy, setConflictStrategy] = useState<AgentCenterConflictStrategy>('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportAgents = useMemo(() => agents, [agents]);

  async function runExport() {
    if (exportAgents.length === 0) {
      setError('没有可导出的 Agent 配置');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = createAgentCenterExportPayload(exportAgents);
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const path = await exportAgentCenterConfig(`AgentBox-agents-${date}.json`, payload);
      if (path) {
        onMessage(`已导出 ${exportAgents.length} 个 Agent：${path}`);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  async function chooseImportFile() {
    setBusy(true);
    setError(null);
    try {
      const nextPreview = await chooseAgentCenterImportFile(agents);
      if (nextPreview) {
        setPreview(nextPreview);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取导入文件失败');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!preview) {
      setError('请先选择要导入的 Agent 配置文件');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = applyAgentCenterImport(preview, agents, conflictStrategy);
      await onApplyImport(result.agents);
      onMessage(`导入完成：新增 ${result.addedCount} 个，覆盖 ${result.overwrittenCount} 个，另存 ${result.duplicatedCount} 个，跳过 ${result.skippedCount} 个`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section aria-labelledby="agent-center-transfer-title" aria-modal="true" className="toolbox-transfer-dialog" role="dialog">
        <header>
          <div>
            <h2 id="agent-center-transfer-title">Agent 配置导入导出</h2>
            <p>导出当前 Agent 配置，或导入 JSON 恢复 / 合并 Agent 配置。</p>
          </div>
          <button className="ghost-button" disabled={busy} onClick={onClose} type="button">关闭</button>
        </header>

        <div className="toolbox-transfer-tabs" role="tablist">
          <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')} role="tab" type="button">
            <Download size={15} />
            导出
          </button>
          <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')} role="tab" type="button">
            <Upload size={15} />
            导入
          </button>
        </div>

        {error && <p className="dialog-error" role="alert">{error}</p>}

        <div className="toolbox-transfer-body">
          {tab === 'export' ? (
            <>
              <div className="transfer-summary-grid">
                <TransferStat label="可导出 Agent" value={exportAgents.length} />
                <TransferStat label="格式" value="JSON" />
                <TransferStat label="内容" value="配置 + 资源" />
                <TransferStat label="范围" value="全部" />
              </div>
              <p className="transfer-empty-import">
                <strong>导出会包含当前 Agent 的完整配置。</strong>
                <span>不包含会话记录本身，但会保留名称、提示词、行为规则、技能与资源配置。</span>
              </p>
            </>
          ) : (
            <>
              {!preview ? (
                <div className="transfer-empty-import">
                  <Upload size={30} />
                  <strong>选择一个 AgentBox Agent 配置 JSON</strong>
                  <span>导入前会先读取并预览，不会直接覆盖你的本机配置。</span>
                  <button className="primary-button" disabled={busy} onClick={chooseImportFile} type="button">选择导入文件</button>
                </div>
              ) : (
                <>
                  <div className="transfer-summary-grid">
                    <TransferStat label="新增" value={preview.added.length} />
                    <TransferStat label="冲突" value={preview.conflicted.length} />
                    <TransferStat label="可导入" value={preview.agents.length} />
                    <TransferStat label="无效" value={preview.invalidCount} />
                  </div>
                  <p className="transfer-file-path">{preview.path}</p>

                  <div className="transfer-section-title">冲突处理</div>
                  <TransferOption active={conflictStrategy === 'skip'} description="已有同名或同 ID Agent 保持不变，只导入新增配置。" label="跳过已有配置" onClick={() => setConflictStrategy('skip')} />
                  <TransferOption active={conflictStrategy === 'overwrite'} description="同名或同 ID Agent 使用导入文件覆盖。" label="覆盖已有配置" onClick={() => setConflictStrategy('overwrite')} />
                  <TransferOption active={conflictStrategy === 'duplicate'} description="同名或同 ID Agent 另存为新配置。" label="另存为新配置" onClick={() => setConflictStrategy('duplicate')} />

                  <div className="transfer-section-title">冲突预览</div>
                  {preview.conflicted.length === 0 ? (
                    <p className="empty">没有同名冲突</p>
                  ) : (
                    <div className="transfer-conflict-list">
                      {preview.conflicted.map((agent) => (
                        <div key={agent.id}>
                          <strong>{agent.name}</strong>
                          <span>{agent.type === 'claude' ? 'Claude' : agent.type === 'codex' ? 'Codex' : 'GUI'}</span>
                          <em>{conflictStrategyLabel(conflictStrategy)}</em>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <footer>
          <button className="secondary-button" disabled={busy} onClick={onClose} type="button">取消</button>
          {tab === 'export' ? (
            <button className="primary-button" disabled={busy || exportAgents.length === 0} onClick={runExport} type="button">导出配置文件</button>
          ) : (
            <button className="primary-button" disabled={busy || !preview} onClick={runImport} type="button">确认导入</button>
          )}
        </footer>
      </section>
    </div>
  );
}

function TransferStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="transfer-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TransferOption({ active, description, label, onClick }: { active: boolean; description: string; label: string; onClick: () => void }) {
  return (
    <button className={active ? 'transfer-option active' : 'transfer-option'} onClick={onClick} type="button">
      <strong>{label}</strong>
      <span>{description}</span>
    </button>
  );
}

function conflictStrategyLabel(strategy: AgentCenterConflictStrategy): string {
  if (strategy === 'overwrite') return '覆盖';
  if (strategy === 'duplicate') return '另存';
  return '跳过';
}
