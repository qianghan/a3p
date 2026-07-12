import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from '../app/page';

describe('HomePage', () => {
  it('renders the main heading', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Bookkeeping');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('that listens.');
  });

  it('renders the description', () => {
    render(<HomePage />);

    expect(screen.getByText(/AgentBook is an AI accountant/i)).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    render(<HomePage />);

    expect(screen.getByRole('link', { name: /Start free, no card/i })).toHaveAttribute(
      'href',
      '/register'
    );
    expect(screen.getByRole('link', { name: /See plans/i })).toHaveAttribute('href', '#pricing');
  });

  it('renders the editorial section markers', () => {
    render(<HomePage />);

    expect(screen.getByText("Who it's for")).toBeInTheDocument();
    expect(screen.getAllByText('How it works').length).toBeGreaterThan(0);
    expect(screen.getByText("What's inside")).toBeInTheDocument();
  });
});
