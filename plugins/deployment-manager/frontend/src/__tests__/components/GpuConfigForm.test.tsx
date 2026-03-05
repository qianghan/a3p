import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GpuConfigForm } from '../../components/GpuConfigForm';
import type { GpuOption } from '../../hooks/useProviders';

const gpuOptions: GpuOption[] = [
  { id: 'a100', name: 'NVIDIA A100', vramGb: 80, available: true, pricePerHour: 2.5 },
  { id: 'h100', name: 'NVIDIA H100', vramGb: 80, available: true, pricePerHour: 3.85 },
  { id: 't4', name: 'NVIDIA T4', vramGb: 16, available: false, pricePerHour: 0.5 },
  { id: 'l4', name: 'NVIDIA L4', vramGb: 24, available: true },
];

describe('GpuConfigForm', () => {
  let onSelectGpu: ReturnType<typeof vi.fn>;
  let onGpuCountChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSelectGpu = vi.fn();
    onGpuCountChange = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading and available GPU buttons', () => {
    render(
      <GpuConfigForm
        gpuOptions={gpuOptions}
        selectedGpu={null}
        gpuCount={1}
        onSelectGpu={onSelectGpu}
        onGpuCountChange={onGpuCountChange}
      />,
    );

    expect(screen.getByText('GPU Configuration')).toBeInTheDocument();
    expect(screen.getByText('NVIDIA A100')).toBeInTheDocument();
    expect(screen.getByText('NVIDIA H100')).toBeInTheDocument();
    expect(screen.getByText('NVIDIA L4')).toBeInTheDocument();
  });

  it('filters out unavailable GPUs', () => {
    render(
      <GpuConfigForm
        gpuOptions={gpuOptions}
        selectedGpu={null}
        gpuCount={1}
        onSelectGpu={onSelectGpu}
        onGpuCountChange={onGpuCountChange}
      />,
    );

    expect(screen.queryByText('NVIDIA T4')).not.toBeInTheDocument();
  });

  it('renders VRAM and price info for each available GPU', () => {
    render(
      <GpuConfigForm
        gpuOptions={gpuOptions}
        selectedGpu={null}
        gpuCount={1}
        onSelectGpu={onSelectGpu}
        onGpuCountChange={onGpuCountChange}
      />,
    );

    expect(screen.getByText('80GB VRAM · $2.50/hr')).toBeInTheDocument();
    expect(screen.getByText('80GB VRAM · $3.85/hr')).toBeInTheDocument();
    expect(screen.getByText('24GB VRAM')).toBeInTheDocument();
  });

  it('calls onSelectGpu when a GPU button is clicked', () => {
    render(
      <GpuConfigForm
        gpuOptions={gpuOptions}
        selectedGpu={null}
        gpuCount={1}
        onSelectGpu={onSelectGpu}
        onGpuCountChange={onGpuCountChange}
      />,
    );

    fireEvent.click(screen.getByText('NVIDIA A100'));
    expect(onSelectGpu).toHaveBeenCalledWith('a100');
  });

  it('calls onGpuCountChange when the GPU count select changes', () => {
    render(
      <GpuConfigForm
        gpuOptions={gpuOptions}
        selectedGpu="a100"
        gpuCount={1}
        onSelectGpu={onSelectGpu}
        onGpuCountChange={onGpuCountChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } });
    expect(onGpuCountChange).toHaveBeenCalledWith(4);
  });

  it('visually highlights the selected GPU', () => {
    const { container } = render(
      <GpuConfigForm
        gpuOptions={gpuOptions}
        selectedGpu="h100"
        gpuCount={2}
        onSelectGpu={onSelectGpu}
        onGpuCountChange={onGpuCountChange}
      />,
    );

    const h100Button = screen.getByText('NVIDIA H100').closest('button')!;
    expect(h100Button.style.border).toContain('2px solid');

    const a100Button = screen.getByText('NVIDIA A100').closest('button')!;
    expect(a100Button.style.border).toContain('1px solid');
  });
});
