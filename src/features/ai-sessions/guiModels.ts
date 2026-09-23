import type { GuiAgentType } from '../../shared/types';

export interface GuiModelOption {
  description: string;
  id: string;
  label: string;
}

export const GUI_MODEL_OPTIONS: Record<GuiAgentType, GuiModelOption[]> = {
  claude: [
    { id: 'sonnet', label: 'sonnet (default)', description: 'Balanced Claude Code model for everyday work.' },
    { id: 'opus', label: 'opus', description: 'Stronger Claude model for complex planning and reasoning.' },
    { id: 'haiku', label: 'haiku', description: 'Faster Claude model for lightweight tasks.' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol (default)', description: 'Latest frontier agentic coding model.' },
    { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', description: 'Balanced agentic coding model for everyday work.' },
    { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', description: 'Fast and affordable agentic coding model.' },
    { id: 'gpt-5.5', label: 'gpt-5.5', description: 'Frontier model for complex coding, research, and real-world work.' },
    { id: 'gpt-5.2', label: 'gpt-5.2', description: 'Optimized for professional work and long-running agents.' },
  ],
};
