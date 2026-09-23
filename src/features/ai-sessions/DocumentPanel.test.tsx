import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPanel } from './DocumentPanel';
import * as documentApi from './documentApi';

vi.mock('./documentApi', () => ({
  chooseDocumentDirectory: vi.fn(),
  listDocumentTree: vi.fn(),
  readDocumentFile: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="rendered-mermaid-svg"><text>流程图</text></svg>' })),
  },
}));

vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_data: Blob, body: HTMLElement) => {
    body.innerHTML = '<div class="docx-wrapper"><p>Word 文档内容</p></div>';
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

describe('DocumentPanel', () => {
  function dispatchPointer(target: EventTarget, type: string, clientX: number) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(event, {
      clientX: { value: clientX },
      pointerId: { value: 1 },
    });
    target.dispatchEvent(event);
  }

  async function chooseDirectory(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '目录操作' }));
    await user.click(screen.getByRole('menuitem', { name: '选择目录' }));
  }

  async function openDirectoryMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '目录操作' }));
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(documentApi.chooseDocumentDirectory).mockReset();
    vi.mocked(documentApi.listDocumentTree).mockReset();
    vi.mocked(documentApi.readDocumentFile).mockReset();
  });

  it('chooses a local directory and opens supported files for preview', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'docs', path: 'docs', kind: 'directory', children: [
        { name: '方案.md', path: 'docs/方案.md', kind: 'file', extension: 'md' },
      ] },
      { name: 'ProductFacade.java', path: 'src/ProductFacade.java', kind: 'file', extension: 'java' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'docs/方案.md', name: '方案.md', extension: 'md', content: '# 服务瘦身\n\n- 合并查询', size: 16 });
    const onInsertText = vi.fn();
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={onInsertText} />);

    await chooseDirectory(user);
    expect(await screen.findByText('/tmp/project')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '方案.md' }));

    expect(documentApi.readDocumentFile).toHaveBeenCalledWith('/tmp/project', 'docs/方案.md');
    expect(await screen.findByRole('heading', { name: '服务瘦身' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '文件操作' }));
    await user.click(screen.getByRole('menuitem', { name: '插入引用' }));
    expect(onInsertText).toHaveBeenCalledWith('请阅读 docs/方案.md，并结合当前会话给出结论。');
  });

  it('renders code files as preformatted text', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'ProductFacade.java', path: 'ProductFacade.java', kind: 'file', extension: 'java' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'ProductFacade.java', name: 'ProductFacade.java', extension: 'java', content: 'class ProductFacade {}', size: 22 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'ProductFacade.java' }));

    expect(screen.getByText('class').closest('pre')).toHaveTextContent('class ProductFacade {}');
    expect(screen.getByText(/Java/)).toBeInTheDocument();
  });

  it('renders docx documents with the Word layout renderer', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: '方案.docx', path: '方案.docx', kind: 'file', extension: 'docx' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: '方案.docx',
      name: '方案.docx',
      extension: 'docx',
      content: '',
      binary: [80, 75, 3, 4],
      previewKind: 'docx',
      size: 4,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: '方案.docx' }));

    expect(await screen.findByLabelText('Word 文档预览')).toBeInTheDocument();
    expect(screen.getByText('Word 文档内容')).toBeInTheDocument();
  });

  it('shows independent whole-document zoom controls for docx previews', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: '方案.docx', path: '方案.docx', kind: 'file', extension: 'docx' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: '方案.docx',
      name: '方案.docx',
      extension: 'docx',
      content: '',
      binary: [80, 75, 3, 4],
      previewKind: 'docx',
      size: 4,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: '方案.docx' }));

    const controls = screen.getByRole('group', { name: '文档整体缩放' });
    expect(within(controls).getByText('100%')).toBeInTheDocument();
    const preview = screen.getByLabelText('文档内容缩放区');
    expect(preview).toHaveClass('document-page-preview');
    expect(preview.querySelector('.document-page-stage')).toBeInTheDocument();
    expect(preview).toHaveStyle({ '--document-page-zoom': '1' });

    await user.click(within(controls).getByRole('button', { name: '放大文档' }));
    expect(within(controls).getByText('110%')).toBeInTheDocument();
    expect(preview).toHaveStyle({ '--document-page-zoom': '1.1' });

    await user.click(within(controls).getByRole('button', { name: '缩小文档' }));
    expect(within(controls).getByText('100%')).toBeInTheDocument();

    await user.click(within(controls).getByRole('button', { name: '放大文档' }));
    await user.click(within(controls).getByRole('button', { name: '重置文档缩放' }));
    expect(within(controls).getByText('100%')).toBeInTheDocument();
  });

  it('renders PDF and image files as binary previews', async () => {
    const user = userEvent.setup();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:document-preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: '截图.png', path: '截图.png', kind: 'file', extension: 'png' },
      { name: '说明.pdf', path: '说明.pdf', kind: 'file', extension: 'pdf' },
    ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({
        path: '截图.png',
        name: '截图.png',
        extension: 'png',
        content: '',
        binary: [137, 80, 78, 71],
        previewKind: 'image',
        size: 4,
      })
      .mockResolvedValueOnce({
        path: '说明.pdf',
        name: '说明.pdf',
        extension: 'pdf',
        content: '',
        binary: [37, 80, 68, 70],
        previewKind: 'pdf',
        size: 4,
      });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: '截图.png' }));
    expect(screen.getByRole('img', { name: '截图.png' })).toHaveAttribute('src', 'blob:document-preview');
    expect(screen.queryByRole('group', { name: '文档整体缩放' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '说明.pdf' }));
    expect(screen.getByLabelText('PDF 文档预览')).toHaveAttribute('src', 'blob:document-preview');
    expect(screen.getByRole('group', { name: '文档整体缩放' })).toBeInTheDocument();
    expect(screen.getByLabelText('文档内容缩放区')).toHaveClass('document-page-preview');

    await user.click(screen.getByRole('button', { name: '放大文档' }));
    await waitFor(() => {
      expect(screen.getByLabelText('PDF 文档预览')).toHaveStyle({ width: '1056px', height: '704px' });
    });
  });

  it('zooms document content without scaling the whole preview canvas', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'ProductFacade.java', path: 'ProductFacade.java', kind: 'file', extension: 'java' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'ProductFacade.java', name: 'ProductFacade.java', extension: 'java', content: 'class ProductFacade {}', size: 22 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'ProductFacade.java' }));

    const scrollRegion = screen.getByLabelText('文档内容滚动区');
    const preview = screen.getByLabelText('文档内容缩放区');
    expect(preview).toHaveStyle({ '--document-content-zoom': '1' });

    fireEvent.wheel(scrollRegion, { ctrlKey: true, deltaY: -100 });

    await waitFor(() => expect(preview).toHaveStyle({ '--document-content-zoom': '1.08' }));
    expect(preview.querySelector('.document-preview-canvas')).not.toBeInTheDocument();
    expect((preview as HTMLElement).style.transform).toBe('');
  });

  it('keeps whole-document zoom controls out of markdown previews', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'README.md',
      name: 'README.md',
      extension: 'md',
      content: '# 标题',
      size: 8,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    expect(screen.queryByRole('group', { name: '文档整体缩放' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Markdown 渲染内容')).toBeInTheDocument();
  });

  it('does not rerender the document panel during a burst of zoom events', async () => {
    const user = userEvent.setup();
    const onRender = vi.fn();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# Title\n\nLong document content', size: 32 });
    render(
      <Profiler id="document-panel" onRender={onRender}>
        <DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />
      </Profiler>,
    );

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const rendersBeforeZoom = onRender.mock.calls.length;
    const scrollRegion = screen.getByLabelText('文档内容滚动区');

    fireEvent.wheel(scrollRegion, { ctrlKey: true, deltaY: -20 });
    fireEvent.wheel(scrollRegion, { ctrlKey: true, deltaY: -20 });
    fireEvent.wheel(scrollRegion, { ctrlKey: true, deltaY: -20 });

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeZoom);
  });

  it('restores the previous directory and selected file after the panel remounts', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 上次文件', size: 10 });
    const first = render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    expect(await screen.findByRole('heading', { name: '上次文件' })).toBeInTheDocument();
    first.unmount();

    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    expect(await screen.findByText('/tmp/project')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '上次文件' })).toBeInTheDocument();
    expect(documentApi.listDocumentTree).toHaveBeenLastCalledWith('/tmp/project');
  });

  it('restores document tabs tree outline and filter state after the panel remounts', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'docs', path: 'docs', kind: 'directory', children: [
        { name: 'README.md', path: 'docs/README.md', kind: 'file', extension: 'md' },
        { name: 'API.md', path: 'docs/API.md', kind: 'file', extension: 'md' },
      ] },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockImplementation(async (_root, path) => ({
      path,
      name: path.endsWith('API.md') ? 'API.md' : 'README.md',
      extension: 'md',
      content: path.endsWith('API.md') ? '# API\n\n## 接口' : '# README\n\n## 背景',
      size: 18,
    }));
    const first = render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    await user.click(screen.getByRole('button', { name: 'API.md' }));
    await user.click(screen.getByRole('button', { name: '隐藏大纲' }));
    await user.click(screen.getByRole('button', { name: '收起目录树' }));
    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: '已打开' }));
    first.unmount();

    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    expect(await screen.findByText('/tmp/project')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开目录树' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '文档树' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示大纲' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Markdown 大纲' })).not.toBeInTheDocument();

    const tabs = screen.getByLabelText('已打开文件');
    expect(within(tabs).getByRole('button', { name: /README.md/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: /API.md/ })).toBeInTheDocument();
    await openDirectoryMenu(user);
    expect(screen.getByRole('menuitemradio', { name: '已打开' })).toHaveAttribute('aria-checked', 'true');
  });

  it('inserts selected preview text into the current session composer', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 标题\n需要插入的内容', size: 20 });
    const onInsertText = vi.fn();
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={onInsertText} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const textNode = screen.getByText('需要插入的内容').firstChild;
    const range = document.createRange();
    range.setStart(textNode as Text, 0);
    range.setEnd(textNode as Text, 5);
    selection?.addRange(range);

    await user.click(screen.getByRole('button', { name: '文件操作' }));
    await user.click(screen.getByRole('menuitem', { name: '插入选中' }));

    expect(onInsertText).toHaveBeenCalledWith('需要插入的');
  });

  it('opens selected-text actions from the document content context menu', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'README.md',
      name: 'README.md',
      extension: 'md',
      content: '# 标题\n需要插入的内容',
      size: 20,
    });
    const onInsertText = vi.fn();
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={onInsertText} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const textNode = screen.getByText('需要插入的内容').firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode as Text, 0);
    range.setEnd(textNode as Text, 5);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(screen.getByLabelText('文档内容滚动区'), { clientX: 120, clientY: 140 });
    expect(screen.getByRole('menuitem', { name: '插入引用' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '带路径插入引用' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: '插入引用' }));
    expect(onInsertText).toHaveBeenLastCalledWith('需要插入的');

    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.contextMenu(screen.getByLabelText('文档内容滚动区'), { clientX: 120, clientY: 140 });
    await user.click(screen.getByRole('menuitem', { name: '带路径插入引用' }));
    expect(onInsertText).toHaveBeenLastCalledWith(expect.stringContaining('文件：README.md'));
    expect(onInsertText).toHaveBeenLastCalledWith(expect.stringContaining('需要插入的'));
  });


  it('renders markdown blocks with structured styling instead of source-like lines', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'README.md',
      name: 'README.md',
      extension: 'md',
      content: '# 标题\n\n- 第一项\n- 第二项\n\n```java\nclass Demo {}\n```\n\n> 风险提示',
      size: 56,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveClass('document-markdown-list');
    expect(screen.getByText('第一项').tagName).toBe('LI');
    const codeBlock = screen.getByText('class').closest('pre');
    expect(codeBlock).toHaveClass('document-markdown-code');
    expect(codeBlock).toHaveTextContent('class Demo {}');
    expect(screen.getByText('风险提示').closest('blockquote')).toHaveClass('document-markdown-quote');
  });

  it('keeps the file toolbar sticky and allows collapsing the directory tree', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 标题', size: 8 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    expect(screen.getAllByText('README.md')[1].closest('.document-viewer-header')).toHaveClass('sticky-file-toolbar');
    await user.click(screen.getByRole('button', { name: '收起目录树' }));
    expect(screen.queryByRole('navigation', { name: '文档树' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('文档浏览器')).toHaveClass('tree-collapsed');
    await user.click(screen.getByRole('button', { name: '展开目录树' }));
    expect(screen.getByRole('navigation', { name: '文档树' })).toBeInTheDocument();
  });

  it('allows resizing the directory list while keeping the document viewer visible', async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    const browser = screen.getByLabelText('文档浏览器');
    const tree = screen.getByRole('navigation', { name: '文档树' });
    vi.spyOn(browser, 'getBoundingClientRect').mockReturnValue({
      bottom: 760,
      height: 600,
      left: 0,
      right: 1000,
      toJSON: () => ({}),
      top: 160,
      width: 1000,
      x: 0,
      y: 160,
    });
    vi.spyOn(tree, 'getBoundingClientRect').mockReturnValue({
      bottom: 760,
      height: 600,
      left: 0,
      right: 360,
      toJSON: () => ({}),
      top: 160,
      width: 360,
      x: 0,
      y: 160,
    });

    const divider = screen.getByRole('separator', { name: '调整目录列表宽度' });
    act(() => {
      dispatchPointer(divider, 'pointerdown', 360);
      dispatchPointer(window, 'pointermove', 220);
      dispatchPointer(window, 'pointerup', 220);
    });

    expect(browser).toHaveStyle('--document-tree-width: 220px');
    expect(screen.getByRole('article')).toBeInTheDocument();
  });


  it('renders mermaid fences as diagrams and markdown tables as real tables', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'design.md', path: 'design.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'design.md',
      name: 'design.md',
      extension: 'md',
      content: '```mermaid\ngraph TD;\nA-->B;\n```\n\n| 字段 | 说明 |\n| --- | --- |\n| status | 状态 |',
      size: 86,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'design.md' }));

    expect(await screen.findByTestId('rendered-mermaid-svg')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveClass('document-markdown-table');
    expect(screen.getByRole('columnheader', { name: '字段' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '状态' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '放大图表' })).not.toBeInTheDocument();
  });

  it('renders markdown tables that use single-dash delimiter cells', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'plan.md', path: 'plan.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'plan.md',
      name: 'plan.md',
      extension: 'md',
      content: '# 结论\n\n| 维度 | 结论 | 原因 |\n|-|-|-|\n| 开发基线 | 不可与二期无关 | 需要复用二期公共能力 |',
      size: 96,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'plan.md' }));

    expect(screen.getByRole('table')).toHaveClass('document-markdown-table');
    expect(screen.getByRole('columnheader', { name: '维度' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '不可与二期无关' })).toBeInTheDocument();
  });

  it('keeps the file toolbar outside the horizontally scrollable preview body', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'wide.md', path: 'wide.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'wide.md',
      name: 'wide.md',
      extension: 'md',
      content: '| A | B | C | D | E | F | G | H | I | J | K | L | |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |',
      size: 166,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'wide.md' }));

    const toolbar = screen.getAllByText('wide.md')[1].closest('.document-viewer-header');
    const body = screen.getByLabelText('文档内容滚动区');

    expect(toolbar?.parentElement).toHaveClass('document-viewer');
    expect(body.parentElement).toHaveClass('document-viewer');
    expect(body).not.toContainElement(toolbar as HTMLElement);
  });

  it('does not render the diagram zoom or explain file toolbar buttons', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'design.md', path: 'design.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'design.md',
      name: 'design.md',
      extension: 'md',
      content: '```mermaid\ngraph TD;\nA-->B;\n```',
      size: 38,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'design.md' }));
    await screen.findByTestId('rendered-mermaid-svg');

    expect(screen.queryByRole('button', { name: '放大图表' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '解释文件' })).not.toBeInTheDocument();
  });


  it('fits markdown content to the viewer width at the original content zoom level', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 标题\n\n这是一段普通文本，需要在初始比例下适配文档查看区宽度。', size: 42 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    const zoomRegion = await screen.findByLabelText('文档内容缩放区');

    expect(zoomRegion).toHaveStyle('--document-content-zoom: 1');
    expect(zoomRegion).toHaveClass('document-preview-content');
    expect(screen.getByLabelText('Markdown 渲染内容')).toHaveClass('document-markdown');
    expect(zoomRegion.querySelector('.document-preview-canvas')).not.toBeInTheDocument();
  });

  it('zooms only the document content with a trackpad pinch gesture', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'design.md', path: 'design.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'design.md',
      name: 'design.md',
      extension: 'md',
      content: '# 方案\n\n```mermaid\ngraph TD;\nA-->B;\n```',
      size: 48,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'design.md' }));
    await screen.findByTestId('rendered-mermaid-svg');

    const browser = screen.getByLabelText('文档浏览器');
    fireEvent.wheel(browser, { ctrlKey: true, deltaY: -120 });

    await waitFor(() => {
      const zoomRegion = screen.getByLabelText('文档内容缩放区');
      expect(zoomRegion).toHaveStyle('--document-content-zoom: 1.08');
      expect((zoomRegion as HTMLElement).style.transform).toBe('');
      expect(zoomRegion.querySelector('.document-preview-canvas')).not.toBeInTheDocument();
    });
  });


  it('can shrink document content without scaling the preview canvas', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'design.md', path: 'design.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'design.md', name: 'design.md', extension: 'md', content: '# 方案', size: 8 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'design.md' }));

    fireEvent.wheel(screen.getByLabelText('文档浏览器'), { ctrlKey: true, deltaY: 120 });

    await waitFor(() => {
      const zoomRegion = screen.getByLabelText('文档内容缩放区');
      expect(zoomRegion).toHaveStyle('--document-content-zoom: 0.92');
      expect((zoomRegion as HTMLElement).style.transform).toBe('');
    });
  });

  it('sizes the document zoom spacer from actual content instead of a viewport-height percentage', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 短文档', size: 8 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    const zoomRegion = await screen.findByLabelText('文档内容缩放区');

    expect(zoomRegion).not.toHaveStyle('min-height: 100%');
    expect(zoomRegion).not.toHaveStyle('min-height: 108%');
  });


  it('opens only the first directory level when a directory is loaded', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'src', path: 'src', kind: 'directory', children: [
        { name: 'service', path: 'src/service', kind: 'directory', children: [
          { name: 'Demo.java', path: 'src/service/Demo.java', kind: 'file', extension: 'java' },
        ] },
      ] },
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);

    expect(await screen.findByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'service' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Demo.java' })).not.toBeInTheDocument();
  });

  it('keeps expanded directory paths stable when refreshing the tree', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree)
      .mockResolvedValueOnce([
        { name: 'src', path: 'src', kind: 'directory', children: [
          { name: 'service', path: 'src/service', kind: 'directory', children: [
            { name: 'Demo.java', path: 'src/service/Demo.java', kind: 'file', extension: 'java' },
          ] },
        ] },
      ])
      .mockResolvedValueOnce([
        { name: 'src', path: 'src', kind: 'directory', children: [
          { name: 'service', path: 'src/service', kind: 'directory', children: [
            { name: 'Demo.java', path: 'src/service/Demo.java', kind: 'file', extension: 'java' },
            { name: 'New.java', path: 'src/service/New.java', kind: 'file', extension: 'java' },
          ] },
          { name: 'controller', path: 'src/controller', kind: 'directory', children: [
            { name: 'Hidden.java', path: 'src/controller/Hidden.java', kind: 'file', extension: 'java' },
          ] },
        ] },
      ]);
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'service' }));
    expect(await screen.findByRole('button', { name: 'Demo.java' })).toBeInTheDocument();

    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitem', { name: '刷新目录' }));

    expect(await screen.findByRole('button', { name: 'New.java' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'service' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'controller' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Hidden.java' })).not.toBeInTheDocument();
  });


  it('allows horizontal scrolling in the directory tree for deeply nested paths', async () => {
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([]);
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    expect(screen.getByRole('navigation', { name: '文档树' })).toHaveClass('horizontal-scroll-tree');
  });


  it('refreshes the current directory only when the refresh button is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree)
      .mockResolvedValueOnce([{ name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' }])
      .mockResolvedValueOnce([
        { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
        { name: '新增.java', path: 'src/新增.java', kind: 'file', extension: 'java' },
      ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 旧内容', size: 8 })
      .mockResolvedValueOnce({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 刷新后内容', size: 12 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    expect(await screen.findByRole('heading', { name: '旧内容' })).toBeInTheDocument();
    expect(documentApi.listDocumentTree).toHaveBeenCalledTimes(1);

    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitem', { name: '刷新目录' }));

    expect(documentApi.listDocumentTree).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('heading', { name: '刷新后内容' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '新增.java' })).toBeInTheDocument();
  });


  it('highlights Java source files with semantic token colors', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'BrandSourceEnum.java', path: 'BrandSourceEnum.java', kind: 'file', extension: 'java' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'BrandSourceEnum.java',
      name: 'BrandSourceEnum.java',
      extension: 'java',
      content: '@Deprecated\npublic enum BrandSourceEnum {\n  ZZ("ExampleCompany"); // 来源\n}',
      size: 68,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'BrandSourceEnum.java' }));

    expect(screen.getByText('public')).toHaveClass('syntax-keyword');
    expect(screen.getByText('enum')).toHaveClass('syntax-keyword');
    expect(screen.getByText('@Deprecated')).toHaveClass('syntax-annotation');
    expect(screen.getByText('"ExampleCompany"')).toHaveClass('syntax-string');
    expect(screen.getByText('// 来源')).toHaveClass('syntax-comment');
  });

  it('renders markdown images and opens a zoom viewer', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'docs/README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'docs/README.md',
      name: 'README.md',
      extension: 'md',
      content: '![架构图](images/arch.png)',
      size: 26,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    const imageButton = await screen.findByRole('button', { name: '放大图片：架构图' });
    expect(screen.getByAltText('架构图')).toHaveAttribute('src', 'asset://localhost//tmp/project/docs/images/arch.png');
    await user.click(imageButton);

    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeInTheDocument();
    expect(screen.getByAltText('架构图 放大预览')).toHaveAttribute('src', 'asset://localhost//tmp/project/docs/images/arch.png');
  });


  it('opens a file context menu with AI actions and copy actions', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 标题', size: 8 });
    const onInsertText = vi.fn();
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={onInsertText} />);

    await chooseDirectory(user);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'README.md' }), { clientX: 10, clientY: 20 });

    expect(screen.getByRole('menuitem', { name: '发给当前会话解释' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '生成摘要' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '找风险点' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '生成待办' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: '找风险点' }));
    expect(onInsertText).toHaveBeenCalledWith(expect.stringContaining('风险点'));
    expect(onInsertText).toHaveBeenCalledWith(expect.stringContaining('README.md'));
  });

  it('inserts selected text with the file path and builds a combined context prompt', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'docs', path: 'docs', kind: 'directory', children: [{ name: 'README.md', path: 'docs/README.md', kind: 'file', extension: 'md' }] },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'docs/README.md', name: 'README.md', extension: 'md', content: '# 标题\n需要分析的内容', size: 20 });
    const onInsertText = vi.fn();
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={onInsertText} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const textNode = screen.getByText('需要分析的内容').firstChild;
    const range = document.createRange();
    range.setStart(textNode as Text, 0);
    range.setEnd(textNode as Text, 4);
    selection?.addRange(range);

    await user.click(screen.getByRole('button', { name: '文件操作' }));
    await user.click(screen.getByRole('menuitem', { name: '带路径插入' }));
    expect(onInsertText).toHaveBeenLastCalledWith(expect.stringContaining('文件：docs/README.md'));
    expect(onInsertText).toHaveBeenLastCalledWith(expect.stringContaining('需要分析'));

    expect(screen.queryByRole('button', { name: '组合上下文' })).not.toBeInTheDocument();
  });

  it('supports Cmd+F file search, markdown outline, tabs, favorites, and highlighted tree search', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'docs', path: 'docs', kind: 'directory', children: [
        { name: 'README.md', path: 'docs/README.md', kind: 'file', extension: 'md' },
        { name: 'API.md', path: 'docs/API.md', kind: 'file', extension: 'md' },
      ] },
    ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({ path: 'docs/README.md', name: 'README.md', extension: 'md', content: '# 标题\n\n## 风险\n风险内容', size: 20 })
      .mockResolvedValueOnce({ path: 'docs/API.md', name: 'API.md', extension: 'md', content: '# API', size: 6 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.type(screen.getByLabelText('搜索文档'), 'api');
    expect(screen.getByText('API')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('搜索文档'));
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    expect(screen.queryByLabelText('搜索当前文件')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '文件操作' }));
    await user.click(screen.getByRole('menuitem', { name: '收藏' }));
    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: '收藏' }));
    expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('搜索当前文件'));
    expect(screen.getByRole('button', { name: '隐藏大纲' })).toHaveClass('document-outline-toggle');
    expect(screen.getByRole('button', { name: '关闭文件搜索' })).toHaveClass('document-file-search-close');
    await user.type(screen.getByLabelText('搜索当前文件'), '风险');
    expect(screen.getAllByText('风险').length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Markdown 大纲' })).toBeInTheDocument();

    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: '全部' }));
    await user.click(screen.getByRole('button', { name: 'API.md' }));
    expect(within(screen.getByLabelText('已打开文件')).getByRole('button', { name: /README.md/ })).toBeInTheDocument();
    expect(within(screen.getByLabelText('已打开文件')).getByRole('button', { name: /API.md/ })).toBeInTheDocument();
  });

  it('keeps only one active search hit when matches span markdown inline fragments', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'inline.md', path: 'inline.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'inline.md',
      name: 'inline.md',
      extension: 'md',
      content: '风险 **风险** `风险`',
      size: 24,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'inline.md' }));
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await user.type(screen.getByLabelText('搜索当前文件'), '风险');

    const content = screen.getByLabelText('文档内容滚动区');
    expect(content.querySelectorAll('.document-search-hit.active')).toHaveLength(1);
    expect(content.querySelector('.document-search-hit.active')).toHaveAttribute('data-search-hit-index', '0');

    fireEvent.keyDown(screen.getByLabelText('搜索当前文件'), { key: 'Enter' });

    expect(content.querySelectorAll('.document-search-hit.active')).toHaveLength(1);
    expect(content.querySelector('.document-search-hit.active')).toHaveAttribute('data-search-hit-index', '1');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('renders code-like files with line numbers, json formatting, and mermaid source copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'data.json', path: 'data.json', kind: 'file', extension: 'json' },
      { name: 'flow.md', path: 'flow.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({ path: 'data.json', name: 'data.json', extension: 'json', content: '{"a":1}', size: 7 })
      .mockResolvedValueOnce({ path: 'flow.md', name: 'flow.md', extension: 'md', content: '```mermaid\ngraph TD;\nA-->B;\n```', size: 38 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'data.json' }));
    expect(screen.getByText('JSON 格式化视图')).toBeInTheDocument();
    expect(screen.getByText('1')).toHaveClass('document-code-line-number');
    expect(screen.getByRole('button', { name: '复制 path: $' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'flow.md' }));
    await screen.findByTestId('rendered-mermaid-svg');
    await user.click(screen.getByRole('button', { name: '复制 Mermaid 源码' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('graph TD'));
  });

  it('renders Mermaid source and preview as independently collapsible panes with vector zoom', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'flow.md', path: 'flow.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'flow.md',
      name: 'flow.md',
      extension: 'md',
      content: '# 流程\n\n```mermaid\ngraph TD;\nA-->B;\n```',
      size: 44,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'flow.md' }));
    await screen.findByTestId('rendered-mermaid-svg');

    expect(screen.getByLabelText('Mermaid 源码')).toBeInTheDocument();
    expect(screen.getByLabelText('Mermaid 图预览')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示 Mermaid 源码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起 Mermaid 预览' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '显示 Mermaid 源码' }));
    expect(screen.getByRole('button', { name: '收起 Mermaid 源码' })).toBeInTheDocument();
    expect(screen.getByLabelText('Mermaid 图预览')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收起 Mermaid 源码' }));
    await user.click(screen.getByRole('button', { name: '放大 Mermaid 图' }));
    const stage = screen.getByLabelText('Mermaid 图矢量画布');
    expect(stage).toHaveStyle({ width: '110%' });
    expect(stage).toHaveAttribute('data-renderer', 'svg');

    await user.click(screen.getByRole('button', { name: '复制 Mermaid 源码' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('graph TD'));
    expect(screen.getByText('Mermaid 源码已复制')).toBeInTheDocument();
  });



  it('treats favorited directories as full subtrees and moves path copy to the tree context menu', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'docs', path: 'docs', kind: 'directory', children: [
        { name: 'README.md', path: 'docs/README.md', kind: 'file', extension: 'md' },
        { name: 'deep', path: 'docs/deep', kind: 'directory', children: [
          { name: 'Risk.java', path: 'docs/deep/Risk.java', kind: 'file', extension: 'java' },
        ] },
      ] },
      { name: 'tmp.log', path: 'tmp.log', kind: 'file', extension: 'log' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'docs/README.md', name: 'README.md', extension: 'md', content: '# 标题', size: 8 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await openDirectoryMenu(user);
    expect(screen.queryByRole('menuitemradio', { name: '最近' })).not.toBeInTheDocument();
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'docs' }), { clientX: 12, clientY: 18 });
    await user.click(screen.getByRole('menuitem', { name: '收藏' }));
    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: '收藏' }));

    expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Risk.java' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'tmp.log' })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Risk.java' }), { clientX: 20, clientY: 30 });
    await user.click(screen.getByRole('menuitem', { name: '复制完整路径' }));
    expect(writeText).toHaveBeenCalledWith('/tmp/project/docs/deep/Risk.java');

    await user.click(screen.getByRole('button', { name: 'README.md' }));
    expect(screen.queryByRole('button', { name: '复制完整路径' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制相对路径' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制文件名' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '组合上下文' })).not.toBeInTheDocument();
  });

  it('keeps Cmd+F search and centered zoom stable for code and mermaid markdown', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'Risk.java', path: 'src/Risk.java', kind: 'file', extension: 'java' },
      { name: 'flow.md', path: 'flow.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({ path: 'src/Risk.java', name: 'Risk.java', extension: 'java', content: 'class Risk { void checkRisk() {} }', size: 35 })
      .mockResolvedValueOnce({ path: 'flow.md', name: 'flow.md', extension: 'md', content: '# 流程\n\n```mermaid\ngraph TD;\nA-->B;\n```', size: 44 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'Risk.java' }));
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('搜索当前文件'));
    await user.type(screen.getByLabelText('搜索当前文件'), 'Risk');
    expect(screen.getAllByText('Risk').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'flow.md' }));
    await screen.findByTestId('rendered-mermaid-svg');
    fireEvent.wheel(screen.getByLabelText('文档内容滚动区'), { ctrlKey: true, deltaY: -120 });
    await waitFor(() => {
      expect(screen.getByTestId('rendered-mermaid-svg')).toBeInTheDocument();
      expect(screen.getByLabelText('文档内容缩放区')).toHaveStyle('--document-content-zoom: 1.08');
      expect(screen.getByLabelText('文档内容缩放区').querySelector('.document-preview-canvas')).not.toBeInTheDocument();
    });
  });


  it('keeps the opened file header compact with tabs above the file toolbar', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 标题', size: 8 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));

    const header = screen.getAllByText('README.md')[1].closest('.document-viewer-header');
    expect(header).toHaveClass('compact-file-toolbar');
    expect(within(header as HTMLElement).getByLabelText('已打开文件')).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText(/Markdown/).closest('.document-file-toolbar-row')).toBeInTheDocument();
  });

  it('keeps markdown content visible after content zooming', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'design.md', path: 'design.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'design.md',
      name: 'design.md',
      extension: 'md',
      content: '# 方案\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\n放大后仍然可见',
      size: 64,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'design.md' }));
    await screen.findByTestId('rendered-mermaid-svg');
    fireEvent.wheel(screen.getByLabelText('文档内容滚动区'), { ctrlKey: true, deltaY: -120 });

    await waitFor(() => {
      expect(screen.getByLabelText('文档内容缩放区')).toHaveStyle('--document-content-zoom: 1.08');
      expect(screen.getByRole('heading', { name: '方案' })).toBeInTheDocument();
      expect(screen.getByTestId('rendered-mermaid-svg')).toBeInTheDocument();
      expect(screen.getByText('放大后仍然可见')).toBeInTheDocument();
    });
  });

  it('finds content with collapsed spaces and line breaks in markdown and code files', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'notes.md', path: 'notes.md', kind: 'file', extension: 'md' },
      { name: 'Risk.java', path: 'Risk.java', kind: 'file', extension: 'java' },
    ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({
        path: 'notes.md',
        name: 'notes.md',
        extension: 'md',
        content: '# 说明\n\n库存设备状态与发货\n线上发货涉及 wms_goods 库存设备状态流转（由服务处理）',
        size: 58,
      })
      .mockResolvedValueOnce({
        path: 'Risk.java',
        name: 'Risk.java',
        extension: 'java',
        content: 'class Risk {\n  // 流程的同名类，职责不同，注意区别\n}',
        size: 45,
      });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'notes.md' }));
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByLabelText('搜索当前文件'), {
      target: { value: '库存设备状态与发货\n线上发货涉及 wms_goods 库存设备状态流转（由' },
    });
    expect(screen.getByLabelText('文档内容滚动区').querySelectorAll('mark').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Risk.java' }));
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await user.type(screen.getByLabelText('搜索当前文件'), '程的同名类，职责不同，注意区');
    expect(within(screen.getByLabelText('文档内容滚动区')).getByText('程的同名类，职责不同，注意区')).toBeInTheDocument();
  });

  it('can favorite the currently opened root directory and show it as a full favorite subtree', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'docs', path: 'docs', kind: 'directory', children: [
        { name: 'README.md', path: 'docs/README.md', kind: 'file', extension: 'md' },
      ] },
      { name: 'src', path: 'src', kind: 'directory', children: [
        { name: 'Demo.java', path: 'src/Demo.java', kind: 'file', extension: 'java' },
      ] },
    ]);
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitem', { name: '收藏当前目录' }));
    await openDirectoryMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: '收藏' }));

    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'src' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Demo.java' })).toBeInTheDocument();
    await openDirectoryMenu(user);
    expect(screen.getByRole('menuitem', { name: '取消收藏当前目录' })).toBeInTheDocument();
  });


  it('keeps opened document tabs in a single horizontal strip', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
      { name: 'BrandSourceEnum.java', path: 'BrandSourceEnum.java', kind: 'file', extension: 'java' },
      { name: 'IPlatRecommendedProductErpFacade.java', path: 'IPlatRecommendedProductErpFacade.java', kind: 'file', extension: 'java' },
    ]);
    vi.mocked(documentApi.readDocumentFile)
      .mockResolvedValueOnce({ path: 'README.md', name: 'README.md', extension: 'md', content: '# 标题', size: 8 })
      .mockResolvedValueOnce({ path: 'BrandSourceEnum.java', name: 'BrandSourceEnum.java', extension: 'java', content: 'enum BrandSourceEnum {}', size: 23 })
      .mockResolvedValueOnce({ path: 'IPlatRecommendedProductErpFacade.java', name: 'IPlatRecommendedProductErpFacade.java', extension: 'java', content: 'interface IPlatRecommendedProductErpFacade {}', size: 43 });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    await user.click(screen.getByRole('button', { name: 'BrandSourceEnum.java' }));
    await user.click(screen.getByRole('button', { name: 'IPlatRecommendedProductErpFacade.java' }));

    const tabs = screen.getByLabelText('已打开文件');
    expect(tabs).toHaveClass('document-tabs');
    expect(tabs).toHaveClass('horizontal-document-tabs');
    expect(within(tabs).getByRole('button', { name: /README.md/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: /BrandSourceEnum.java/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: /IPlatRecommendedProductErpFacade.java/ })).toBeInTheDocument();
  });

  it('uses a stable base canvas size when zooming markdown with mermaid diagrams', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'flow.md', path: 'flow.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'flow.md',
      name: 'flow.md',
      extension: 'md',
      content: '# 流程\n\n```mermaid\ngraph TD;\nA-->B;\n```',
      size: 42,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'flow.md' }));
    await screen.findByTestId('rendered-mermaid-svg');

    fireEvent.wheel(screen.getByLabelText('文档内容滚动区'), { ctrlKey: true, deltaY: -120 });

    await waitFor(() => {
      const zoomRegion = screen.getByLabelText('文档内容缩放区');
      expect(zoomRegion).toHaveStyle('--document-content-zoom: 1.08');
      expect((zoomRegion as HTMLElement).style.width).toBe('');
      expect((zoomRegion as HTMLElement).style.height).toBe('');
      expect(screen.getByTestId('rendered-mermaid-svg')).toBeInTheDocument();
    });
  });


  it('keeps markdown images tables and mermaid visible when zooming document content', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'mixed.md', path: 'docs/mixed.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'docs/mixed.md',
      name: 'mixed.md',
      extension: 'md',
      content: '# 混合文档\n\n![架构图](./arch.png)\n\n| 模块 | 说明 |\n| --- | --- |\n| 库存 | 状态流转 |\n\n```mermaid\ngraph TD;\nA-->B;\n```',
      size: 118,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'mixed.md' }));
    await screen.findByTestId('rendered-mermaid-svg');

    fireEvent.wheel(screen.getByLabelText('文档内容滚动区'), { ctrlKey: true, deltaY: -120 });

    await waitFor(() => {
      expect(screen.getByRole('img', { name: '架构图' })).toBeInTheDocument();
      expect(screen.getByRole('table')).toHaveClass('document-markdown-table');
      expect(screen.getByTestId('rendered-mermaid-svg')).toBeInTheDocument();
      expect(screen.getByLabelText('文档内容缩放区')).toHaveStyle('--document-content-zoom: 1.08');
      expect(screen.getByLabelText('文档内容缩放区').querySelector('.document-preview-canvas')).not.toBeInTheDocument();
    });
  });


  it('keeps markdown outline independently scrollable and file actions in a compact menu', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'guide.md', path: 'guide.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'guide.md',
      name: 'guide.md',
      extension: 'md',
      content: '# 标题\n\n## 第一节\n内容\n\n## 第二节\n内容\n\n## 第三节\n内容',
      size: 42,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'guide.md' }));

    expect(screen.queryByRole('button', { name: '收藏' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '插入选中' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '插入引用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '带路径插入' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '隐藏大纲' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '文件操作' }));
    expect(screen.getByRole('menuitem', { name: '收藏' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '插入选中' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '插入引用' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '带路径插入' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Markdown 大纲' })).toHaveClass('independent-scroll-outline');
  });

  it('navigates normalized file search results with Enter without inserting line breaks', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'notes.md', path: 'notes.md', kind: 'file', extension: 'md' },
    ]);
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      path: 'notes.md',
      name: 'notes.md',
      extension: 'md',
      content: '# 说明\n\n库存设备状态与发货\n线上发货涉及 wms_goods 库存设备状态流转（由服务处理）\n\n再次提到库存设备状态与发货 线上发货涉及 wms_goods 库存设备状态流转（由',
      size: 120,
    });
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await chooseDirectory(user);
    await user.click(await screen.findByRole('button', { name: 'notes.md' }));
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByLabelText('搜索当前文件'), {
      target: { value: '库存设备状态与发货\n线上发货涉及 wms_goods 库存设备状态流转（由' },
    });

    expect(screen.getByLabelText('搜索结果数量')).toHaveTextContent('1/2');
    expect(screen.getByLabelText('文档内容滚动区').querySelectorAll('.document-search-hit').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('文档内容滚动区').querySelector('.document-search-hit.active')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('搜索当前文件'), { key: 'Enter' });
    expect(screen.getByLabelText('搜索结果数量')).toHaveTextContent('2/2');
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByLabelText('搜索当前文件')).toHaveValue('库存设备状态与发货\n线上发货涉及 wms_goods 库存设备状态流转（由');
  });


  it('collapses directory actions into a single menu in the panel header', async () => {
    const user = userEvent.setup();
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue('/tmp/project');
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', kind: 'file', extension: 'md' },
    ]);
    render(<DocumentPanel onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '选择目录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收藏当前目录' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('目录筛选')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新目录' })).not.toBeInTheDocument();

    await openDirectoryMenu(user);

    expect(screen.getByRole('menuitem', { name: '选择目录' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '收藏当前目录' })).toBeDisabled();
    expect(screen.getByRole('menuitemradio', { name: '全部' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: '已打开' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '收藏' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '刷新目录' })).toBeDisabled();

    await user.click(screen.getByRole('menuitem', { name: '选择目录' }));
    expect(await screen.findByText('/tmp/project')).toBeInTheDocument();

    await openDirectoryMenu(user);
    expect(screen.getByRole('menuitem', { name: '收藏当前目录' })).not.toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '刷新目录' })).not.toBeDisabled();
  });


});
