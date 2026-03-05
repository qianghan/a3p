import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateSelector } from '../../components/TemplateSelector';

const mockTemplates = [
  { id: 'ai-runner', name: 'AI Runner', description: 'Livepeer AI', icon: '🤖', dockerImage: 'livepeer/ai-runner', healthEndpoint: '/health', healthPort: 8080, category: 'curated' },
  { id: 'scope', name: 'Scope', description: 'Daydream Scope', icon: '🔬', dockerImage: 'daydreamlive/scope', healthEndpoint: '/health', healthPort: 8188, category: 'curated' },
];

const defaultProps = {
  selectedTemplateId: null as string | null,
  selectedVersion: null as string | null,
  customImage: '',
  customHealthPort: 8080,
  customHealthEndpoint: '/health',
  onSelectTemplate: vi.fn(),
  onSelectVersion: vi.fn(),
  onCustomImageChange: vi.fn(),
  onCustomHealthPortChange: vi.fn(),
  onCustomHealthEndpointChange: vi.fn(),
};

beforeEach(() => {
  global.fetch = vi.fn();
  (global.fetch as any).mockImplementation((url: string) => {
    if (url.includes('/templates') && !url.includes('/versions')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: mockTemplates }) });
    }
    if (url.includes('/versions')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          data: [
            { version: 'v1.0.0', publishedAt: '2026-01-01', prerelease: false, dockerImage: 'img:v1.0.0' },
            { version: 'v2.0.0', publishedAt: '2026-02-01', prerelease: false, dockerImage: 'img:v2.0.0' },
          ],
        }),
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TemplateSelector', () => {
  it('should render curated templates', async () => {
    render(<TemplateSelector {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('AI Runner')).toBeInTheDocument();
      expect(screen.getByText('Scope')).toBeInTheDocument();
    });
  });

  it('should render custom image option', async () => {
    render(<TemplateSelector {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Custom Docker Image')).toBeInTheDocument();
    });
  });

  it('should call onSelectTemplate when curated template clicked', async () => {
    const onSelectTemplate = vi.fn();
    render(<TemplateSelector {...defaultProps} onSelectTemplate={onSelectTemplate} />);
    await waitFor(() => expect(screen.getByText('AI Runner')).toBeInTheDocument());
    fireEvent.click(screen.getByText('AI Runner'));
    expect(onSelectTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: 'ai-runner' }));
  });

  it('should call onSelectTemplate with custom template when custom clicked', async () => {
    const onSelectTemplate = vi.fn();
    render(<TemplateSelector {...defaultProps} onSelectTemplate={onSelectTemplate} />);
    await waitFor(() => expect(screen.getByText('Custom Docker Image')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom Docker Image'));
    expect(onSelectTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom', category: 'custom' }));
  });

  it('should show custom image input fields when custom is selected', async () => {
    const onSelectTemplate = vi.fn();
    const { rerender } = render(<TemplateSelector {...defaultProps} onSelectTemplate={onSelectTemplate} />);
    await waitFor(() => expect(screen.getByText('Custom Docker Image')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom Docker Image'));
    rerender(<TemplateSelector {...defaultProps} selectedTemplateId="custom" onSelectTemplate={onSelectTemplate} />);
    fireEvent.click(screen.getByText('Custom Docker Image'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('myregistry/my-model:latest')).toBeInTheDocument();
    });
  });

  it('should render heading and description', async () => {
    render(<TemplateSelector {...defaultProps} />);
    expect(screen.getByText('Choose a Template')).toBeInTheDocument();
    expect(screen.getByText(/Pick a curated template/)).toBeInTheDocument();
  });

  it('should handle empty templates', async () => {
    (global.fetch as any).mockImplementation(() =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) }),
    );
    render(<TemplateSelector {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Custom Docker Image')).toBeInTheDocument();
    });
  });

  it('should show version dropdown when curated template is selected', async () => {
    render(
      <TemplateSelector
        {...defaultProps}
        selectedTemplateId="ai-runner"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Version')).toBeInTheDocument();
    });

    expect(screen.getByText('Select a version...')).toBeInTheDocument();
  });

  it('should call onSelectVersion when version is picked from dropdown', async () => {
    const onSelectVersion = vi.fn();
    render(
      <TemplateSelector
        {...defaultProps}
        selectedTemplateId="ai-runner"
        onSelectVersion={onSelectVersion}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Version')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'v1.0.0' } });
    expect(onSelectVersion).toHaveBeenCalledWith('v1.0.0', 'img:v1.0.0');
  });

  it('should call onCustomImageChange when custom image input changes', async () => {
    const onCustomImageChange = vi.fn();
    const onSelectTemplate = vi.fn();

    const { rerender } = render(
      <TemplateSelector {...defaultProps} onSelectTemplate={onSelectTemplate} onCustomImageChange={onCustomImageChange} />,
    );

    await waitFor(() => expect(screen.getByText('Custom Docker Image')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom Docker Image'));

    rerender(
      <TemplateSelector
        {...defaultProps}
        selectedTemplateId="custom"
        onSelectTemplate={onSelectTemplate}
        onCustomImageChange={onCustomImageChange}
      />,
    );
    fireEvent.click(screen.getByText('Custom Docker Image'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('myregistry/my-model:latest')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('myregistry/my-model:latest'), {
      target: { value: 'my-image:v2' },
    });
    expect(onCustomImageChange).toHaveBeenCalledWith('my-image:v2');
  });

  it('should call onCustomHealthEndpointChange when endpoint input changes', async () => {
    const onCustomHealthEndpointChange = vi.fn();
    const onSelectTemplate = vi.fn();

    const { rerender } = render(
      <TemplateSelector {...defaultProps} onSelectTemplate={onSelectTemplate} onCustomHealthEndpointChange={onCustomHealthEndpointChange} />,
    );

    await waitFor(() => expect(screen.getByText('Custom Docker Image')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom Docker Image'));

    rerender(
      <TemplateSelector
        {...defaultProps}
        selectedTemplateId="custom"
        onSelectTemplate={onSelectTemplate}
        onCustomHealthEndpointChange={onCustomHealthEndpointChange}
      />,
    );
    fireEvent.click(screen.getByText('Custom Docker Image'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/health')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('/health'), {
      target: { value: '/healthz' },
    });
    expect(onCustomHealthEndpointChange).toHaveBeenCalledWith('/healthz');
  });

  it('should call onCustomHealthPortChange when health port input changes', async () => {
    const onCustomHealthPortChange = vi.fn();
    const onSelectTemplate = vi.fn();

    const { rerender } = render(
      <TemplateSelector {...defaultProps} onSelectTemplate={onSelectTemplate} onCustomHealthPortChange={onCustomHealthPortChange} />,
    );

    await waitFor(() => expect(screen.getByText('Custom Docker Image')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom Docker Image'));

    rerender(
      <TemplateSelector
        {...defaultProps}
        selectedTemplateId="custom"
        onSelectTemplate={onSelectTemplate}
        onCustomHealthPortChange={onCustomHealthPortChange}
      />,
    );
    fireEvent.click(screen.getByText('Custom Docker Image'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('8080')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByDisplayValue('8080'), {
      target: { value: '3000' },
    });
    expect(onCustomHealthPortChange).toHaveBeenCalledWith(3000);
  });

  it('should render template docker images and descriptions', async () => {
    render(<TemplateSelector {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Livepeer AI')).toBeInTheDocument();
      expect(screen.getByText('livepeer/ai-runner')).toBeInTheDocument();
      expect(screen.getByText('Daydream Scope')).toBeInTheDocument();
    });
  });
});
