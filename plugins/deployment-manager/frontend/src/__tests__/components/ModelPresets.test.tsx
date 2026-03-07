import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelPresetPicker, getPresetsForProvider, getSelfHostedPresets } from '../../components/ModelPresets';

describe('getPresetsForProvider', () => {
  it('returns fal-ai presets', () => {
    const presets = getPresetsForProvider('fal-ai');
    expect(presets.length).toBeGreaterThan(5);
    expect(presets.every((p) => p.provider === 'fal-ai')).toBe(true);
  });

  it('returns replicate presets', () => {
    const presets = getPresetsForProvider('replicate');
    expect(presets.length).toBeGreaterThan(5);
    expect(presets.every((p) => p.provider === 'replicate')).toBe(true);
  });

  it('returns runpod presets', () => {
    const presets = getPresetsForProvider('runpod');
    expect(presets.length).toBeGreaterThan(3);
    expect(presets.every((p) => p.provider === 'runpod')).toBe(true);
  });

  it('returns empty for custom provider', () => {
    expect(getPresetsForProvider('custom')).toEqual([]);
  });

  it('returns empty for unknown provider', () => {
    expect(getPresetsForProvider('unknown')).toEqual([]);
  });
});

describe('getSelfHostedPresets', () => {
  it('returns self-hosted presets with dockerImage', () => {
    const presets = getSelfHostedPresets();
    expect(presets.length).toBeGreaterThan(3);
    expect(presets.every((p) => p.provider === 'self-hosted')).toBe(true);
    expect(presets.every((p) => !!p.dockerImage)).toBe(true);
  });
});

describe('ModelPresetPicker', () => {
  const presets = getPresetsForProvider('fal-ai');
  const onSelect = vi.fn();

  it('renders search input', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    expect(screen.getByTestId('model-preset-search')).toBeTruthy();
  });

  it('opens dropdown on focus', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    fireEvent.focus(screen.getByTestId('model-preset-search'));
    expect(screen.getByTestId('model-preset-dropdown')).toBeTruthy();
  });

  it('filters presets by search query', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    const input = screen.getByTestId('model-preset-search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'flux' } });
    const dropdown = screen.getByTestId('model-preset-dropdown');
    expect(dropdown.textContent).toContain('FLUX');
    expect(dropdown.textContent).not.toContain('Whisper');
  });

  it('filters by category', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    const input = screen.getByTestId('model-preset-search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'audio' } });
    const dropdown = screen.getByTestId('model-preset-dropdown');
    expect(dropdown.textContent).toContain('Whisper');
  });

  it('calls onSelect when preset selected via keyboard', () => {
    const selectFn = vi.fn();
    render(<ModelPresetPicker presets={presets} value="" onSelect={selectFn} />);
    const input = screen.getByTestId('model-preset-search');
    fireEvent.focus(input);
    // ArrowDown without filtering first — selects from full list
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(selectFn).toHaveBeenCalledWith(expect.objectContaining({ provider: 'fal-ai' }));
  });

  it('shows "no presets match" for unmatched query', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    const input = screen.getByTestId('model-preset-search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'xyznonexistent123' } });
    expect(screen.getByText(/No presets match/)).toBeTruthy();
  });

  it('displays existing value as preset name', () => {
    render(<ModelPresetPicker presets={presets} value="fal-ai/flux/dev" onSelect={onSelect} />);
    const input = screen.getByTestId('model-preset-search') as HTMLInputElement;
    expect(input.value).toBe('FLUX.1 Dev');
  });

  it('displays raw value when not matching preset', () => {
    render(<ModelPresetPicker presets={presets} value="custom/my-model" onSelect={onSelect} />);
    const input = screen.getByTestId('model-preset-search') as HTMLInputElement;
    expect(input.value).toBe('custom/my-model');
  });

  it('calls onCustomValue on blur with typed value', () => {
    const onCustom = vi.fn();
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} onCustomValue={onCustom} />);
    const input = screen.getByTestId('model-preset-search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'my-org/my-custom-model' } });
    fireEvent.blur(input);
    expect(onCustom).toHaveBeenCalledWith('my-org/my-custom-model');
  });

  it('supports keyboard navigation with ArrowDown/Enter', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    const input = screen.getByTestId('model-preset-search');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalled();
  });

  it('groups presets by category', () => {
    render(<ModelPresetPicker presets={presets} value="" onSelect={onSelect} />);
    fireEvent.focus(screen.getByTestId('model-preset-search'));
    const dropdown = screen.getByTestId('model-preset-dropdown');
    expect(dropdown.textContent).toContain('Image Generation');
  });
});
