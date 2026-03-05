import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArtifactSelector } from '../../components/ArtifactSelector';

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mockArtifacts = [
  {
    type: 'livepeer-ai-worker',
    displayName: 'Livepeer AI Worker',
    description: 'Standard AI inference worker',
    dockerImage: 'livepeer/ai-worker:latest',
  },
  {
    type: 'custom-model',
    displayName: 'Custom Model',
    description: 'User-defined model container',
    dockerImage: 'registry.example.com/custom:latest',
  },
];

const mockVersions = [
  {
    version: 'v0.9.0',
    publishedAt: '2025-05-20T00:00:00Z',
    prerelease: false,
    dockerImage: 'livepeer/ai-worker:v0.9.0',
  },
  {
    version: 'v1.0.0-rc1',
    publishedAt: '2025-06-01T00:00:00Z',
    prerelease: true,
    dockerImage: 'livepeer/ai-worker:v1.0.0-rc1',
  },
];

describe('ArtifactSelector', () => {
  it('fetches and displays artifact cards on mount', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockArtifacts }),
    });

    render(
      <ArtifactSelector
        selectedType={null}
        selectedVersion={null}
        onSelectType={vi.fn()}
        onSelectVersion={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Livepeer AI Worker')).toBeInTheDocument();
    });

    expect(screen.getByText('Custom Model')).toBeInTheDocument();
    expect(screen.getByText('Standard AI inference worker')).toBeInTheDocument();
    expect(screen.getByText('livepeer/ai-worker:latest')).toBeInTheDocument();
  });

  it('renders the heading', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [] }),
    });

    render(
      <ArtifactSelector
        selectedType={null}
        selectedVersion={null}
        onSelectType={vi.fn()}
        onSelectVersion={vi.fn()}
      />,
    );

    expect(screen.getByText('Deployment Artifact')).toBeInTheDocument();
  });

  it('calls onSelectType when an artifact card is clicked', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockArtifacts }),
    });

    const onSelectType = vi.fn();
    render(
      <ArtifactSelector
        selectedType={null}
        selectedVersion={null}
        onSelectType={onSelectType}
        onSelectVersion={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Livepeer AI Worker')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Livepeer AI Worker'));
    expect(onSelectType).toHaveBeenCalledWith('livepeer-ai-worker');
  });

  it('fetches versions when selectedType changes and displays version dropdown', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockArtifacts }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockVersions }),
      });

    render(
      <ArtifactSelector
        selectedType="livepeer-ai-worker"
        selectedVersion={null}
        onSelectType={vi.fn()}
        onSelectVersion={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Version')).toBeInTheDocument();
    });

    expect(screen.getByText('Select a version...')).toBeInTheDocument();
    expect(screen.getByText(/v0\.9\.0/)).toBeInTheDocument();
    expect(screen.getByText(/v1\.0\.0-rc1.*\(pre-release\)/)).toBeInTheDocument();
  });

  it('calls onSelectVersion when a version is selected from dropdown', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockArtifacts }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockVersions }),
      });

    const onSelectVersion = vi.fn();
    render(
      <ArtifactSelector
        selectedType="livepeer-ai-worker"
        selectedVersion={null}
        onSelectType={vi.fn()}
        onSelectVersion={onSelectVersion}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Version')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'v0.9.0' } });

    expect(onSelectVersion).toHaveBeenCalledWith('v0.9.0', 'livepeer/ai-worker:v0.9.0');
  });

  it('does not render version dropdown when no type is selected', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockArtifacts }),
    });

    render(
      <ArtifactSelector
        selectedType={null}
        selectedVersion={null}
        onSelectType={vi.fn()}
        onSelectVersion={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Livepeer AI Worker')).toBeInTheDocument();
    });

    expect(screen.queryByText('Version')).not.toBeInTheDocument();
  });
});
