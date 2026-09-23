import { Download, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NormalizedFeatureDef, Prefs } from '../../shared/types';
import {
  applyToolboxImport,
  chooseToolboxImportFile,
  createToolboxExportPayload,
  exportToolboxConfig,
  type ToolboxExportScope,
  type ToolboxImportConflictStrategy,
  type ToolboxImportPreview,
} from './toolboxTransfer';

interface ToolboxTransferDialogProps {
  customFeatures: NormalizedFeatureDef[];
  filteredFeatures: NormalizedFeatureDef[];
  prefs: Prefs;
  onApplyImport: (features: NormalizedFeatureDef[], prefs: Prefs) => Promise<void> | void;
  onClose: () => void;
  onMessage: (message: string) => void;
}

export function ToolboxTransferDialog({
  customFeatures,
  filteredFeatures,
  prefs,
  onApplyImport,
  onClose,
  onMessage,
}: ToolboxTransferDialogProps) {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [scope, setScope] = useState<ToolboxExportScope>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ToolboxImportPreview | null>(null);
  const [conflictStrategy, setConflictStrategy] = useState<ToolboxImportConflictStrategy>('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectableFeatures = useMemo(
    () => customFeatures.filter((feature) => !feature.builtin),
    [customFeatures],
  );
  const exportFeatures = useMemo(() => {
    if (scope === 'filtered') {
      return filteredFeatures.filter((feature) => !feature.builtin);
    }
    if (scope === 'selected') {
      return selectableFeatures.filter((feature) => selectedIds.includes(feature.id));
    }
    return selectableFeatures;
  }, [filteredFeatures, scope, selectableFeatures, selectedIds]);

  async function runExport() {
    if (exportFeatures.length === 0) {
      setError('没有可导出的自定义功能');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = createToolboxExportPayload(exportFeatures, prefs);
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const path = await exportToolboxConfig(`AgentBox-tools-${date}.json`, payload);
      if (path) {
        onMessage(`已导出 ${exportFeatures.length} 个功能：${path}`);
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
      const nextPreview = await chooseToolboxImportFile(customFeatures);
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
      setError('请先选择要导入的工具配置文件');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = applyToolboxImport(preview, customFeatures, prefs, conflictStrategy);
      await onApplyImport(result.features, result.prefs);
      onMessage(`导入完成：新增 ${result.addedCount} 个，覆盖 ${result.overwrittenCount} 个，另存 ${result.duplicatedCount} 个，跳过 ${result.skippedCount} 个`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ));
  }

  return (
    <div className="modal-backdrop">
      <section aria-labelledby="toolbox-transfer-title" aria-modal="true" className="toolbox-transfer-dialog" role="dialog">
        <header>
          <div>
            <h2 id="toolbox-transfer-title">工具配置导入导出</h2>
            <p>分享自定义工具、提示词、片段和工作流配置，不包含会话记录和本机密钥。</p>
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
                <TransferStat label="可导出功能" value={exportFeatures.length} />
                <TransferStat label="全部自定义" value={selectableFeatures.length} />
                <TransferStat label="当前筛选" value={filteredFeatures.filter((feature) => !feature.builtin).length} />
                <TransferStat label="格式" value="JSON" />
              </div>

              <div className="transfer-section-title">导出范围</div>
              <TransferOption active={scope === 'all'} description="导出全部自定义功能，适合完整分享给别人。" label="全部自定义功能" onClick={() => setScope('all')} />
              <TransferOption active={scope === 'filtered'} description="只导出当前工具箱筛选结果里的自定义功能。" label="当前筛选结果" onClick={() => setScope('filtered')} />
              <TransferOption active={scope === 'selected'} description="手动勾选需要分享的功能。" label="选择功能导出" onClick={() => setScope('selected')} />

              {scope === 'selected' && (
                <div className="transfer-feature-picker" aria-label="选择导出功能">
                  {selectableFeatures.map((feature) => (
                    <label key={feature.id}>
                      <input checked={selectedIds.includes(feature.id)} onChange={() => toggleSelected(feature.id)} type="checkbox" />
                      <span>{feature.name}</span>
                      <small>{typeLabel(feature.type)}</small>
                    </label>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {!preview ? (
                <div className="transfer-empty-import">
                  <Upload size={30} />
                  <strong>选择一个 AgentBox 工具配置 JSON</strong>
                  <span>导入前会先预览新增和冲突，不会直接覆盖你的本机配置。</span>
                  <button className="primary-button" disabled={busy} onClick={chooseImportFile} type="button">选择导入文件</button>
                </div>
              ) : (
                <>
                  <div className="transfer-summary-grid">
                    <TransferStat label="新增" value={preview.added.length} />
                    <TransferStat label="冲突" value={preview.conflicted.length} />
                    <TransferStat label="可导入" value={preview.features.length} />
                    <TransferStat label="无效" value={preview.invalidCount} />
                  </div>
                  <p className="transfer-file-path">{preview.path}</p>

                  <div className="transfer-section-title">冲突处理</div>
                  <TransferOption active={conflictStrategy === 'skip'} description="已有同名功能保持不变，只导入新增功能。" label="跳过已有功能" onClick={() => setConflictStrategy('skip')} />
                  <TransferOption active={conflictStrategy === 'overwrite'} description="同名功能会使用导入文件中的配置覆盖。" label="覆盖已有同名功能" onClick={() => setConflictStrategy('overwrite')} />
                  <TransferOption active={conflictStrategy === 'duplicate'} description="同名功能另存为新功能，名称后追加“导入”。" label="另存为新功能" onClick={() => setConflictStrategy('duplicate')} />

                  <div className="transfer-section-title">冲突预览</div>
                  {preview.conflicted.length === 0 ? (
                    <p className="empty">没有同名冲突</p>
                  ) : (
                    <div className="transfer-conflict-list">
                      {preview.conflicted.map((feature) => (
                        <div key={feature.id}>
                          <strong>{feature.name}</strong>
                          <span>{typeLabel(feature.type)}</span>
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
            <button className="primary-button" disabled={busy || exportFeatures.length === 0} onClick={runExport} type="button">导出配置文件</button>
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

function typeLabel(type: NormalizedFeatureDef['type']): string {
  if (type === 'agent') return 'Agent';
  if (type === 'url') return 'URL';
  if (type === 'snippet') return '片段';
  if (type === 'sequence') return '工作流';
  return '提示词';
}

function conflictStrategyLabel(strategy: ToolboxImportConflictStrategy): string {
  if (strategy === 'overwrite') return '覆盖';
  if (strategy === 'duplicate') return '另存';
  return '跳过';
}
