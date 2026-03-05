import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SshHostConfig } from '../../components/SshHostConfig';

describe('SshHostConfig', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading and all input fields', () => {
    render(
      <SshHostConfig host="" port={22} username="" onChange={onChange} />,
    );

    expect(screen.getByText('SSH Host Configuration')).toBeInTheDocument();
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
  });

  it('populates inputs with provided values', () => {
    render(
      <SshHostConfig host="10.0.1.5" port={2222} username="deploy" onChange={onChange} />,
    );

    expect(screen.getByDisplayValue('10.0.1.5')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2222')).toBeInTheDocument();
    expect(screen.getByDisplayValue('deploy')).toBeInTheDocument();
  });

  it('calls onChange with sshHost when host input changes', () => {
    render(
      <SshHostConfig host="" port={22} username="" onChange={onChange} />,
    );

    const hostInput = screen.getByPlaceholderText('10.0.1.5 or gpu-server.example.com');
    fireEvent.change(hostInput, { target: { value: '192.168.1.1' } });
    expect(onChange).toHaveBeenCalledWith('sshHost', '192.168.1.1');
  });

  it('calls onChange with sshPort when port input changes', () => {
    render(
      <SshHostConfig host="" port={22} username="" onChange={onChange} />,
    );

    const portInput = screen.getByDisplayValue('22');
    fireEvent.change(portInput, { target: { value: '3022' } });
    expect(onChange).toHaveBeenCalledWith('sshPort', 3022);
  });

  it('calls onChange with sshUsername when username input changes', () => {
    render(
      <SshHostConfig host="" port={22} username="" onChange={onChange} />,
    );

    const usernameInput = screen.getByPlaceholderText('deploy');
    fireEvent.change(usernameInput, { target: { value: 'admin' } });
    expect(onChange).toHaveBeenCalledWith('sshUsername', 'admin');
  });

  it('does not render Test Connection button when onTestConnection is not provided', () => {
    render(
      <SshHostConfig host="" port={22} username="" onChange={onChange} />,
    );

    expect(screen.queryByText('Test Connection')).not.toBeInTheDocument();
  });

  it('renders Test Connection button and fires callback on click', () => {
    const onTestConnection = vi.fn();
    render(
      <SshHostConfig
        host="10.0.1.5"
        port={22}
        username="deploy"
        onChange={onChange}
        onTestConnection={onTestConnection}
      />,
    );

    const btn = screen.getByText('Test Connection');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTestConnection).toHaveBeenCalledOnce();
  });

  it('displays a successful test result', () => {
    render(
      <SshHostConfig
        host="10.0.1.5"
        port={22}
        username="deploy"
        onChange={onChange}
        onTestConnection={vi.fn()}
        testResult={{ success: true, message: 'Connection successful' }}
      />,
    );

    expect(screen.getByText('Connection successful')).toBeInTheDocument();
  });

  it('displays a failed test result', () => {
    render(
      <SshHostConfig
        host="10.0.1.5"
        port={22}
        username="deploy"
        onChange={onChange}
        onTestConnection={vi.fn()}
        testResult={{ success: false, message: 'Connection refused' }}
      />,
    );

    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });
});
