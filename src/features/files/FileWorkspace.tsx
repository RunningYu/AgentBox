import { DocumentPanel } from '../ai-sessions/DocumentPanel';

interface FileWorkspaceProps {
  onBack: () => void;
  onMessage: (message: string) => void;
}

/**
 * Standalone file workspace.
 *
 * The document panel is intentionally reused here so the File workspace and
 * the AI workspace share the same directory state, preview renderers and
 * document actions. Actions that insert text into an AI session are disabled
 * in this standalone view because there is no active composer to receive it.
 */
export function FileWorkspace({ onBack, onMessage }: FileWorkspaceProps) {
  return (
    <section aria-label="File 工作区" className="file-workspace">
      <DocumentPanel
        onCollapse={onBack}
        onError={onMessage}
        onInsertText={() => onMessage('请切换到 AI 工作台后使用插入功能')}
      />
    </section>
  );
}
