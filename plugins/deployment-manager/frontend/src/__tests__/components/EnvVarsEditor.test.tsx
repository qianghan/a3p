import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnvVarsEditor } from '../../components/EnvVarsEditor';

describe('EnvVarsEditor', () => {
  it('shows empty message when no env vars', () => {
    render(<EnvVarsEditor envVars={{}} onChange={vi.fn()} />);
    expect(screen.getByText('No environment variables configured.')).toBeInTheDocument();
  });

  it('renders Add Variable button', () => {
    render(<EnvVarsEditor envVars={{}} onChange={vi.fn()} />);
    expect(screen.getByText('+ Add Variable')).toBeInTheDocument();
  });

  it('renders existing env vars as key-value inputs', () => {
    render(<EnvVarsEditor envVars={{ API_KEY: 'secret123', DEBUG: 'true' }} onChange={vi.fn()} />);
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(4);
  });

  it('displays correct key and value in inputs', () => {
    render(<EnvVarsEditor envVars={{ API_KEY: 'secret123' }} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('API_KEY')).toBeInTheDocument();
    expect(screen.getByDisplayValue('secret123')).toBeInTheDocument();
  });

  it('does not show empty message when vars exist', () => {
    render(<EnvVarsEditor envVars={{ KEY: 'val' }} onChange={vi.fn()} />);
    expect(screen.queryByText('No environment variables configured.')).not.toBeInTheDocument();
  });

  it('calls onChange with new entry when Add Variable is clicked', () => {
    const onChange = vi.fn();
    render(<EnvVarsEditor envVars={{}} onChange={onChange} />);
    fireEvent.click(screen.getByText('+ Add Variable'));
    expect(onChange).toHaveBeenCalledWith({ VAR_1: '' });
  });

  it('generates incremented key name when adding to existing vars', () => {
    const onChange = vi.fn();
    render(<EnvVarsEditor envVars={{ EXISTING: 'val' }} onChange={onChange} />);
    fireEvent.click(screen.getByText('+ Add Variable'));
    expect(onChange).toHaveBeenCalledWith({ EXISTING: 'val', VAR_2: '' });
  });

  it('calls onChange without entry when X is clicked', () => {
    const onChange = vi.fn();
    render(<EnvVarsEditor envVars={{ KEY: 'val' }} onChange={onChange} />);
    fireEvent.click(screen.getByText('X'));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('calls onChange when value is modified', () => {
    const onChange = vi.fn();
    render(<EnvVarsEditor envVars={{ KEY: 'old' }} onChange={onChange} />);
    const valueInput = screen.getByDisplayValue('old');
    fireEvent.change(valueInput, { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalledWith({ KEY: 'new' });
  });

  it('calls onChange when key is renamed', () => {
    const onChange = vi.fn();
    render(<EnvVarsEditor envVars={{ OLD_KEY: 'val' }} onChange={onChange} />);
    const keyInput = screen.getByDisplayValue('OLD_KEY');
    fireEvent.change(keyInput, { target: { value: 'NEW_KEY' } });
    expect(onChange).toHaveBeenCalledWith({ NEW_KEY: 'val' });
  });
});
