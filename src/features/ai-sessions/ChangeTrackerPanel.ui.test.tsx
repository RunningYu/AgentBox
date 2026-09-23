import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeTrackerPanel, resetChangeTrackerRuntimeStateForTests } from './ChangeTrackerPanel';
import { readContextFile } from './documentApi';
import { scanRecentChanges } from './changeTrackerApi';

vi.mock('./documentApi', () => ({
  chooseDocumentDirectory: vi.fn(),
  readContextFile: vi.fn(),
}));

vi.mock('./changeTrackerApi', () => ({
  scanRecentChanges: vi.fn(),
}));

describe('ChangeTrackerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetChangeTrackerRuntimeStateForTests();
    vi.mocked(scanRecentChanges).mockResolvedValue([
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_000_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 24,
      },
    ]);
    vi.mocked(readContextFile).mockResolvedValue({
      content: 'class Test {\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 24,
    });
  });

  afterEach(() => {
    cleanup();
    resetChangeTrackerRuntimeStateForTests();
    vi.restoreAllMocks();
  });

  it('builds a baseline for existing files instead of showing them as all added', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '变更详情' })).toHaveClass('active'));
    expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument();
    expect(screen.getByText('暂无已捕获的红绿 Diff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test.java/ })).not.toBeInTheDocument();
    expect(screen.queryByText('+3 新增')).not.toBeInTheDocument();
    expect(screen.queryByText('暂无可展示的前后变更')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '当前内容' }));
    await user.click(screen.getByRole('button', { name: '变更详情' }));
    expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument();
  });

  it('builds a baseline for files first discovered after tracking starts instead of showing them as all added', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
          absolutePath: '/tmp/demo/NewPlan.md',
          createdMs: Date.now() + 1_000,
          extension: 'md',
          modifiedMs: 1_723_000_001_000,
        name: 'NewPlan.md',
        path: 'NewPlan.md',
        size: 11,
      },
      {
          absolutePath: '/tmp/demo/Test.java',
          createdMs: 1_722_999_900_000,
          extension: 'java',
          modifiedMs: 1_723_000_000_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 24,
      },
    ]);
    vi.mocked(readContextFile).mockImplementation(async (path: string) => ({
      content: path.endsWith('NewPlan.md') ? 'new file' : 'class Test {\n}\n',
      extension: path.endsWith('NewPlan.md') ? 'md' : 'java',
      name: path.endsWith('NewPlan.md') ? 'NewPlan.md' : 'Test.java',
      path,
      size: path.endsWith('NewPlan.md') ? 8 : 24,
    }));

    await user.click(screen.getByRole('button', { name: '刷新变更' }));

    expect(screen.queryByRole('button', { name: /NewPlan.md/ })).not.toBeInTheDocument();
    expect(screen.queryByText('+1 新增')).not.toBeInTheDocument();

    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/NewPlan.md',
        createdMs: Date.now() + 1_000,
        extension: 'md',
        modifiedMs: 1_723_000_002_000,
        name: 'NewPlan.md',
        path: 'NewPlan.md',
        size: 19,
      },
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_000_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 24,
      },
    ]);
    vi.mocked(readContextFile).mockImplementation(async (path: string) => ({
      content: path.endsWith('NewPlan.md') ? 'new file\nchanged' : 'class Test {\n}\n',
      extension: path.endsWith('NewPlan.md') ? 'md' : 'java',
      name: path.endsWith('NewPlan.md') ? 'NewPlan.md' : 'Test.java',
      path,
      size: path.endsWith('NewPlan.md') ? 16 : 24,
    }));
    await user.click(screen.getByRole('button', { name: '刷新变更' }));

    expect(await screen.findByRole('button', { name: /NewPlan.md/ })).toBeInTheDocument();
    expect(screen.getByText('+1 新增')).toBeInTheDocument();
    expect(screen.getByText('changed')).toBeInTheDocument();
  });


  it('shows a real diff for an existing file after it changes from its baseline', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_002_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 42,
      },
    ]);
    vi.mocked(readContextFile).mockResolvedValueOnce({
      content: 'class Test {\n  void changed() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 42,
    });

    await user.click(screen.getByRole('button', { name: '刷新变更' }));

    expect(screen.getByText('+1 新增')).toBeInTheDocument();
    expect(screen.getByText('-0 删除')).toBeInTheDocument();
    expect(screen.getByText(/void changed\(\) \{\}/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test.java/ })).toBeInTheDocument();
  });

  it('keeps changed files sorted by modified time after a file is opened', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    const trackedFiles = [
      {
        absolutePath: '/tmp/demo/Old.java',
        createdMs: 1_722_999_800_000,
        extension: 'java',
        modifiedMs: 1_723_000_001_000,
        name: 'Old.java',
        path: 'Old.java',
        size: 32,
      },
      {
        absolutePath: '/tmp/demo/New.java',
        createdMs: 1_722_999_700_000,
        extension: 'java',
        modifiedMs: 1_723_000_003_000,
        name: 'New.java',
        path: 'New.java',
        size: 32,
      },
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_000_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 24,
      },
    ];
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      ...trackedFiles,
    ]);
    vi.mocked(readContextFile).mockImplementation(async (path: string) => ({
      content: path.endsWith('New.java')
        ? 'class New {\n}\n'
        : path.endsWith('Old.java')
          ? 'class Old {\n}\n'
          : 'class Test {\n}\n',
      extension: 'java',
      name: path.split('/').pop() ?? 'Test.java',
      path,
      size: 32,
    }));
    await user.click(screen.getByRole('button', { name: '刷新变更' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Old.java/ })).not.toBeInTheDocument());

    vi.mocked(scanRecentChanges).mockResolvedValueOnce(trackedFiles.map((file) => ({
      ...file,
      modifiedMs: file.name === 'New.java' ? 1_723_000_006_000 : file.name === 'Old.java' ? 1_723_000_004_000 : file.modifiedMs,
      size: file.name === 'New.java' || file.name === 'Old.java' ? 48 : file.size,
    })));
    vi.mocked(readContextFile).mockImplementation(async (path: string) => ({
      content: path.endsWith('New.java')
        ? 'class New {\n  void changed() {}\n}\n'
        : path.endsWith('Old.java')
          ? 'class Old {\n  void changed() {}\n}\n'
          : 'class Test {\n}\n',
      extension: 'java',
      name: path.split('/').pop() ?? 'Test.java',
      path,
      size: 48,
    }));
    await user.click(screen.getByRole('button', { name: '刷新变更' }));
    await user.click(await screen.findByRole('button', { name: /Old.java/ }));

    const changedFileNames = screen.getAllByRole('button', { name: /\.java/ })
      .filter((button) => button.classList.contains('change-tracker-file'))
      .map((button) => button.textContent ?? '');
    expect(changedFileNames[0]).toContain('New.java');
    expect(changedFileNames[1]).toContain('Old.java');
  });

  it('keeps captured diffs after the tracker panel remounts', async () => {
    const user = userEvent.setup();
    const first = render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    vi.mocked(scanRecentChanges).mockResolvedValue([
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_002_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 42,
      },
    ]);
    vi.mocked(readContextFile).mockResolvedValue({
      content: 'class Test {\n  void changed() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 42,
    });

    await user.click(screen.getByRole('button', { name: '刷新变更' }));
    expect(await screen.findByText('+1 新增')).toBeInTheDocument();
    first.unmount();

    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /Test.java/ })).toBeInTheDocument();
    expect(await screen.findByText('+1 新增')).toBeInTheDocument();
    expect(screen.getByText(/void changed\(\) \{\}/)).toBeInTheDocument();
  });

  it('accumulates multiple saves against the same baseline until the baseline is reset', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_002_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 42,
      },
    ]);
    vi.mocked(readContextFile).mockResolvedValueOnce({
      content: 'class Test {\n  void changed() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 42,
    });
    await user.click(screen.getByRole('button', { name: '刷新变更' }));
    expect(await screen.findByText('+1 新增')).toBeInTheDocument();

    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_003_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 66,
      },
    ]);
    vi.mocked(readContextFile).mockResolvedValueOnce({
      content: 'class Test {\n  void changed() {}\n  void changedAgain() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 66,
    });
    await user.click(screen.getByRole('button', { name: '刷新变更' }));

    expect(await screen.findByText('+2 新增')).toBeInTheDocument();
    expect(screen.getByText(/void changed\(\) \{\}/)).toBeInTheDocument();
    expect(screen.getByText(/void changedAgain\(\) \{\}/)).toBeInTheDocument();
  });

  it('resets the tracking baseline only when the reset baseline button is clicked', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    const changedFile = {
      absolutePath: '/tmp/demo/Test.java',
      createdMs: 1_722_999_900_000,
      extension: 'java',
      modifiedMs: 1_723_000_002_000,
      name: 'Test.java',
      path: 'Test.java',
      size: 42,
    };
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([changedFile]);
    vi.mocked(readContextFile).mockResolvedValueOnce({
      content: 'class Test {\n  void changed() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 42,
    });
    await user.click(screen.getByRole('button', { name: '刷新变更' }));
    expect(await screen.findByRole('button', { name: /Test.java/ })).toBeInTheDocument();

    vi.mocked(scanRecentChanges).mockResolvedValueOnce([changedFile]);
    vi.mocked(readContextFile).mockResolvedValueOnce({
      content: 'class Test {\n  void changed() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 42,
    });
    await user.click(screen.getByRole('button', { name: '重置追踪基线' }));
    expect(await screen.findByText('暂无已捕获的红绿 Diff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test.java/ })).not.toBeInTheDocument();

    vi.mocked(scanRecentChanges).mockResolvedValueOnce([{ ...changedFile, modifiedMs: 1_723_000_003_000, size: 66 }]);
    vi.mocked(readContextFile).mockResolvedValueOnce({
      content: 'class Test {\n  void changed() {}\n  void afterReset() {}\n}\n',
      extension: 'java',
      name: 'Test.java',
      path: '/tmp/demo/Test.java',
      size: 66,
    });
    await user.click(screen.getByRole('button', { name: '刷新变更' }));
    expect(await screen.findByText('+1 新增')).toBeInTheDocument();
    expect(screen.getByText(/void afterReset\(\) \{\}/)).toBeInTheDocument();
  });


  it('does not show an existing file as all added when it is discovered after tracking started', async () => {
    const user = userEvent.setup();
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_000_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 24,
      },
    ]);
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/ExistingPlan.md',
        createdMs: 1_722_999_800_000,
        extension: 'md',
        modifiedMs: 1_723_000_010_000,
        name: 'ExistingPlan.md',
        path: 'ExistingPlan.md',
        size: 16,
      },
      {
        absolutePath: '/tmp/demo/Test.java',
        createdMs: 1_722_999_900_000,
        extension: 'java',
        modifiedMs: 1_723_000_000_000,
        name: 'Test.java',
        path: 'Test.java',
        size: 24,
      },
    ]);
    vi.mocked(readContextFile).mockImplementation(async (path: string) => ({
      content: path.endsWith('ExistingPlan.md') ? 'old existing file' : 'class Test {\n}\n',
      extension: path.endsWith('ExistingPlan.md') ? 'md' : 'java',
      name: path.endsWith('ExistingPlan.md') ? 'ExistingPlan.md' : 'Test.java',
      path,
      size: path.endsWith('ExistingPlan.md') ? 17 : 24,
    }));

    await user.click(screen.getByRole('button', { name: '刷新变更' }));

    expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ExistingPlan.md/ })).not.toBeInTheDocument();
    expect(screen.queryByText('+1 新增')).not.toBeInTheDocument();
  });

  it('does not show a newly discovered worktree file as all added even when its created time is recent', async () => {
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
    vi.mocked(scanRecentChanges).mockResolvedValueOnce([
      {
        absolutePath: '/tmp/demo/worktrees/sample-service/ProductManageRpcFacade.java',
        createdMs: Date.now() + 1_000,
        extension: 'java',
        modifiedMs: 1_723_000_010_000,
        name: 'ProductManageRpcFacade.java',
        path: 'worktrees/sample-service/ProductManageRpcFacade.java',
        size: 5_200,
      },
    ]);
    vi.mocked(readContextFile).mockResolvedValue({
      content: Array.from({ length: 189 }, (_, index) => `line ${index + 1}`).join('\n'),
      extension: 'java',
      name: 'ProductManageRpcFacade.java',
      path: '/tmp/demo/worktrees/sample-service/ProductManageRpcFacade.java',
      size: 5_200,
    });

    fireEvent.click(screen.getByRole('button', { name: '刷新变更' }));
    await waitFor(() => expect(screen.queryByText('正在扫描最近修改')).not.toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /ProductManageRpcFacade.java/ })).not.toBeInTheDocument();
    expect(screen.queryByText('+189 新增')).not.toBeInTheDocument();
    expect(screen.getByText('暂无已捕获的红绿 Diff')).toBeInTheDocument();
  });


  it('continues auto tracking and switches the preview while the changed file list is collapsed', async () => {
    const user = userEvent.setup();
    let intervalCallback: (() => void) | undefined;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((callback: TimerHandler, timeout?: number) => {
      if (timeout === 8_000) {
        intervalCallback = callback as () => void;
      }
      return 1;
    });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    try {
      render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('已建立基线，等待文件下一次保存后展示红绿 Diff')).toBeInTheDocument());
      await waitFor(() => expect(intervalCallback).toBeTypeOf('function'));
      await user.click(screen.getByRole('button', { name: '收起实时追踪文档列表' }));
      expect(screen.getByRole('complementary')).toHaveClass('list-collapsed');

      vi.mocked(scanRecentChanges).mockResolvedValueOnce([
        {
          absolutePath: '/tmp/demo/Test.java',
          createdMs: 1_722_999_900_000,
          extension: 'java',
          modifiedMs: 1_723_000_003_000,
          name: 'Test.java',
          path: 'Test.java',
          size: 55,
        },
      ]);
      vi.mocked(readContextFile).mockResolvedValueOnce({
        content: 'class Test {\n  void autoChanged() {}\n}\n',
        extension: 'java',
        name: 'Test.java',
        path: '/tmp/demo/Test.java',
        size: 55,
      });

      await act(async () => {
        intervalCallback?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByText('已自动切换到最新变更')).toBeInTheDocument());
      expect(screen.getByRole('complementary')).toHaveClass('list-collapsed');
      expect(screen.getByText(/autoChanged/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '变更详情' })).toHaveClass('active');
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('collapses and expands the changed file list', async () => {
    const user = userEvent.setup();
    render(<ChangeTrackerPanel cwd="/tmp/demo" onCollapse={vi.fn()} onError={vi.fn()} onInsertText={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '收起实时追踪文档列表' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '收起实时追踪文档列表' }));

    expect(screen.getByRole('complementary')).toHaveClass('list-collapsed');
    await user.click(screen.getAllByRole('button', { name: '展开实时追踪文档列表' })[0]);
    expect(screen.getByRole('complementary')).not.toHaveClass('list-collapsed');
  });

});
