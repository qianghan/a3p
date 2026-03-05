import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthIndicator } from '../../components/HealthIndicator';

describe('HealthIndicator', () => {
  it('should render GREEN indicator', () => {
    const { container } = render(<HealthIndicator status="GREEN" />);
    const dot = container.querySelector('span span');
    expect(dot).toBeTruthy();
    expect(dot!.style.backgroundColor).toBe('rgb(34, 197, 94)');
  });

  it('should render RED indicator', () => {
    const { container } = render(<HealthIndicator status="RED" />);
    const dot = container.querySelector('span span');
    expect(dot!.style.backgroundColor).toBe('rgb(239, 68, 68)');
  });

  it('should render ORANGE indicator', () => {
    const { container } = render(<HealthIndicator status="ORANGE" />);
    const dot = container.querySelector('span span');
    expect(dot!.style.backgroundColor).toBe('rgb(245, 158, 11)');
  });

  it('should render UNKNOWN for unrecognized status', () => {
    const { container } = render(<HealthIndicator status="BOGUS" />);
    const dot = container.querySelector('span span');
    expect(dot!.style.backgroundColor).toBe('rgb(156, 163, 175)');
  });

  it('should show label when showLabel is true', () => {
    render(<HealthIndicator status="GREEN" showLabel />);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('should not show label by default', () => {
    render(<HealthIndicator status="GREEN" />);
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
  });

  it('should use custom size', () => {
    const { container } = render(<HealthIndicator status="GREEN" size={24} />);
    const dot = container.querySelector('span span');
    expect(dot!.style.width).toBe('24px');
    expect(dot!.style.height).toBe('24px');
  });
});
